import {
	erc20Abi,
	isAddress,
	parseAbi,
	type Address,
	type Hash,
	type Hex,
	type PublicClient,
	type TransactionReceipt,
} from "viem";
import { z } from "zod";

import {
	ABI,
	AquaProtocolContract,
	AQUA_CONTRACT_ADDRESSES,
	DockedEvent,
	PushedEvent,
	ShippedEvent,
} from "@1inch/aqua-sdk";
import {
	AQUA_SWAP_VM_CONTRACT_ADDRESSES,
	AquaProgramBuilder,
	AquaXYCAmmStrategy,
	Address as SdkAddress,
	HexString as SdkHexString,
	Order,
	instructions,
	MakerTraits,
	type NetworkEnum as SdkNetworkEnum,
} from "@1inch/swap-vm-sdk";

import { newFailure, newSuccess, type PResult } from "@anyflo/lib/result";

import type { SolverConfig } from "./config";
import type { Evm } from "./evm";

/**
 * Reusable Aqua position toolkit for the permissionless concentrated strategy
 * (0.99..1.01 band, 5 bps taker fee, 30 s decay, uint64 salt, no resolver NFT).
 * Maker liquidity is virtual: tokens stay in the maker wallet and the Aqua
 * registry pulls them via transferFrom, so the maker approves the registry while
 * the solver taker approves the SwapVM router; these approvals are distinct.
 */

export const AQUA_POSITION_PRICE_LOWER = "0.99";
export const AQUA_POSITION_PRICE_UPPER = "1.01";
export const AQUA_POSITION_FEE_BPS = 5;
export const AQUA_POSITION_DECAY_SECONDS = 30n;

export const AQUA_UINT64_MAX = 2n ** 64n - 1n;
const AQUA_UINT248_MAX = 2n ** 248n - 1n;

export const sameAddress = (a: string, b: string): boolean =>
	a.toLowerCase() === b.toLowerCase();
const normalize = (value: string): Address => value.toLowerCase() as Address;

function requireAddress(value: string, label: string): Address {
	if (!isAddress(value)) throw new Error(`${label} is not a valid EVM address`);
	return normalize(value);
}

function requirePositiveInt(value: number, label: string, max: number): number {
	if (!Number.isInteger(value) || value <= 0 || value > max)
		throw new Error(`${label} must be an integer in (0, ${max}]`);
	return value;
}

/** Position parameters for `buildAquaPosition`. */
export interface AquaPositionSpec {
	readonly maker: Address;
	readonly tokenIn: Address;
	readonly tokenOut: Address;
	readonly tokenInDecimals: number;
	readonly tokenOutDecimals: number;
	readonly priceLower?: string;
	readonly priceUpper?: string;
	readonly feeBps?: number;
	readonly decaySeconds?: bigint;
	/** Unique uint64 salt; a fresh cryptographically random one when omitted. */
	readonly salt?: bigint;
}

export interface AquaStrategyDescription {
	readonly program: Hex;
	readonly maker: Address;
	readonly traits: bigint;
	readonly instructionKinds: string[];
	readonly salt: bigint | null;
	readonly decaySeconds: bigint | null;
	readonly feeBps: number | null;
	readonly sqrtPriceMin: bigint | null;
	readonly sqrtPriceMax: bigint | null;
	readonly hasDeadlineInstruction: boolean;
	readonly useAquaInsteadOfSignature: boolean;
	readonly shouldUnwrap: boolean;
	readonly allowZeroAmountIn: boolean;
	readonly customReceiver: Address | null;
	readonly hasHooks: boolean;
}

export interface BuiltAquaPosition extends AquaStrategyDescription {
	readonly tokenIn: Address;
	readonly tokenOut: Address;
	/** ABI-encoded SwapVM order `(maker, traits, data)` shipped as Aqua `strategy` bytes. */
	readonly strategy: Hex;
	readonly strategyHash: Hex;
	readonly salt: bigint;
	readonly priceLower: string;
	readonly priceUpper: string;
	readonly feeBps: number;
	readonly decaySeconds: bigint;
	readonly sqrtPriceMin: bigint;
	readonly sqrtPriceMax: bigint;
	readonly tokenInDecimals: number;
	readonly tokenOutDecimals: number;
}

/**
 * Builds the deterministic permissionless concentrated position: identical
 * inputs (including salt) yield identical strategy bytes and hash.
 */
