import { afterEach, expect, mock, spyOn, test } from "bun:test";
import {
	encodeAbiParameters,
	encodeEventTopics,
	encodeFunctionResult,
	erc20Abi,
	parseAbiParameters,
	toHex,
	type Address,
	type TransactionReceipt,
} from "viem";
import { ABI as SwapABI } from "@1inch/swap-vm-sdk";
import { ABI as AquaABI } from "@1inch/aqua-sdk";
import { newSuccess } from "@anyflo/lib/result";
import {
	buildAquaPosition,
	checkAquaBacking,
	dockAquaPosition,
	inspectAquaPosition,
	manifestFromPosition,
	positionFromManifest,
	shipAquaPosition,
} from "../src/aqua-position";
import { createAquaStrategy } from "../src/aqua";
import { ConfigSchema } from "../src/config";
import type { Evm } from "../src/evm";

const MAKER: Address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	SOLVER: Address = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const IN: Address = "0x1111111111111111111111111111111111111111",
	OUT: Address = "0x2222222222222222222222222222222222222222";
const APP: Address = "0x3333333333333333333333333333333333333333",
	REG: Address = "0x4444444444444444444444444444444444444444";
const INPUT = 1_000_000n,
	OUTPUT = 1_000_000_000_000_000_000n,
	MIN = (OUTPUT * 9950n) / 10000n;
const position = buildAquaPosition({
	maker: MAKER,
	tokenIn: IN,
	tokenOut: OUT,
	tokenInDecimals: 6,
	tokenOutDecimals: 18,
	salt: 42n,
});
const config = ConfigSchema.parse({
	hubUrl: "ws://127.0.0.1:1",
	solverId: 1,
	kid: 1,
	chainId: 31337,
	rpcUrl: "http://127.0.0.1:2",
	depositAccount: REG,
	deliveryAccount: REG,
	tokenIn: { address: IN, decimals: 6, symbol: "IN" },
	tokenOut: { address: OUT, decimals: 18, symbol: "OUT" },
	strategy: "Aqua",
	marginBps: 100,
	slippageBps: 50,
	uniswapApiKey: "test",
	oneInchApiKey: "test",
	aqua: {
		maker: MAKER,
		app: APP,
		strategyHash: position.strategyHash,
		strategyBytes: position.strategy,
	},
});
afterEach(() => mock.restore());
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
function settlement(
	eventName: "Pushed" | "Pulled",
	token: Address,
	amount: bigint,
	registry = REG,
) {
	return {
		address: registry,
		topics: encodeEventTopics({ abi: AquaABI.AQUA_ABI, eventName }),
		data: encodeAbiParameters(
			parseAbiParameters("address,address,bytes32,address,uint256"),
			[MAKER, APP, position.strategyHash, token, amount],
		),
	};
}
function swapped(amountIn = INPUT) {
	return {
		address: APP,
		topics: encodeEventTopics({
			abi: SwapABI.SWAP_VM_ABI,
			eventName: "Swapped",
		}),
		data: encodeAbiParameters(
			parseAbiParameters(
				"bytes32,address,address,address,address,uint256,uint256",
			),
			[position.strategyHash, MAKER, SOLVER, IN, OUT, amountIn, OUTPUT],
		),
	};
}
function receiptLogs() {
	return [
		swapped(),
		settlement("Pushed", IN, INPUT),
		settlement("Pulled", OUT, OUTPUT),
		transfer(IN, SOLVER, APP, INPUT),
		transfer(IN, APP, MAKER, INPUT),
		transfer(OUT, MAKER, SOLVER, OUTPUT),
	];
}
function fixture(
	options: {
		logs?: unknown[];
		tokensCount?: number;
		wallet?: bigint;
		allowance?: bigint;
		virtual?: bigint;
		maker?: boolean;
	} = {},
) {
	spyOn(globalThis, "fetch").mockResolvedValue(
		Response.json({ dstAmount: OUTPUT.toString() }),
	);
	const readContract = mock(async (args: { functionName: string }) => {
		if (args.functionName === "AQUA") return REG;
		if (args.functionName === "rawBalances")
			return [options.virtual ?? 10n ** 30n, options.tokensCount ?? 2];
		if (args.functionName === "allowance")
			return options.allowance ?? 10n ** 30n;
		return options.wallet ?? 10n ** 30n;
	});
	const call = mock(async () => ({
		data: encodeFunctionResult({
			abi: SwapABI.SWAP_VM_ABI,
			functionName: "quote",
			result: [INPUT, OUTPUT, position.strategyHash],
		}),
	}));
	const send = mock(async () =>
		newSuccess({
			transactionHash: toHex(1, { size: 32 }),
			logs: options.logs ?? receiptLogs(),
		} as unknown as TransactionReceipt),
	);
	const approve = mock(
		async (_token: Address, _spender: Address, _amount: bigint) =>
			newSuccess(null),
	);
	const evm = {
		config,
		address: options.maker ? MAKER : SOLVER,
		client: { readContract, call, estimateGas: mock(async () => 100000n) },
		approve,
		send,
	} as unknown as Evm;
	return {
		evm,
		send,
		approve,
		readContract,
		strategy: createAquaStrategy(config, evm),
	};
}

