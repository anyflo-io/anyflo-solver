import { afterEach, expect, mock, spyOn, test } from "bun:test";
import {
	encodeAbiParameters,
	encodeFunctionData,
	encodeEventTopics,
	erc20Abi,
	parseAbi,
	parseAbiParameters,
	toHex,
	type Address,
	type Hex,
	type TransactionReceipt,
} from "viem";
import { newSuccess } from "@anyflo/lib/result";
import { ConfigSchema } from "../src/config";
import type { Evm } from "../src/evm";
import {
	createUniswapStrategy,
	validatePermitData,
	validateUniversalRouterCalldata,
	type UniswapPermitData,
} from "../src/uniswap";

const IN: Address = "0x1111111111111111111111111111111111111111";
const OUT: Address = "0x2222222222222222222222222222222222222222";
const SOLVER: Address = "0x3333333333333333333333333333333333333333";
const UR: Address = "0x4444444444444444444444444444444444444444";
const P2: Address = "0x5555555555555555555555555555555555555555";
const OTHER: Address = "0x6666666666666666666666666666666666666666";
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const INPUT = 1_000_000n,
	OUTPUT = 999_000n,
	MIN = (OUTPUT * 9950n) / 10000n;
const SIG = `0x${"ab".repeat(65)}` as Hex;
const HASH = toHex(7, { size: 32 });
const config = ConfigSchema.parse({
	hubUrl: "ws://127.0.0.1:1",
	solverId: 1,
	kid: 1,
	chainId: 31337,
	rpcUrl: "http://127.0.0.1:2",
	depositAccount: OTHER,
	deliveryAccount: OTHER,
	tokenIn: { address: IN, decimals: 6, symbol: "IN" },
	tokenOut: { address: OUT, decimals: 6, symbol: "OUT" },
	strategy: "Uniswap",
	marginBps: 100,
	slippageBps: 50,
	uniswapApiKey: "test",
	oneInchApiKey: "test",
	uniswapApiUrl: "http://127.0.0.1:3/v1",
	universalRouter: UR,
	permit2: P2,
});
const context = {
	chainId: 31337,
	permit2: P2,
	universalRouter: UR,
	tokenIn: IN,
	amountIn: INPUT,
};
const expectations = {
	tokenIn: IN,
	tokenOut: OUT,
	swapper: SOLVER,
	universalRouter: UR,
	amountIn: INPUT,
	minOut: MIN,
	permitSigned: false,
};
const execute = parseAbi([
	"function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
]);
const seconds = () => Math.floor(Date.now() / 1000);
afterEach(() => mock.restore());