export function buildAquaPosition(spec: AquaPositionSpec): BuiltAquaPosition {
	const maker = requireAddress(spec.maker, "maker");
	if (SdkAddress.ZERO_ADDRESS.equal(new SdkAddress(maker)))
		throw new Error("maker must not be the zero address");
	const tokenIn = requireAddress(spec.tokenIn, "tokenIn");
	const tokenOut = requireAddress(spec.tokenOut, "tokenOut");
	if (sameAddress(tokenIn, tokenOut))
		throw new Error("tokenIn and tokenOut must differ");
	for (const [decimals, label] of [
		[spec.tokenInDecimals, "tokenInDecimals"],
		[spec.tokenOutDecimals, "tokenOutDecimals"],
	] as const) {
		if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18)
			throw new Error(`${label} must be an integer in [0, 18]`);
	}
	const priceLower = spec.priceLower ?? AQUA_POSITION_PRICE_LOWER;
	const priceUpper = spec.priceUpper ?? AQUA_POSITION_PRICE_UPPER;
	const pricePattern = /^[0-9]+(\.[0-9]+)?$/;
	for (const [price, label] of [
		[priceLower, "priceLower"],
		[priceUpper, "priceUpper"],
	] as const) {
		if (!pricePattern.test(price) || Number.parseFloat(price) <= 0)
			throw new Error(`${label} must be a positive decimal string`);
	}
	if (Number.parseFloat(priceLower) >= Number.parseFloat(priceUpper))
		throw new Error(
			`priceLower (${priceLower}) must be below priceUpper (${priceUpper})`,
		);
	const feeBps = requirePositiveInt(
		spec.feeBps ?? AQUA_POSITION_FEE_BPS,
		"feeBps",
		9999,
	);
	const decaySeconds = spec.decaySeconds ?? AQUA_POSITION_DECAY_SECONDS;
	if (decaySeconds <= 0n) throw new Error("decaySeconds must be positive");
	const salt = spec.salt ?? randomAquaSalt();
	if (salt < 0n || salt > AQUA_UINT64_MAX)
		throw new Error(`salt must fit uint64 (0..${AQUA_UINT64_MAX})`);

	// P = tokenGt/tokenLt with sqrt(P*1e18) encoded on-chain; the SDK sorts the
	// pair internally, so a fixed quote/base orientation keeps both bounds in the
	// same price space: human prices are tokenOut per one tokenIn.
	const pair = {
		quoteToken: {
			address: new SdkAddress(tokenOut),
			decimals: BigInt(spec.tokenOutDecimals),
		},
		baseToken: {
			address: new SdkAddress(tokenIn),
			decimals: BigInt(spec.tokenInDecimals),
		},
	};
	const { Price } = instructions.concentrate;
	const lower = Price.fromHuman(priceLower, pair).toSqrt();
	const upper = Price.fromHuman(priceUpper, pair).toSqrt();
	const sqrtPriceMin = lower < upper ? lower : upper;
	const sqrtPriceMax = lower < upper ? upper : lower;
	if (sqrtPriceMin <= 0n || sqrtPriceMin >= sqrtPriceMax)
		throw new Error(
			"concentrated bounds must satisfy 0 < sqrtPriceMin < sqrtPriceMax",
		);

	const program = AquaXYCAmmStrategy.newConcentrate({
		sqrtPriceMin,
		sqrtPriceMax,
	})
		.withDecayPeriod(decaySeconds)
		.withFeeTokenIn(feeBps)
		.withSalt(salt)
		.build();
	const order = Order.new({
		maker: new SdkAddress(maker),
		traits: MakerTraits.default(),
		program,
	});
	const description = describeAquaStrategy(order.encode().toString() as Hex);
	return {
		...description,
		sqrtPriceMin,
		sqrtPriceMax,
		tokenIn,
		tokenOut,
		salt,
		priceLower,
		priceUpper,
		feeBps,
		decaySeconds,
		tokenInDecimals: spec.tokenInDecimals,
		tokenOutDecimals: spec.tokenOutDecimals,
		strategyHash: AquaProtocolContract.calculateStrategyHash(
			order.encode(),
		).toString() as Hex,
		strategy: order.encode().toString() as Hex,
	};
}

