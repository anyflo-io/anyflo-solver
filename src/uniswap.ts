import {
	CommandParser,
	CommandType,
	UniversalRouterVersion,
	type UniversalRouterCommand,
} from "@uniswap/universal-router-sdk";
import {
	decodeAbiParameters,
	decodeFunctionData,
	erc20Abi,
	parseAbi,
	parseEventLogs,
	type Address,
	type Hex,
	type SignTypedDataParameters,
	type TransactionReceipt,
} from "viem";
import { z } from "zod";
import { newFailure, newSuccess, type PResult } from "@anyflo/lib/result";
import type { SolverConfig } from "./config";
import type { Evm } from "./evm";
import type { LiquidityStrategy, StrategyQuote, SwapResult } from "./types";

export const UNISWAP_ROUTER_VERSION = "2.1.2";
const ZERO = "0x0000000000000000000000000000000000000000";
const MSG_SENDER = "0x0000000000000000000000000000000000000001";
const MAX_LIFETIME = 3600n;
const same = (a: unknown, b: unknown) =>
	typeof a === "string" &&
	typeof b === "string" &&
	a.toLowerCase() === b.toLowerCase();
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const uint = z.union([
	z.string().regex(/^[0-9]+$/),
	z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
]);
const hex = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/);
const permitMessage = z
	.object({
		details: z
			.object({ token: address, amount: uint, expiration: uint, nonce: uint })
			.strict(),
		spender: address,
		sigDeadline: uint,
	})
	.strict();
const permitSchema = z
	.object({
		domain: z
			.object({
				name: z.literal("Permit2"),
				chainId: uint,
				verifyingContract: address,
			})
			.strict(),
		primaryType: z.literal("PermitSingle").optional(),
		types: z.record(
			z.string(),
			z.array(z.object({ name: z.string(), type: z.string() }).strict()),
		),
		values: permitMessage.optional(),
		message: permitMessage.optional(),
		value: permitMessage.optional(),
	})
	.strict();
export type UniswapPermitData = z.infer<typeof permitSchema>;
type PermitMessage = z.infer<typeof permitMessage>;
const quoteSchema = z.object({
	routing: z.literal("CLASSIC"),
	quote: z.looseObject({
		input: z.looseObject({ token: address, amount: uint }),
		output: z.looseObject({
			token: address,
			amount: uint,
			minimumAmount: uint.optional(),
		}),
	}),
	permitData: permitSchema.nullish(),
});
const swapSchema = z.object({
	routing: z.literal("CLASSIC").optional(),
	swap: z.object({
		to: address,
		from: address,
		data: hex,
		value: z.union([uint, hex]),
		chainId: z.number().int(),
	}),
});
const canonicalTypes = {
	PermitDetails: [
		{ name: "token", type: "address" },
		{ name: "amount", type: "uint160" },
		{ name: "expiration", type: "uint48" },
		{ name: "nonce", type: "uint48" },
	],
	PermitSingle: [
		{ name: "details", type: "PermitDetails" },
		{ name: "spender", type: "address" },
		{ name: "sigDeadline", type: "uint256" },
	],
};

export class UnsafePayloadError extends Error {
	constructor(
		readonly code: number,
		message: string,
	) {
		super(message);
		this.name = "UnsafePayloadError";
	}
}
function requireSafe(ok: unknown, message: string): asserts ok {
	if (!ok) throw new UnsafePayloadError(400, message);
}
function integer(value: unknown): bigint {
	if (typeof value === "bigint") return value;
	if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value))
		return BigInt(value);
	if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
		return BigInt(value);
	if (value !== null && value !== undefined && /^[0-9]+$/.test(String(value)))
		return BigInt(String(value));
	throw new UnsafePayloadError(400, "Invalid unsigned amount");
}
function liveDeadline(value: unknown, now: number): void {
	const deadline = integer(value),
		seconds = BigInt(Math.floor(now / 1000));
	requireSafe(
		deadline > seconds && deadline <= seconds + MAX_LIFETIME,
		"Deadline outside bounded live window",
	);
}