function permit(): UniswapPermitData {
	return {
		domain: { name: "Permit2", chainId: 31337, verifyingContract: P2 },
		types: {
			PermitSingle: [
				{ name: "details", type: "PermitDetails" },
				{ name: "spender", type: "address" },
				{ name: "sigDeadline", type: "uint256" },
			],
			PermitDetails: [
				{ name: "token", type: "address" },
				{ name: "amount", type: "uint160" },
				{ name: "expiration", type: "uint48" },
				{ name: "nonce", type: "uint48" },
			],
		},
		values: {
			details: {
				token: IN,
				amount: INPUT.toString(),
				expiration: seconds() + 30 * 86400,
				nonce: "0",
			},
			spender: UR,
			sigDeadline: seconds() + 600,
		},
	};
}
function plan(
	commands: Hex,
	inputs: Hex[],
	deadline = BigInt(seconds() + 60),
): Hex {
	return encodeFunctionData({
		abi: execute,
		functionName: "execute",
		args: [commands, inputs, deadline],
	});
}
function v3(
	overrides: {
		recipient?: Address;
		amount?: bigint;
		min?: bigint;
		payer?: boolean;
	} = {},
): Hex {
	return encodeAbiParameters(
		parseAbiParameters("address,uint256,uint256,bytes,bool,uint256[]"),
		[
			overrides.recipient ?? SOLVER,
			overrides.amount ?? INPUT,
			overrides.min ?? MIN,
			`0x${IN.slice(2)}0001f4${OUT.slice(2)}`,
			overrides.payer ?? true,
			[],
		],
	);
}
function permitInput(p: UniswapPermitData): Hex {
	const m = p.values!;
	return encodeAbiParameters(
		parseAbiParameters(
			"((address token,uint160 amount,uint48 expiration,uint48 nonce) details,address spender,uint256 sigDeadline),bytes",
		),
		[
			{
				details: {
					token: m.details.token as Address,
					amount: BigInt(m.details.amount),
					expiration: Number(m.details.expiration),
					nonce: Number(m.details.nonce),
				},
				spender: m.spender as Address,
				sigDeadline: BigInt(m.sigDeadline),
			},
			SIG,
		],
	);
}
function v4(
	hooks: Address = ZERO,
	takeTo: Address = SOLVER,
	settleAmount = INPUT,
): Hex {
	const swap = encodeAbiParameters(
		parseAbiParameters(
			"(address currencyIn,(address intermediateCurrency,uint256 fee,int24 tickSpacing,address hooks,bytes hookData)[] path,uint256[] minHopPriceX36,uint128 amountIn,uint128 amountOutMinimum)",
		),
		[
			{
				currencyIn: IN,
				path: [
					{
						intermediateCurrency: OUT,
						fee: 500n,
						tickSpacing: 10,
						hooks,
						hookData: "0x",
					},
				],
				minHopPriceX36: [],
				amountIn: INPUT,
				amountOutMinimum: MIN,
			},
		],
	);
	const settle = encodeAbiParameters(parseAbiParameters("address,uint256"), [
		IN,
		settleAmount,
	]);
	const take = encodeAbiParameters(
		parseAbiParameters("address,address,uint256"),
		[OUT, takeTo, 0n],
	);
	return encodeAbiParameters(parseAbiParameters("bytes,bytes[]"), [
		"0x070c0e",
		[swap, settle, take],
	]);
}
function transfer(token: Address, from: Address, to: Address, amount: bigint) {
	return {
		address: token,
		topics: encodeEventTopics({
			abi: erc20Abi,
			eventName: "Transfer",
			args: { from, to },
		}),
		data: encodeAbiParameters([{ type: "uint256" }], [amount]),
	};
}
function fixture(
	options: {
		permit?: UniswapPermitData;
		data?: Hex;
		logs?: unknown[];
		tx?: Record<string, unknown>;
		routing?: string;
		approval?: unknown;
		minimum?: bigint;
	} = {},
) {
	const response = {
		routing: options.routing ?? "CLASSIC",
		quote: {
			chainId: 31337,
			swapper: SOLVER,
			route: [{ pool: "preserved" }],
			input: { token: IN, amount: INPUT.toString() },
			output: {
				token: OUT,
				amount: OUTPUT.toString(),
				minimumAmount: (options.minimum ?? MIN).toString(),
				recipient: SOLVER,
			},
		},
		permitData: options.permit ?? null,
	};
	let submitted: Record<string, unknown> | undefined;
	spyOn(globalThis, "fetch").mockImplementation((async (
		url: string | URL | Request,
		init?: RequestInit,
	) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		if (String(url).endsWith("/quote")) {
			// This HTTP double enforces the actual API contract, not incidental headers/defaults.
			if (
				typeof body.tokenInChainId !== "number" ||
				typeof body.tokenOutChainId !== "number"
			)
				return Response.json({}, { status: 400 });
			return Response.json(response);
		}
		if (String(url).endsWith("/check_approval"))
			return Response.json({ approval: options.approval ?? null });
		submitted = body;
		const passed = body.quote as typeof response.quote | undefined;
		if (
			passed?.chainId !== 31337 ||
			!passed.route?.length ||
			passed.input?.amount !== INPUT.toString() ||
			passed.output?.recipient !== SOLVER
		)
			return Response.json({}, { status: 400 });
		return Response.json({
			swap: {
				to: UR,
				from: SOLVER,
				data:
					options.data ??
					plan(
						options.permit ? "0x0a00" : "0x00",
						options.permit ? [permitInput(options.permit), v3()] : [v3()],
					),
				value: "0x00",
				chainId: 31337,
				...options.tx,
			},
		});
	}) as typeof fetch);
	const send = mock(async () =>
		newSuccess({
			transactionHash: HASH,
			logs: options.logs ?? [
				transfer(IN, SOLVER, UR, INPUT),
				transfer(OUT, UR, SOLVER, OUTPUT),
			],
		} as unknown as TransactionReceipt),
	);
	const approve = mock(
		async (_token: Address, _spender: Address, _amount: bigint) =>
			newSuccess(null),
	);
	const sign = mock(async () => SIG);
	const evm = {
		address: SOLVER,
		send,
		approve,
		wallet: { signTypedData: sign },
	} as unknown as Evm;
	return {
		strategy: createUniswapStrategy(config, evm),
		send,
		approve,
		sign,
		submitted: () => submitted,
	};
}