/** Cryptographically random uint64 salt. */
export function randomAquaSalt(): bigint {
	const [salt] = globalThis.crypto.getRandomValues(new BigUint64Array(1));
	return salt!;
}

/**
 * Decodes shipped strategy bytes into their instruction-level shape and
 * maker/traits binding; throws on bytes that do not decode as an Aqua program.
 */
export function describeAquaStrategy(
	strategy: Hex,
	expectedMaker?: Address,
): AquaStrategyDescription {
	const order = Order.decode(new SdkHexString(strategy));
	const builder = new AquaProgramBuilder().decode(order.program);
	let salt: bigint | null = null;
	let decaySeconds: bigint | null = null;
	let feeBps: number | null = null;
	let sqrtPriceMin: bigint | null = null;
	let sqrtPriceMax: bigint | null = null;
	let hasDeadlineInstruction = false;
	const kinds: string[] = [];
	for (const ix of builder.getInstructions()) {
		const { opcode, args } = ix;
		if (opcode === instructions.concentrate.concentrateGrowLiquidity2D) {
			kinds.push("concentrate");
			sqrtPriceMin = (
				args as instructions.concentrate.ConcentrateGrowLiquidity2DArgs
			).sqrtPriceMin;
			sqrtPriceMax = (
				args as instructions.concentrate.ConcentrateGrowLiquidity2DArgs
			).sqrtPriceMax;
		} else if (opcode === instructions.decay.decayXD) {
			kinds.push("decay");
			decaySeconds = (args as instructions.decay.DecayXDArgs).decayPeriod;
		} else if (opcode === instructions.fee.flatFeeAmountInXD) {
			kinds.push("fee");
			// FlatFeeArgs.fromBps multiplies by 1e5 (1e9 raw = 100 %).
			feeBps = Number((args as instructions.fee.FlatFeeArgs).fee / 100_000n);
		} else if (opcode === instructions.xycSwap.xycSwapXD) {
			kinds.push("xycSwap");
		} else if (opcode === instructions.controls.salt) {
			kinds.push("salt");
			salt = new SdkHexString(
				(args as instructions.controls.SaltArgs).bytes.toString(),
			).toBigInt();
		} else if (opcode === instructions.controls.deadline) {
			kinds.push("deadline");
			hasDeadlineInstruction = true;
		} else {
			kinds.push("other");
		}
	}
	const traits = order.traits;
	const maker = normalize(order.maker.toString());
	if (expectedMaker && !sameAddress(maker, expectedMaker))
		throw new Error(
			`Strategy maker ${maker} does not match configured maker ${expectedMaker}`,
		);
	return {
		program: order.program.toString() as Hex,
		maker,
		traits: traits.encode(new SdkAddress(maker)).traits,
		instructionKinds: kinds,
		salt,
		decaySeconds,
		feeBps,
		sqrtPriceMin,
		sqrtPriceMax,
		hasDeadlineInstruction,
		useAquaInsteadOfSignature: traits.useAquaInsteadOfSignature,
		shouldUnwrap: traits.shouldUnwrap,
		allowZeroAmountIn: traits.allowZeroAmountIn,
		customReceiver:
			traits.customReceiver && !traits.customReceiver.isZero()
				? normalize(traits.customReceiver.toString())
				: null,
		hasHooks: Boolean(
			traits.preTransferInHook ||
			traits.postTransferInHook ||
			traits.preTransferOutHook ||
			traits.postTransferOutHook,
		),
	};
}

/** Aqua registry + SwapVM router addresses per chain; local chains need explicit overrides. */
export function resolveAquaRegistryAddress(
	chainId: number,
	override?: Address,
): Address | null {
	if (override) return normalize(override);
	const official = AQUA_CONTRACT_ADDRESSES[chainId as SdkNetworkEnum];
	return official ? normalize(official.toString()) : null;
}

export function resolveSwapVmAddress(
	chainId: number,
	override?: Address,
): Address | null {
	if (override) return normalize(override);
	const official = AQUA_SWAP_VM_CONTRACT_ADDRESSES[chainId as SdkNetworkEnum];
	return official ? normalize(official.toString()) : null;
}

// ---------------------------------------------------------------- manifest

const HexBody = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/);
const ManifestAddress = z
	.string()
	.refine(isAddress, "Invalid EVM address")
	.transform((v) => v.toLowerCase() as Address);
