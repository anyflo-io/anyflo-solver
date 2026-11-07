// Anyflo solver demo fixture: deploys the real local chain stack on a fresh Anvil (chainId 31337).
//
// Real official contracts: Uniswap V3 core/periphery from published npm artifacts (@uniswap/v3-core
// 1.0.0, @uniswap/v3-periphery 1.4.4 — old-solc graphs are never compiled here), Permit2 built from
// the pinned upstream commit in an isolated solc 0.8.17 graph, UniversalRouter built from the pinned
// upstream commit (minHopPriceX36 exact-in layout, "2.1.2" deployment layout) in an isolated solc
// 0.8.26 graph, and the real 1inch Aqua registry (Aqua 1.0.1) + SwapVM v1.0.2 AquaSwapVMRouter
// compiled in this fixture's solc 0.8.30 via-IR graph (settings copied from upstream swap-vm).
//
// Fixture-owned doubles (clearly labeled, NOT production proof): DemoToken (two 6-dec test tokens),
// AnyfloDeposit / AnyfloDelivery settlement doubles with exact solver-verified events, real ERC20
// transfers, direct deposit and protocol-fee separation. WETH is the constructor-initialized
// official Solmate implementation from the router's pinned recursive dependency graph.
//
// Account policy: deterministic Anvil well-known keys — 0 deployer (fee recipient), 1 maker LP,
// 2 solver (gas-only, ZERO initial tokens; input arrives via customer direct deposit), 3 customer.
// deployFixture refuses non-loopback RPCs, wrong chain ids and non-fresh chains. Demo-local only:
// never point it at a public chain.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	BaseError,
	createPublicClient,
	createWalletClient,
	erc20Abi,
	http,
	keccak256,
	parseEventLogs,
	type Abi,
	type Address,
	type Hash,
	type Hex,
	type HttpTransport,
	type PublicClient,
	type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { foundry } from "viem/chains";

import type { SolverConfig } from "../src/config";
import { Evm, settlementAbi } from "../src/evm";
import { buildAndShipPosition } from "../src/aqua-position";

// ---------------------------------------------------------------------------
// Pins and constants
// ---------------------------------------------------------------------------

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const foundryDir = join(repoRoot, "foundry");
const foundryOut = join(foundryDir, "out");
const vendorDir = join(foundryDir, "vendor");

/** Deterministic Anvil dev accounts (mnemonic "test test … junk"), index = account number. */
const ANVIL_PRIVATE_KEYS = [
	"0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // 0 deployer
	"0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // 1 maker
	"0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // 2 solver
	"0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // 3 customer
] as const;

const DEMO_TOKEN_ABI = [
	{
		type: "function",
		name: "mint",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "to", type: "address" },
			{ name: "amount", type: "uint256" },
		],
		outputs: [],
	},
] as const;

const V3_NPM_ABI = [
	{
		type: "function",
		name: "createAndInitializePoolIfNecessary",
		stateMutability: "payable",
		inputs: [
			{ name: "token0", type: "address" },
			{ name: "token1", type: "address" },
			{ name: "fee", type: "uint24" },
			{ name: "sqrtPriceX96", type: "uint160" },
		],
		outputs: [{ name: "pool", type: "address" }],
	},
	{
		type: "function",
		name: "mint",
		stateMutability: "payable",
		inputs: [
			{
				name: "params",
				type: "tuple",
				components: [
					{ name: "token0", type: "address" },
					{ name: "token1", type: "address" },
					{ name: "fee", type: "uint24" },
					{ name: "tickLower", type: "int24" },
					{ name: "tickUpper", type: "int24" },
					{ name: "amount0Desired", type: "uint256" },
					{ name: "amount1Desired", type: "uint256" },
					{ name: "amount0Min", type: "uint256" },
					{ name: "amount1Min", type: "uint256" },
					{ name: "recipient", type: "address" },
					{ name: "deadline", type: "uint256" },
				],
			},
		],
		outputs: [
			{ name: "tokenId", type: "uint256" },
			{ name: "liquidity", type: "uint128" },
			{ name: "amount0", type: "uint256" },
			{ name: "amount1", type: "uint256" },
		],
	},
	{
		type: "event",
		name: "IncreaseLiquidity",
		inputs: [
			{ name: "tokenId", type: "uint256", indexed: true },
			{ name: "liquidity", type: "uint128", indexed: false },
			{ name: "amount0", type: "uint256", indexed: false },
			{ name: "amount1", type: "uint256", indexed: false },
		],
	},
] as const;