/** Only standard AllowanceTransfer PermitSingle; no SignatureTransfer or extra spenders. */
export function validatePermitData(
	permit: UniswapPermitData,
	ctx: {
		chainId: number;
		permit2: Address;
		universalRouter: Address;
		tokenIn: Address;
		amountIn: bigint;
	},
	now: number,
): PermitMessage {
	const p = permitSchema.parse(permit);
	requireSafe(
		integer(p.domain.chainId) === BigInt(ctx.chainId) &&
			same(p.domain.verifyingContract, ctx.permit2),
		"Foreign Permit2 domain",
	);
	for (const [name, fields] of Object.entries(canonicalTypes)) {
		requireSafe(
			JSON.stringify(p.types[name]) === JSON.stringify(fields),
			"Noncanonical PermitSingle type",
		);
	}
	requireSafe(
		Object.keys(p.types).every(
			(name) => name in canonicalTypes || name === "EIP712Domain",
		),
		"Extra permit types",
	);
	const carriers = [p.values, p.message, p.value].filter(
		(v) => v !== undefined,
	);
	requireSafe(carriers.length === 1, "Ambiguous permit message");
	const message = carriers[0]!;
	requireSafe(
		same(message.details.token, ctx.tokenIn) &&
			same(message.spender, ctx.universalRouter),
		"Foreign permit token or spender",
	);
	requireSafe(
		integer(message.details.amount) === ctx.amountIn &&
			ctx.amountIn > 0n &&
			ctx.amountIn < 1n << 160n,
		"Permit must authorize exact input",
	);
	requireSafe(
		integer(message.details.nonce) < 1n << 48n,
		"Permit nonce overflow",
	);
	const expiration = integer(message.details.expiration),
		seconds = BigInt(Math.floor(now / 1000));
	requireSafe(
		expiration > seconds &&
			expiration <= seconds + 31n * 86400n &&
			expiration < 1n << 48n,
		"Permit expiration outside bounded window",
	);
	liveDeadline(message.sigDeadline, now);
	return message;
}

export interface RouterPlanExpectations {
	tokenIn: Address;
	tokenOut: Address;
	swapper: Address;
	universalRouter: Address;
	amountIn: bigint;
	minOut: bigint;
	permitSigned: boolean;
	/** The exact locally signed authorization, not merely a flag that something was signed. */
	permit?: { message: PermitMessage; signature: Hex };
}
function param(c: UniversalRouterCommand, name: string): unknown {
	const p = c.params.find((p) => p.name === name);
	requireSafe(p !== undefined, `Missing router parameter ${name}`);
	return p.value;
}
function solverRecipient(value: unknown, e: RouterPlanExpectations): boolean {
	return same(value, e.swapper) || same(value, MSG_SENDER);
}
function boundedSwap(
	input: unknown,
	output: unknown,
	e: RouterPlanExpectations,
): bigint {
	requireSafe(
		integer(input) === e.amountIn,
		"Router must spend exact input once",
	);
	const minimum = integer(output);
	requireSafe(
		minimum >= e.minOut && e.minOut > 0n,
		"Router output floor below accepted minimum",
	);
	return minimum;
}
function validateV2V3(
	c: UniversalRouterCommand,
	e: RouterPlanExpectations,
): bigint {
	requireSafe(
		solverRecipient(param(c, "recipient"), e),
		"Foreign swap recipient",
	);
	requireSafe(param(c, "payerIsUser") === true, "Swap must pull from solver");
	const path = param(c, "path");
	requireSafe(Array.isArray(path) && path.length > 0, "Empty swap path");
	if (c.commandType === CommandType.V3_SWAP_EXACT_IN) {
		requireSafe(
			same(path[0]?.tokenIn, e.tokenIn) &&
				same(path.at(-1)?.tokenOut, e.tokenOut),
			"Foreign V3 pair",
		);
	} else {
		requireSafe(
			path.length >= 2 &&
				same(path[0], e.tokenIn) &&
				same(path.at(-1), e.tokenOut),
			"Foreign V2 pair",
		);
	}
	return boundedSwap(param(c, "amountIn"), param(c, "amountOutMin"), e);
}
function validateV4(
	c: UniversalRouterCommand,
	e: RouterPlanExpectations,
): bigint {
	// The SDK exposes actions directly as command.params; swap structs live under each action's `swap` parameter.
	let floor = 0n,
		swaps = 0,
		settlements = 0,
		takes = 0;
	for (const action of c.params) {
		requireSafe(Array.isArray(action.value), "Malformed V4 action");
		const p = Object.fromEntries(
			action.value.map((p: { name: string; value: unknown }) => [
				p.name,
				p.value,
			]),
		);
		switch (action.name) {
			case "SWAP_EXACT_IN": {
				const s = p.swap as
					| {
							currencyIn: string;
							path: {
								hooks: string;
								hookData: string;
								intermediateCurrency: string;
							}[];
							amountIn: unknown;
							amountOutMinimum: unknown;
					  }
					| undefined;
				requireSafe(
					s &&
						same(s.currencyIn, e.tokenIn) &&
						Array.isArray(s.path) &&
						s.path.length > 0,
					"Foreign V4 input",
				);
				requireSafe(
					s.path.every(
						(hop: { hooks: string; hookData: string }) =>
							same(hop.hooks, ZERO) && hop.hookData === "0x",
					),
					"V4 hooks unsupported",
				);
				requireSafe(
					same(s.path.at(-1)!.intermediateCurrency, e.tokenOut),
					"Foreign V4 output",
				);
				floor = boundedSwap(s.amountIn, s.amountOutMinimum, e);
				swaps++;
				break;
			}
			case "SWAP_EXACT_IN_SINGLE": {
				const s = p.swap as
					| {
							poolKey: { hooks: string; currency0: string; currency1: string };
							hookData: string;
							zeroForOne: boolean;
							amountIn: unknown;
							amountOutMinimum: unknown;
					  }
					| undefined;
				requireSafe(
					s && s.poolKey && same(s.poolKey.hooks, ZERO) && s.hookData === "0x",
					"V4 hooks unsupported",
				);
				requireSafe(typeof s.zeroForOne === "boolean", "Invalid V4 direction");
				requireSafe(
					same(
						s.zeroForOne ? s.poolKey.currency0 : s.poolKey.currency1,
						e.tokenIn,
					) &&
						same(
							s.zeroForOne ? s.poolKey.currency1 : s.poolKey.currency0,
							e.tokenOut,
						),
					"Foreign V4 pair",
				);
				floor = boundedSwap(s.amountIn, s.amountOutMinimum, e);
				swaps++;
				break;
			}
			case "SETTLE":
				requireSafe(
					swaps === 1 &&
						same(p.currency, e.tokenIn) &&
						p.payerIsUser === true &&
						[0n, e.amountIn].includes(integer(p.amount)),
					"Unbounded V4 settlement",
				);
				settlements++;
				break;
			case "SETTLE_ALL":
				requireSafe(
					swaps === 1 &&
						same(p.currency, e.tokenIn) &&
						integer(p.maxAmount) === e.amountIn,
					"Unbounded V4 settlement",
				);
				settlements++;
				break;
			case "TAKE":
				requireSafe(
					swaps === 1 &&
						same(p.currency, e.tokenOut) &&
						solverRecipient(p.recipient, e) &&
						integer(p.amount) === 0n,
					"Foreign V4 take",
				);
				takes++;
				break;
			case "TAKE_ALL":
				requireSafe(
					swaps === 1 &&
						same(p.currency, e.tokenOut) &&
						integer(p.minAmount) >= e.minOut,
					"V4 take below minimum",
				);
				takes++;
				break;
			default:
				throw new UnsafePayloadError(400, "Unsupported V4 action");
		}
	}
	requireSafe(
		swaps === 1 && settlements === 1 && takes === 1,
		"V4 requires one swap, bounded payment and full solver receipt",
	);
	return floor;
}
const executeAbi = parseAbi([
	"function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
]);