const PositiveIntString = z
	.string()
	.regex(/^[0-9]+$/, "Must be a non-negative integer string");

/** JSON artifact coordinating the shipped position with the fixture agent and the CLI. */
export const AquaPositionManifestSchema = z
	.object({
		schema: z.literal("anyflo.aqua-position/1"),
		chainId: z.union([z.literal(8453), z.literal(31337)]),
		/** Aqua registry contract (ship/dock/push/pull). */
		registry: ManifestAddress,
		/** SwapVM router app the strategy was shipped under and takers call. */
		app: ManifestAddress,
		maker: ManifestAddress,
		tokenIn: z
			.object({
				address: ManifestAddress,
				decimals: z.number().int().min(0).max(18),
				symbol: z.string().min(1),
			})
			.strict(),
		tokenOut: z
			.object({
				address: ManifestAddress,
				decimals: z.number().int().min(0).max(18),
				symbol: z.string().min(1),
			})
			.strict(),
		priceLower: z.string().min(1),
		priceUpper: z.string().min(1),
		feeBps: z.number().int().min(1).max(9999),
		decaySeconds: z.number().int().positive(),
		salt: PositiveIntString,
		amounts: z
			.object({ tokenIn: PositiveIntString, tokenOut: PositiveIntString })
			.strict(),
		strategy: HexBody.refine((v) => v.length > 2).transform(
			(v) => v.toLowerCase() as Hex,
		),
		strategyHash: HexBody.refine((v) => v.length === 66).transform(
			(v) => v.toLowerCase() as Hex,
		),
	})
	.strict();
export type AquaPositionManifest = z.infer<typeof AquaPositionManifestSchema>;

export function manifestFromPosition(
	position: BuiltAquaPosition,
	args: {
		chainId: number;
		registry: Address;
		app: Address;
		tokenIn: { address: Address; decimals: number; symbol: string };
		tokenOut: { address: Address; decimals: number; symbol: string };
		amounts?: { tokenIn: bigint; tokenOut: bigint };
	},
): AquaPositionManifest {
	if (args.chainId !== 31337 && args.chainId !== 8453)
		throw new Error("Unsupported Aqua chain");
	if (
		!sameAddress(position.tokenIn, args.tokenIn.address) ||
		!sameAddress(position.tokenOut, args.tokenOut.address)
	)
		throw new Error("Manifest tokens do not match the built position");
	return {
		schema: "anyflo.aqua-position/1",
		chainId: args.chainId === 31337 ? 31337 : 8453,
		registry: normalize(args.registry),
		app: normalize(args.app),
		maker: position.maker,
		tokenIn: {
			address: normalize(args.tokenIn.address),
			decimals: args.tokenIn.decimals,
			symbol: args.tokenIn.symbol,
		},
		tokenOut: {
			address: normalize(args.tokenOut.address),
			decimals: args.tokenOut.decimals,
			symbol: args.tokenOut.symbol,
		},
		priceLower: position.priceLower,
		priceUpper: position.priceUpper,
		feeBps: position.feeBps,
		decaySeconds: Number(position.decaySeconds),
		salt: position.salt.toString(),
		amounts: {
			tokenIn: (args.amounts?.tokenIn ?? 0n).toString(),
			tokenOut: (args.amounts?.tokenOut ?? 0n).toString(),
		},
		strategy: position.strategy,
		strategyHash: position.strategyHash,
	};
}

/**
 * Rebuilds the position from a manifest, cross-checking the recorded strategy
 * bytes and hash so ship/dock/inspect act on exactly the shipped strategy.
 */
export function positionFromManifest(
	manifest: AquaPositionManifest,
): BuiltAquaPosition {
	const rebuilt = buildAquaPosition({
		maker: manifest.maker,
		tokenIn: manifest.tokenIn.address,
		tokenOut: manifest.tokenOut.address,
		tokenInDecimals: manifest.tokenIn.decimals,
		tokenOutDecimals: manifest.tokenOut.decimals,
		priceLower: manifest.priceLower,
		priceUpper: manifest.priceUpper,
		feeBps: manifest.feeBps,
		decaySeconds: BigInt(manifest.decaySeconds),
		salt: BigInt(manifest.salt),
	});
	if (
		rebuilt.strategy.toLowerCase() !== manifest.strategy.toLowerCase() ||
		rebuilt.strategyHash.toLowerCase() !== manifest.strategyHash.toLowerCase()
	)
		throw new Error(
			"Manifest does not reproduce the recorded strategy; refusing to act on a stale or tampered position",
		);
	return rebuilt;
}

