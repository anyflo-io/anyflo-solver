import { isAddress, type Address, type Hex } from "viem";
import { z } from "zod";

const AddressSchema = z
	.string()
	.refine(
		(v) => isAddress(v) && BigInt(v) !== 0n,
		"Invalid or zero EVM address",
	)
	.transform((v) => v as Address);
const HexSchema = z
	.string()
	.regex(/^0x(?:[0-9a-fA-F]{2})*$/)
	.transform((v) => v as Hex);
export const TokenSchema = z.object({
	address: AddressSchema,
	decimals: z.number().int().min(0).max(18),
	symbol: z.string().min(1),
});
export const AquaPositionSchema = z.object({
	maker: AddressSchema,
	app: AddressSchema,
	strategyHash: HexSchema.refine((v) => v.length === 66),
	strategyBytes: HexSchema.refine((v) => v.length > 2),
});
export type AquaPosition = z.infer<typeof AquaPositionSchema>;
export const ConfigSchema = z
	.object({
		hubUrl: z.string().url(),
		solverId: z.number().int().positive(),
		kid: z.number().int().positive(),
		chainId: z.union([z.literal(8453), z.literal(31337)]),
		rpcUrl: z.string().url(),
		depositAccount: AddressSchema,
		deliveryAccount: AddressSchema,
		tokenIn: TokenSchema,
		tokenOut: TokenSchema,
		strategy: z.enum(["Uniswap", "Aqua"]),
		marginBps: z.number().int().min(0).max(9999).default(10),
		slippageBps: z.number().int().min(1).max(1000).default(50),
		quoteTimeoutMs: z.number().int().positive().max(30000).default(5000),
		stateDir: z.string().min(1).default("private/state"),
		finality: z.enum(["latest", "safe", "finalized"]).default("safe"),
		uniswapApiKey: z.string().min(1),
		oneInchApiKey: z.string().min(1),
		uniswapApiUrl: z
			.string()
			.url()
			.default("https://trade-api.gateway.uniswap.org/v1"),
		oneInchApiUrl: z.string().url().default("https://api.1inch.com/swap/v6.1"),
		universalRouter: AddressSchema.default(
			"0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40",
		),
		permit2: AddressSchema.default(
			"0x000000000022D473030F116dDEE9F6B43aC78BA3",
		),
		aqua: AquaPositionSchema.optional(),
	})
	.strict()
	.superRefine((c, ctx) => {
		if (c.tokenIn.address.toLowerCase() === c.tokenOut.address.toLowerCase())
			ctx.addIssue({
				code: "custom",
				message: "Input and output tokens must differ",
			});
		if (c.strategy === "Aqua" && !c.aqua)
			ctx.addIssue({
				code: "custom",
				message: "Aqua requires a configured position",
			});
		for (const [key, value] of [
			["hubUrl", c.hubUrl],
			["rpcUrl", c.rpcUrl],
			["uniswapApiUrl", c.uniswapApiUrl],
			["oneInchApiUrl", c.oneInchApiUrl],
		] as const) {
			const u = new URL(value);
			const local =
				c.chainId === 31337 &&
				["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
			if (!local && !["https:", "wss:"].includes(u.protocol))
				ctx.addIssue({
					code: "custom",
					path: [key],
					message: "Live connections require TLS",
				});
			if (u.username || u.password)
				ctx.addIssue({
					code: "custom",
					path: [key],
					message: "URL credentials are not supported",
				});
			if (key !== "hubUrl" && !["http:", "https:"].includes(u.protocol))
				ctx.addIssue({
					code: "custom",
					path: [key],
					message: "RPC and API URLs require HTTP(S)",
				});
			if (
				key === "hubUrl" &&
				!["http:", "https:", "ws:", "wss:"].includes(u.protocol)
			)
				ctx.addIssue({
					code: "custom",
					path: [key],
					message: "Hub URL requires WebSocket or HTTP(S)",
				});
		}
		if (c.chainId === 8453) {
			if (
				c.uniswapApiUrl !== "https://trade-api.gateway.uniswap.org/v1" ||
				c.oneInchApiUrl !== "https://api.1inch.com/swap/v6.1"
			)
				ctx.addIssue({
					code: "custom",
					message:
						"Live API credentials may only be sent to official provider hosts",
				});
			if (
				c.universalRouter.toLowerCase() !==
					"0xd6145b2d3f379919e8cdeda7b97e37c4b2ca9c40" ||
				c.permit2.toLowerCase() !== "0x000000000022d473030f116ddee9f6b43ac78ba3"
			)
				ctx.addIssue({
					code: "custom",
					message: "Unexpected Base router or Permit2 deployment",
				});
		}
	});
export type SolverConfig = z.infer<typeof ConfigSchema>;
export async function loadConfig(path: string): Promise<SolverConfig> {
	const parsed = ConfigSchema.safeParse(await Bun.file(path).json());
	if (!parsed.success)
		throw new Error(
			`Invalid Solver config: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
		);
	return parsed.data;
}