const AQUA_RAW_BALANCES_ABI = [
	{
		type: "function",
		name: "rawBalances",
		stateMutability: "view",
		inputs: [
			{ type: "address" },
			{ type: "address" },
			{ type: "bytes32" },
			{ type: "address" },
		],
		outputs: [
			{ name: "balance", type: "uint248" },
			{ name: "tokensCount", type: "uint8" },
		],
	},
] as const;

/** Demo sizes (base units, 6 decimals). Trade size agreed with the Uniswap adapter: 100 tokens. */
const CUSTOMER_BALANCE = 1_000_000_000000n;
const MAKER_BALANCE = 300_000_000000n;
const V3_LP_SEED = 100_000_000000n;
const AQUA_POSITION_SEED = 100_000_000000n;
const TRADE_SIZE = 100_000000n;
const POOL_FEE = 500;
const FIXED_SALT = 20261107n; // reproducible uint64 salt for the shipped Aqua position

// ---------------------------------------------------------------------------
// Fixture types
// ---------------------------------------------------------------------------

export interface DemoAccount {
	label: "deployer" | "maker" | "solver" | "customer";
	index: number;
	address: Address;
	/** Demo-local Anvil well-known key. Never use outside chain 31337. */
	privateKey: Hex;
}

export interface DemoToken {
	address: Address;
	decimals: 6;
	symbol: string;
	name: string;
}

export interface DemoAquaPosition {
	aquaRouter: Address;
	swapVMRouter: Address;
	/** The app the position ships under — the real AquaSwapVMRouter deployment itself. */
	app: Address;
	maker: Address;
	strategyHash: Hex;
	strategyBytes: Hex;
	salt: string;
	priceLower: string;
	priceUpper: string;
	feeBps: number;
	decaySeconds: number;
	shipped: true;
	shipHash: Hash;
}

export interface DemoFixture {
	rpcUrl: string;
	chainId: 31337;
	tokenIn: DemoToken;
	tokenOut: DemoToken;
	depositAccount: Address;
	deliveryAccount: Address;
	universalRouter: Address;
	permit2: Address;
	weth9: Address;
	uniswapV3Factory: Address;
	uniswapV3Pool: Address;
	uniswapV3Npm: Address;
	uniswapV3Quoter: Address;
	/** The maker's real NPM LP position backing the demo pool. */
	uniswapV3MakerTokenId: bigint;
	aqua: DemoAquaPosition;
	customer: DemoAccount;
	maker: DemoAccount;
	solver: DemoAccount;
	deployer: DemoAccount;
	addresses: Record<string, Address>;
	/** Typed SolverConfig pre-wired to the fixture; caller overrides URLs/strategy as needed. */
	config(overrides?: Partial<SolverConfig>): SolverConfig;
}

// ---------------------------------------------------------------------------
// Artifact loading (forge `out` + hardhat `artifacts` formats)
// ---------------------------------------------------------------------------

interface ArtifactJson {
	abi: Abi;
	bytecode: { object?: string } | string;
	linkReferences?: Record<
		string,
		Record<string, readonly { start: number; length: number }[]>
	>;
}

function parseArtifactFile(path: string, contractName: string): ArtifactJson {
	let raw: ArtifactJson;
	try {
		raw = JSON.parse(readFileSync(path, "utf8")) as ArtifactJson;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			throw new Error(
				`Missing ${contractName} artifact at ${path}; run bun run demo:setup`,
				{ cause: error },
			);
		throw new Error(`Cannot read ${contractName} artifact at ${path}`, {
			cause: error,
		});
	}
	const bytecode =
		typeof raw.bytecode === "string" ? raw.bytecode : raw.bytecode?.object;
	if (
		!Array.isArray(raw.abi) ||
		typeof bytecode !== "string" ||
		bytecode.length < 4
	) {
		throw new Error(`Invalid artifact for ${contractName} at ${path}`);
	}
	return raw;
}

/** Forge graph artifact (fixture contracts, Aqua, SwapVM): foundry/out/**\/<Name>.sol/<Name>.json. */
function loadForgeArtifact(contractName: string): ArtifactJson {
	return parseArtifactFile(
		join(foundryOut, `${contractName}.sol`, `${contractName}.json`),
		contractName,
	);
}