// ---------------------------------------------------------------- inspect

export interface AquaPositionInspect {
	readonly registry: Address;
	readonly app: Address;
	readonly maker: Address;
	readonly strategyHash: Hex;
	/** Aqua virtual balances recorded for (maker, app, strategyHash, token). */
	readonly virtualIn: bigint;
	readonly virtualOut: bigint;
	readonly active: boolean;
	/** Maker wallet backing: token balance and allowance towards the registry. */
	readonly walletIn: bigint;
	readonly walletOut: bigint;
	readonly allowanceIn: bigint;
	readonly allowanceOut: bigint;
}

/** Read-only on-chain inspection of a shipped position; no key required. */
export async function inspectAquaPosition(
	client: PublicClient,
	args: {
		registry: Address;
		app: Address;
		maker: Address;
		strategyHash: Hex;
		tokenIn: Address;
		tokenOut: Address;
	},
): Promise<AquaPositionInspect> {
	const strategyHash = (
		args.strategyHash.startsWith("0x")
			? args.strategyHash
			: `0x${args.strategyHash}`
	) as Hex;
	const rawBalances = await Promise.all(
		[args.tokenIn, args.tokenOut].map((token) =>
			client.readContract({
				address: args.registry,
				abi: ABI.AQUA_ABI,
				functionName: "rawBalances",
				args: [args.maker, args.app, strategyHash, token],
			}),
		),
	);
	const balances = async (token: Address) => ({
		balance: await client.readContract({
			address: token,
			abi: erc20Abi,
			functionName: "balanceOf",
			args: [args.maker],
		}),
		allowance: await client.readContract({
			address: token,
			abi: erc20Abi,
			functionName: "allowance",
			args: [args.maker, args.registry],
		}),
	});
	const [walletIn, walletOut] = await Promise.all([
		balances(args.tokenIn),
		balances(args.tokenOut),
	]);
	const virtualIn = rawBalances[0]![0];
	const virtualOut = rawBalances[1]![0];
	return {
		registry: normalize(args.registry),
		app: normalize(args.app),
		maker: normalize(args.maker),
		strategyHash: normalize(strategyHash),
		virtualIn,
		virtualOut,
		active: rawBalances[0]![1] === 2 && rawBalances[1]![1] === 2,
		walletIn: walletIn.balance,
		walletOut: walletOut.balance,
		allowanceIn: walletIn.allowance,
		allowanceOut: walletOut.allowance,
	};
}

// ---------------------------------------------------------------- backing checks

export interface AquaBackingCheck {
	readonly amounts: { tokenIn: bigint; tokenOut: bigint };
	readonly walletIn: bigint;
	readonly walletOut: bigint;
	readonly allowanceIn: bigint;
	readonly allowanceOut: bigint;
	readonly approvalsNeeded: readonly Address[];
	readonly sufficient: boolean;
	readonly problems: readonly string[];
}

/**
 * Read-only pre-flight for ship: the maker wallet must hold the shipped
 * amounts and must be able to cover the registry allowance for each token.
 */
export async function checkAquaBacking(
	client: PublicClient,
	args: {
		maker: Address;
		registry: Address;
		tokenIn: Address;
		tokenOut: Address;
		amounts: { tokenIn: bigint; tokenOut: bigint };
	},
): Promise<AquaBackingCheck> {
	const problems: string[] = [];
	const approvalsNeeded: Address[] = [];
	const read = async (token: Address) => ({
		balance: await client.readContract({
			address: token,
			abi: erc20Abi,
			functionName: "balanceOf",
			args: [args.maker],
		}),
		allowance: await client.readContract({
			address: token,
			abi: erc20Abi,
			functionName: "allowance",
			args: [args.maker, args.registry],
		}),
	});
	const [inState, outState] = await Promise.all([
		read(args.tokenIn),
		read(args.tokenOut),
	]);
	for (const [token, label, wallet, amount, allowance] of [
		[
			args.tokenIn,
			"tokenIn",
			inState.balance,
			args.amounts.tokenIn,
			inState.allowance,
		],
		[
			args.tokenOut,
			"tokenOut",
			outState.balance,
			args.amounts.tokenOut,
			outState.allowance,
		],
	] as const) {
		if (amount <= 0n) problems.push(`${label} shipped amount must be positive`);
		if (wallet < amount)
			problems.push(
				`Maker wallet holds ${wallet} of ${label} but ship needs ${amount}`,
			);
		if (allowance < amount) approvalsNeeded.push(token);
	}
	return {
		amounts: args.amounts,
		walletIn: inState.balance,
		walletOut: outState.balance,
		allowanceIn: inState.allowance,
		allowanceOut: outState.allowance,
		approvalsNeeded,
		sufficient: problems.length === 0 && approvalsNeeded.length === 0,
		problems,
	};
}

