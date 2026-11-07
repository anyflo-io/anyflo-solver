/**
 * Interactive demo entry point: `bun run demo --strategy Uniswap|Aqua|both`.
 *
 * Each run owns its full local stack — Anvil, the deployed Uniswap/Aqua fixture, the
 * provider-quote HTTP mock, the mock Solver Hub and a REAL `index.ts` solver child process
 * with a generated private config and test-only keys (no user API keys, no mainnet, no
 * real funds). `both` runs two independent orders sequentially, each with its own process,
 * config and checkpoint state.
 *
 * Progress goes to stderr; the JSON summary (mock boundaries + real protocol results,
 * actual txs/amounts/final position, no secrets) goes to stdout. Exit code 0 only if every
 * run's checks pass.
 */
import { parseArgs } from "node:util";

import {
	runDemoScenario,
	reportJson,
	type DemoStrategy,
	type DemoScenario,
} from "../demo/run";

const STRATEGIES: DemoStrategy[] = ["Uniswap", "Aqua"];
const SCENARIOS: DemoScenario[] = [
	"positive",
	"unfundedDeposit",
	"completedRestart",
];

const { values } = parseArgs({
	args: Bun.argv.slice(2),
	options: {
		strategy: { type: "string", default: "both" },
		scenario: { type: "string", default: "positive" },
		help: { type: "boolean", default: false },
	},
});

if (values.help) {
	process.stdout.write(
		[
			"Anyflo standalone solver demo",
			"  bun run demo --strategy Uniswap   # full order flow through the Uniswap AMM adapter",
			"  bun run demo --strategy Aqua      # full order flow through the Aqua/SwapVM position",
			"  bun run demo --strategy both      # two independent sequential orders (one per strategy)",
			"  --scenario unfundedDeposit       # real shortfall receipt; no swap/payout permitted",
			"  --scenario completedRestart      # graceful completed restart and duplicate delivery",
			"  Funded/in-flight restart is always manual reconciliation, never automatic recovery.",
			"",
			"Starts a private local stack (Anvil chainId 31337, deployed official Uniswap/Aqua contracts",
			"plus Anyflo settlement test doubles, mock provider quotes, mock Solver Hub) and a real solver",
			"process. Fresh auth keys and well-known Anvil wallets only; no user API keys are used.",
			"First run requires the pinned Foundry artifacts: `bun run demo:setup` (automatic fixture",
			"acquisition/build; rerun it if the demo reports missing artifacts).",
			"The Hub/provider/customer layers and settlement contracts are simulated/test doubles;",
			"official engine swaps and all ERC20 movements have real local receipts. JSON: stdout.",
		].join("\n"),
	);
	process.stdout.write("\n");
	process.exit(0);
}

const requested = (values.strategy ?? "both").toLowerCase();
const strategies: DemoStrategy[] =
	requested === "both"
		? STRATEGIES
		: requested === "uniswap"
			? ["Uniswap"]
			: requested === "aqua"
				? ["Aqua"]
				: [];
if (strategies.length === 0) {
	process.stderr.write(
		`Unknown --strategy ${values.strategy}; use Uniswap, Aqua or both\n`,
	);
	process.exit(2);
}
const scenario = SCENARIOS.find((value) => value === values.scenario);
if (!scenario) {
	process.stderr.write(
		"Unknown --scenario; use positive, unfundedDeposit or completedRestart\n",
	);
	process.exit(2);
}

let failures = 0;
for (const strategy of strategies) {
	process.stderr.write(`\n=== demo: ${strategy} (${scenario}) ===\n`);
	const report = await runDemoScenario({
		strategy,
		scenario,
		log: (line) => {
			process.stderr.write(`${line}\n`);
		},
	});
	process.stdout.write(`${reportJson(report)}\n`);
	if (!report.ok) {
		failures += 1;
		process.stderr.write(
			`[${report.runId}] FAILED: ${report.error ?? "one or more checks failed"}\n`,
		);
	} else {
		process.stderr.write(
			`[${report.runId}] ok — ${report.checks.length} checks passed\n`,
		);
	}
}
if (failures > 0) {
	process.stderr.write(
		`\n${failures} demo run(s) failed; see the JSON summaries and private/demo/ logs\n`,
	);
	process.exitCode = 1;
} else {
	process.stderr.write("\nAll demo runs passed\n");
}
