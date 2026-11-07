/**
 * Shared demo harness: owns Anvil, the local chain fixture, the provider-quote mock, the
 * mock Solver Hub and the REAL solver child process (`index.ts`) for one scenario run.
 * Used by `scripts/demo.ts` and `tests/demo.test.ts` so both exercise identical
 * orchestration — there is exactly one simulation, not two.
 *
 * Ownership and cleanup: every spawned process/server (anvil, provider mock, mock hub,
 * solver child) is stopped on every code path via reverse-order cleanup. Each run gets its
 * own ephemeral ports and an ignored `private/demo/<runId>` directory holding the generated
 * private config, solver state and logs. The auth JWK and EVM key live only in the child
 * process env; nothing secret is written to disk or included in the report.
 *
 * Restart semantics: gracefully close only after the completed checkpoint is durable, restart
 * on the same state and replay the same real delivery notification. No second spend is allowed.
 * Every funded or ambiguous in-flight restart requires manual reconciliation; no automatic
 * production recovery, stale-lock deletion or SIGKILL-and-resume is implemented here.
 *
 * Truthfulness: the hub, HTTP providers and Anyflo settlement contracts are explicitly labeled
 * mocks/test doubles. The AMM, Permit2, UniversalRouter, Aqua and SwapVM are official engines.
 * All reported funds movement is read from real receipts, logs and balances on the local chain.
 * Reports separate `mockBoundary` labels from `realProtocol` results. Provider credentials
 * are synthetic local strings, never user API keys.
 */
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";

import {
	createPublicClient,
	createWalletClient,
	decodeEventLog,
	erc20Abi,
	http,
	getAbiItem,
	parseAbi,
	parseEventLogs,
	toHex,
	toBytes,
	type Address,
	type Hash,
	type PublicClient,
} from "viem";
import { foundry } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

import { generateEd25519Keypair, toJwk } from "@anyflo/lib/ed25519";

import { ConfigSchema } from "../src/config";
import { Evm } from "../src/evm";
import { dockAquaPosition } from "../src/aqua-position";
import {
	aquaBalances,
	demoSettlementAbi,
	deployFixture,
	type DemoFixture,
} from "./chain";
import { startDemoProvider, type DemoProviderHandle } from "./provider";
import { startMockHub, type HubOrderReport, type MockHubHandle } from "./hub";

export type DemoStrategy = "Uniswap" | "Aqua";
export type DemoScenario =
	/** Full happy-path order flow. */
	| "positive"
	/** Real shortfall receipt that must be disputed with zero spend. */
	| "unfundedDeposit"
	/** Graceful restart of a completed checkpoint, then replay the actual delivery notification. */
	| "completedRestart";

/** Synthetic provider credential for local runs — never a user key; provider URLs point at the local mock. */
const LOCAL_SYNTHETIC_API_KEY = "demo-local-mock-key";

const SCENARIO_TIMEOUT_MS = 90_000;
const STOP_GRACE_MS = 15_000;
const DEPOSIT_WAIT_MS = 45_000;
const DELIVERY_WAIT_MS = 90_000;
const FEE_BPS = 100n; // 1% protocol fee on the synthetic customer order

export interface DemoCheck {
	name: string;
	pass: boolean;
	detail: string;
}

export interface DemoReport {
	runId: string;
	strategy: DemoStrategy;
	scenario: DemoScenario;
	ok: boolean;
	checks: DemoCheck[];
	/** Which parts of this run are simulated vs real; printed with every summary. */
	mockBoundary: Record<string, string>;
	/** Real protocol + on-chain results read from receipts, logs and balances. */
	realProtocol: {
		hubUrl: string;
		chainId: number;
		orders: HubOrderReport[];
		deposit: {
			txHash: Hash;
			orderRef: string;
			solverAmount: bigint;
			fee: bigint;
			token: Address;
		} | null;
		delivery: {
			txHash: Hash;
			orderRef: string;
			recipient: Address;
			token: Address;
			amount: bigint;
		} | null;
		solverSpends: {
			tokenInTransfersFromSolver: { count: number; hashes: Hash[] };
			tokenOutTransfersFromSolver: { count: number; hashes: Hash[] };
		};
		balances: { before: Record<string, bigint>; after: Record<string, bigint> };
		aquaPosition: {
			raw0: bigint;
			raw1: bigint;
			wallet0: bigint;
			wallet1: bigint;
		} | null;
		aquaLifecycle: { shipHash: Hash; fillHash: Hash; dockHash: Hash } | null;
	};
	solver: {
		restarts: number;
		exitCodes: number[];
		logPath: string;
		configPath: string;
	};
	timings: Record<string, number>;
	error?: string;
}

/** Serialize a report for printing: bigints become strings; the report never carries keys. */
export function reportJson(report: DemoReport): string {
	return JSON.stringify(
		report,
		(_k, v) => (typeof v === "bigint" ? v.toString() : v),
		2,
	);
}

interface AnvilHandle {
	rpcUrl: string;
	stop(): Promise<void>;
}

interface SolverChild {
	logPath: string;
	kill(signal: "SIGTERM" | "SIGKILL"): Promise<number>;
}