// ---------------------------------------------------------------- ship / dock

export interface AquaShipPlan {
	readonly registry: Address;
	readonly app: Address;
	readonly maker: Address;
	/** ABI-encoded SwapVM order shipped as the Aqua strategy bytes. */
	readonly strategy: Hex;
	readonly strategyHash: Hex;
	readonly tokenIn: Address;
	readonly tokenOut: Address;
	readonly amounts: { tokenIn: bigint; tokenOut: bigint };
}

/** Simulates a call from the executor and estimates its gas before any broadcast. */
async function simulateBeforeBroadcast(
	evm: Evm,
	tx: { to: Hex; data: Hex; value: bigint },
): PResult<{ gasEstimate: bigint }> {
	try {
		const gasEstimate = await evm.client.estimateGas({
			account: evm.address,
			to: tx.to as Address,
			data: tx.data,
			value: tx.value,
		});
		return newSuccess({ gasEstimate });
	} catch (error) {
		return newFailure(
			502,
			"Simulation unavailable or reverted before broadcast",
		);
	}
}

export interface AquaShipResult {
	readonly hash: Hash;
	readonly strategyHash: Hex;
	readonly maker: Address;
	readonly app: Address;
	readonly gasEstimate: bigint;
}

function shippedEventFrom(
	receipt: TransactionReceipt,
	registry: Address,
	plan: AquaShipPlan,
): ShippedEvent | null {
	for (const log of receipt.logs) {
		if (
			!sameAddress(log.address, registry) ||
			log.topics[0]?.toLowerCase() !==
				ShippedEvent.TOPIC.toString().toLowerCase()
		)
			continue;
		const event = ShippedEvent.fromLog({
			data: log.data,
			topics: log.topics as [Hex, ...Hex[]],
		});
		if (
			sameAddress(event.maker.toString(), plan.maker) &&
			sameAddress(event.app.toString(), plan.app) &&
			sameAddress(event.strategyHash.toString(), plan.strategyHash) &&
			sameAddress(event.strategy.toString(), plan.strategy)
		)
			return event;
	}
	return null;
}

/**
 * Ships from the maker: bounded registry approvals for both tokens, then ship
 * recording the virtual balances. Refuses non-permissionless strategies or a
 * plan hash that the strategy bytes do not reproduce; simulates before
 * broadcast and verifies the Shipped event from the receipt.
 */
