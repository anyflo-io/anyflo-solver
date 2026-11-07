// LOCAL HTTP mocks, never live-provider evidence. Uniswap quotes execute the official
// QuoterV2 against the real local V3 pool. /swap embeds exactly the client's canonical
// PermitSingle signature and honors the live API's explicit simulateTransaction option.
// The 1inch endpoint is a clearly labeled local reference, not a live aggregator.
import {
	createPublicClient,
	encodeAbiParameters,
	encodeFunctionData,
	encodePacked,
	erc20Abi,
	http,
	parseAbi,
	recoverTypedDataAddress,
	type Address,
	type Hex,
} from "viem";
import { foundry } from "viem/chains";
import type { DemoFixture } from "./chain";
import { isDeepStrictEqual } from "node:util";

const POOL_FEE = 500;
const PERMIT_TYPES = {
	PermitDetails: [
		{ name: "token", type: "address" },
		{ name: "amount", type: "uint160" },
		{ name: "expiration", type: "uint48" },
		{ name: "nonce", type: "uint48" },
	],
	PermitSingle: [
		{ name: "details", type: "PermitDetails" },
		{ name: "spender", type: "address" },
		{ name: "sigDeadline", type: "uint256" },
	],
} as const;
const permitAbi = parseAbi([
	"function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);
const quoterAbi = parseAbi([
	"function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const executeAbi = parseAbi([
	"function execute(bytes commands,bytes[] inputs,uint256 deadline) payable",
]);
const permitInputAbi = [
	{
		type: "tuple",
		components: [
			{
				type: "tuple",
				name: "details",
				components: [
					{ type: "address", name: "token" },
					{ type: "uint160", name: "amount" },
					{ type: "uint48", name: "expiration" },
					{ type: "uint48", name: "nonce" },
				],
			},
			{ type: "address", name: "spender" },
			{ type: "uint256", name: "sigDeadline" },
		],
	},
	{ type: "bytes" },
] as const;

type PermitMessage = {
	details: {
		token: Address;
		amount: bigint;
		expiration: number;
		nonce: number;
	};
	spender: Address;
	sigDeadline: bigint;
};
interface IssuedQuote {
	quote: {
		quoteId: string;
		input: { token: Address; amount: string };
		output: { token: Address; amount: string };
		slippage: number;
	};
	permitData: {
		domain: { name: string; chainId: number; verifyingContract: Address };
		types: typeof PERMIT_TYPES;
		values: PermitMessage;
	};
	swapper: Address;
	minOut: bigint;
}
export interface DemoProviderHandle {
	uniswapUrl: string;
	oneInchUrl: string;
	port: number;
	close(): Promise<void>;
}
export interface DemoProviderOptions {
	fixture: DemoFixture;
	host?: string;
	port?: number;
}
const stringify = (body: unknown) =>
	JSON.stringify(body, (_key, value) =>
		typeof value === "bigint" ? value.toString() : value,
	);
function json(
	body: unknown,
	status = 200,
	headers: Record<string, string> = {},
): Response {
	return new Response(stringify(body), {
		status,
		headers: {
			"content-type": "application/json",
			"x-demo-fixture": "anyflo-local-mock",
			...headers,
		},
	});
}
const error = (detail: string, status = 400) => json({ detail }, status);
const same = (a: unknown, b: string) =>
	typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const address = (value: unknown): value is Address =>
	typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
const amount = (value: unknown): bigint => {
	if (
		typeof value !== "string" ||
		!/^[0-9]+$/.test(value) ||
		BigInt(value) <= 0n
	)
		throw new Error("Expected positive decimal amount");
	return BigInt(value);
};

export async function startDemoProvider(
	opts: DemoProviderOptions,
): Promise<DemoProviderHandle> {
	const { fixture } = opts;
	const host = opts.host ?? "127.0.0.1";
	if (!["127.0.0.1", "localhost", "::1"].includes(host))
		throw new Error("Demo provider must bind loopback");
	const pub = createPublicClient({
		chain: foundry,
		transport: http(fixture.rpcUrl, { retryCount: 0, timeout: 5_000 }),
	});
	const issued = new Map<string, IssuedQuote>();

	async function quoteAmount(amountIn: bigint): Promise<bigint> {
		const { result } = await pub.simulateContract({
			address: fixture.uniswapV3Quoter,
			abi: quoterAbi,
			functionName: "quoteExactInputSingle",
			args: [
				{
					tokenIn: fixture.tokenIn.address,
					tokenOut: fixture.tokenOut.address,
					amountIn,
					fee: POOL_FEE,
					sqrtPriceLimitX96: 0n,
				},
			],
		});
		if (result[0] <= 0n) throw new Error("Real V3 pool produced no output");
		return result[0];
	}
	async function handleQuote(request: Request): Promise<Response> {
		const body = (await request.json()) as Record<string, unknown>;
		if (
			!address(body.swapper) ||
			!same(body.tokenIn, fixture.tokenIn.address) ||
			!same(body.tokenOut, fixture.tokenOut.address) ||
			body.type !== "EXACT_INPUT" ||
			body.tokenInChainId !== 31337 ||
			body.tokenOutChainId !== 31337
		)
			return error(
				"Expected configured pair, numeric local chain IDs and EXACT_INPUT",
			);
		const amountIn = amount(body.amount);
		const slippage = body.slippageTolerance;
		if (
			typeof slippage !== "number" ||
			!Number.isFinite(slippage) ||
			slippage <= 0 ||
			slippage > 10
		)
			return error("Invalid slippage percentage");
		const [amountOut, allowance] = await Promise.all([
			quoteAmount(amountIn),
			pub.readContract({
				address: fixture.permit2,
				abi: permitAbi,
				functionName: "allowance",
				args: [body.swapper, fixture.tokenIn.address, fixture.universalRouter],
			}),
		]);
		const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
		const entry: IssuedQuote = {
			quote: {
				quoteId: crypto.randomUUID(),
				input: { token: fixture.tokenIn.address, amount: amountIn.toString() },
				output: {
					token: fixture.tokenOut.address,
					amount: amountOut.toString(),
				},
				slippage,
			},
			permitData: {
				domain: {
					name: "Permit2",
					chainId: 31337,
					verifyingContract: fixture.permit2,
				},
				types: PERMIT_TYPES,
				values: {
					details: {
						token: fixture.tokenIn.address,
						amount: amountIn,
						expiration: Number(deadline),
						nonce: allowance[2],
					},
					spender: fixture.universalRouter,
					sigDeadline: deadline,
				},
			},
			swapper: body.swapper,
			minOut:
				(amountOut * (10_000n - BigInt(Math.round(slippage * 100)))) / 10_000n,
		};
		for (const [id, old] of issued)
			if (
				old.permitData.values.sigDeadline <
				BigInt(Math.floor(Date.now() / 1000))
			)
				issued.delete(id);
		issued.set(entry.quote.quoteId, entry);
		return json({
			routing: "CLASSIC",
			quote: entry.quote,
			permitData: entry.permitData,
		});
	}
	async function handleApproval(request: Request): Promise<Response> {
		const body = (await request.json()) as Record<string, unknown>;
		if (
			!address(body.walletAddress) ||
			!same(body.token, fixture.tokenIn.address) ||
			body.chainId !== 31337
		)
			return error("Invalid approval chain/token/wallet");
		const amountIn = amount(body.amount);
		const allowance = await pub.readContract({
			address: fixture.tokenIn.address,
			abi: erc20Abi,
			functionName: "allowance",
			args: [body.walletAddress, fixture.permit2],
		});
		return json({
			approval:
				allowance >= amountIn
					? null
					: {
							to: fixture.tokenIn.address,
							from: body.walletAddress,
							chainId: 31337,
							value: "0",
							data: encodeFunctionData({
								abi: erc20Abi,
								functionName: "approve",
								args: [fixture.permit2, amountIn],
							}),
						},
		});
	}
	async function handleSwap(request: Request): Promise<Response> {
		const body = (await request.json()) as {
			quote?: { quoteId?: string };
			permitData?: unknown;
			signature?: Hex;
			simulateTransaction?: boolean;
			deadline?: number;
		};
		const entry = body.quote?.quoteId
			? issued.get(body.quote.quoteId)
			: undefined;
		if (
			!entry ||
			!isDeepStrictEqual(body.quote, entry.quote) ||
			!isDeepStrictEqual(
				body.permitData,
				JSON.parse(stringify(entry.permitData)),
			) ||
			!body.signature
		)
			return error(
				"Swap must echo an issued quote and permitData with the client signature",
			);
		const message = entry.permitData.values;
		if (message.sigDeadline <= BigInt(Math.floor(Date.now() / 1000)))
			return error("Permit expired");
		const signer = await recoverTypedDataAddress({
			domain: entry.permitData.domain,
			types: PERMIT_TYPES,
			primaryType: "PermitSingle",
			message,
			signature: body.signature,
		});
		if (!same(signer, entry.swapper))
			return error("Client signature does not authorize issued quote");
		const amountIn = BigInt(entry.quote.input.amount);
		const permitInput = encodeAbiParameters(permitInputAbi, [
			message,
			body.signature,
		]);
		const swapInput = encodeAbiParameters(
			[
				{ type: "address" },
				{ type: "uint256" },
				{ type: "uint256" },
				{ type: "bytes" },
				{ type: "bool" },
				{ type: "uint256[]" },
			],
			[
				entry.swapper,
				amountIn,
				entry.minOut,
				encodePacked(
					["address", "uint24", "address"],
					[fixture.tokenIn.address, POOL_FEE, fixture.tokenOut.address],
				),
				true,
				[(entry.minOut * 10n ** 36n) / amountIn],
			],
		);
		const deadline =
			body.deadline === undefined ? message.sigDeadline : BigInt(body.deadline);
		if (
			deadline <= BigInt(Math.floor(Date.now() / 1000)) ||
			deadline > message.sigDeadline
		)
			return error("Swap deadline outside the issued permit lifetime");
		const data = encodeFunctionData({
			abi: executeAbi,
			functionName: "execute",
			args: ["0x0a00", [permitInput, swapInput], deadline],
		});
		// Like the live API, allow transaction construction before ERC20 approval when explicitly
		// requested. The solver still validates the plan, journals its bounded approval, then
		// independently simulates and verifies the actual mined swap receipt through Evm.send.
		if (body.simulateTransaction !== false)
			await pub.call({
				to: fixture.universalRouter,
				data,
				account: entry.swapper,
			});
		return json({
			swap: {
				to: fixture.universalRouter,
				from: entry.swapper,
				data,
				value: "0",
				chainId: 31337,
			},
		});
	}
	const server = Bun.serve({
		hostname: host,
		port: opts.port ?? 0,
		async fetch(request): Promise<Response> {
			const url = new URL(request.url);
			try {
				if (request.method === "POST" && url.pathname === "/v1/quote")
					return await handleQuote(request);
				if (request.method === "POST" && url.pathname === "/v1/check_approval")
					return await handleApproval(request);
				if (request.method === "POST" && url.pathname === "/v1/swap")
					return await handleSwap(request);
				if (
					request.method === "GET" &&
					url.pathname === "/oneinch/swap/v6.1/31337/quote"
				) {
					if (
						!same(url.searchParams.get("src"), fixture.tokenIn.address) ||
						!same(url.searchParams.get("dst"), fixture.tokenOut.address)
					)
						return error("Reference pair mismatch");
					return json(
						{
							dstAmount: (
								await quoteAmount(amount(url.searchParams.get("amount")))
							).toString(),
							protocols: [],
							_anyfloDemoFake:
								"LOCAL V3 QuoterV2 reference, NOT the 1inch Classic API",
						},
						200,
						{ "x-demo-fake": "1inch-reference-local-mock" },
					);
				}
				return error("No local mock route", 404);
			} catch {
				return error(
					"Local provider request or onchain simulation failed",
					503,
				);
			}
		},
	});
	const base = `http://${host}:${server.port}`;
	return {
		uniswapUrl: `${base}/v1`,
		oneInchUrl: `${base}/oneinch/swap/v6.1`,
		port: server.port!,
		async close() {
			await server.stop(true);
		},
	};
}
