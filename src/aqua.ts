import {
	decodeFunctionResult,
	parseAbi,
	parseEventLogs,
	erc20Abi,
	type Address,
	type Hash,
	type Hex,
	type TransactionReceipt,
} from "viem";

import { newFailure, newSuccess, type PResult } from "@anyflo/lib/result";

import { PulledEvent, PushedEvent } from "@1inch/aqua-sdk";
import {
	ABI,
	Address as SdkAddress,
	HexString as SdkHexString,
	Order,
	SwapVMContract,
	SwappedEvent,
	TakerTraits,
} from "@1inch/swap-vm-sdk";

import {
	buildAquaPosition,
	describeAquaStrategy,
	inspectAquaPosition,
	resolveAquaRegistryAddress,
	resolveSwapVmAddress,
	sameAddress,
} from "./aqua-position";
import type { AquaPosition, SolverConfig } from "./config";
import type { Evm } from "./evm";
import type {
	LiquidityStrategy,
	MarketReferenceQuote,
	StrategyQuote,
	SwapResult,
} from "./types";

/**
 * Aqua strategy: authoritative on-chain quotes against the maker's shipped
 * SwapVM position (config.aqua), executed as taker via Evm.send/Evm.approve only.
 * The 1inch Classic API is consulted separately and attached as an attributed
 * market reference: never authoritative, never a fallback, no discovery.
 * Every swap re-checks maker/app/hash/bytes/pair, positive bounds and a
 * positive deadline; no callbacks, unwrap or custom receiver.
 */

/** Validity window for the swap transaction, independent of quote freshness. */
const SWAP_DEADLINE_SECONDS = 60n;
const AQUA_UINT40_MAX = 2n ** 40n - 1n;
const BPS_DENOMINATOR = 10_000n;

/** Payload sealed into `StrategyQuote.payload` and re-verified before any spend. */
interface AquaQuotePayload {
	strategy: Hex;
	strategyHash: Hex;
	maker: Address;
	app: Address;
	tokenIn: Address;
	tokenOut: Address;
	amountIn: bigint;
	orderHash: Hex;
}

function isAquaQuotePayload(value: unknown): value is AquaQuotePayload {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.strategy === "string" &&
		typeof v.strategyHash === "string" &&
		typeof v.maker === "string" &&
		typeof v.app === "string" &&
		typeof v.tokenIn === "string" &&
		typeof v.tokenOut === "string" &&
		typeof v.amountIn === "bigint" &&
		typeof v.orderHash === "string"
	);
}

/** Bounds a provider call by the caller's signal and the configured quote timeout. */
async function raceAbort<T>(
	promise: Promise<T>,
	signal: AbortSignal,
	timeoutMs: number,
	label: string,
): Promise<T> {
	const { promise: abort, reject } = Promise.withResolvers<never>();
	const fail = (reason: string): void => reject(new Error(reason));
	const timer = setTimeout(
		() => fail(`${label} timed out after ${timeoutMs} ms`),
		timeoutMs,
	);
	const onAbort = (): void => fail(`${label} aborted`);
	if (signal.aborted) onAbort();
	else signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([promise, abort]);
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
	}
}

/**
 * Throws unless the configured position is a permissionless Aqua order bound
 * to the configured maker and hash, decodable as an Aqua router program.
 */