/** Fail closed on unsupported plans; decode with the official 2.1.2 SDK, then enforce monetary semantics. */
export function validateUniversalRouterCalldata(
	data: Hex,
	e: RouterPlanExpectations,
	now: number,
): { minOut: bigint } {
	try {
		const decoded = decodeFunctionData({ abi: executeAbi, data });
		liveDeadline(decoded.args[2], now);
		const bytes = decoded.args[0].slice(2).match(/../g) ?? [];
		requireSafe(
			bytes.length === decoded.args[1].length && bytes.length > 0,
			"Mismatched command inputs",
		);
		requireSafe(
			bytes.every((b) =>
				[0x00, 0x08, 0x0a, 0x10].includes(Number.parseInt(b, 16)),
			),
			"Unsupported or optional-failure router command",
		);
		// Also bind nested action/input cardinality; the SDK otherwise ignores trailing inputs.
		for (const [i, b] of bytes.entries())
			if (b === "10") {
				const [actions, inputs] = decodeAbiParameters(
					[{ type: "bytes" }, { type: "bytes[]" }],
					decoded.args[1][i]!,
				);
				requireSafe(
					(actions.length - 2) / 2 === inputs.length,
					"Mismatched V4 inputs",
				);
			}
		const call = CommandParser.parseCalldata(
			data,
			UniversalRouterVersion.V2_1_2,
		);
		let swaps = 0,
			permits = 0,
			minimum = 0n;
		for (const c of call.commands) {
			if (c.commandType === CommandType.PERMIT2_PERMIT) {
				requireSafe(
					swaps === 0 && ++permits === 1 && e.permitSigned && e.permit,
					"Unexpected permit command",
				);
				const p = param(c, "permit") as unknown[];
				const d = p[0] as unknown[],
					m = e.permit.message;
				requireSafe(
					Array.isArray(d) &&
						same(d[0], m.details.token) &&
						integer(d[1]) === integer(m.details.amount) &&
						integer(d[2]) === integer(m.details.expiration) &&
						integer(d[3]) === integer(m.details.nonce) &&
						same(p[1], m.spender) &&
						integer(p[2]) === integer(m.sigDeadline) &&
						same(param(c, "signature"), e.permit.signature),
					"Embedded permit differs from signed authorization",
				);
			} else {
				swaps++;
				minimum =
					c.commandType === CommandType.V4_SWAP
						? validateV4(c, e)
						: validateV2V3(c, e);
			}
		}
		requireSafe(
			swaps === 1 && permits === (e.permitSigned ? 1 : 0),
			"Expected exactly one swap and its signed permit",
		);
		return { minOut: minimum };
	} catch (error) {
		if (error instanceof UnsafePayloadError) throw error;
		throw new UnsafePayloadError(
			400,
			"Malformed or unsupported router calldata",
		);
	}
}

