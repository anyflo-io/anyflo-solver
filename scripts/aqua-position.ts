import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import {
	createPublicClient,
	http,
	isAddress,
	type Address,
	type Chain,
	type Hex,
	type PublicClient,
} from "viem";
import { base, foundry } from "viem/chains";

import {
	AquaPositionManifestSchema,
	buildAquaPosition,
	checkAquaBacking,
	describeAquaStrategy,
	dockAquaPosition,
	inspectAquaPosition,
	manifestFromPosition,
	positionFromManifest,
	type AquaPositionManifest,
	resolveAquaRegistryAddress,
	resolveSwapVmAddress,
	shipAquaPosition,
	type AquaShipPlan,
} from "../src/aqua-position";
import { loadConfig, ConfigSchema, type SolverConfig } from "../src/config";
import { Evm } from "../src/evm";

/**
 * Aqua position CLI: build / inspect / ship / dock for the permissionless
 * concentrated 0.99..1.01 / 5 bps / 30 s decay / uint64 salt position.
 * Read-only by default; --execute requires AQUA_MAKER_PRIVATE_KEY, matching
 * manifest/chain/pair, maker ownership and successful simulation.
 */

interface Cli {
	command: string;
	configPath: string;
	manifestPath?: string;
	out?: string;
	registry?: Address;
	app?: Address;
	maker?: Address;
	salt?: bigint;
	priceLower?: string;
	priceUpper?: string;
	feeBps?: number;
	decaySeconds?: bigint;
	amountIn?: bigint;
	amountOut?: bigint;
	execute: boolean;
}

const HELP = `Aqua position CLI: build / inspect / ship / dock for the permissionless concentrated
0.99..1.01 / 5 bps / 30 s decay / uint64 salt strategy.

  bun scripts/aqua-position.ts build  --config <cfg> [--registry <aqua>] [--app <swapvm>] [--maker <addr>]
                                      [--salt <uint64>] [--price-lower 0.99] [--price-upper 1.01]
                                      [--fee-bps 5] [--decay-seconds 30] [--amount-in <u>] [--amount-out <u>]
                                      [--out <manifest.json>]
  bun scripts/aqua-position.ts inspect --config <cfg> [--manifest <path>] [--registry <aqua>]
  bun scripts/aqua-position.ts ship   --config <cfg> [--manifest <path>] [--amount-in <u>] [--amount-out <u>] [--execute]
  bun scripts/aqua-position.ts dock   --config <cfg> [--manifest <path>] [--execute]

Read-only by default; --execute writes on 31337 or 8453 require AQUA_MAKER_PRIVATE_KEY and matching maker ownership.`;