function requireConfiguredPosition(config: SolverConfig): {
	order: Order;
	orderHash: Hex;
} {
	const aqua = config.aqua;
	if (!aqua)
		throw new Error(
			"Aqua strategy requires a configured position (config.aqua)",
		);
	let order: Order;
	try {
		order = Order.decode(new SdkHexString(aqua.strategyBytes));
	} catch {
		throw new Error(
			"Configured aqua.strategyBytes are not a decodable SwapVM order",
		);
	}
	const description = describeAquaStrategy(aqua.strategyBytes, aqua.maker);
	if (!description.useAquaInsteadOfSignature)
		throw new Error(
			"Configured position must be a permissionless Aqua order, not a signature order",
		);
	if (description.shouldUnwrap)
		throw new Error(
			"Configured position must not unwrap WETH (incompatible with Aqua)",
		);
	if (description.allowZeroAmountIn)
		throw new Error("Configured position must not allow zero amountIn");
	if (description.customReceiver)
		throw new Error("Configured position must not set a custom receiver");
	if (description.hasHooks)
		throw new Error("Configured position must not carry transfer hooks");
	const orderHash = order.hash().toString() as Hex;
	if (!sameAddress(orderHash, aqua.strategyHash))
		throw new Error(
			`Configured aqua.strategyHash does not match strategy bytes (${orderHash})`,
		);
	if (!sameAddress(description.maker, aqua.maker))
		throw new Error(
			`Configured position maker ${description.maker} does not match aqua.maker ${aqua.maker}`,
		);
	if (description.salt === null)
		throw new Error("Configured position has no unique salt");
	const canonical = buildAquaPosition({
		maker: aqua.maker,
		tokenIn: config.tokenIn.address,
		tokenOut: config.tokenOut.address,
		tokenInDecimals: config.tokenIn.decimals,
		tokenOutDecimals: config.tokenOut.decimals,
		salt: description.salt,
	});
	if (!sameAddress(canonical.strategy, aqua.strategyBytes))
		throw new Error(
			"Configured program must be the canonical permissionless 0.99..1.01/5bps/30s position for this pair",
		);
	if (
		config.chainId === 8453 &&
		!sameAddress(aqua.app, resolveSwapVmAddress(config.chainId) ?? "")
	)
		throw new Error("Unexpected live Aqua SwapVM deployment");
	return { order, orderHash };
}

/**
 * 1inch Classic API spot quote for the configured pair, attributed as a market
 * reference. Best-effort: any failure yields null; the on-chain quote stays
 * the only authoritative number. No fallback logic, no token discovery.
 */
async function fetchMarketReferenceQuote(
	config: SolverConfig,
	amountIn: bigint,
	signal: AbortSignal,
): Promise<MarketReferenceQuote | null> {
	try {
		const url = `${config.oneInchApiUrl}/${config.chainId}/quote?src=${config.tokenIn.address}&dst=${config.tokenOut.address}&amount=${amountIn}&include_protocols=true`;
		const response = await fetch(url, {
			headers: {
				accept: "application/json",
				authorization: `Bearer ${config.oneInchApiKey}`,
			},
			redirect: "error",
			signal: AbortSignal.any([
				signal,
				AbortSignal.timeout(config.quoteTimeoutMs),
			]),
		});
		if (!response.ok) return null;
		const body = (await response.json()) as {
			dstAmount?: string;
			protocols?: unknown;
		};
		const amountOut = BigInt(body.dstAmount ?? "0");
		if (amountOut <= 0n) return null;
		return {
			source: "1inchClassic",
			amountIn,
			amountOut,
			protocols: body.protocols ?? null,
			timestamp: Date.now(),
		};
	} catch {
		return null;
	}
}

function swappedEventFromReceipt(
	receipt: TransactionReceipt,
	app: Address,
	orderHash: Hex,
	args: {
		maker: Address;
		taker: Address;
		tokenIn: Address;
		tokenOut: Address;
	},
): SwappedEvent | null {
	for (const log of receipt.logs) {
		if (
			!sameAddress(log.address, app) ||
			log.topics[0]?.toLowerCase() !==
				SwappedEvent.TOPIC.toString().toLowerCase()
		)
			continue;
		const event = SwappedEvent.fromLog({
			data: log.data,
			topics: log.topics as [Hex, ...Hex[]],
		});
		if (!sameAddress(event.orderHash.toString(), orderHash)) continue;
		if (
			!sameAddress(event.maker.toString(), args.maker) ||
			!sameAddress(event.taker.toString(), args.taker)
		)
			continue;
		if (
			!sameAddress(event.tokenIn.toString(), args.tokenIn) ||
			!sameAddress(event.tokenOut.toString(), args.tokenOut)
		)
			continue;
		return event;
	}
	return null;
}