function movements(
	receipt: TransactionReceipt,
	e: { tokenIn: Address; tokenOut: Address; swapper: Address },
) {
	let amountIn = 0n,
		amountOut = 0n;
	for (const l of parseEventLogs({
		abi: erc20Abi,
		eventName: "Transfer",
		logs: receipt.logs,
		strict: true,
	})) {
		if (same(l.address, e.tokenIn)) {
			if (same(l.args.from, e.swapper)) amountIn += l.args.value;
			if (same(l.args.to, e.swapper)) amountIn -= l.args.value;
		}
		if (same(l.address, e.tokenOut)) {
			if (same(l.args.to, e.swapper)) amountOut += l.args.value;
			if (same(l.args.from, e.swapper)) amountOut -= l.args.value;
		}
	}
	return { amountIn, amountOut };
}
function failure(error: unknown) {
	return newFailure(
		error instanceof UnsafePayloadError
			? error.code
			: error instanceof z.ZodError
				? 400
				: 502,
		error instanceof UnsafePayloadError
			? error.message
			: "Uniswap provider operation failed",
	);
}

export function createUniswapStrategy(
	config: SolverConfig,
	evm: Evm,
): LiquidityStrategy {
	async function post(
		endpoint: string,
		body: unknown,
		signal?: AbortSignal,
	): Promise<unknown> {
		const response = await fetch(`${config.uniswapApiUrl}${endpoint}`, {
			method: "POST",
			redirect: "error",
			headers: {
				"content-type": "application/json",
				"x-api-key": config.uniswapApiKey,
				"x-universal-router-version": UNISWAP_ROUTER_VERSION,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.any([
				AbortSignal.timeout(config.quoteTimeoutMs),
				...(signal ? [signal] : []),
			]),
		});
		if (!response.ok)
			throw new UnsafePayloadError(
				response.status,
				`Trading API ${endpoint} rejected request`,
			);
		return response.json();
	}
	const context = (amountIn: bigint) => ({
		chainId: config.chainId,
		permit2: config.permit2,
		universalRouter: config.universalRouter,
		tokenIn: config.tokenIn.address,
		amountIn,
	});
	const payloadSchema = z.object({
		response: quoteSchema,
		amountIn: z.bigint(),
		expectedOut: z.bigint(),
		minOut: z.bigint(),
	});
	async function quote(
		amountIn: bigint,
		signal: AbortSignal,
	): PResult<StrategyQuote> {
		try {
			requireSafe(
				amountIn > 0n && amountIn < 1n << 160n,
				"Invalid exact input",
			);
			const started = Date.now();
			const response = quoteSchema.parse(
				await post(
					"/quote",
					{
						swapper: evm.address,
						tokenIn: config.tokenIn.address,
						tokenOut: config.tokenOut.address,
						tokenInChainId: config.chainId,
						tokenOutChainId: config.chainId,
						amount: amountIn.toString(),
						type: "EXACT_INPUT",
						slippageTolerance: config.slippageBps / 100,
						routingPreference: "BEST_PRICE",
						protocols: ["V2", "V3", "V4"],
						hooksOptions: "V4_NO_HOOKS",
						permitAmount: "EXACT",
					},
					signal,
				),
			);
			requireSafe(
				!signal.aborted && Date.now() < started + config.quoteTimeoutMs,
				"Quote expired during request",
			);
			requireSafe(
				same(response.quote.input.token, config.tokenIn.address) &&
					integer(response.quote.input.amount) === amountIn &&
					same(response.quote.output.token, config.tokenOut.address),
				"Quote changed exact input or pair",
			);
			const expectedOut = integer(response.quote.output.amount);
			const protectedOut =
				(expectedOut * (10000n - BigInt(config.slippageBps))) / 10000n;
			const providerMin =
				response.quote.output.minimumAmount === undefined
					? protectedOut
					: integer(response.quote.output.minimumAmount);
			requireSafe(
				providerMin >= protectedOut && providerMin <= expectedOut,
				"Provider minimum weakens configured maximum slippage",
			);
			const minOut = providerMin;
			requireSafe(minOut > 0n, "Quote output is too small");
			if (response.permitData)
				validatePermitData(response.permitData, context(amountIn), Date.now());
			return newSuccess({
				amountIn,
				expectedOut,
				minOut,
				expiresAt: started + config.quoteTimeoutMs,
				payload: { response, amountIn, expectedOut, minOut },
			});
		} catch (error) {
			return failure(error);
		}
	}
	async function swap(q: StrategyQuote, minOut: bigint): PResult<SwapResult> {
		try {
			requireSafe(
				Date.now() < q.expiresAt &&
					minOut > 0n &&
					minOut <= q.expectedOut &&
					minOut >= q.minOut &&
					q.minOut >=
						(q.expectedOut * (10000n - BigInt(config.slippageBps))) / 10000n,
				"Expired or unbounded swap",
			);
			const p = payloadSchema.parse(q.payload);
			requireSafe(
				p.amountIn === q.amountIn &&
					p.expectedOut === q.expectedOut &&
					p.minOut === q.minOut &&
					integer(p.response.quote.input.amount) === q.amountIn &&
					integer(p.response.quote.output.amount) === q.expectedOut &&
					same(p.response.quote.input.token, config.tokenIn.address) &&
					same(p.response.quote.output.token, config.tokenOut.address),
				"Quote payload changed",
			);
			const permitData = p.response.permitData;
			const message = permitData
				? validatePermitData(permitData, context(q.amountIn), Date.now())
				: undefined;
			// Advisory only. Never broadcast provider approval/cancel calldata, including maxUint approvals.
			await post("/check_approval", {
				walletAddress: evm.address,
				token: config.tokenIn.address,
				amount: q.amountIn.toString(),
				chainId: config.chainId,
			});
			let signature: Hex | undefined;
			if (permitData && message)
				signature = await evm.wallet.signTypedData({
					domain: {
						name: "Permit2",
						chainId: config.chainId,
						verifyingContract: config.permit2,
					},
					types: canonicalTypes,
					primaryType: "PermitSingle",
					message,
				} as unknown as SignTypedDataParameters);
			const result = swapSchema.parse(
				await post("/swap", {
					quote: p.response.quote,
					deadline: Math.floor(Date.now() / 1000) + 60,
					simulateTransaction: false,
					...(signature ? { permitData, signature } : {}),
				}),
			);
			const tx = result.swap;
			requireSafe(
				same(tx.to, config.universalRouter) &&
					same(tx.from, evm.address) &&
					tx.chainId === config.chainId &&
					integer(tx.value) === 0n,
				"Foreign swap transaction",
			);
			const expectations = {
				tokenIn: config.tokenIn.address,
				tokenOut: config.tokenOut.address,
				swapper: evm.address,
				universalRouter: config.universalRouter,
				amountIn: q.amountIn,
				minOut,
				permitSigned: Boolean(signature),
				...(message && signature ? { permit: { message, signature } } : {}),
			};
			validateUniversalRouterCalldata(tx.data as Hex, expectations, Date.now());
			const approved = await evm.approve(
				config.tokenIn.address,
				config.permit2,
				q.amountIn,
			);
			if (!approved.ok) return approved;
			requireSafe(Date.now() < q.expiresAt, "Quote expired during approval");
			validateUniversalRouterCalldata(tx.data as Hex, expectations, Date.now());
			const sent = await evm.send({
				to: config.universalRouter,
				data: tx.data as Hex,
				value: 0n,
			});
			if (!sent.ok) return sent;
			const actual = movements(sent.data, expectations);
			requireSafe(
				actual.amountIn === q.amountIn && actual.amountOut >= minOut,
				"Mined swap token movements violate accepted bounds",
			);
			return newSuccess({ hash: sent.data.transactionHash, ...actual });
		} catch (error) {
			return failure(error);
		}
	}
	return { quote, swap };
}