/** Forge artifact from an isolated vendored graph root (Permit2 solc 0.8.17, UniversalRouter solc 0.8.26). */
function loadIsolatedArtifact(
	graph: "permit2" | "universal-router",
	contractName: string,
): ArtifactJson {
	return parseArtifactFile(
		join(
			vendorDir,
			graph,
			"out",
			`${contractName}.sol`,
			`${contractName}.json`,
		),
		contractName,
	);
}

/** Published hardhat artifact from vendored npm packages (Uniswap V3 old-solc graphs — bytecode only). */
function loadVendorArtifact(
	pkg: "v3-core" | "v3-periphery",
	contractPath: string,
): ArtifactJson {
	const path = join(
		vendorDir,
		"uniswap",
		pkg,
		"artifacts",
		"contracts",
		contractPath,
	);
	return parseArtifactFile(
		path,
		path
			.split("/")
			.pop()!
			.replace(/\.json$/, ""),
	);
}

function bytecodeOf(artifact: ArtifactJson): Hex {
	return (
		typeof artifact.bytecode === "string"
			? artifact.bytecode
			: artifact.bytecode.object!
	) as Hex;
}

/** Patches hardhat link placeholders (20-byte slots listed in linkReferences) with deployed addresses. */
function linkBytecode(
	artifact: ArtifactJson,
	libraries: Record<string, Address>,
): Hex {
	const refs = artifact.linkReferences ?? {};
	const needed = Object.entries(refs).flatMap(([file, libs]) =>
		Object.keys(libs).map((name) => `${file}:${name}`),
	);
	const known = Object.keys(libraries);
	const missing = needed.filter((n) => !known.some((k) => n.endsWith(k)));
	if (missing.length > 0)
		throw new Error(`Unlinked libraries in artifact: ${missing.join(", ")}`);
	let code = bytecodeOf(artifact);
	for (const libs of Object.values(refs)) {
		for (const [name, positions] of Object.entries(libs)) {
			const lib = Object.entries(libraries).find(([k]) =>
				name.endsWith(k),
			)?.[1];
			for (const { start } of positions) {
				const at = 2 + start * 2; // skip 0x prefix
				code = (code.slice(0, at) +
					lib!.slice(2).toLowerCase() +
					code.slice(at + 40)) as Hex;
			}
		}
	}
	return code as Hex;
}

// ---------------------------------------------------------------------------
// Chain helpers
// ---------------------------------------------------------------------------

interface Clients {
	public: PublicClient<HttpTransport, typeof foundry>;
	byAccount: (
		account: PrivateKeyAccount,
	) => WalletClient<HttpTransport, typeof foundry, PrivateKeyAccount>;
}

function makeClients(rpcUrl: string): Clients {
	const pub = createPublicClient({
		chain: foundry,
		transport: http(rpcUrl, { retryCount: 0 }),
	});
	const byAccount = (account: PrivateKeyAccount) =>
		createWalletClient({
			account,
			chain: foundry,
			transport: http(rpcUrl, { retryCount: 0 }),
		});
	return { public: pub, byAccount };
}

