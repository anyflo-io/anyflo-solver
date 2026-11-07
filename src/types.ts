import type { Address, Hash, Hex } from "viem";

import type { PResult } from "@anyflo/lib/result";

export interface SwapTransaction {
	to: Address;
	data: Hex;
	value: bigint;
}
export type SpendIntent = SwapTransaction;
export interface MarketReferenceQuote {
	source: "1inchClassic";
	amountIn: bigint;
	amountOut: bigint;
	protocols: unknown;
	timestamp: number;
}
export interface StrategyQuote {
	amountIn: bigint;
	expectedOut: bigint;
	minOut: bigint;
	expiresAt: number;
	payload: unknown;
	reference?: MarketReferenceQuote;
}
export interface SwapResult {
	hash: Hash;
	amountIn: bigint;
	amountOut: bigint;
}
export interface LiquidityStrategy {
	quote(amountIn: bigint, signal: AbortSignal): PResult<StrategyQuote>;
	swap(quote: StrategyQuote, minOut: bigint): PResult<SwapResult>;
}
export interface DepositError {
	type: "Pending" | "Invalid";
	reason: string;
}
