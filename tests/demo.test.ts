/**
 * Essential end-to-end demo tests over the shared harness (demo/run.ts) — the same
 * orchestration as `bun run demo`, not a second simulation:
 *
 * - one positive full-flow scenario per provider (Uniswap AMM, Aqua/SwapVM): signed bid →
 *   assignment → direct deposit → real swap → payout → clean delivery acknowledgment,
 *   asserting exact recipient increase, single swap/payout, protocol fee separation,
 *   no output prefunding and (Aqua) real position liquidity movement;
 * - one invalid/unfunded deposit scenario: a real receipt with mismatched amounts must be
 *   disputed (OrderDepositNotAck) with NO swap and NO payout;
 * - graceful restart of a durably completed order, replaying the actual delivery notification
 *   and proving there is no second swap or payout. Every funded/in-flight restart fails closed
 *   for manual reconciliation, covered by lifecycle tests rather than automatic demo recovery.
 *
 * Every scenario runs its own Anvil, fixture, provider mock, mock hub and real solver
 * child process; all services are stopped on every path. Runs are sequential to keep the
 * local resource footprint predictable.
 */
import { describe, expect, test } from "bun:test";

import { runDemoScenario, reportJson, type DemoReport } from "../demo/run";

const TEST_TIMEOUT_MS = 300_000;

function requireOk(report: DemoReport): DemoReport {
	if (!report.ok)
		process.stderr.write(
			`scenario ${report.scenario}/${report.strategy} failed:\n${reportJson(report)}\n`,
		);
	expect(report.error).toBeUndefined();
	expect(report.ok).toBe(true);
	return report;
}

describe("demo: mock Solver Hub + real local chain", () => {
	test(
		"positive flow through the Uniswap adapter completes with exact delivery",
		async () => {
			const report = requireOk(
				await runDemoScenario({ strategy: "Uniswap", scenario: "positive" }),
			);
			expect(report.realProtocol.orders).toHaveLength(1);
			expect(
				report.realProtocol.solverSpends.tokenInTransfersFromSolver.count,
			).toBe(1);
			expect(
				report.realProtocol.solverSpends.tokenOutTransfersFromSolver.count,
			).toBe(1);
			expect(report.realProtocol.delivery).not.toBeNull();
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"positive flow through the Aqua/SwapVM position completes and moves position liquidity",
		async () => {
			const report = requireOk(
				await runDemoScenario({ strategy: "Aqua", scenario: "positive" }),
			);
			expect(report.realProtocol.orders).toHaveLength(1);
			expect(
				report.realProtocol.solverSpends.tokenInTransfersFromSolver.count,
			).toBe(1);
			expect(
				report.realProtocol.solverSpends.tokenOutTransfersFromSolver.count,
			).toBe(1);
			expect(report.realProtocol.aquaPosition).not.toBeNull();
			const positionCheck = report.checks.find(
				(c) => c.name === "aqua-position-liquidity-actually-moved",
			);
			expect(positionCheck?.pass).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"invalid/unfunded deposit is disputed with no swap and no payout",
		async () => {
			const report = requireOk(
				await runDemoScenario({
					strategy: "Uniswap",
					scenario: "unfundedDeposit",
				}),
			);
			expect(
				report.realProtocol.solverSpends.tokenInTransfersFromSolver.count,
			).toBe(0);
			expect(
				report.realProtocol.solverSpends.tokenOutTransfersFromSolver.count,
			).toBe(0);
			expect(report.realProtocol.delivery).toBeNull();
			const order = report.realProtocol.orders[0]!;
			expect(order.order.status).toBe("depositNotAck");
			expect(order.depositAckedAt).toBeNull();
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"completed restart and duplicate delivery do not spend twice",
		async () => {
			const report = requireOk(
				await runDemoScenario({
					strategy: "Uniswap",
					scenario: "completedRestart",
				}),
			);
			expect(report.solver.restarts).toBe(1);
			expect(
				report.realProtocol.solverSpends.tokenInTransfersFromSolver.count,
			).toBe(1);
			expect(
				report.realProtocol.solverSpends.tokenOutTransfersFromSolver.count,
			).toBe(1);
			const order = report.realProtocol.orders[0]!;
			expect(order.order.status).toBe("delivered");
			expect(
				order.timeline.filter((e) => e.kind === "orderDepositSent"),
			).toHaveLength(1);
			expect(
				order.timeline.filter((e) => e.kind === "orderDeliverySent"),
			).toHaveLength(2);
			expect(order.deliveryNotAckedAt).toBeNull();
		},
		TEST_TIMEOUT_MS,
	);
});