const transferEvent = getAbiItem({ abi: erc20Abi, name: "Transfer" });
/** Customer-side view of the DepositAccount double: the solver-facing demoSettlementAbi
 * (events + payout) has no deposit entrypoint, so the synthetic customer carries its own. */
const depositAccountCustomerAbi = parseAbi([
	"function deposit(bytes16 orderId, address token, uint256 solverAmount, uint256 fee, address solver, bool directDeposit)",
]);

async function freePort(): Promise<number> {
	const listener = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: { data() {}, close() {}, error() {} },
	});
	const port = listener.port;
	await listener.stop(true);
	return port;
}

function repoRoot(): string {
	return path.resolve(import.meta.dir, "..");
}

async function startAnvil(
	workDir: string,
	registerCleanup: (stop: () => Promise<void>) => void,
): Promise<AnvilHandle> {
	const port = await freePort();
	const rpcUrl = `http://127.0.0.1:${port}`;
	const logPath = path.join(workDir, "anvil.log");
	const arch = process.arch === "x64" ? "amd64" : process.arch;
	const name = process.platform === "win32" ? "anvil.exe" : "anvil";
	const binary = createRequire(import.meta.url).resolve(
		`@foundry-rs/anvil-${process.platform}-${arch}/bin/${name}`,
	);
	const proc = Bun.spawn(
		[
			binary,
			"--host",
			"127.0.0.1",
			"--port",
			String(port),
			"--chain-id",
			"31337",
		],
		{
			stdout: Bun.file(logPath),
			stderr: Bun.file(`${logPath}.stderr`),
		},
	);
	const stop = async () => {
		if (proc.exitCode !== null) return;
		proc.kill("SIGTERM");
		const { promise, resolve } = Promise.withResolvers<void>();
		const timer = setTimeout(resolve, 5_000);
		try {
			await Promise.race([proc.exited, promise]);
		} finally {
			clearTimeout(timer);
		}
		if (proc.exitCode === null) proc.kill("SIGKILL");
		await proc.exited;
	};
	registerCleanup(stop);
	try {
		const deadline = Date.now() + 20_000;
		for (;;) {
			if (proc.exitCode !== null)
				throw new Error(`Anvil exited ${proc.exitCode}; see ${logPath}.stderr`);
			try {
				const res = await fetch(rpcUrl, {
					method: "POST",
					headers: { "content-type": "application/json" },
					signal: AbortSignal.timeout(1_000),
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "eth_chainId",
						params: [],
					}),
				});
				const body = (await res.json()) as { result?: string };
				if (body.result === toHex(31337)) return { rpcUrl, stop };
			} catch {
				/* not listening yet */
			}
			if (Date.now() > deadline)
				throw new Error(`Anvil readiness timed out; see ${logPath}.stderr`);
			await sleep(150);
		}
	} catch (error) {
		await stop();
		throw error;
	}
}

/** bytes16 payout/deposit order reference: order UUID bytes, same encoding as src/evm.ts. */
function orderRefBytes(orderId: string): `0x${string}` {
	return toHex(toBytes(`0x${orderId.replaceAll("-", "")}`), { size: 16 });
}

/** REAL customer deposit effect injected into the mock hub: the fixture customer calls the
 * settlement double's deposit(orderId, token, solverAmount, fee, solver, directDeposit),
 * which transfers the solver-net amount to the solver EOA and the fee to the fee recipient,
 * then emits the real OrderDeposit event. Resolves only after observing an actual receipt.
 * The fixture pre-approves customer -> depositAccount for the full supply; a defensive
 * approve fires only if that ever changes. */
function makeCustomerDepositSender(
	fixture: DemoFixture,
	publicClient: PublicClient,
) {
	const wallet = createWalletClient({
		account: privateKeyToAccount(fixture.customer.privateKey),
		chain: foundry,
		transport: http(fixture.rpcUrl),
	});
	return async (args: {
		orderId: string;
		token: string;
		solverAmount: bigint;
		fee: bigint;
		solver: string;
	}): Promise<{ txHash: string }> => {
		const total = args.solverAmount + args.fee;
		const allowance = await publicClient.readContract({
			address: args.token as Address,
			abi: erc20Abi,
			functionName: "allowance",
			args: [wallet.account.address, fixture.depositAccount],
		});
		if (allowance < total) {
			const approveHash = await wallet.writeContract({
				address: args.token as Address,
				abi: erc20Abi,
				functionName: "approve",
				args: [fixture.depositAccount, total],
			});
			const approved = await publicClient.waitForTransactionReceipt({
				hash: approveHash,
				timeout: 30_000,
			});
			if (approved.status !== "success")
				throw new Error("Customer approval reverted");
		}
		const hash = await wallet.writeContract({
			address: fixture.depositAccount,
			abi: depositAccountCustomerAbi,
			functionName: "deposit",
			args: [
				orderRefBytes(args.orderId),
				args.token as Address,
				args.solverAmount,
				args.fee,
				args.solver as Address,
				true,
			],
		});
		const receipt = await publicClient.waitForTransactionReceipt({
			hash,
			timeout: 30_000,
		});
		if (receipt.status !== "success")
			throw new Error(`customer deposit reverted: ${hash}`);
		return { txHash: hash };
	};
}

