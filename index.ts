import { parseArgs } from "node:util";
import { erc20Abi, type Hex } from "viem";
import { z } from "zod";

import { fromJwk } from "@anyflo/lib/ed25519";
import { logError, logger } from "@anyflo/lib/logger";

import { createAquaStrategy } from "./src/aqua";
import { loadConfig } from "./src/config";
import { Evm } from "./src/evm";
import { runSolver } from "./src/solver";
import { createUniswapStrategy } from "./src/uniswap";

class UsageError extends Error {}

async function main(): Promise<void> {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			config: { type: "string", default: "private/solver.config.json" },
			check: { type: "boolean", default: false },
			execute: { type: "boolean", default: false },
			amount: { type: "string", default: "10000000" },
			help: { type: "boolean", default: false },
		},
	});
	if (values.help) {
		process.stdout.write(
			"Anyflo DeFi Provider\n  bun run start --config <private.json> --check [--amount <base-units>]\n  bun run start --config <private.json> --execute\n\n--check is read-only. --execute authorizes automatic funded-order transactions.\nEVM_PRIVATE_KEY and SOLVER_AUTH_JWK are private environment inputs.\n",
		);
		return;
	}
	if (values.check === values.execute)
		throw new UsageError(
			"Choose exactly one of --check (read-only) or --execute",
		);
	const config = await loadConfig(values.config!).catch((error: unknown) => {
		throw new UsageError(
			error instanceof Error &&
				error.message.startsWith("Invalid Solver config:")
				? error.message
				: "Cannot read private configuration file",
		);
	});
	const privateKey = process.env.EVM_PRIVATE_KEY;
	if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey))
		throw new UsageError(
			"EVM_PRIVATE_KEY must be a private 32-byte hex environment value",
		);
	const evm = new Evm(config, privateKey as Hex);
	if ((await evm.client.getChainId()) !== config.chainId)
		throw new UsageError("Configured RPC chain mismatch");
	for (const address of [
		config.depositAccount,
		config.deliveryAccount,
		config.tokenIn.address,
		config.tokenOut.address,
		config.universalRouter,
		config.permit2,
		...(config.aqua ? [config.aqua.app] : []),
	]) {
		const code = await evm.client.getCode({ address });
		if (!code || code === "0x")
			throw new UsageError(`Missing deployed contract at ${address}`);
	}
	for (const token of [config.tokenIn, config.tokenOut]) {
		const decimals = await evm.client.readContract({
			address: token.address,
			abi: erc20Abi,
			functionName: "decimals",
		});
		if (decimals !== token.decimals)
			throw new UsageError(`Unexpected decimals for ${token.symbol}`);
	}
	const strategy =
		config.strategy === "Uniswap"
			? createUniswapStrategy(config, evm)
			: createAquaStrategy(config, evm);
	if (values.check) {
		if (!/^[1-9][0-9]*$/.test(values.amount!))
			throw new UsageError("--amount must be positive integer base units");
		const result = await strategy.quote(
			BigInt(values.amount!),
			AbortSignal.timeout(config.quoteTimeoutMs),
		);
		if (!result.ok)
			throw new UsageError(
				"Selected strategy quote unavailable; check pair, amount, API access and position backing",
			);
		logger.info({
			msg: "Read-only preflight passed",
			strategy: config.strategy,
			chainId: config.chainId,
			amountIn: result.data.amountIn.toString(),
			expectedOut: result.data.expectedOut.toString(),
			minOut: result.data.minOut.toString(),
			referenceSource: result.data.reference?.source ?? null,
		});
		return;
	}
	let authKey: CryptoKey;
	try {
		const auth = z
			.object({
				kty: z.literal("OKP"),
				crv: z.literal("Ed25519"),
				x: z.string().min(1),
				d: z.string().min(1),
			})
			.parse(JSON.parse(process.env.SOLVER_AUTH_JWK ?? "null"));
		authKey = await fromJwk(auth);
	} catch {
		throw new UsageError(
			"SOLVER_AUTH_JWK must contain a valid private Ed25519 JWK",
		);
	}
	const running = await runSolver(config, evm, strategy, authKey);
	const stop = () => {
		void running
			.close()
			.then(() => process.exit(0))
			.catch(() => process.exit(1));
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	logger.info({
		msg: "Solver connected",
		strategy: config.strategy,
		chainId: config.chainId,
		address: evm.address,
	});
}
if (import.meta.main) {
	main().catch((error: unknown) => {
		logError(
			{ method: "main", msg: "Solver stopped" },
			error instanceof UsageError
				? error
				: new Error(
						"RPC/provider operation failed; inspect connectivity and pending state. Private provider errors are not logged.",
					),
		);
		process.exitCode = 1;
	});
}