export async function shipAquaPosition(
	evm: Evm,
	plan: AquaShipPlan,
): PResult<AquaShipResult> {
	if (
		!sameAddress(evm.address, plan.maker) ||
		sameAddress(plan.tokenIn, plan.tokenOut)
	)
		return newFailure(
			400,
			"Ship must use the maker wallet and distinct tokens",
		);
	if (
		evm.config.chainId === 8453 &&
		(!sameAddress(plan.registry, resolveAquaRegistryAddress(8453) ?? "") ||
			!sameAddress(plan.app, resolveSwapVmAddress(8453) ?? ""))
	)
		return newFailure(400, "Unexpected live Aqua deployment");
	if (
		!sameAddress(
			AquaProtocolContract.calculateStrategyHash(
				new SdkHexString(plan.strategy),
			).toString(),
			plan.strategyHash,
		)
	)
		return newFailure(
			400,
			"Refusing to ship: plan strategyHash does not match the strategy bytes",
		);
	try {
		const description = describeAquaStrategy(plan.strategy, plan.maker);
		if (
			description.salt === null ||
			!sameAddress(plan.tokenIn, evm.config.tokenIn.address) ||
			!sameAddress(plan.tokenOut, evm.config.tokenOut.address)
		)
			return newFailure(400, "Position does not match the configured pair");
		const canonical = buildAquaPosition({
			maker: plan.maker,
			tokenIn: plan.tokenIn,
			tokenOut: plan.tokenOut,
			tokenInDecimals: evm.config.tokenIn.decimals,
			tokenOutDecimals: evm.config.tokenOut.decimals,
			salt: description.salt,
		});
		if (!sameAddress(canonical.strategy, plan.strategy))
			return newFailure(
				400,
				"Refusing noncanonical concentrated position program",
			);
	} catch {
		return newFailure(
			400,
			"Refusing to ship: strategy bytes are not a decodable Aqua router program",
		);
	}
	for (const [amount, label] of [
		[plan.amounts.tokenIn, "tokenIn"],
		[plan.amounts.tokenOut, "tokenOut"],
	] as const) {
		if (amount <= 0n || amount > AQUA_UINT248_MAX)
			return newFailure(
				400,
				`${label} shipped amount must be in (0, uint248 max]`,
			);
	}
	const backing = await checkAquaBacking(evm.client, {
		maker: plan.maker,
		registry: plan.registry,
		tokenIn: plan.tokenIn,
		tokenOut: plan.tokenOut,
		amounts: plan.amounts,
	});
	if (backing.problems.length)
		return newFailure(
			400,
			`Maker cannot back the position: ${backing.problems.join("; ")}`,
		);
	const aqua = new AquaProtocolContract(new SdkAddress(plan.registry));
	const tx = aqua.ship({
		app: new SdkAddress(plan.app),
		strategy: new SdkHexString(plan.strategy),
		amountsAndTokens: [
			{ token: new SdkAddress(plan.tokenIn), amount: plan.amounts.tokenIn },
			{ token: new SdkAddress(plan.tokenOut), amount: plan.amounts.tokenOut },
		],
	});
	const registry = await evm.client.readContract({
		address: plan.app,
		abi: parseAbi(["function AQUA() view returns(address)"]),
		functionName: "AQUA",
	});
	if (!sameAddress(registry, plan.registry))
		return newFailure(400, "SwapVM registry does not match ship plan");
	const simulated = await simulateBeforeBroadcast(evm, tx);
	if (!simulated.ok) return simulated;
	for (const token of backing.approvalsNeeded) {
		const amount = sameAddress(token, plan.tokenIn)
			? plan.amounts.tokenIn
			: plan.amounts.tokenOut;
		const approved = await evm.approve(token, plan.registry, amount);
		if (!approved.ok) return approved;
	}
	const sent = await evm.send({
		to: tx.to as Address,
		data: tx.data as Hex,
		value: tx.value,
	});
	if (!sent.ok) return sent;
	const event = shippedEventFrom(sent.data, plan.registry, plan);
	if (!event)
		return newFailure(
			502,
			"Ship receipt has no Shipped event matching the strategy",
		);
	for (const [token, amount] of [
		[plan.tokenIn, plan.amounts.tokenIn],
		[plan.tokenOut, plan.amounts.tokenOut],
	] as const) {
		const credit = sent.data.logs.some((log) => {
			if (
				!sameAddress(log.address, plan.registry) ||
				log.topics[0]?.toLowerCase() !==
					PushedEvent.TOPIC.toString().toLowerCase()
			)
				return false;
			const pushed = PushedEvent.fromLog({
				data: log.data,
				topics: log.topics as [Hex, ...Hex[]],
			});
			return (
				sameAddress(pushed.maker.toString(), plan.maker) &&
				sameAddress(pushed.app.toString(), plan.app) &&
				sameAddress(pushed.strategyHash.toString(), plan.strategyHash) &&
				sameAddress(pushed.token.toString(), token) &&
				pushed.amount === amount
			);
		});
		if (!credit)
			return newFailure(502, "Ship receipt missing exact virtual token credit");
	}
	return newSuccess({
		hash: sent.data.transactionHash,
		strategyHash: normalize(event.strategyHash.toString()),
		maker: plan.maker,
		app: plan.app,
		gasEstimate: simulated.data.gasEstimate,
	});
}

/**
 * Docks the position: requires on-chain virtual backing, sends dock covering
 * both tokens, simulates before broadcast and verifies the Docked event.
 */