/** REAL delivery observation (indexer stand-in) injected into the mock hub: fires only on
 * actual OrderDelivered logs from the DeliveryAccount on the local chain. */
function makeDeliveryWatcher(fixture: DemoFixture, publicClient: PublicClient) {
	return (
		cb: (delivery: {
			txHash: string;
			ref: string;
			recipient: string;
			token: string;
			amount: bigint;
		}) => void,
	): (() => void) => {
		let nextBlock = 0n;
		let querying = false;
		let stopped = false;
		// Avoid RPC filters: viem's filter teardown awaits uninstallFilter before stopping its
		// poller, which can race Anvil shutdown. Block polling has synchronous cancellation.
		const unwatch = publicClient.watchBlockNumber({
			emitOnBegin: true,
			poll: true,
			pollingInterval: 200,
			onBlockNumber: (blockNumber) => {
				if (stopped || querying || blockNumber < nextBlock) return;
				querying = true;
				void (async () => {
					try {
						const logs = await publicClient.getLogs({
							address: fixture.deliveryAccount,
							event: getAbiItem({
								abi: demoSettlementAbi,
								name: "OrderDelivered",
							}),
							fromBlock: nextBlock,
							toBlock: blockNumber,
							strict: true,
						});
						if (stopped) return;
						for (const log of logs) {
							if (log.transactionHash == null) continue;
							cb({
								txHash: log.transactionHash,
								ref: log.args.orderId,
								recipient: log.args.recipient,
								token: log.args.token,
								amount: log.args.amount,
							});
						}
						nextBlock = blockNumber + 1n;
					} catch {
						// No invented delivery on RPC failure; the bounded scenario wait fails closed.
					} finally {
						querying = false;
					}
				})();
			},
		});
		return () => {
			stopped = true;
			unwatch();
		};
	};
}

function spawnSolver(args: {
	cfgPath: string;
	authJwk: unknown;
	solverPrivateKey: string;
	logDir: string;
	index: number;
}): SolverChild {
	const logPath = path.join(args.logDir, `solver-${args.index}.log`);
	const proc = Bun.spawn(
		[
			process.execPath,
			"run",
			"index.ts",
			"--config",
			args.cfgPath,
			"--execute",
		],
		{
			cwd: repoRoot(),
			env: {
				...process.env,
				EVM_PRIVATE_KEY: args.solverPrivateKey,
				SOLVER_AUTH_JWK: JSON.stringify(args.authJwk),
			},
			stdout: Bun.file(logPath),
			stderr: Bun.file(`${logPath}.stderr`),
		},
	);
	return {
		logPath,
		async kill(signal) {
			if (proc.exitCode !== null) return proc.exitCode;
			proc.kill(signal);
			const { promise, resolve } = Promise.withResolvers<null>();
			const timer = setTimeout(() => resolve(null), STOP_GRACE_MS);
			try {
				const code = await Promise.race([proc.exited, promise]);
				if (code !== null) return code;
				proc.kill("SIGKILL");
				return await proc.exited;
			} finally {
				clearTimeout(timer);
			}
		},
	};
}

async function decodeSettlementEvent(
	publicClient: PublicClient,
	fixture: DemoFixture,
	txHash: Hash,
	eventName: "OrderDeposit" | "OrderDelivered",
): Promise<Record<string, unknown> | null> {
	const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
	if (receipt.status !== "success")
		throw new Error("Cannot report a reverted settlement receipt");
	const target =
		eventName === "OrderDeposit"
			? fixture.depositAccount.toLowerCase()
			: fixture.deliveryAccount.toLowerCase();
	for (const log of receipt.logs) {
		if (log.address.toLowerCase() !== target) continue;
		try {
			const decoded = decodeEventLog({
				abi: demoSettlementAbi,
				eventName,
				data: log.data,
				topics: log.topics,
			});
			if (decoded.args) return decoded.args as Record<string, unknown>;
		} catch {
			// not this event
		}
	}
	return null;
}

