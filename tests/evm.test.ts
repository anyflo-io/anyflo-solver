import { afterEach, expect, mock, spyOn, test } from "bun:test";
import {
	encodeAbiParameters,
	encodeEventTopics,
	parseAbiParameters,
	toHex,
	type TransactionReceipt,
} from "viem";
import { generatePrivateKey } from "viem/accounts";

import type { Order } from "@anyflo/lib/order";
import { uuidToBytes } from "@anyflo/lib/uuid";

import { ConfigSchema } from "../src/config";
import { Evm, settlementAbi } from "../src/evm";

const config = ConfigSchema.parse({
	hubUrl: "ws://127.0.0.1:9000/connect",
	solverId: 1,
	kid: 1,
	chainId: 31337,
	rpcUrl: "http://127.0.0.1:8545",
	depositAccount: "0x1111111111111111111111111111111111111111",
	deliveryAccount: "0x2222222222222222222222222222222222222222",
	tokenIn: {
		address: "0x3333333333333333333333333333333333333333",
		decimals: 6,
		symbol: "USDT",
	},
	tokenOut: {
		address: "0x4444444444444444444444444444444444444444",
		decimals: 6,
		symbol: "USDC",
	},
	strategy: "Uniswap",
	uniswapApiKey: "test-only",
	oneInchApiKey: "test-only",
	finality: "latest",
});
const hash = toHex(1, { size: 32 });
const blockHash = toHex(2, { size: 32 });
afterEach(() => mock.restore());

function fixture() {
	const evm = new Evm(config, generatePrivateKey());
	const order: Order = {
		id: "11111111-1111-4111-8111-111111111111",
		senderId: "22222222-2222-4222-8222-222222222222",
		recipientId: null,
		senderAddr: "0x5555555555555555555555555555555555555555",
		recipientAddr: "0x6666666666666666666666666666666666666666",
		senderChain: "eip155:31337",
		recipientChain: "eip155:31337",
		tokenIn: config.tokenIn.address,
		tokenOut: config.tokenOut.address,
		amountIn: 10000000n,
		amountOut: 9900000n,
		typ: 1,
		status: "executing",
		solverId: 1,
		solverAddress: evm.address,
		directDeposit: true,
		fee: 10000n,
		feeRecipient: "0x7777777777777777777777777777777777777777",
		depositExpiresAt: 100000,
		createdAt: 1,
		updatedAt: 1,
	};
	spyOn(evm.client, "getBlock").mockResolvedValue({
		hash: blockHash,
		number: 1n,
	} as never);
	spyOn(evm.client, "readContract").mockResolvedValue(10000000n);
	function receipt(amount: bigint, fee: bigint): TransactionReceipt {
		return {
			status: "success",
			transactionHash: hash,
			blockHash,
			blockNumber: 1n,
			logs: [
				{
					address: config.depositAccount,
					topics: encodeEventTopics({
						abi: settlementAbi,
						eventName: "OrderDeposit",
						args: { orderId: toHex(uuidToBytes(order.id)) },
					}),
					data: encodeAbiParameters(
						parseAbiParameters(
							"(address token,uint256 solverAmount,uint256 fee)[] deposits,address sender,bool directDeposit,address solver",
						),
						[
							[{ token: config.tokenIn.address, solverAmount: amount, fee }],
							order.senderAddr as `0x${string}`,
							true,
							evm.address,
						],
					),
				},
			],
		} as unknown as TransactionReceipt;
	}
	return { evm, order, receipt };
}

test("deposit receipt must fund the exact accepted solver input and separate protocol fee", async () => {
	const { evm, order, receipt } = fixture();
	const fetch = spyOn(evm.client, "getTransactionReceipt");
	fetch.mockResolvedValue(receipt(order.amountIn, order.fee!));
	expect((await evm.verifyDeposit(order, hash)).ok).toBe(true);
	fetch.mockResolvedValue(receipt(order.amountIn - 1n, order.fee!));
	const short = await evm.verifyDeposit(order, hash);
	expect(short.ok).toBe(false);
	if (!short.ok) expect(short.error.type).toBe("Invalid");
	fetch.mockResolvedValue(receipt(order.amountIn, order.fee! - 1n));
	const wrongFee = await evm.verifyDeposit(order, hash);
	expect(wrongFee.ok).toBe(false);
	if (!wrongFee.ok) expect(wrongFee.error.type).toBe("Invalid");
});

test("noncanonical funding stays pending instead of authorizing execution", async () => {
	const { evm, order, receipt } = fixture();
	spyOn(evm.client, "getTransactionReceipt").mockResolvedValue(
		receipt(order.amountIn, order.fee!),
	);
	spyOn(evm.client, "getBlock").mockResolvedValue({
		hash: toHex(3, { size: 32 }),
		number: 1n,
	} as never);
	const result = await evm.verifyDeposit(order, hash);
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.error.type).toBe("Pending");
});

test("spend intent is durable before raw broadcast, and cancellation after signing still preempts broadcast", async () => {
	const { evm } = fixture();
	spyOn(evm.client, "getChainId").mockResolvedValue(config.chainId);
	spyOn(evm.client, "call").mockResolvedValue({ data: "0x" } as never);
	spyOn(evm.wallet, "prepareTransactionRequest").mockResolvedValue({
		to: config.tokenIn.address,
		gas: 100000n,
		nonce: 0,
		chainId: config.chainId,
	} as never);
	const events: string[] = [];
	evm.beforeSpend = async () => {
		events.push("durable intent");
	};
	const serialized: Awaited<ReturnType<typeof evm.wallet.signTransaction>> =
		"0x01";
	spyOn(evm.wallet, "signTransaction").mockResolvedValue(serialized);
	const broadcast = spyOn(evm.wallet, "sendRawTransaction").mockImplementation(
		async () => {
			events.push("broadcast");
			return hash;
		},
	);
	spyOn(evm.client, "waitForTransactionReceipt").mockResolvedValue({
		status: "success",
		transactionHash: hash,
		blockNumber: 1n,
		blockHash,
		logs: [],
	} as unknown as TransactionReceipt);
	evm.afterBroadcast = async () => {
		events.push("journal hash");
	};
	evm.afterConfirmed = async () => {
		events.push("canonical confirmation");
	};
	const tx = { to: config.tokenIn.address, data: "0x01" as const, value: 0n };
	expect((await evm.send(tx)).ok).toBe(true);
	expect(events).toEqual([
		"durable intent",
		"broadcast",
		"journal hash",
		"canonical confirmation",
	]);
	broadcast.mockClear();
	evm.guardSpend = () => {
		throw new Error("cancelled");
	};
	expect((await evm.send(tx)).ok).toBe(false);
	expect(broadcast).not.toHaveBeenCalled();
});

test("failure to persist intent prevents any signature or broadcast", async () => {
	const { evm } = fixture();
	spyOn(evm.client, "getChainId").mockResolvedValue(config.chainId);
	spyOn(evm.client, "call").mockResolvedValue({ data: "0x" } as never);
	spyOn(evm.wallet, "prepareTransactionRequest").mockResolvedValue({} as never);
	evm.beforeSpend = async () => {
		throw new Error("disk fsync failed");
	};
	const sign = spyOn(evm.wallet, "signTransaction"),
		broadcast = spyOn(evm.wallet, "sendRawTransaction");
	expect(
		(await evm.send({ to: config.tokenIn.address, data: "0x01", value: 0n }))
			.ok,
	).toBe(false);
	expect(sign).not.toHaveBeenCalled();
	expect(broadcast).not.toHaveBeenCalled();
});