async function deployContract(
	name: string,
	wallet: WalletClient<HttpTransport, typeof foundry, PrivateKeyAccount>,
	pub: PublicClient,
	artifact: { abi: Abi; bytecode: Hex },
	args: readonly unknown[] = [],
): Promise<Address> {
	const constructor = artifact.abi.find((item) => item.type === "constructor");
	const expectedArgs = constructor?.inputs.length ?? 0;
	if (args.length !== expectedArgs)
		throw new Error(
			`${name}: constructor requires ${expectedArgs} arguments, received ${args.length}`,
		);
	try {
		const hash = await wallet.deployContract({
			abi: artifact.abi,
			bytecode: artifact.bytecode,
			args: args as never,
			account: wallet.account,
			chain: foundry,
		});
		const receipt = await pub.waitForTransactionReceipt({
			hash,
			timeout: 30_000,
		});
		if (receipt.status !== "success" || !receipt.contractAddress)
			throw new Error(`deployment receipt failed: ${hash}`);
		return receipt.contractAddress;
	} catch (error) {
		throw new Error(
			`${name} deployment failed: ${error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}

const anvilAccount = (
	index: number,
	label: DemoAccount["label"],
): DemoAccount => {
	const privateKey = ANVIL_PRIVATE_KEYS[index] as Hex;
	return {
		label,
		index,
		address: privateKeyToAccount(privateKey).address,
		privateKey,
	};
};

async function requireLocalChain(
	rpcUrl: string,
	pub: PublicClient,
): Promise<void> {
	let host: string;
	try {
		host = new URL(rpcUrl).hostname;
	} catch {
		throw new Error(`demo fixture: invalid rpcUrl ${rpcUrl}`);
	}
	if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
		throw new Error(
			`demo fixture refuses non-loopback rpcUrl (${host}); this fixture is for local Anvil only`,
		);
	}
	const chainId = await pub.getChainId();
	if (chainId !== 31337)
		throw new Error(
			`demo fixture requires chainId 31337, node reports ${chainId}`,
		);
	const height = await pub.getBlockNumber();
	if (height > 0n)
		throw new Error(
			`demo fixture requires a fresh chain (height ${height} > 0); restart Anvil`,
		);
}

// ---------------------------------------------------------------------------
// deployFixture
// ---------------------------------------------------------------------------

/**
 * Deploys the complete demo stack on a fresh, already-running local Anvil (rpcUrl).
 * Post-conditions: pool created + seeded by a real maker NPM LP position, Aqua position shipped
 * with virtual maker backing, customer funded, deposit double pre-approved for the customer,
 * and the solver holding ZERO tokens and no preinstalled approvals (gas-only).
 */
export async function deployFixture(rpcUrl: string): Promise<DemoFixture> {
	const { public: pub, byAccount } = makeClients(rpcUrl);
	await requireLocalChain(rpcUrl, pub);

	const deployerAcct = anvilAccount(0, "deployer");
	const makerAcct = anvilAccount(1, "maker");
	const solverAcct = anvilAccount(2, "solver");
	const customerAcct = anvilAccount(3, "customer");
	const deployer = byAccount(privateKeyToAccount(deployerAcct.privateKey));
	const maker = byAccount(privateKeyToAccount(makerAcct.privateKey));

	// --- fixture-owned test tokens (6 decimals) ---
	const tokenArtifact = loadForgeArtifact("DemoToken");
	const deployToken = async (name: string, symbol: string): Promise<Address> =>
		deployContract(
			`DemoToken(${symbol})`,
			deployer,
			pub,
			{ abi: tokenArtifact.abi, bytecode: bytecodeOf(tokenArtifact) },
			[name, symbol, deployerAcct.address],
		);
	const tokenInAddress = await deployToken("Demo USD Token In", "DUSI");
	const tokenOutAddress = await deployToken("Demo USD Token Out", "DUSO");
	const tokenIn: DemoToken = {
		address: tokenInAddress,
		decimals: 6,
		symbol: "DUSI",
		name: "Demo USD Token In",
	};
	const tokenOut: DemoToken = {
		address: tokenOutAddress,
		decimals: 6,
		symbol: "DUSO",
		name: "Demo USD Token Out",
	};

	// --- official Solmate WETH, deployed with its real ERC20 initialization constructor ---
	const wethArtifact = loadForgeArtifact("WETH");
	const weth9 = await deployContract("WETH", deployer, pub, {
		abi: wethArtifact.abi,
		bytecode: bytecodeOf(wethArtifact),
	});

	// --- official Uniswap V3 (published artifacts, no compilation of old-solc graphs) ---
	const factoryArtifact = loadVendorArtifact(
		"v3-core",
		"UniswapV3Factory.sol/UniswapV3Factory.json",
	);
	const v3Factory = await deployContract("UniswapV3Factory", deployer, pub, {
		abi: factoryArtifact.abi,
		bytecode: bytecodeOf(factoryArtifact),
	});
	const nftDescriptorArtifact = loadVendorArtifact(
		"v3-periphery",
		"libraries/NFTDescriptor.sol/NFTDescriptor.json",
	);
	const nftDescriptor = await deployContract("NFTDescriptor", deployer, pub, {
		abi: nftDescriptorArtifact.abi,
		bytecode: bytecodeOf(nftDescriptorArtifact),
	});
	const descriptorArtifact = loadVendorArtifact(
		"v3-periphery",
		"NonfungibleTokenPositionDescriptor.sol/NonfungibleTokenPositionDescriptor.json",
	);
	const descriptor = await deployContract(
		"NonfungibleTokenPositionDescriptor",
		deployer,
		pub,
		{
			abi: descriptorArtifact.abi,
			bytecode: linkBytecode(descriptorArtifact, {
				NFTDescriptor: nftDescriptor,
			}),
		},
		[
			weth9,
			`0x${Buffer.from("ETH", "utf8").toString("hex").padStart(64, "0")}`,
		],
	);
	const npmArtifact = loadVendorArtifact(
		"v3-periphery",
		"NonfungiblePositionManager.sol/NonfungiblePositionManager.json",
	);
	const npm = await deployContract(
		"NonfungiblePositionManager",
		deployer,
		pub,
		{ abi: npmArtifact.abi, bytecode: bytecodeOf(npmArtifact) },
		[v3Factory, weth9, descriptor],
	);
	const quoterArtifact = loadVendorArtifact(
		"v3-periphery",
		"lens/QuoterV2.sol/QuoterV2.json",
	);
	const uniswapV3Quoter = await deployContract(
		"QuoterV2",
		deployer,
		pub,
		{ abi: quoterArtifact.abi, bytecode: bytecodeOf(quoterArtifact) },
		[v3Factory, weth9],
	);

	// --- Permit2 (isolated solc 0.8.17 graph, pinned upstream commit) ---
	const permit2Artifact = loadIsolatedArtifact("permit2", "Permit2");
	const permit2 = await deployContract("Permit2", deployer, pub, {
		abi: permit2Artifact.abi,
		bytecode: bytecodeOf(permit2Artifact),
	});

	// --- UniversalRouter (isolated solc 0.8.26 graph, pinned upstream commit, 2.1.2 command layout) ---
	const urArtifact = loadIsolatedArtifact(
		"universal-router",
		"UniversalRouter",
	);
	const poolArtifact = loadVendorArtifact(
		"v3-core",
		"UniswapV3Pool.sol/UniswapV3Pool.json",
	);
	const poolInitCodeHash = keccak256(bytecodeOf(poolArtifact));
	const ctor = (
		urArtifact.abi as readonly {
			type: string;
			inputs?: readonly {
				name: string;
				components?: readonly { name: string }[];
			}[];
		}[]
	).find((x) => x.type === "constructor");
	const paramValues: Record<string, unknown> = {
		permit2,
		weth9,
		v2Factory: "0x0000000000000000000000000000000000000000",
		v3Factory,
		pairInitCodeHash:
			"0x0000000000000000000000000000000000000000000000000000000000000000",
		poolInitCodeHash,
		v4PoolManager: "0x0000000000000000000000000000000000000000",
		// No V4 routes or permissioned pools are deployed by this V3-only local fixture.
		permissionsAdapterFactory: "0x0000000000000000000000000000000000000000",
		v3NFTPositionManager: npm,
		v4PositionManager: "0x0000000000000000000000000000000000000000",
		spokePool: "0x0000000000000000000000000000000000000000",
	};
	const routerParams =
		ctor?.inputs?.[0]?.components?.map((c) => {
			const value = paramValues[c.name ?? ""];
			if (value === undefined)
				throw new Error(
					`UniversalRouter ctor field "${c.name}" unknown — vendored UR layout changed; update demo/chain.ts`,
				);
			return value;
		}) ?? [];
	const universalRouter = await deployContract(
		"UniversalRouter",
		deployer,
		pub,
		{ abi: urArtifact.abi, bytecode: bytecodeOf(urArtifact) },
		[routerParams],
	);

	// --- fixture-owned settlement doubles (Anyflo contract test doubles, NOT production proof) ---
	const depositArtifact = loadForgeArtifact("AnyfloDeposit");
	const depositAccount = await deployContract(
		"AnyfloDeposit",
		deployer,
		pub,
		{ abi: depositArtifact.abi, bytecode: bytecodeOf(depositArtifact) },
		[deployerAcct.address],
	);
	const deliveryArtifact = loadForgeArtifact("AnyfloDelivery");
	const deliveryAccount = await deployContract(
		"AnyfloDelivery",
		deployer,
		pub,
		{ abi: deliveryArtifact.abi, bytecode: bytecodeOf(deliveryArtifact) },
	);

	// --- real Aqua registry (1.0.1) + SwapVM v1.0.2 AquaSwapVMRouter (0.8.30 via-IR graph) ---
	const aquaRouterArtifact = loadForgeArtifact("AquaRouter");
	const aquaRouter = await deployContract(
		"AquaRouter",
		deployer,
		pub,
		{ abi: aquaRouterArtifact.abi, bytecode: bytecodeOf(aquaRouterArtifact) },
		[deployerAcct.address],
	);
	const swapVmRouterArtifact = loadForgeArtifact("AquaSwapVMRouter");
	const swapVMRouter = await deployContract(
		"AquaSwapVMRouter",
		deployer,
		pub,
		{
			abi: swapVmRouterArtifact.abi,
			bytecode: bytecodeOf(swapVmRouterArtifact),
		},
		[aquaRouter, weth9, deployerAcct.address, "AnyfloDemo", "1.0.0"],
	);

	// --- pool: official NPM creation path, 1:1 price, fee 500 ---
	const orderedTokens = [tokenInAddress, tokenOutAddress].sort((a, b) =>
		a.toLowerCase() < b.toLowerCase() ? -1 : 1,
	);
	const token0 = orderedTokens[0]!;
	const token1 = orderedTokens[1]!;
	const SQRT_1X1 = 79228162514264337593543950336n; // sqrt(1) * 2^96 — equal decimals, 1:1 price
	const poolHash = await maker.writeContract({
		address: npm,
		abi: V3_NPM_ABI,
		functionName: "createAndInitializePoolIfNecessary",
		args: [token0, token1, POOL_FEE, SQRT_1X1],
		account: maker.account,
		chain: foundry,
	});
	const poolReceipt = await pub.waitForTransactionReceipt({
		hash: poolHash,
		timeout: 30_000,
	});
	if (poolReceipt.status !== "success")
		throw new Error(`Pool creation reverted: ${poolHash}`);
	const uniswapV3Pool = decodePoolAddress(
		poolReceipt.logs,
		v3Factory,
		factoryArtifact.abi,
		token0,
		token1,
	);

	// --- funding: customer full, maker LP/position sized, solver intentionally ZERO tokens ---
	const mintTo = async (token: Address, to: Address, amount: bigint) => {
		const hash = await deployer.writeContract({
			address: token,
			abi: DEMO_TOKEN_ABI as Abi,
			functionName: "mint",
			args: [to, amount],
			account: deployer.account,
			chain: foundry,
		});
		const receipt = await pub.waitForTransactionReceipt({
			hash,
			timeout: 30_000,
		});
		if (receipt.status !== "success") throw new Error(`mint failed: ${hash}`);
	};
	await mintTo(tokenInAddress, customerAcct.address, CUSTOMER_BALANCE);
	await mintTo(tokenInAddress, makerAcct.address, MAKER_BALANCE);
	await mintTo(tokenOutAddress, makerAcct.address, MAKER_BALANCE);

	// customer pre-approves the deposit double (deposit is a real transferFrom at order time)
	await approve(
		pub,
		byAccount(privateKeyToAccount(customerAcct.privateKey)),
		tokenInAddress,
		customerAcct.address,
		depositAccount,
		TRADE_SIZE,
	);
	// maker pre-approves NPM so the LP mint pulls the seed from the maker wallet
	await approve(pub, maker, tokenInAddress, makerAcct.address, npm, V3_LP_SEED);
	await approve(
		pub,
		maker,
		tokenOutAddress,
		makerAcct.address,
		npm,
		V3_LP_SEED,
	);

	// --- maker LP: real NPM position (full range, fee 500) owned by the maker ---
	const mintHash = await maker.writeContract({
		address: npm,
		abi: V3_NPM_ABI,
		functionName: "mint",
		args: [
			{
				token0,
				token1,
				fee: POOL_FEE,
				tickLower: -887220,
				tickUpper: 887220,
				amount0Desired: V3_LP_SEED,
				amount1Desired: V3_LP_SEED,
				amount0Min: 0n,
				amount1Min: 0n,
				recipient: makerAcct.address,
				deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
			},
		],
		account: maker.account,
		chain: foundry,
	});
	const mintReceipt = await pub.waitForTransactionReceipt({
		hash: mintHash,
		timeout: 30_000,
	});
	if (mintReceipt.status !== "success")
		throw new Error(`LP mint reverted: ${mintHash}`);
	const uniswapV3MakerTokenId = decodeTokenId(mintReceipt.logs);
	if (uniswapV3MakerTokenId === 0n)
		throw new Error(
			`NPM mint produced no IncreaseLiquidity event: ${mintHash}`,
		);

	// --- Aqua position: real ship through the Aqua registry under the AquaSwapVMRouter app ---
	const position = await shipAquaPosition(rpcUrl, {
		aquaRouter,
		swapVMRouter,
		tokenIn,
		tokenOut,
	});

	const addresses: Record<string, Address> = {
		tokenIn: tokenInAddress,
		tokenOut: tokenOutAddress,
		weth9,
		uniswapV3Factory: v3Factory,
		uniswapV3Pool,
		uniswapV3Npm: npm,
		permit2,
		universalRouter,
		depositAccount,
		deliveryAccount,
		aquaRouter,
		swapVMRouter,
		uniswapV3Quoter,
	};

	const buildConfig = (overrides?: Partial<SolverConfig>): SolverConfig => ({
		hubUrl: "http://127.0.0.1:1",
		solverId: 1,
		kid: 1,
		chainId: 31337,
		rpcUrl,
		depositAccount,
		deliveryAccount,
		tokenIn,
		tokenOut,
		strategy: "Uniswap",
		marginBps: 10,
		slippageBps: 50,
		quoteTimeoutMs: 5000,
		stateDir: "private/state",
		finality: "latest",
		uniswapApiKey: "local-demo-key",
		oneInchApiKey: "local-demo-key",
		uniswapApiUrl: "http://127.0.0.1:1/v1",
		oneInchApiUrl: "http://127.0.0.1:1/oneinch/swap/v6.1",
		universalRouter,
		permit2,
		aqua: {
			maker: position.maker,
			app: position.app,
			strategyHash: position.strategyHash,
			strategyBytes: position.strategyBytes,
		},
		...overrides,
	});

	return {
		rpcUrl,
		chainId: 31337,
		tokenIn,
		tokenOut,
		depositAccount,
		deliveryAccount,
		universalRouter,
		permit2,
		weth9,
		uniswapV3Factory: v3Factory,
		uniswapV3Pool,
		uniswapV3Npm: npm,
		uniswapV3Quoter,
		uniswapV3MakerTokenId,
		aqua: position,
		customer: customerAcct,
		maker: makerAcct,
		solver: solverAcct,
		deployer: deployerAcct,
		addresses,
		config: buildConfig,
	};
}

// ---------------------------------------------------------------------------
// Shipping the Aqua position (real registry interaction via the aqua adapter's builder)
// ---------------------------------------------------------------------------

async function shipAquaPosition(
	rpcUrl: string,
	ctx: {
		aquaRouter: Address;
		swapVMRouter: Address;
		tokenIn: DemoToken;
		tokenOut: DemoToken;
	},
): Promise<DemoAquaPosition> {
	const config: SolverConfig = {
		hubUrl: "http://127.0.0.1:1",
		solverId: 1,
		kid: 1,
		chainId: 31337,
		rpcUrl,
		depositAccount: "0x0000000000000000000000000000000000000000",
		deliveryAccount: "0x0000000000000000000000000000000000000000",
		tokenIn: ctx.tokenIn,
		tokenOut: ctx.tokenOut,
		strategy: "Aqua",
		marginBps: 10,
		slippageBps: 50,
		quoteTimeoutMs: 5000,
		stateDir: "private/state",
		finality: "latest",
		uniswapApiKey: "local-demo-key",
		oneInchApiKey: "local-demo-key",
		uniswapApiUrl: "http://127.0.0.1:1/v1",
		oneInchApiUrl: "http://127.0.0.1:1/oneinch/swap/v6.1",
		universalRouter: "0x0000000000000000000000000000000000000000",
		permit2: "0x0000000000000000000000000000000000000000",
	};
	const makerEvm = new Evm(config, ANVIL_PRIVATE_KEYS[1]!);
	const shipped = await buildAndShipPosition({
		config,
		makerEvm,
		registry: ctx.aquaRouter,
		app: ctx.swapVMRouter,
		amounts: { tokenIn: AQUA_POSITION_SEED, tokenOut: AQUA_POSITION_SEED },
		salt: FIXED_SALT,
	});
	if (!shipped.ok)
		throw new Error(
			`Aqua position ship failed (${shipped.code}): ${shipped.error}`,
		);
	const { manifest } = shipped.data;
	if (manifest.maker.toLowerCase() !== makerEvm.address.toLowerCase())
		throw new Error("Aqua position maker mismatch");
	return {
		aquaRouter: ctx.aquaRouter,
		swapVMRouter: ctx.swapVMRouter,
		app: manifest.app,
		maker: manifest.maker,
		strategyHash: manifest.strategyHash,
		strategyBytes: manifest.strategy,
		salt: manifest.salt,
		priceLower: manifest.priceLower,
		priceUpper: manifest.priceUpper,
		feeBps: manifest.feeBps,
		decaySeconds: manifest.decaySeconds,
		shipped: true,
		shipHash: shipped.data.hash,
	};
}

// ---------------------------------------------------------------------------
// Public fixture helpers
// ---------------------------------------------------------------------------

/** Final Aqua position balances: registry (virtual) + maker wallet (backing custody). */
export async function aquaBalances(fixture: DemoFixture): Promise<{
	raw0: bigint;
	raw1: bigint;
	wallet0: bigint;
	wallet1: bigint;
}> {
	const pub = createPublicClient({
		chain: foundry,
		transport: http(fixture.rpcUrl, { retryCount: 0 }),
	});
	const readRaw = (token: Address) =>
		pub.readContract({
			address: fixture.aqua.aquaRouter,
			abi: AQUA_RAW_BALANCES_ABI,
			functionName: "rawBalances",
			args: [
				fixture.aqua.maker,
				fixture.aqua.app,
				fixture.aqua.strategyHash,
				token,
			],
		}) as Promise<[bigint, number]>;
	const readWallet = (token: Address) =>
		pub.readContract({
			address: token,
			abi: erc20Abi,
			functionName: "balanceOf",
			args: [fixture.aqua.maker],
		});
	const [[raw0], [raw1], wallet0, wallet1] = await Promise.all([
		readRaw(fixture.tokenIn.address),
		readRaw(fixture.tokenOut.address),
		readWallet(fixture.tokenIn.address),
		readWallet(fixture.tokenOut.address),
	]);
	return { raw0, raw1, wallet0, wallet1 };
}

/** Exact settlement ABI the doubles implement and src/evm.ts verifies (re-exported for demo orchestration). */
export { settlementAbi as demoSettlementAbi };

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function approve(
	pub: PublicClient,
	wallet: WalletClient<HttpTransport, typeof foundry, PrivateKeyAccount>,
	token: Address,
	owner: Address,
	spender: Address,
	minAllowance: bigint,
): Promise<void> {
	const allowance = await pub.readContract({
		address: token,
		abi: erc20Abi,
		functionName: "allowance",
		args: [owner, spender],
	});
	if (allowance >= minAllowance) return;
	if (wallet.account.address.toLowerCase() !== owner.toLowerCase())
		throw new Error("Fixture approval owner mismatch");
	const hash = await wallet.writeContract({
		address: token,
		abi: erc20Abi,
		functionName: "approve",
		args: [spender, minAllowance],
		account: wallet.account,
		chain: foundry,
	});
	const receipt = await pub.waitForTransactionReceipt({
		hash,
		timeout: 30_000,
	});
	if (receipt.status !== "success") throw new Error(`approve failed: ${hash}`);
}

function decodePoolAddress(
	logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[],
	factory: Address,
	abi: Abi,
	token0: Address,
	token1: Address,
): Address {
	const events = parseEventLogs({
		abi,
		eventName: "PoolCreated",
		logs: logs.filter(
			(log) => log.address.toLowerCase() === factory.toLowerCase(),
		) as never,
	});
	for (const event of events) {
		const {
			fee,
			pool,
			token0: actual0,
			token1: actual1,
		} = event.args as {
			fee: number;
			pool: Address;
			token0: Address;
			token1: Address;
		};
		if (
			Number(fee) === POOL_FEE &&
			actual0.toLowerCase() === token0.toLowerCase() &&
			actual1.toLowerCase() === token1.toLowerCase()
		)
			return pool;
	}
	throw new Error(`PoolCreated event not found for ${token0}/${token1}`);
}

function decodeTokenId(
	logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[],
): bigint {
	const events = parseEventLogs({
		abi: V3_NPM_ABI,
		eventName: "IncreaseLiquidity",
		logs: logs as never,
	});
	for (const event of events) {
		const { tokenId } = event.args as { tokenId: bigint };
		if (tokenId !== 0n) return tokenId;
	}
	return 0n;
}