export async function runDemoScenario(opts: {
	strategy: DemoStrategy;
	scenario: DemoScenario;
	/** Bidding window for the mock hub auction; the plan's demo default is 10s. */
	biddingMs?: number;
	workDir?: string;
	log?: (line: string) => void;
}): Promise<DemoReport> {
	let interrupted = false;
	const log = (line: string) => {
		if (interrupted) throw new Error("Demo interrupted");
		opts.log?.(line);
	};
	const runId = `${opts.strategy.toLowerCase()}-${opts.scenario}-${Date.now()}`;
	const workDir =
		opts.workDir ?? path.join(repoRoot(), "private", "demo", runId);
	await mkdir(workDir, { recursive: true, mode: 0o700 });
	const stateDir = path.join(workDir, "state");

	const report: DemoReport = {
		runId,
		strategy: opts.strategy,
		scenario: opts.scenario,
		ok: false,
		checks: [],
		mockBoundary: {
			hub: "simulated Anyflo Solver Hub (demo/hub.ts, not the production backend)",
			providerQuotes:
				"local HTTP mock of the Uniswap Trading API / 1inch Classic API (demo/provider.ts) with a synthetic API key",
			settlementDoubles:
				"Anyflo DepositAccount/DeliveryAccount test doubles: real ERC20 moves, not production-contract proof",
			customer: "synthetic customer funded with minted local test tokens",
			chain: "local Anvil chainId 31337; no mainnet, no real funds",
			real: "swaps run against the official local Uniswap/AquaSwapVM deployments; deposits, fees, payouts and balances are real receipts",
		},
		realProtocol: {
			hubUrl: "",
			chainId: 31337,
			orders: [],
			deposit: null,
			delivery: null,
			solverSpends: {
				tokenInTransfersFromSolver: { count: 0, hashes: [] },
				tokenOutTransfersFromSolver: { count: 0, hashes: [] },
			},
			balances: { before: {}, after: {} },
			aquaPosition: null,
			aquaLifecycle: null,
		},
		solver: {
			restarts: 0,
			exitCodes: [],
			logPath: "",
			configPath: path.join(workDir, "solver.config.json"),
		},
		timings: {},
	};
	const timings = report.timings;
	const started = Date.now();

	const cleanups: Array<() => Promise<void> | void> = [];
	let currentSolver: { child: SolverChild } | null = null;
	let shutdownPromise: Promise<void> | undefined;
	function shutdown(): Promise<void> {
		return (shutdownPromise ??= (async () => {
			const child = currentSolver?.child;
			currentSolver = null;
			if (child) {
				report.solver.logPath = child.logPath;
				try {
					report.solver.exitCodes.push(await child.kill("SIGKILL"));
				} catch {
					/* already exited */
				}
			}
			for (const cleanup of cleanups.reverse()) {
				try {
					await cleanup();
				} catch {
					opts.log?.(`[${runId}] local resource cleanup failed`);
				}
			}
		})());
	}
	const interrupt = (code: number) => {
		interrupted = true;
		void shutdown().finally(() => process.exit(code));
	};
	const onSigint = () => interrupt(130);
	const onSigterm = () => interrupt(143);
	process.once("SIGINT", onSigint);
	process.once("SIGTERM", onSigterm);
	try {
		log(`[${runId}] starting anvil`);
		const anvil = await startAnvil(workDir, (stop) => cleanups.push(stop));

		log(
			`[${runId}] deploying local chain fixture (Uniswap v3 stack, Permit2, Aqua/SwapVM, settlement doubles)`,
		);
		const fixture = await deployFixture(anvil.rpcUrl);
		const publicClient = createPublicClient({
			chain: foundry,
			transport: http(anvil.rpcUrl, { retryCount: 0, timeout: 5_000 }),
		});

		log(`[${runId}] starting local provider-quote mock`);
		const provider: DemoProviderHandle = await startDemoProvider({ fixture });
		cleanups.push(() => provider.close());

		// Solver authentication: fresh Ed25519 keypair per run; JWK (with private d) lives only
		// in the child env; the hub verifies JWT + canonical signatures with the public key.
		const auth = await generateEd25519Keypair();
		const authJwk = await toJwk(auth.privateKey);

		const recipient = privateKeyToAccount(generatePrivateKey()).address;
		log(`[${runId}] starting mock Solver Hub`);
		const hub: MockHubHandle = startMockHub({
			solverId: 1,
			kid: 1,
			solverPublicKey: auth.publicKey,
			expectedSolverAddress: fixture.solver.address,
			chain: "eip155:31337",
			customerAddress: fixture.customer.address,
			feeRecipient: fixture.deployer.address,
			tokenIn: fixture.tokenIn,
			tokenOut: fixture.tokenOut,
			depositAccount: fixture.depositAccount,
			feeBps: Number(FEE_BPS),
			biddingMs: opts.biddingMs,
			sendCustomerDeposit: makeCustomerDepositSender(fixture, publicClient),
			watchDeliveries: makeDeliveryWatcher(fixture, publicClient),
		});
		cleanups.push(() => hub.stop());
		report.realProtocol.hubUrl = hub.url;

		const cfgPath = report.solver.configPath;
		const cfg = ConfigSchema.parse(
			fixture.config({
				hubUrl: hub.url,
				strategy: opts.strategy,
				uniswapApiUrl: provider.uniswapUrl,
				oneInchApiUrl: provider.oneInchUrl,
				uniswapApiKey: LOCAL_SYNTHETIC_API_KEY,
				oneInchApiKey: LOCAL_SYNTHETIC_API_KEY,
				stateDir,
				finality: "latest",
				marginBps: 10,
				slippageBps: 50,
				quoteTimeoutMs: 15_000,
			}),
		);
		await Bun.write(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);

		const balanceLabels: Record<string, { holder: Address; token: Address }> = {
			customerTokenIn: {
				holder: fixture.customer.address,
				token: fixture.tokenIn.address,
			},
			makerTokenIn: {
				holder: fixture.maker.address,
				token: fixture.tokenIn.address,
			},
			solverTokenIn: {
				holder: fixture.solver.address,
				token: fixture.tokenIn.address,
			},
			recipientTokenIn: { holder: recipient, token: fixture.tokenIn.address },
			depositAccountTokenIn: {
				holder: fixture.depositAccount,
				token: fixture.tokenIn.address,
			},
			feeRecipientTokenIn: {
				holder: fixture.deployer.address,
				token: fixture.tokenIn.address,
			},
			solverTokenOut: {
				holder: fixture.solver.address,
				token: fixture.tokenOut.address,
			},
			recipientTokenOut: { holder: recipient, token: fixture.tokenOut.address },
			makerTokenOut: {
				holder: fixture.maker.address,
				token: fixture.tokenOut.address,
			},
		};
		async function balancesSnapshot(): Promise<Record<string, bigint>> {
			return Object.fromEntries(
				await Promise.all(
					Object.entries(balanceLabels).map(
						async ([label, { holder, token }]) => [
							label,
							await publicClient.readContract({
								address: token,
								abi: erc20Abi,
								functionName: "balanceOf",
								args: [holder],
							}),
						],
					),
				),
			);
		}
		async function transfersFromSolver(
			token: Address,
		): Promise<{ count: number; hashes: Hash[] }> {
			const logs = await publicClient.getLogs({
				address: token,
				event: transferEvent,
				args: { from: fixture.solver.address },
				fromBlock: 0n,
				toBlock: "latest",
			});
			return {
				count: logs.length,
				hashes: logs
					.map((l) => l.transactionHash!)
					.filter((h): h is Hash => h != null),
			};
		}

		report.realProtocol.balances.before = await balancesSnapshot();
		const aquaPositionBefore =
			opts.strategy === "Aqua" ? await aquaBalances(fixture) : null;

		async function collectEvidence(orderId: string): Promise<void> {
			const hubOrder =
				hub.report().orders.find((o) => o.order.id === orderId) ?? null;
			if (hubOrder) report.realProtocol.orders = [hubOrder];
			const depositTx = hubOrder?.order.depositTx ?? null;
			if (depositTx) {
				const args = await decodeSettlementEvent(
					publicClient,
					fixture,
					depositTx as Hash,
					"OrderDeposit",
				);
				if (args) {
					const first = (
						args.deposits as
							| Array<{ token: Address; solverAmount: bigint; fee: bigint }>
							| undefined
					)?.[0];
					if (first) {
						report.realProtocol.deposit = {
							txHash: depositTx as Hash,
							orderRef: String(args.orderId),
							solverAmount: first.solverAmount,
							fee: first.fee,
							token: first.token,
						};
					}
				}
			}
			const deliverTx = hubOrder?.deliverTx ?? null;
			if (deliverTx) {
				const args = await decodeSettlementEvent(
					publicClient,
					fixture,
					deliverTx as Hash,
					"OrderDelivered",
				);
				if (args && args.recipient != null) {
					report.realProtocol.delivery = {
						txHash: deliverTx as Hash,
						orderRef: String(args.orderId),
						recipient: args.recipient as Address,
						token: args.token as Address,
						amount: args.amount as bigint,
					};
				}
			}
			report.realProtocol.solverSpends.tokenInTransfersFromSolver =
				await transfersFromSolver(fixture.tokenIn.address);
			report.realProtocol.solverSpends.tokenOutTransfersFromSolver =
				await transfersFromSolver(fixture.tokenOut.address);
			report.realProtocol.balances.after = await balancesSnapshot();
			if (opts.strategy === "Aqua")
				report.realProtocol.aquaPosition = await aquaBalances(fixture);
		}

		function check(name: string, pass: boolean, detail: string): void {
			report.checks.push({ name, pass, detail });
		}

		function delta(label: string): bigint {
			const before = report.realProtocol.balances.before[label] ?? 0n;
			const after = report.realProtocol.balances.after[label] ?? 0n;
			return after - before;
		}

		function stopSolver(): SolverChild | null {
			const current = currentSolver;
			currentSolver = null;
			const child = current?.child ?? null;
			if (child) report.solver.logPath = child.logPath;
			return child;
		}

		const spawnChild = (): { child: SolverChild } => {
			const spawned = spawnSolver({
				cfgPath,
				authJwk,
				solverPrivateKey: fixture.solver.privateKey,
				logDir: workDir,
				index: report.solver.exitCodes.length,
			});
			return { child: spawned };
		};

		// Synthetic customer order: fixed input, solver-net amountIn, protocol fee separate.
		const amountIn = 10_000_000n; // 10 test tokens, 6 decimals
		const fee = (amountIn * FEE_BPS) / 10_000n;

		log(`[${runId}] spawning solver process (strategy ${opts.strategy})`);
		currentSolver = spawnChild();
		await hub.waitFor(
			(h) => h.connected(),
			30_000,
			"solver authenticated its /connect WebSocket",
		);
		const order = hub.createOrder({ amountIn, recipientAddr: recipient });
		timings.orderCreated = Date.now() - started;

		await hub.waitFor(
			(h) =>
				h
					.report()
					.orders.some(
						(o) => o.order.id === order.id && o.assignAckedAt != null,
					),
			SCENARIO_TIMEOUT_MS,
			"assignment accepted",
		);
		const accepted = hub.report().orders.find((o) => o.order.id === order.id)!;
		timings.assigned = Date.now() - started;
		{
			const assignedSentAt =
				accepted.timeline.find((e) => e.kind === "orderAssignedSent")?.at ??
				accepted.assignAckedAt!;
			const ackDeltaMs = accepted.assignAckedAt! - assignedSentAt;
			check(
				"signed-bid-accepted",
				accepted.winnerBid != null &&
					accepted.winnerBid.sigValid &&
					accepted.order.amountOut === accepted.winnerBid.quote,
				`winning bid ${accepted.order.amountOut} accepted`,
			);
			check(
				"accept-deadline-honored",
				ackDeltaMs >= 0 && ackDeltaMs <= 1500,
				`OrderAssignAck ${ackDeltaMs}ms after OrderAssigned (1.5s deadline)`,
			);
			check(
				"direct-deposit-acknowledged",
				accepted.order.directDeposit &&
					accepted.order.solverAddress?.toLowerCase() ===
						fixture.solver.address.toLowerCase(),
				`directDeposit=true, solverAddress=${accepted.order.solverAddress}`,
			);
		}

		if (opts.scenario === "unfundedDeposit") {
			await hub.customerDeposit(order.id, { kind: "shortfall" });
			timings.depositSent = Date.now() - started;
			await hub.waitFor(
				(h) =>
					h
						.report()
						.orders.some(
							(o) => o.order.id === order.id && o.depositNotAckedAt != null,
						),
				DEPOSIT_WAIT_MS,
				"deposit dispute recorded",
			);
			timings.depositDisputed = Date.now() - started;
			const disputed = hub
				.report()
				.orders.find((o) => o.order.id === order.id)!;
			await collectEvidence(order.id);
			check(
				"invalid-deposit-genuinely-mismatched",
				report.realProtocol.deposit != null &&
					report.realProtocol.deposit.solverAmount !== accepted.order.amountIn,
				`receipt solverAmount ${report.realProtocol.deposit?.solverAmount} != accepted ${accepted.order.amountIn}`,
			);
			check(
				"solver-disputed-invalid-deposit",
				disputed.order.status === "depositNotAck" &&
					disputed.depositNotAckedAt != null,
				`status ${disputed.order.status}`,
			);
			check(
				"no-swap-spend-after-invalid-deposit",
				report.realProtocol.solverSpends.tokenInTransfersFromSolver.count ===
					0 &&
					report.realProtocol.solverSpends.tokenOutTransfersFromSolver.count ===
						0,
				`tokenIn spends ${report.realProtocol.solverSpends.tokenInTransfersFromSolver.count}, tokenOut spends ${report.realProtocol.solverSpends.tokenOutTransfersFromSolver.count}`,
			);
			check(
				"recipient-received-nothing",
				delta("recipientTokenOut") === 0n && delta("recipientTokenIn") === 0n,
				`recipientTokenOut delta ${delta("recipientTokenOut")}`,
			);
			check(
				"protocol-fee-intact-on-dispute",
				delta("feeRecipientTokenIn") === fee,
				`feeRecipient delta ${delta("feeRecipientTokenIn")}, expected ${fee}`,
			);

			const child = stopSolver();
			if (child) report.solver.exitCodes.push(await child.kill("SIGTERM"));
			report.ok = report.checks.every((c) => c.pass);
			timings.total = Date.now() - started;
			return report;
		}

		await hub.customerDeposit(order.id, { kind: "full" });
		timings.depositSent = Date.now() - started;

		await hub.waitFor(
			(h) =>
				h
					.report()
					.orders.some(
						(o) =>
							o.order.id === order.id &&
							o.order.status === "delivered" &&
							o.deliverTx != null &&
							o.deliveryAckedAt != null,
					),
			DELIVERY_WAIT_MS,
			"delivered with clean acknowledgment",
		);
		timings.delivered = Date.now() - started;
		await hub.waitFor(
			async () =>
				await Bun.file(
					path.join(stateDir, "completed", `${order.id}.cbor`),
				).exists(),
			15_000,
			"durable completed checkpoint",
		);

		// Duplicate/restart proof (deterministic, no ambiguity race): the order completed, the
		// solver is stopped and restarted against the same state + hub, and must not spend a
		// second time. Ambiguous pending-spend restarts fail closed by design and are covered by
		// lifecycle unit tests — this demo claims no automatic mid-spend recovery.
		let baselineSpends: {
			tokenIn: { count: number; hashes: Hash[] };
			tokenOut: { count: number; hashes: Hash[] };
		} | null = null;
		if (opts.scenario === "completedRestart") {
			baselineSpends = {
				tokenIn: await transfersFromSolver(fixture.tokenIn.address),
				tokenOut: await transfersFromSolver(fixture.tokenOut.address),
			};
			const child = stopSolver();
			if (child) report.solver.exitCodes.push(await child.kill("SIGTERM"));
			await hub.waitFor(
				(h) => !h.connected(),
				5_000,
				"completed solver socket closed before restart",
			);
			const syncsBeforeRestart = hub.activeSyncs();
			log(
				`[${runId}] completed order; restarting solver on same state (exit ${report.solver.exitCodes.at(-1)})`,
			);
			currentSolver = spawnChild();
			report.solver.restarts += 1;
			await hub.waitFor(
				(h) => h.connected() && h.activeSyncs() > syncsBeforeRestart,
				30_000,
				"restarted solver authenticated and synchronized active orders",
			);
			const ackCount = hub
				.report()
				.orders.find((o) => o.order.id === order.id)!
				.timeline.filter((e) => e.kind === "deliveryAckReceived").length;
			hub.replayDelivery(order.id);
			await hub.waitFor(
				(h) =>
					h
						.report()
						.orders.find((o) => o.order.id === order.id)!
						.timeline.filter((e) => e.kind === "deliveryAckReceived").length >
					ackCount,
				15_000,
				"restarted solver reverified and acknowledged duplicate delivery",
			);
		}

		const completed = hub.report().orders.find((o) => o.order.id === order.id)!;
		await collectEvidence(order.id);
		const deposit = report.realProtocol.deposit;
		const delivery = report.realProtocol.delivery;
		const spends = report.realProtocol.solverSpends;
		const retainedMargin =
			(accepted.order.amountIn * BigInt(cfg.marginBps)) / 10_000n;
		const expectedSwapInput = accepted.order.amountIn - retainedMargin;
		const swapHash = spends.tokenInTransfersFromSolver.hashes[0];
		if (!swapHash) throw new Error("No actual swap input transfer receipt");
		const swapReceipt = await publicClient.getTransactionReceipt({
			hash: swapHash,
		});
		const actualSwapInput = parseEventLogs({
			abi: erc20Abi,
			eventName: "Transfer",
			logs: swapReceipt.logs,
			strict: true,
		})
			.filter(
				(event) =>
					event.address.toLowerCase() ===
						fixture.tokenIn.address.toLowerCase() &&
					event.args.from.toLowerCase() ===
						fixture.solver.address.toLowerCase(),
			)
			.reduce((sum, event) => sum + event.args.value, 0n);

		check(
			"deposit-verified-with-real-receipt",
			deposit != null &&
				deposit.solverAmount === accepted.order.amountIn &&
				deposit.fee === fee &&
				deposit.token.toLowerCase() === fixture.tokenIn.address.toLowerCase() &&
				deposit.orderRef === orderRefBytes(order.id),
			`OrderDeposit solverAmount ${deposit?.solverAmount}, fee ${deposit?.fee}, ref ${deposit?.orderRef}`,
		);
		check(
			"exact-accepted-recipient-increase",
			delivery != null &&
				delta("recipientTokenOut") === accepted.order.amountOut &&
				delivery.amount === accepted.order.amountOut &&
				delivery.recipient.toLowerCase() === recipient.toLowerCase() &&
				delivery.token.toLowerCase() === fixture.tokenOut.address.toLowerCase(),
			`recipient +${delta("recipientTokenOut")} == accepted ${accepted.order.amountOut}`,
		);
		check(
			"single-swap-spend",
			spends.tokenInTransfersFromSolver.count === 1,
			`tokenIn transfers from solver: ${spends.tokenInTransfersFromSolver.count} (${spends.tokenInTransfersFromSolver.hashes.join(", ")})`,
		);
		check(
			"single-delivery-payout",
			spends.tokenOutTransfersFromSolver.count === 1,
			`tokenOut transfers from solver: ${spends.tokenOutTransfersFromSolver.count} (${spends.tokenOutTransfersFromSolver.hashes.join(", ")})`,
		);
		check(
			"protocol-fee-separate-and-intact",
			delta("feeRecipientTokenIn") === fee && delta("recipientTokenIn") === 0n,
			`feeRecipient +${delta("feeRecipientTokenIn")} == fee ${fee}; recipient got no input token`,
		);
		check(
			"gas-only-solver",
			report.realProtocol.balances.before.solverTokenIn === 0n &&
				report.realProtocol.balances.before.solverTokenOut === 0n,
			`initial solver input/output balances are zero`,
		);
		check(
			"exact-input-and-margin-accounting",
			swapReceipt.status === "success" &&
				actualSwapInput === expectedSwapInput &&
				report.realProtocol.balances.after.solverTokenIn === retainedMargin &&
				delta("customerTokenIn") === -(accepted.order.amountIn + fee),
			`actual swap input ${actualSwapInput}; exact retained input margin ${retainedMargin}; separate customer fee ${fee}`,
		);
		check(
			"clean-delivery-acknowledgment",
			completed.deliveryAckedAt != null &&
				completed.deliveryNotAckedAt == null &&
				completed.order.status === "delivered",
			`status ${completed.order.status}, deliveryAcked=${completed.deliveryAckedAt != null}`,
		);
		if (opts.strategy === "Aqua") {
			const after = report.realProtocol.aquaPosition;
			const receivedOut = delta("solverTokenOut") + accepted.order.amountOut;
			check(
				"aqua-position-liquidity-actually-moved",
				aquaPositionBefore != null &&
					after != null &&
					receivedOut > 0n &&
					aquaPositionBefore.wallet0 >= aquaPositionBefore.raw0 &&
					aquaPositionBefore.wallet1 >= aquaPositionBefore.raw1 &&
					after.raw0 - aquaPositionBefore.raw0 === expectedSwapInput &&
					after.wallet0 - aquaPositionBefore.wallet0 === expectedSwapInput &&
					aquaPositionBefore.raw1 - after.raw1 === receivedOut &&
					aquaPositionBefore.wallet1 - after.wallet1 === receivedOut,
				`virtual reserves and maker custody moved by exact input ${expectedSwapInput} and actual output ${receivedOut}`,
			);
			const fillHash = swapHash;
			const fillReceipt = swapReceipt;
			const movements = parseEventLogs({
				abi: parseAbi([
					"event Pushed(address maker,address app,bytes32 strategyHash,address token,uint256 amount)",
					"event Pulled(address maker,address app,bytes32 strategyHash,address token,uint256 amount)",
				]),
				logs: fillReceipt.logs.filter(
					(entry) =>
						entry.address.toLowerCase() ===
						fixture.aqua.aquaRouter.toLowerCase(),
				),
				strict: true,
			});
			const boundEvents = movements.filter(
				(event) =>
					event.args.maker.toLowerCase() === fixture.aqua.maker.toLowerCase() &&
					event.args.app.toLowerCase() === fixture.aqua.app.toLowerCase() &&
					event.args.strategyHash === fixture.aqua.strategyHash,
			);
			check(
				"aqua-fill-official-events",
				fillReceipt.status === "success" &&
					boundEvents.some(
						(event) =>
							event.eventName === "Pushed" &&
							event.args.token.toLowerCase() ===
								fixture.tokenIn.address.toLowerCase() &&
							event.args.amount === expectedSwapInput,
					) &&
					boundEvents.some(
						(event) =>
							event.eventName === "Pulled" &&
							event.args.token.toLowerCase() ===
								fixture.tokenOut.address.toLowerCase() &&
							event.args.amount === receivedOut,
					),
				`official registry Pushed/Pulled events in real fill ${fillHash}`,
			);
			const docked = await dockAquaPosition(
				new Evm(cfg, fixture.maker.privateKey),
				{
					registry: fixture.aqua.aquaRouter,
					app: fixture.aqua.app,
					maker: fixture.aqua.maker,
					strategyHash: fixture.aqua.strategyHash,
					tokenIn: fixture.tokenIn.address,
					tokenOut: fixture.tokenOut.address,
				},
			);
			if (!docked.ok)
				throw new Error(`Local Aqua dock failed: ${docked.error}`);
			const afterDock = await aquaBalances(fixture);
			check(
				"aqua-docked-with-custody-intact",
				after != null &&
					afterDock.raw0 === 0n &&
					afterDock.raw1 === 0n &&
					afterDock.wallet0 === after.wallet0 &&
					afterDock.wallet1 === after.wallet1,
				`verified Docked receipt ${docked.data.hash}; virtual allowances revoked, maker custody unchanged`,
			);
			report.realProtocol.aquaLifecycle = {
				shipHash: fixture.aqua.shipHash,
				fillHash,
				dockHash: docked.data.hash,
			};
		}
		if (opts.scenario === "completedRestart") {
			const finalSpends = {
				tokenIn: await transfersFromSolver(fixture.tokenIn.address),
				tokenOut: await transfersFromSolver(fixture.tokenOut.address),
			};
			check(
				"restart-added-no-spends",
				baselineSpends != null &&
					finalSpends.tokenIn.count === baselineSpends.tokenIn.count &&
					finalSpends.tokenOut.count === baselineSpends.tokenOut.count,
				`solver transfers tokenIn ${baselineSpends?.tokenIn.count}→${finalSpends.tokenIn.count}, tokenOut ${baselineSpends?.tokenOut.count}→${finalSpends.tokenOut.count}`,
			);
			const depositNotifications = completed.timeline.filter(
				(e) => e.kind === "orderDepositSent",
			).length;
			const deliveryNotifications = completed.timeline.filter(
				(e) => e.kind === "orderDeliverySent",
			).length;
			check(
				"duplicate-delivery-replayed-without-spend",
				depositNotifications === 1 && deliveryNotifications === 2,
				`one actual deposit; delivery notification replayed against the same real receipt`,
			);
			check(
				"solver-restarted-once-and-order-remains-complete",
				report.solver.restarts === 1 && completed.order.status === "delivered",
				`restarts ${report.solver.restarts}, final status ${completed.order.status}`,
			);
		}

		const child = stopSolver();
		if (child) report.solver.exitCodes.push(await child.kill("SIGTERM"));
		report.ok = report.checks.every((c) => c.pass);
		timings.total = Date.now() - started;
		return report;
	} catch (e) {
		report.error = e instanceof Error ? e.message : String(e);
		return report;
	} finally {
		process.removeListener("SIGINT", onSigint);
		process.removeListener("SIGTERM", onSigterm);
		await shutdown();
	}
}