export async function dockAquaPosition(
	evm: Evm,
	plan: {
		registry: Address;
		app: Address;
		maker: Address;
		strategyHash: Hex;
		tokenIn: Address;
		tokenOut: Address;
	},
): PResult<{ hash: Hash; strategyHash: Hex; gasEstimate: bigint }> {
	if (
		!sameAddress(evm.address, plan.maker) ||
		sameAddress(plan.tokenIn, plan.tokenOut)
	)
		return newFailure(
			400,
			"Dock must use the maker wallet and distinct tokens",
		);
	if (
		evm.config.chainId === 8453 &&
		(!sameAddress(plan.registry, resolveAquaRegistryAddress(8453) ?? "") ||
			!sameAddress(plan.app, resolveSwapVmAddress(8453) ?? ""))
	)
		return newFailure(400, "Unexpected live Aqua deployment");
	const state = await inspectAquaPosition(evm.client, {
		registry: plan.registry,
		app: plan.app,
		maker: plan.maker,
		strategyHash: plan.strategyHash,
		tokenIn: plan.tokenIn,
		tokenOut: plan.tokenOut,
	});
	if (!state.active)
		return newFailure(
			400,
			"Position has no virtual backing on-chain; nothing to dock",
		);
	const aqua = new AquaProtocolContract(new SdkAddress(plan.registry));
	const tx = aqua.dock({
		app: new SdkAddress(plan.app),
		strategyHash: new SdkHexString(plan.strategyHash),
		tokens: [new SdkAddress(plan.tokenIn), new SdkAddress(plan.tokenOut)],
	});
	const simulated = await simulateBeforeBroadcast(evm, tx);
	if (!simulated.ok) return simulated;
	const sent = await evm.send({
		to: tx.to as Address,
		data: tx.data as Hex,
		value: tx.value,
	});
	if (!sent.ok) return sent;
	const event = sent.data.logs.find(
		(log) =>
			sameAddress(log.address, plan.registry) &&
			log.topics[0]?.toLowerCase() ===
				DockedEvent.TOPIC.toString().toLowerCase(),
	);
	if (!event)
		return newFailure(502, "Dock receipt has no Docked event for the registry");
	const docked = DockedEvent.fromLog({
		data: event.data,
		topics: event.topics as [Hex, ...Hex[]],
	});
	if (
		!sameAddress(docked.strategyHash.toString(), plan.strategyHash) ||
		!sameAddress(docked.maker.toString(), plan.maker) ||
		!sameAddress(docked.app.toString(), plan.app)
	)
		return newFailure(502, "Docked event does not match the docked position");
	return newSuccess({
		hash: sent.data.transactionHash,
		strategyHash: plan.strategyHash,
		gasEstimate: simulated.data.gasEstimate,
	});
}

/**
 * Builds the canonical concentrated position and ships it from the maker;
 * the returned manifest fills `config.aqua`. Pass a maker-keyed Evm.
 */
export async function buildAndShipPosition(args: {
	config: SolverConfig;
	/** Evm bound to the maker key (AQUA_MAKER_PRIVATE_KEY in authorized flows). */
	makerEvm: Evm;
	registry: Address;
	app: Address;
	amounts: { tokenIn: bigint; tokenOut: bigint };
	salt?: bigint;
}): PResult<{ manifest: AquaPositionManifest; hash: Hash }> {
	const { config } = args;
	const position = buildAquaPosition({
		maker: args.makerEvm.address,
		tokenIn: config.tokenIn.address,
		tokenOut: config.tokenOut.address,
		tokenInDecimals: config.tokenIn.decimals,
		tokenOutDecimals: config.tokenOut.decimals,
		salt: args.salt,
	});
	const manifest = manifestFromPosition(position, {
		chainId: config.chainId,
		registry: args.registry,
		app: args.app,
		tokenIn: config.tokenIn,
		tokenOut: config.tokenOut,
		amounts: args.amounts,
	});
	const shipped = await shipAquaPosition(args.makerEvm, {
		registry: args.registry,
		app: args.app,
		maker: args.makerEvm.address,
		strategy: manifest.strategy,
		strategyHash: manifest.strategyHash,
		tokenIn: manifest.tokenIn.address,
		tokenOut: manifest.tokenOut.address,
		amounts: args.amounts,
	});
	if (!shipped.ok) return shipped;
	return newSuccess({ manifest, hash: shipped.data.hash });
}