function fail(message: string): never {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

function parseCli(): Cli {
	const { values, positionals } = parseArgs({
		args: Bun.argv.slice(2),
		allowPositionals: true,
		options: {
			config: { type: "string", default: "private/solver.config.json" },
			manifest: { type: "string" },
			out: { type: "string" },
			registry: { type: "string" },
			app: { type: "string" },
			maker: { type: "string" },
			salt: { type: "string" },
			"price-lower": { type: "string" },
			"price-upper": { type: "string" },
			"fee-bps": { type: "string" },
			"decay-seconds": { type: "string" },
			"amount-in": { type: "string" },
			"amount-out": { type: "string" },
			execute: { type: "boolean", default: false },
			help: { type: "boolean", default: false },
		},
	});
	if (values.help) {
		process.stdout.write(`${HELP}\n`);
		process.exit(0);
	}
	const command = positionals[0];
	if (
		!command ||
		!["build", "inspect", "ship", "dock"].includes(command) ||
		command.startsWith("-")
	)
		fail(
			"Usage: bun scripts/aqua-position.ts <build|inspect|ship|dock> --config <cfg> [--help]",
		);
	const address = (
		value: string | undefined,
		label: string,
	): Address | undefined => {
		if (!value) return undefined;
		if (!isAddress(value)) fail(`${label} must be a valid EVM address`);
		return value.toLowerCase() as Address;
	};
	const positiveBigInt = (
		value: string | undefined,
		label: string,
	): bigint | undefined => {
		if (!value) return undefined;
		if (!/^[0-9]+$/.test(value))
			fail(`${label} must be a non-negative integer`);
		return BigInt(value);
	};
	return {
		command,
		configPath: values.config!,
		manifestPath: values.manifest,
		out: values.out,
		registry: address(values.registry, "--registry"),
		app: address(values.app, "--app"),
		maker: address(values.maker, "--maker"),
		salt: positiveBigInt(values.salt, "--salt"),
		priceLower: values["price-lower"],
		priceUpper: values["price-upper"],
		feeBps:
			values["fee-bps"] === undefined ? undefined : Number(values["fee-bps"]),
		decaySeconds: positiveBigInt(values["decay-seconds"], "--decay-seconds"),
		amountIn: positiveBigInt(values["amount-in"], "--amount-in"),
		amountOut: positiveBigInt(values["amount-out"], "--amount-out"),
		execute: values.execute!,
	};
}

function printJson(label: string, value: unknown): void {
	process.stdout.write(
		`${label}\n${JSON.stringify(value, (_, v) => (typeof v === "bigint" ? `${v}` : v), 2)}\n`,
	);
}

function readClient(config: SolverConfig): PublicClient {
	const chain: Chain = config.chainId === 8453 ? base : foundry;
	return createPublicClient({
		chain,
		transport: http(config.rpcUrl, { retryCount: 0 }),
	});
}

function loadManifest(
	path: string | undefined,
	config: SolverConfig,
	cli: Cli,
): AquaPositionManifest {
	if (path) {
		const parsed = AquaPositionManifestSchema.safeParse(
			JSON.parse(readFileSync(path, "utf8")),
		);
		if (!parsed.success)
			fail(
				`Invalid aqua position manifest: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
			);
		if (
			parsed.data.chainId !== config.chainId ||
			parsed.data.tokenIn.address !== config.tokenIn.address.toLowerCase() ||
			parsed.data.tokenOut.address !== config.tokenOut.address.toLowerCase() ||
			parsed.data.tokenIn.decimals !== config.tokenIn.decimals ||
			parsed.data.tokenOut.decimals !== config.tokenOut.decimals
		)
			fail("Manifest chain/pair/decimals do not match configuration");
		positionFromManifest(parsed.data);
		return parsed.data;
	}
	const aqua = config.aqua;
	if (!aqua)
		fail(
			"No --manifest given and the solver config has no aqua position; run `build` first",
		);
	const registry = cli.registry ?? resolveAquaRegistryAddress(config.chainId);
	if (!registry)
		fail(
			"No --manifest given: the Aqua registry address must come from --registry on this chain",
		);
	const amounts = {
		tokenIn: cli.amountIn ?? 0n,
		tokenOut: cli.amountOut ?? 0n,
	};
	return {
		schema: "anyflo.aqua-position/1",
		chainId: config.chainId === 31337 ? 31337 : 8453,
		registry,
		app: aqua.app,
		maker: aqua.maker,
		tokenIn: {
			address: config.tokenIn.address,
			decimals: config.tokenIn.decimals,
			symbol: config.tokenIn.symbol,
		},
		tokenOut: {
			address: config.tokenOut.address,
			decimals: config.tokenOut.decimals,
			symbol: config.tokenOut.symbol,
		},
		priceLower: cli.priceLower ?? "0.99",
		priceUpper: cli.priceUpper ?? "1.01",
		feeBps: cli.feeBps ?? 5,
		decaySeconds: Number(cli.decaySeconds ?? 30n),
		salt: "0",
		amounts: {
			tokenIn: amounts.tokenIn.toString(),
			tokenOut: amounts.tokenOut.toString(),
		},
		strategy: aqua.strategyBytes,
		strategyHash: aqua.strategyHash,
	};
}

function shipPlanFrom(manifest: AquaPositionManifest, cli: Cli): AquaShipPlan {
	const amounts = {
		tokenIn: cli.amountIn ?? BigInt(manifest.amounts.tokenIn),
		tokenOut: cli.amountOut ?? BigInt(manifest.amounts.tokenOut),
	};
	if (amounts.tokenIn <= 0n || amounts.tokenOut <= 0n)
		fail(
			"Ship needs positive backing amounts: pass --amount-in/--amount-out or a manifest with amounts",
		);
	return {
		registry: manifest.registry,
		app: manifest.app,
		maker: manifest.maker,
		strategy: manifest.strategy,
		strategyHash: manifest.strategyHash,
		tokenIn: manifest.tokenIn.address,
		tokenOut: manifest.tokenOut.address,
		amounts,
	};
}

function requireMakerKey(): Hex {
	const key = process.env.AQUA_MAKER_PRIVATE_KEY;
	if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key))
		fail(
			"AQUA_MAKER_PRIVATE_KEY must be set to a 32-byte hex private key for --execute",
		);
	return key as Hex;
}

async function runBuild(config: SolverConfig, cli: Cli): Promise<void> {
	const maker = cli.maker ?? config.aqua?.maker;
	if (!maker)
		fail("Build needs a maker: pass --maker or configure config.aqua.maker");
	const app = cli.app ?? config.aqua?.app;
	if (!app)
		fail(
			"Build needs the SwapVM app address: pass --app or configure config.aqua.app",
		);
	const registry = cli.registry ?? resolveAquaRegistryAddress(config.chainId);
	if (!registry)
		fail(
			`Build needs the Aqua registry address: pass --registry (no official deployment for chain ${config.chainId})`,
		);
	const position = buildAquaPosition({
		maker,
		tokenIn: config.tokenIn.address,
		tokenOut: config.tokenOut.address,
		tokenInDecimals: config.tokenIn.decimals,
		tokenOutDecimals: config.tokenOut.decimals,
		priceLower: cli.priceLower,
		priceUpper: cli.priceUpper,
		feeBps: cli.feeBps,
		decaySeconds: cli.decaySeconds,
		salt: cli.salt,
	});
	const manifest = manifestFromPosition(position, {
		chainId: config.chainId,
		registry,
		app,
		tokenIn: config.tokenIn,
		tokenOut: config.tokenOut,
		amounts: { tokenIn: cli.amountIn ?? 0n, tokenOut: cli.amountOut ?? 0n },
	});
	printJson("Aqua position built (no on-chain writes):", {
		strategyHash: manifest.strategyHash,
		salt: manifest.salt,
		priceRange: `${manifest.priceLower}..${manifest.priceUpper} ${manifest.tokenOut.symbol} per ${manifest.tokenIn.symbol}`,
		feeBps: manifest.feeBps,
		decaySeconds: manifest.decaySeconds,
		instructionKinds: position.instructionKinds,
		sqrtPriceMin: position.sqrtPriceMin,
		sqrtPriceMax: position.sqrtPriceMax,
		permissionless: {
			useAquaInsteadOfSignature: position.useAquaInsteadOfSignature,
			shouldUnwrap: position.shouldUnwrap,
			allowZeroAmountIn: position.allowZeroAmountIn,
			customReceiver: position.customReceiver,
			hasHooks: position.hasHooks,
		},
	});
	if (cli.out) {
		await Bun.write(cli.out, `${JSON.stringify(manifest, null, 2)}\n`);
		process.stdout.write(`Manifest written to ${cli.out}\n`);
	} else {
		printJson("Manifest (ship/dock/inspect input):", manifest);
	}
}

async function runInspect(config: SolverConfig, cli: Cli): Promise<void> {
	const manifest = loadManifest(cli.manifestPath, config, cli);
	const state = await inspectAquaPosition(readClient(config), {
		registry: manifest.registry,
		app: manifest.app,
		maker: manifest.maker,
		strategyHash: manifest.strategyHash,
		tokenIn: manifest.tokenIn.address,
		tokenOut: manifest.tokenOut.address,
	});
	const backing = await checkAquaBacking(readClient(config), {
		maker: manifest.maker,
		registry: manifest.registry,
		tokenIn: manifest.tokenIn.address,
		tokenOut: manifest.tokenOut.address,
		amounts: {
			tokenIn: BigInt(manifest.amounts.tokenIn),
			tokenOut: BigInt(manifest.amounts.tokenOut),
		},
	});
	printJson("Aqua position inspection (read-only):", {
		...state,
		amounts: manifest.amounts,
		backingSufficient: backing.sufficient,
		backingProblems: backing.problems,
		approvalsNeeded: backing.approvalsNeeded,
	});
}

async function runShip(config: SolverConfig, cli: Cli): Promise<void> {
	const manifest = loadManifest(cli.manifestPath, config, cli);
	const plan = shipPlanFrom(manifest, cli);
	const description = describeAquaStrategy(plan.strategy, plan.maker);
	const client = readClient(config);
	const backing = await checkAquaBacking(client, {
		maker: plan.maker,
		registry: plan.registry,
		tokenIn: plan.tokenIn,
		tokenOut: plan.tokenOut,
		amounts: plan.amounts,
	});
	printJson(
		cli.execute
			? "Shipping position..."
			: "Ship plan (read-only; add --execute to write):",
		{
			to: plan.registry,
			function:
				"ship(address app, bytes strategy, address[] tokens, uint256[] amounts)",
			app: plan.app,
			strategyHash: plan.strategyHash,
			instructionKinds: description.instructionKinds,
			amounts: plan.amounts,
			makerBalances: {
				[manifest.tokenIn.symbol]: backing.walletIn,
				[manifest.tokenOut.symbol]: backing.walletOut,
			},
			makerAllowancesToRegistry: {
				[manifest.tokenIn.symbol]: backing.allowanceIn,
				[manifest.tokenOut.symbol]: backing.allowanceOut,
			},
			approvalsNeeded: backing.approvalsNeeded.map(
				(a) => `${a} -> ${plan.registry}`,
			),
			backingProblems: backing.problems,
		},
	);
	if (!cli.execute) return;
	if (backing.problems.length)
		fail(`Cannot ship: ${backing.problems.join("; ")}`);
	const makerEvm = new Evm(config, requireMakerKey());
	if (makerEvm.address.toLowerCase() !== plan.maker.toLowerCase())
		fail("AQUA_MAKER_PRIVATE_KEY does not control the plan maker address");
	const shipped = await shipAquaPosition(makerEvm, plan);
	if (!shipped.ok)
		fail(
			`Ship failed: ${typeof shipped.error === "string" ? shipped.error : JSON.stringify(shipped.error)}`,
		);
	printJson(
		`Position shipped (chain ${config.chainId}; simulated before broadcast):`,
		shipped.data,
	);
}

async function runDock(config: SolverConfig, cli: Cli): Promise<void> {
	const manifest = loadManifest(cli.manifestPath, config, cli);
	const plan = {
		registry: manifest.registry,
		app: manifest.app,
		maker: manifest.maker,
		strategyHash: manifest.strategyHash,
		tokenIn: manifest.tokenIn.address,
		tokenOut: manifest.tokenOut.address,
	};
	const state = await inspectAquaPosition(readClient(config), plan);
	printJson(
		cli.execute
			? "Docking position..."
			: "Dock plan (read-only; add --execute to write):",
		{
			to: plan.registry,
			function: "dock(address app, bytes32 strategyHash, address[] tokens)",
			...state,
		},
	);
	if (!cli.execute) return;
	if (!state.active)
		fail("Cannot dock: position has no virtual backing on-chain");
	const makerEvm = new Evm(config, requireMakerKey());
	if (makerEvm.address.toLowerCase() !== plan.maker.toLowerCase())
		fail("AQUA_MAKER_PRIVATE_KEY does not control the plan maker address");
	const docked = await dockAquaPosition(makerEvm, plan);
	if (!docked.ok)
		fail(
			`Dock failed: ${typeof docked.error === "string" ? docked.error : JSON.stringify(docked.error)}`,
		);
	printJson(
		`Position docked (chain ${config.chainId}; simulated before broadcast):`,
		docked.data,
	);
}

/**
 * A first-position build precedes config.aqua, which loadConfig otherwise
 * requires for Aqua strategy configs; validate the rest with a placeholder
 * strategy and let the produced manifest fill config.aqua.
 */
async function loadCliConfig(cli: Cli): Promise<SolverConfig> {
	const raw = JSON.parse(readFileSync(cli.configPath, "utf8")) as Record<
		string,
		unknown
	>;
	if (cli.command === "build" && raw.strategy === "Aqua" && !raw.aqua) {
		const parsed = ConfigSchema.safeParse({ ...raw, strategy: "Uniswap" });
		if (parsed.success) {
			process.stdout.write(
				"First-position build: validated without config.aqua; write the manifest into the solver config.\n",
			);
			return parsed.data;
		}
	}
	return loadConfig(cli.configPath);
}

async function main(): Promise<void> {
	const cli = parseCli();
	const config = await loadCliConfig(cli);
	if (cli.command === "build") return runBuild(config, cli);
	const client = readClient(config);
	const chainId = await client.getChainId();
	if (chainId !== config.chainId)
		fail(
			`Configured RPC serves chain ${chainId}, config expects ${config.chainId}`,
		);
	const swapVm = resolveSwapVmAddress(
		config.chainId,
		cli.app ?? config.aqua?.app,
	);
	if (config.chainId === 31337 && swapVm) {
		const code = await client.getCode({ address: swapVm });
		if (!code || code === "0x") fail(`No deployed SwapVM router at ${swapVm}`);
	}
	switch (cli.command) {
		case "inspect":
			return runInspect(config, cli);
		case "ship":
			return runShip(config, cli);
		case "dock":
			return runDock(config, cli);
	}
}

if (import.meta.main) {
	main().catch(() =>
		fail(
			"Aqua position command failed; inspect configuration and reconcile any pending maker transaction",
		),
	);
}