test("concentrated bounds remain ordered across reversed token addresses and decimal scales", () => {
	for (const [tokenIn, tokenOut, decimalsIn, decimalsOut] of [
		[IN, OUT, 6, 18],
		[OUT, IN, 18, 6],
	] as const) {
		const p = buildAquaPosition({
			maker: MAKER,
			tokenIn,
			tokenOut,
			tokenInDecimals: decimalsIn,
			tokenOutDecimals: decimalsOut,
			salt: 42n,
		});
		expect(p.sqrtPriceMin).toBeGreaterThan(0n);
		expect(p.sqrtPriceMin).toBeLessThan(p.sqrtPriceMax);
		const manifest = manifestFromPosition(p, {
			chainId: 31337,
			registry: REG,
			app: APP,
			tokenIn: { address: tokenIn, decimals: decimalsIn, symbol: "IN" },
			tokenOut: { address: tokenOut, decimals: decimalsOut, symbol: "OUT" },
		});
		expect(positionFromManifest(manifest).strategyHash).toBe(p.strategyHash);
		expect(() => positionFromManifest({ ...manifest, salt: "43" })).toThrow();
	}
});

test("rejects a foreign maker/hash or a noncanonical configured economic program before offering liquidity", () => {
	const { evm } = fixture();
	for (const aqua of [
		{ ...config.aqua!, maker: SOLVER },
		{ ...config.aqua!, strategyHash: toHex(0, { size: 32 }) },
	])
		expect(() => createAquaStrategy({ ...config, aqua }, evm)).toThrow();
	const changed = buildAquaPosition({
		maker: MAKER,
		tokenIn: IN,
		tokenOut: OUT,
		tokenInDecimals: 6,
		tokenOutDecimals: 18,
		salt: 42n,
		feeBps: 6,
	});
	expect(() =>
		createAquaStrategy(
			{
				...config,
				aqua: {
					maker: MAKER,
					app: APP,
					strategyHash: changed.strategyHash,
					strategyBytes: changed.strategy,
				},
			},
			evm,
		),
	).toThrow();
});

test("authoritative quote requires active registry state and real maker wallet/allowance backing", async () => {
	for (const options of [
		{ tokensCount: 255 },
		{ wallet: OUTPUT - 1n },
		{ allowance: OUTPUT - 1n },
		{ virtual: OUTPUT - 1n },
	]) {
		const f = fixture(options);
		expect((await f.strategy.quote(INPUT, AbortSignal.timeout(5000))).ok).toBe(
			false,
		);
		expect(f.send).not.toHaveBeenCalled();
	}
	const f = fixture();
	const q = await f.strategy.quote(INPUT, AbortSignal.timeout(5000));
	expect(q.ok).toBe(true);
	if (q.ok) {
		expect(q.data.minOut).toBe(MIN);
		expect(q.data.expectedOut).toBe(OUTPUT);
	}
});