function erc20Transfers(
	receipt: TransactionReceipt,
	token: Address,
): Array<{ from: Address; to: Address; value: bigint }> {
	return parseEventLogs({
		abi: erc20Abi,
		eventName: "Transfer",
		logs: receipt.logs.filter((l) => sameAddress(l.address, token)),
		strict: true,
	}).map((e) => ({ from: e.args.from, to: e.args.to, value: e.args.value }));
}

/**
 * Registry Pull/Push evidence for the maker-side settlement: the taker payment
 * must appear as a Pushed credit into the maker's Aqua balance and the maker
 * payout as a Pulled debit from that strategy, in the swapped amounts.
 * Returns null when proven, otherwise the missing-evidence reason.
 */
function aquaSettlementEvidence(
	receipt: TransactionReceipt,
	args: {
		registry: Address;
		maker: Address;
		app: Address;
		strategyHash: Hex;
		tokenIn: Address;
		amountIn: bigint;
		tokenOut: Address;
		amountOut: bigint;
	},
): string | null {
	let pushed = false;
	let pulled = false;
	for (const log of receipt.logs) {
		if (!sameAddress(log.address, args.registry)) continue;
		const topic = log.topics[0]?.toLowerCase();
		if (topic === PushedEvent.TOPIC.toString().toLowerCase()) {
			const event = PushedEvent.fromLog({
				data: log.data,
				topics: log.topics as [Hex, ...Hex[]],
			});
			pushed ||=
				sameAddress(event.maker.toString(), args.maker) &&
				sameAddress(event.app.toString(), args.app) &&
				sameAddress(event.strategyHash.toString(), args.strategyHash) &&
				sameAddress(event.token.toString(), args.tokenIn) &&
				event.amount === args.amountIn;
		}
		if (topic === PulledEvent.TOPIC.toString().toLowerCase()) {
			const event = PulledEvent.fromLog({
				data: log.data,
				topics: log.topics as [Hex, ...Hex[]],
			});
			pulled ||=
				sameAddress(event.maker.toString(), args.maker) &&
				sameAddress(event.app.toString(), args.app) &&
				sameAddress(event.strategyHash.toString(), args.strategyHash) &&
				sameAddress(event.token.toString(), args.tokenOut) &&
				event.amount === args.amountOut;
		}
	}
	if (!pushed)
		return "receipt lacks Aqua Pushed evidence for the taker payment into the maker balance";
	if (!pulled)
		return "receipt lacks Aqua Pulled evidence for the maker payout from the strategy";
	return null;
}