test("standard PermitSingle binds chain, token, spender, exact amount and both expiries", () => {
	expect(validatePermitData(permit(), context, Date.now()).details.amount).toBe(
		INPUT.toString(),
	);
	for (const mutate of [
		(p: UniswapPermitData) => {
			p.domain.chainId = 8453;
		},
		(p: UniswapPermitData) => {
			p.domain.verifyingContract = OTHER;
		},
		(p: UniswapPermitData) => {
			p.values!.details.token = OUT;
		},
		(p: UniswapPermitData) => {
			p.values!.spender = OTHER;
		},
		(p: UniswapPermitData) => {
			p.values!.details.amount = (INPUT + 1n).toString();
		},
		(p: UniswapPermitData) => {
			p.values!.details.expiration = seconds() - 1;
		},
		(p: UniswapPermitData) => {
			p.values!.sigDeadline = seconds() + 7200;
		},
		(p: UniswapPermitData) => {
			p.types.PermitDetails![1]!.type = "uint256";
		},
	]) {
		const p = permit();
		mutate(p);
		expect(() => validatePermitData(p, context, Date.now())).toThrow();
	}
});

test("official V2/V3/V4 exact-input plans protect the same pair and solver minimum", () => {
	const v2 = encodeAbiParameters(
		parseAbiParameters("address,uint256,uint256,address[],bool,uint256[]"),
		[SOLVER, INPUT, MIN, [IN, OUT], true, []],
	);
	for (const data of [
		plan("0x00", [v3()]),
		plan("0x08", [v2]),
		plan("0x10", [v4()]),
	])
		expect(
			validateUniversalRouterCalldata(data, expectations, Date.now()).minOut,
		).toBe(MIN);
});

test("rejects excess input, diverted/insufficient output, extra pulls, optional failures, hooks and unbounded V4 settlement", () => {
	for (const data of [
		plan("0x00", [v3({ amount: INPUT + 1n })]),
		plan("0x00", [v3({ min: MIN - 1n })]),
		plan("0x00", [v3({ recipient: OTHER })]),
		plan("0x00", [v3({ payer: false })]),
		plan("0x0002", [v3(), "0x"]),
		plan("0x80", [v3()]),
		plan("0x00", [v3()], BigInt(seconds() - 1)),
		plan("0x10", [v4(OTHER)]),
		plan("0x10", [v4(ZERO, OTHER)]),
		plan("0x10", [v4(ZERO, SOLVER, INPUT + 1n)]),
	])
		expect(() =>
			validateUniversalRouterCalldata(data, expectations, Date.now()),
		).toThrow();
});

test("embedded permit must equal the actual locally signed PermitSingle", () => {
	const p = permit(),
		message = validatePermitData(p, context, Date.now());
	const e = {
		...expectations,
		permitSigned: true,
		permit: { message, signature: SIG },
	};
	expect(
		validateUniversalRouterCalldata(
			plan("0x0a00", [permitInput(p), v3()]),
			e,
			Date.now(),
		).minOut,
	).toBe(MIN);
	const different = permit();
	different.values!.details.nonce = "1";
	expect(() =>
		validateUniversalRouterCalldata(
			plan("0x0a00", [permitInput(different), v3()]),
			e,
			Date.now(),
		),
	).toThrow();
	expect(() =>
		validateUniversalRouterCalldata(plan("0x00", [v3()]), e, Date.now()),
	).toThrow();
});