test("Aqua swap proves exact net input/output and both registry-address-bound settlement events", async () => {
	const f = fixture(),
		q = await f.strategy.quote(INPUT, AbortSignal.timeout(5000));
	if (!q.ok) throw new Error("quote failed");
	const result = await f.strategy.swap(q.data, MIN);
	expect(result.ok).toBe(true);
	if (result.ok)
		expect(result.data).toMatchObject({ amountIn: INPUT, amountOut: OUTPUT });
	expect(f.approve).toHaveBeenCalledWith(IN, APP, INPUT);
	for (const logs of [
		[swapped(INPUT + 1n), ...receiptLogs().slice(1)],
		[
			swapped(),
			settlement("Pushed", IN, INPUT, SOLVER),
			settlement("Pulled", OUT, OUTPUT, SOLVER),
			transfer(IN, SOLVER, APP, INPUT),
			transfer(OUT, MAKER, SOLVER, OUTPUT),
		],
		[...receiptLogs(), transfer(OUT, SOLVER, MAKER, 1n)],
		[...receiptLogs(), transfer(IN, MAKER, SOLVER, 1n)],
	]) {
		const bad = fixture({ logs }),
			quote = await bad.strategy.quote(INPUT, AbortSignal.timeout(5000));
		if (!quote.ok) throw new Error("quote failed");
		expect((await bad.strategy.swap(quote.data, MIN)).ok).toBe(false);
	}
});

test("expired or unfrozen Aqua quote cannot create an approval", async () => {
	const f = fixture(),
		q = await f.strategy.quote(INPUT, AbortSignal.timeout(5000));
	if (!q.ok) throw new Error("quote failed");
	for (const quote of [
		{ ...q.data, expiresAt: Date.now() - 1 },
		{ ...q.data, amountIn: INPUT + 1n },
	])
		expect((await f.strategy.swap(quote, MIN)).ok).toBe(false);
	expect((await f.strategy.swap(q.data, 0n)).ok).toBe(false);
	expect(f.approve).not.toHaveBeenCalled();
});

test("zero balances can still be active; docked sentinel and missing allowances are not healthy backing", async () => {
	const f = fixture({ virtual: 0n });
	expect(
		(
			await inspectAquaPosition(f.evm.client, {
				registry: REG,
				app: APP,
				maker: MAKER,
				strategyHash: position.strategyHash,
				tokenIn: IN,
				tokenOut: OUT,
			})
		).active,
	).toBe(true);
	const missing = fixture({ allowance: 0n });
	const backing = await checkAquaBacking(missing.evm.client, {
		maker: MAKER,
		registry: REG,
		tokenIn: IN,
		tokenOut: OUT,
		amounts: { tokenIn: INPUT, tokenOut: OUTPUT },
	});
	expect(backing.sufficient).toBe(false);
	expect(backing.approvalsNeeded).toEqual([IN, OUT]);
});

test("maker lifecycle never acts through a different wallet or accepts ship receipt without exact credits", async () => {
	const plan = {
		registry: REG,
		app: APP,
		maker: MAKER,
		strategy: position.strategy,
		strategyHash: position.strategyHash,
		tokenIn: IN,
		tokenOut: OUT,
		amounts: { tokenIn: INPUT, tokenOut: OUTPUT },
	};
	const wrong = fixture();
	expect((await shipAquaPosition(wrong.evm, plan)).ok).toBe(false);
	expect((await dockAquaPosition(wrong.evm, plan)).ok).toBe(false);
	expect(wrong.approve).not.toHaveBeenCalled();
	expect(wrong.send).not.toHaveBeenCalled();
	const shipped = {
		address: REG,
		topics: encodeEventTopics({ abi: AquaABI.AQUA_ABI, eventName: "Shipped" }),
		data: encodeAbiParameters(
			parseAbiParameters("address,address,bytes32,bytes"),
			[MAKER, APP, position.strategyHash, position.strategy],
		),
	};
	const missing = fixture({ maker: true, logs: [shipped] });
	expect((await shipAquaPosition(missing.evm, plan)).ok).toBe(false);
	const backed = fixture({
		maker: true,
		logs: [
			shipped,
			settlement("Pushed", IN, INPUT),
			settlement("Pushed", OUT, OUTPUT),
		],
	});
	expect((await shipAquaPosition(backed.evm, plan)).ok).toBe(true);
});