export function createAquaStrategy(
	config: SolverConfig,
	evm: Evm,
): LiquidityStrategy {
	const configured = config.aqua;
	if (!configured)
		throw new Error(
			"Aqua strategy requires a configured position (config.aqua)",
		);
	const bound: AquaPosition = configured;
	const { order, orderHash } = requireConfiguredPosition(config);
	const swapVm = new SwapVMContract(new SdkAddress(bound.app));
	const app = bound.app;
	const tokenIn = config.tokenIn;
	const tokenOut = config.tokenOut;

	async function positionState() {
		const registry = await evm.client.readContract({
			address: app,
			abi: parseAbi(["function AQUA() view returns(address)"]),
			functionName: "AQUA",
		});
		if (
			config.chainId === 8453 &&
			!sameAddress(registry, resolveAquaRegistryAddress(config.chainId) ?? "")
		)
			throw new Error("Unexpected live Aqua registry");
		return inspectAquaPosition(evm.client, {
			registry,
			app,
			maker: bound.maker,
			strategyHash: bound.strategyHash,
			tokenIn: tokenIn.address,
			tokenOut: tokenOut.address,
		});
	}
	async function quote(
		amountIn: bigint,
		signal: AbortSignal,
	): PResult<StrategyQuote> {
		if (amountIn <= 0n) return newFailure(400, "amountIn must be positive");
		try {
			const started = Date.now();
			const referencePromise = fetchMarketReferenceQuote(
				config,
				amountIn,
				AbortSignal.any([
					signal,
					AbortSignal.timeout(Math.min(1_000, config.quoteTimeoutMs)),
				]),
			);
			const state = await raceAbort(
				positionState(),
				signal,
				config.quoteTimeoutMs,
				"Aqua position backing",
			);
			if (!state.active)
				return newFailure(400, "Aqua position is not active for this pair");
			const call = swapVm.quote({
				order,
				tokenIn: new SdkAddress(tokenIn.address),
				tokenOut: new SdkAddress(tokenOut.address),
				amount: amountIn,
				takerTraits: TakerTraits.default(),
			});
			const simulated = await raceAbort(
				evm.client.call({
					to: call.to as Address,
					data: call.data as Hex,
					account: evm.address,
				}),
				signal,
				config.quoteTimeoutMs,
				"SwapVM quote",
			);
			if (!simulated.data)
				return newFailure(502, "SwapVM quote returned no data");
			const result = decodeFunctionResult({
				abi: ABI.SWAP_VM_ABI,
				functionName: "quote",
				data: simulated.data,
			});
			const [returnedIn, returnedOut, returnedHash] = [
				result[0]!,
				result[1]!,
				result[2]!,
			];
			if (returnedIn !== amountIn)
				return newFailure(502, "SwapVM quote did not echo the exact-in amount");
			if (returnedOut <= 0n)
				return newFailure(502, "SwapVM quote returned a non-positive output");
			if (!sameAddress(returnedHash, orderHash))
				return newFailure(
					502,
					"SwapVM quote hash does not match the configured strategy",
				);
			if (
				returnedOut > state.virtualOut ||
				returnedOut > state.walletOut ||
				returnedOut > state.allowanceOut
			)
				return newFailure(400, "Maker cannot back quoted Aqua output");
			const minOut =
				(returnedOut * (BPS_DENOMINATOR - BigInt(config.slippageBps))) /
				BPS_DENOMINATOR;
			if (minOut <= 0n)
				return newFailure(
					400,
					"Quoted output is too small for the configured slippage bound; refusing an unbounded swap",
				);
			const reference = await referencePromise;
			if (signal.aborted || Date.now() >= started + config.quoteTimeoutMs)
				return newFailure(504, "Quote expired during provider calls");
			return newSuccess({
				amountIn,
				expectedOut: returnedOut,
				minOut,
				expiresAt: started + config.quoteTimeoutMs,
				payload: {
					strategy: bound.strategyBytes,
					strategyHash: bound.strategyHash,
					maker: bound.maker,
					app,
					tokenIn: tokenIn.address,
					tokenOut: tokenOut.address,
					amountIn,
					orderHash,
				} satisfies AquaQuotePayload,
				...(reference ? { reference } : {}),
			});
		} catch (error) {
			if (signal.aborted) return newFailure(499, "Quote aborted");
			return newFailure(502, "SwapVM quote unavailable or timed out");
		}
	}

	async function swap(
		rawQuote: StrategyQuote,
		minOut: bigint,
	): PResult<SwapResult> {
		if (!isAquaQuotePayload(rawQuote.payload))
			return newFailure(
				400,
				"Swap rejected: quote payload is not an Aqua position quote",
			);
		const payload = rawQuote.payload;
		const mismatches: string[] = [];
		if (!sameAddress(payload.strategy, bound.strategyBytes))
			mismatches.push("strategy bytes");
		if (!sameAddress(payload.strategyHash, bound.strategyHash))
			mismatches.push("strategy hash");
		if (!sameAddress(payload.maker, bound.maker)) mismatches.push("maker");
		if (!sameAddress(payload.app, bound.app)) mismatches.push("app");
		if (
			!sameAddress(payload.tokenIn, tokenIn.address) ||
			!sameAddress(payload.tokenOut, tokenOut.address)
		)
			mismatches.push("token pair");
		if (payload.amountIn !== rawQuote.amountIn) mismatches.push("amount");
		if (!sameAddress(payload.orderHash, orderHash))
			mismatches.push("order hash");
		if (mismatches.length > 0)
			return newFailure(
				400,
				`Swap rejected: quote payload does not match the configured position (${mismatches.join(", ")})`,
			);
		if (
			rawQuote.amountIn <= 0n ||
			rawQuote.expectedOut <= 0n ||
			rawQuote.minOut <= 0n
		)
			return newFailure(400, "Swap rejected: quote amounts must be positive");
		if (
			minOut < rawQuote.minOut ||
			rawQuote.minOut <
				(rawQuote.expectedOut *
					(BPS_DENOMINATOR - BigInt(config.slippageBps))) /
					BPS_DENOMINATOR
		)
			return newFailure(
				400,
				"Swap rejected: minimum weakens configured slippage protection",
			);
		if (minOut > rawQuote.expectedOut)
			return newFailure(
				400,
				"Swap rejected: minOut exceeds the quoted expected output",
			);
		if (Date.now() >= rawQuote.expiresAt)
			return newFailure(400, "Swap rejected: quote expired");
		const deadline =
			BigInt(Math.floor(Date.now() / 1000)) + SWAP_DEADLINE_SECONDS;
		if (deadline > AQUA_UINT40_MAX)
			return newFailure(500, "Swap deadline does not fit uint40");
		try {
			const state = await positionState();
			if (
				!state.active ||
				state.virtualOut < minOut ||
				state.walletOut < minOut ||
				state.allowanceOut < minOut
			)
				return newFailure(400, "Maker cannot back Aqua swap");
			const approved = await evm.approve(
				tokenIn.address,
				app,
				rawQuote.amountIn,
			);
			if (!approved.ok) return approved;
			if (
				Date.now() >= rawQuote.expiresAt ||
				BigInt(Math.floor(Date.now() / 1000)) >= deadline
			)
				return newFailure(400, "Aqua quote expired during approval");
			const call = swapVm.swap({
				order,
				tokenIn: new SdkAddress(tokenIn.address),
				tokenOut: new SdkAddress(tokenOut.address),
				amount: rawQuote.amountIn,
				takerTraits: TakerTraits.default().with({
					threshold: minOut,
					deadline,
				}),
			});
			const sent = await evm.send({
				to: call.to as Address,
				data: call.data as Hex,
				value: call.value,
			});
			if (!sent.ok) return sent;
			const event = swappedEventFromReceipt(sent.data, app, orderHash, {
				maker: bound.maker,
				taker: evm.address,
				tokenIn: tokenIn.address,
				tokenOut: tokenOut.address,
			});
			if (!event)
				return newFailure(
					502,
					"Swap receipt has no Swapped event matching the position and pair",
				);
			if (event.amountOut < minOut)
				return newFailure(
					502,
					"Swapped event reports less than the requested minimum output",
				);
			if (event.amountIn !== payload.amountIn)
				return newFailure(502, "Swapped event changed the exact input");
			const settlement = aquaSettlementEvidence(sent.data, {
				registry: state.registry,
				maker: bound.maker,
				app,
				strategyHash: bound.strategyHash,
				tokenIn: tokenIn.address,
				amountIn: event.amountIn,
				tokenOut: tokenOut.address,
				amountOut: event.amountOut,
			});
			if (settlement)
				return newFailure(502, `Swap settlement incomplete: ${settlement}`);
			const net = (token: Address) =>
				erc20Transfers(sent.data, token).reduce(
					(sum, t) =>
						sum +
						(sameAddress(t.to, evm.address) ? t.value : 0n) -
						(sameAddress(t.from, evm.address) ? t.value : 0n),
					0n,
				);
			const received = net(tokenOut.address),
				spent = -net(tokenIn.address);
			if (
				received !== event.amountOut ||
				received < minOut ||
				spent !== payload.amountIn
			)
				return newFailure(
					502,
					"Receipt net token movements do not match the exact Aqua swap",
				);
			return newSuccess({
				hash: sent.data.transactionHash as Hash,
				amountIn: spent,
				amountOut: received,
			});
		} catch {
			return newFailure(
				502,
				"Aqua operation failed; reconcile any journaled spend before retrying",
			);
		}
	}

	return { quote, swap };
}
