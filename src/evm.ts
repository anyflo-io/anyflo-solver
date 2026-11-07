import { setTimeout as sleep } from "node:timers/promises";
import {
	createPublicClient,
	createWalletClient,
	encodeFunctionData,
	erc20Abi,
	http,
	parseAbi,
	parseEventLogs,
	toHex,
	type Address,
	type Chain,
	type Hash,
	type Hex,
	type PublicClient,
	type TransactionReceipt,
	type Transport,
	type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { base, foundry } from "viem/chains";

import type { Order } from "@anyflo/lib/order";
import { newFailure, newSuccess, type PResult } from "@anyflo/lib/result";
import { uuidToBytes } from "@anyflo/lib/uuid";

import type { SolverConfig } from "./config";
import type { DepositError, SpendIntent, SwapTransaction } from "./types";

export const settlementAbi = parseAbi([
	"event OrderDeposit(bytes16 indexed orderId, (address token, uint256 solverAmount, uint256 fee)[] deposits, address sender, bool directDeposit, address solver)",
	"event OrderDelivered(bytes16 indexed orderId, address indexed recipient, address sender, uint256 amount, address indexed token)",
	"function payout(bytes16 orderId, address token, uint256 amount, address recipient)",
]);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export class Evm {
	readonly client: PublicClient;
	readonly wallet: WalletClient<Transport, Chain, PrivateKeyAccount>;
	readonly address: Address;
	beforeSpend?: (intent: SpendIntent) => Promise<void>;
	guardSpend?: () => void;
	afterBroadcast?: (hash: Hash) => Promise<void>;
	afterConfirmed?: (hash: Hash) => Promise<void>;
	constructor(
		readonly config: SolverConfig,
		privateKey: Hex,
	) {
		const chain: Chain = config.chainId === 8453 ? base : foundry;
		const account = privateKeyToAccount(privateKey);
		this.address = account.address;
		this.client = createPublicClient({
			chain,
			transport: http(config.rpcUrl, { retryCount: 0 }),
		});
		this.wallet = createWalletClient({
			account,
			chain,
			transport: http(config.rpcUrl, { retryCount: 0 }),
		});
	}
	async send(tx: SwapTransaction): PResult<TransactionReceipt> {
		try {
			if ((await this.client.getChainId()) !== this.config.chainId)
				return newFailure(400, "RPC chain mismatch");
			await this.client.call({ ...tx, account: this.address });
			const request = await this.wallet.prepareTransactionRequest({
				...tx,
				account: this.wallet.account,
			});
			await this.beforeSpend?.(tx);
			const serializedTransaction = await this.wallet.signTransaction(request);
			this.guardSpend?.();
			const hash = await this.wallet.sendRawTransaction({
				serializedTransaction,
			});
			await this.afterBroadcast?.(hash);
			const receipt = await this.client.waitForTransactionReceipt({
				hash,
				timeout: 120_000,
			});
			if (receipt.transactionHash !== hash || receipt.status !== "success")
				return newFailure(
					502,
					"Transaction reverted; inspect checkpoint before retrying",
				);
			const deadline = Date.now() + 120_000;
			while (!(await this.canonical(receipt))) {
				if (Date.now() >= deadline)
					return newFailure(
						409,
						"Transaction not canonical at required finality; reconcile checkpoint",
					);
				await sleep(1_000);
			}
			await this.afterConfirmed?.(hash);
			return newSuccess(receipt);
		} catch {
			return newFailure(
				502,
				"EVM operation failed; reconcile any pending spend before retrying",
			);
		}
	}
	async balance(token: Address): Promise<bigint> {
		return this.client.readContract({
			address: token,
			abi: erc20Abi,
			functionName: "balanceOf",
			args: [this.address],
		});
	}
	async approve(
		token: Address,
		spender: Address,
		amount: bigint,
	): PResult<null> {
		try {
			if (amount <= 0n)
				return newFailure(400, "Approval amount must be positive");
			const allowance = await this.client.readContract({
				address: token,
				abi: erc20Abi,
				functionName: "allowance",
				args: [this.address, spender],
			});
			if (allowance >= amount) return newSuccess(null);
			for (const value of allowance > 0n ? [0n, amount] : [amount]) {
				const sent = await this.send({
					to: token,
					data: encodeFunctionData({
						abi: erc20Abi,
						functionName: "approve",
						args: [spender, value],
					}),
					value: 0n,
				});
				if (!sent.ok) return sent;
				const updated = await this.client.readContract({
					address: token,
					abi: erc20Abi,
					functionName: "allowance",
					args: [this.address, spender],
				});
				if (updated !== value)
					return newFailure(
						502,
						"Token did not grant the requested bounded allowance",
					);
			}
			return newSuccess(null);
		} catch {
			return newFailure(502, "Cannot establish token allowance");
		}
	}
	private async canonical(receipt: TransactionReceipt): Promise<boolean> {
		const block = await this.client.getBlock({
			blockNumber: receipt.blockNumber,
		});
		const final = await this.client.getBlock({
			blockTag: this.config.finality,
		});
		return (
			block.hash === receipt.blockHash &&
			final.number !== null &&
			final.number >= receipt.blockNumber
		);
	}
	async verifyDeposit(order: Order, hash: Hash): PResult<null, DepositError> {
		try {
			if (
				order.senderChain !== `eip155:${this.config.chainId}` ||
				!same(order.tokenIn, this.config.tokenIn.address) ||
				!same(order.solverAddress ?? "", this.address) ||
				!order.directDeposit ||
				order.fee === null ||
				order.amountIn <= 0n
			)
				return newFailure(400, {
					type: "Invalid",
					reason: "Deposit order/chain/solver mismatch",
				});
			const receipt = await this.client.getTransactionReceipt({ hash });
			if (receipt.status !== "success")
				return newFailure(400, { type: "Invalid", reason: "Deposit reverted" });
			if (receipt.transactionHash !== hash)
				return newFailure(400, {
					type: "Invalid",
					reason: "Deposit receipt hash mismatch",
				});
			const events = parseEventLogs({
				abi: settlementAbi,
				eventName: "OrderDeposit",
				logs: receipt.logs.filter((l) =>
					same(l.address, this.config.depositAccount),
				),
				strict: true,
			});
			const expectedId = toHex(uuidToBytes(order.id));
			const event = events.find(
				(e) =>
					same(e.args.orderId, expectedId) &&
					same(e.args.sender, order.senderAddr) &&
					same(e.args.solver, this.address) &&
					e.args.directDeposit &&
					e.args.deposits.length === 1 &&
					same(e.args.deposits[0]!.token, order.tokenIn) &&
					e.args.deposits[0]!.solverAmount === order.amountIn &&
					e.args.deposits[0]!.fee === order.fee,
			);
			if (!event)
				return newFailure(400, {
					type: "Invalid",
					reason: "Deposit event does not match accepted funding",
				});
			if (!(await this.canonical(receipt)))
				return newFailure(409, {
					type: "Pending",
					reason: "Deposit awaiting canonical finality",
				});
			if ((await this.balance(this.config.tokenIn.address)) < order.amountIn)
				return newFailure(400, {
					type: "Invalid",
					reason: "Credited deposit is not spendable",
				});
			return newSuccess(null);
		} catch {
			return newFailure(409, {
				type: "Pending",
				reason: "Deposit receipt or finality unavailable",
			});
		}
	}
	async payout(order: Order): PResult<TransactionReceipt> {
		if (
			order.recipientChain !== `eip155:${this.config.chainId}` ||
			!same(order.tokenOut, this.config.tokenOut.address) ||
			order.amountOut <= 0n
		)
			return newFailure(400, "Unsupported payout");
		if ((await this.balance(this.config.tokenOut.address)) < order.amountOut)
			return newFailure(409, "Insufficient swapped payout balance");
		const approved = await this.approve(
			this.config.tokenOut.address,
			this.config.deliveryAccount,
			order.amountOut,
		);
		if (!approved.ok) return approved;
		return this.send({
			to: this.config.deliveryAccount,
			data: encodeFunctionData({
				abi: settlementAbi,
				functionName: "payout",
				args: [
					toHex(uuidToBytes(order.id)),
					this.config.tokenOut.address,
					order.amountOut,
					order.recipientAddr as Address,
				],
			}),
			value: 0n,
		});
	}
	async verifyDelivery(order: Order, hash: Hash): PResult<null> {
		try {
			const receipt = await this.client.getTransactionReceipt({ hash });
			if (
				receipt.transactionHash !== hash ||
				order.recipientChain !== `eip155:${this.config.chainId}` ||
				!same(order.tokenOut, this.config.tokenOut.address)
			)
				return newFailure(400, "Delivery receipt chain/hash/token mismatch");
			if (receipt.status !== "success" || !(await this.canonical(receipt)))
				return newFailure(409, "Delivery pending canonical confirmation");
			const events = parseEventLogs({
				abi: settlementAbi,
				eventName: "OrderDelivered",
				logs: receipt.logs.filter((l) =>
					same(l.address, this.config.deliveryAccount),
				),
				strict: true,
			});
			const event = events.find(
				(e) =>
					same(e.args.orderId, toHex(uuidToBytes(order.id))) &&
					same(e.args.sender, this.address) &&
					same(e.args.recipient, order.recipientAddr) &&
					same(e.args.token, order.tokenOut) &&
					e.args.amount === order.amountOut,
			);
			return event
				? newSuccess(null)
				: newFailure(400, "Delivery does not match accepted payout");
		} catch {
			return newFailure(409, "Delivery receipt unavailable");
		}
	}
}