test("real wire shape preserves quote, signs PermitSingle, ignores unlimited advisory approval, and broadcasts only bounded own approval + swap", async () => {
	const p = permit();
	const f = fixture({
		permit: p,
		approval: {
			to: IN,
			from: SOLVER,
			data: encodeFunctionData({
				abi: erc20Abi,
				functionName: "approve",
				args: [P2, (1n << 256n) - 1n],
			}),
			value: "0x00",
			chainId: 31337,
		},
	});
	const q = await f.strategy.quote(INPUT, AbortSignal.timeout(5000));
	expect(q.ok).toBe(true);
	if (!q.ok) return;
	const result = await f.strategy.swap(q.data, MIN);
	expect(result.ok).toBe(true);
	if (result.ok)
		expect(result.data).toEqual({
			hash: HASH,
			amountIn: INPUT,
			amountOut: OUTPUT,
		});
	expect(f.approve).toHaveBeenCalledWith(IN, P2, INPUT);
	expect(f.send).toHaveBeenCalledTimes(1);
	expect(f.sign).toHaveBeenCalledTimes(1);
	expect(f.submitted()?.signature).toBe(SIG);
});

test("refuses unsupported routing, stale quotes and foreign transaction metadata without any approval/broadcast", async () => {
	for (const tx of [
		{ to: OTHER },
		{ from: OTHER },
		{ chainId: 8453 },
		{ value: "0x01" },
		{ data: "0x" },
	]) {
		const f = fixture({ tx }),
			q = await f.strategy.quote(INPUT, AbortSignal.timeout(5000));
		if (!q.ok) throw new Error("fixture quote failed");
		expect((await f.strategy.swap(q.data, MIN)).ok).toBe(false);
		expect(f.approve).not.toHaveBeenCalled();
		expect(f.send).not.toHaveBeenCalled();
	}
	const f = fixture({ routing: "DUTCH_V2" });
	expect((await f.strategy.quote(INPUT, AbortSignal.timeout(5000))).ok).toBe(
		false,
	);
	expect(f.sign).not.toHaveBeenCalled();
	const g = fixture(),
		q = await g.strategy.quote(INPUT, AbortSignal.timeout(5000));
	if (!q.ok) throw new Error("fixture quote failed");
	expect(
		(await g.strategy.swap({ ...q.data, expiresAt: Date.now() - 1 }, MIN)).ok,
	).toBe(false);
	expect(g.approve).not.toHaveBeenCalled();
});

test("receipt proof uses net movements, not gross transfers or provider output estimates", async () => {
	for (const logs of [
		[
			transfer(IN, SOLVER, UR, INPUT),
			transfer(IN, UR, SOLVER, 1n),
			transfer(OUT, UR, SOLVER, OUTPUT),
		],
		[
			transfer(IN, SOLVER, UR, INPUT),
			transfer(OUT, UR, SOLVER, OUTPUT),
			transfer(OUT, SOLVER, OTHER, OUTPUT),
		],
		[transfer(IN, SOLVER, UR, INPUT)],
	]) {
		const f = fixture({ logs }),
			q = await f.strategy.quote(INPUT, AbortSignal.timeout(5000));
		if (!q.ok) throw new Error("fixture quote failed");
		expect((await f.strategy.swap(q.data, MIN)).ok).toBe(false);
		expect(f.send).toHaveBeenCalledTimes(1);
	}
});

test("API output minimum must respect the configured slippage floor, with no extra haircut", async () => {
	for (const minimum of [MIN - 1n, OUTPUT + 1n]) {
		const f = fixture({ minimum });
		expect((await f.strategy.quote(INPUT, AbortSignal.timeout(5000))).ok).toBe(
			false,
		);
		expect(f.approve).not.toHaveBeenCalled();
		expect(f.sign).not.toHaveBeenCalled();
		expect(f.send).not.toHaveBeenCalled();
	}
	const f = fixture({ minimum: MIN + 1n }),
		q = await f.strategy.quote(INPUT, AbortSignal.timeout(5000));
	expect(q.ok).toBe(true);
	if (q.ok) expect(q.data.minOut).toBe(MIN + 1n);
});
