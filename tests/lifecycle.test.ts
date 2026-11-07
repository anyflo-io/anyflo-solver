import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode, encode } from "cbor-x";
import { parseJwt, verifyJwt } from "@anyflo/lib/auth";
import {
	deterministicEncode,
	sign,
	generateEd25519Keypair,
	pubKeyBytes,
	pubKeyFromBytes,
	verifyCanonicalSig,
} from "@anyflo/lib/ed25519";
import { OrderType, type Order } from "@anyflo/lib/order";
import {
	FromHubMsgType as From,
	ToHubMsgType as To,
	type FromHubMsg,
	type ToHubMsg,
} from "@anyflo/lib/solverhub";
import { newFailure, newSuccess, type PResult } from "@anyflo/lib/result";
import { toHex, type Hash, type TransactionReceipt } from "viem";
import { ConfigSchema, type SolverConfig } from "../src/config";
import { CheckpointStore, type OrderCheckpoint } from "../src/checkpoint";
import { HubClient } from "../src/hub";
import { Solver, type EvmLike, type HubLike } from "../src/solver";
import type {
	LiquidityStrategy,
	StrategyQuote,
	SwapResult,
	SwapTransaction,
} from "../src/types";

const IN = `0x${"aa".repeat(20)}` as const,
	OUT = `0x${"bb".repeat(20)}` as const,
	ADDR = `0x${"11".repeat(20)}` as const;
const CHAIN = "eip155:31337";
const INPUT = 990_000n; // explicit 100bps margin, not an incidental config default
const BID = 945_250n;
const key = await generateEd25519Keypair();
const publicKey = await pubKeyFromBytes(await pubKeyBytes(key.publicKey));
let sequence = 1;
const hash = (): Hash => toHex(sequence++, { size: 32 });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	mock.restore();
});

function config(stateDir: string): SolverConfig {
	return ConfigSchema.parse({
		hubUrl: "ws://127.0.0.1:1",
		solverId: 7,
		kid: 2,
		chainId: 31337,
		rpcUrl: "http://127.0.0.1:2",
		depositAccount: `0x${"33".repeat(20)}`,
		deliveryAccount: `0x${"44".repeat(20)}`,
		tokenIn: { address: IN, decimals: 6, symbol: "USDT" },
		tokenOut: { address: OUT, decimals: 6, symbol: "USDC" },
		strategy: "Uniswap",
		marginBps: 100,
		slippageBps: 50,
		quoteTimeoutMs: 5000,
		stateDir,
		finality: "latest",
		uniswapApiKey: "test",
		oneInchApiKey: "test",
	});
}
function order(overrides: Partial<Order> = {}): Order {
	return {
		id: crypto.randomUUID(),
		senderId: crypto.randomUUID(),
		recipientId: null,
		senderAddr: `0x${"77".repeat(20)}`,
		recipientAddr: `0x${"88".repeat(20)}`,
		senderChain: CHAIN,
		recipientChain: CHAIN,
		tokenIn: IN,
		tokenOut: OUT,
		amountIn: 1_000_000n,
		amountOut: 0n,
		typ: OrderType.in,
		status: "bidding",
		solverId: null,
		solverAddress: null,
		directDeposit: false,
		fee: null,
		feeRecipient: null,
		depositExpiresAt: null,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}
function quoted(out = 950_000n): StrategyQuote {
	return {
		amountIn: INPUT,
		expectedOut: out,
		minOut: (out * 9950n) / 10000n,
		expiresAt: Date.now() + 60_000,
		payload: null,
	};
}
function assigned(o: Order): Order {
	return {
		...o,
		status: "selected",
		solverId: 7,
		amountOut: BID,
		fee: 1000n,
		feeRecipient: `0x${"99".repeat(20)}`,
		depositExpiresAt: Date.now() + 60_000,
	};
}
function checkpoint(store: CheckpointStore, id: string): OrderCheckpoint {
	const cp = store.load(id);
	if (!cp || cp === "corrupt") throw new Error("checkpoint missing");
	return cp;
}
async function harness(existing?: string, active: Order[] = []) {
	const dir = existing ?? mkdtempSync(join(tmpdir(), "anyflo-runtime-"));
	const store = await CheckpointStore.open(dir);
	const sent: ToHubMsg[] = [];
	let message: ((m: FromHubMsg) => void | Promise<void>) | undefined;
	const hub: HubLike = {
		start: mock(() => {}),
		close: mock(async () => {}),
		send: mock((m: ToHubMsg) => {
			sent.push(m);
			return true;
		}),
		activeOrders: mock(async () =>
			newSuccess({ orders: active.map((order) => ({ order })) }),
		),
		onMessage: (h) => {
			message = h;
		},
		onOpen: () => {},
		onHalt: () => {},
	};
	const evm: EvmLike = {
		address: ADDR,
		send: mock(async (tx: SwapTransaction): PResult<TransactionReceipt> => {
			try {
				await evm.beforeSpend?.(tx);
				evm.guardSpend?.();
				const h = hash();
				await evm.afterBroadcast?.(h);
				await evm.afterConfirmed?.(h);
				return newSuccess({
					transactionHash: h,
					status: "success",
				} as TransactionReceipt);
			} catch {
				return newFailure(502, "send refused");
			}
		}),
		verifyDeposit: mock(async () => newSuccess(null)),
		verifyDelivery: mock(async () => newSuccess(null)),
		payout: mock(async () =>
			evm.send({
				to: config(dir).deliveryAccount,
				data: "0x12345678",
				value: 0n,
			}),
		),
	};
	const quote = mock(async (_amount: bigint, _signal: AbortSignal) =>
		newSuccess(quoted()),
	);
	const swap = mock(
		async (_q: StrategyQuote, _min: bigint): PResult<SwapResult> => {
			const receipt = await evm.send({
				to: config(dir).universalRouter,
				data: "0xdeadbeef",
				value: 0n,
			});
			return receipt.ok
				? newSuccess({
						hash: receipt.data.transactionHash,
						amountIn: INPUT,
						amountOut: _min + 1000n,
					})
				: receipt;
		},
	);
	const strategy: LiquidityStrategy = { quote, swap };
	const solver = new Solver({
		config: config(dir),
		evm,
		strategy,
		hub,
		store,
		authKey: key.privateKey,
		log: () => {},
	});
	await solver.start();
	cleanups.push(async () => {
		await solver.close();
		if (!existing) rmSync(dir, { recursive: true, force: true });
	});
	const emit = async (m: FromHubMsg) => {
		if (!message) throw new Error("hub not started");
		await message(m);
	};
	const bid = async (o: Order) =>
		emit({
			type: From.NewOrder,
			payload: { order: o, biddingDeadline: Date.now() + 10_000 },
		});
	const assign = async (o: Order) =>
		emit({
			type: From.OrderAssigned,
			payload: { orderId: o.id, winnerId: 7, order: assigned(o) },
		});
	const deposit = async (o: Order, tx = hash()) =>
		emit({
			type: From.OrderDeposit,
			payload: { orderId: o.id, chain: CHAIN, depositTx: tx },
		});
	return {
		solver,
		store,
		hub,
		evm,
		strategy,
		quote,
		swap,
		sent,
		dir,
		emit,
		bid,
		assign,
		deposit,
	};
}

test("bids once on solver-net input minus configured margin, with one slippage haircut and real canonical signatures", async () => {
	const h = await harness(),
		o = order();
	await h.bid(o);
	await h.bid(o);
	const bid = h.sent.find((m) => m.type === To.Bid);
	if (bid?.type !== To.Bid) throw new Error("no bid");
	expect(bid.payload.quote).toBe(BID);
	expect(h.quote.mock.calls[0]?.[0]).toBe(INPUT);
	expect(
		await verifyCanonicalSig(bid.payload, new Uint8Array(bid.sig), publicKey),
	).toBe(true);
	expect(h.quote).toHaveBeenCalledTimes(1);
	await h.assign(o);
	const ack = h.sent.find((m) => m.type === To.OrderAssignAck);
	if (ack?.type !== To.OrderAssignAck) throw new Error("no assignment ack");
	expect(ack.payload.directDeposit).toBe(true);
	expect(
		await verifyCanonicalSig(ack.payload, new Uint8Array(ack.sig), publicKey),
	).toBe(true);
	await h.assign(o);
	expect(h.swap).not.toHaveBeenCalled();
	expect(checkpoint(h.store, o.id).accepted?.amountOut).toBe(BID);
});

test("rejects changed assignment economics and unsupported input without spending", async () => {
	const h = await harness();
	await h.bid(order({ tokenOut: IN }));
	await h.bid(order({ typ: OrderType.out }));
	expect(h.sent).toHaveLength(0);
	const o = order();
	await h.bid(o);
	await h.emit({
		type: From.OrderAssigned,
		payload: {
			orderId: o.id,
			winnerId: 7,
			order: { ...assigned(o), amountIn: o.amountIn + 1n },
		},
	});
	expect(h.sent.some((m) => m.type === To.OrderAssignNotAck)).toBe(true);
	expect(h.swap).not.toHaveBeenCalled();
});

test("refuses a mismatched or already expired quote before bidding", async () => {
	const h = await harness();
	h.quote.mockResolvedValueOnce(
		newSuccess({ ...quoted(), amountIn: INPUT + 1n }),
	);
	await h.bid(order());
	h.quote.mockResolvedValueOnce(
		newSuccess({ ...quoted(), expiresAt: Date.now() - 1 }),
	);
	await h.bid(order());
	expect(h.sent).toHaveLength(0);
	await h.bid(order());
	expect(h.sent.some((m) => m.type === To.Bid)).toBe(true);
});

test("deposit verification and durable state precede ack; exact accepted payout is independently verified", async () => {
	const h = await harness(),
		o = order({ tokenIn: "usdt", tokenOut: "USDC" });
	await h.bid(o);
	await h.assign(o);
	spyOn(h.hub, "send").mockImplementation((m) => {
		if (m.type === To.OrderDepositAck)
			expect(checkpoint(h.store, o.id).phase).toBe("executing");
		h.sent.push(m);
		return true;
	});
	await h.deposit(o);
	expect(h.swap).toHaveBeenCalledTimes(1);
	expect(h.swap.mock.calls[0]?.[1]).toBe(BID);
	expect(h.evm.verifyDeposit).toHaveBeenCalledWith(
		expect.objectContaining({
			tokenIn: IN,
			tokenOut: OUT,
			amountIn: o.amountIn,
			fee: 1000n,
			directDeposit: true,
		}),
		expect.any(String),
	);
	expect(h.evm.payout).toHaveBeenCalledWith(
		expect.objectContaining({ amountOut: BID, recipientAddr: o.recipientAddr }),
	);
	expect(h.evm.verifyDelivery).toHaveBeenCalledTimes(1);
	expect(checkpoint(h.store, o.id).order.tokenIn).toBe("usdt");
	const cp = checkpoint(h.store, o.id);
	await h.emit({
		type: From.OrderDelivery,
		payload: { orderId: o.id, chain: CHAIN, deliverTx: cp.payoutHash! },
	});
	expect(checkpoint(h.store, o.id).phase).toBe("done");
	await h.deposit(o);
	expect(h.swap).toHaveBeenCalledTimes(1);
});

test("late verified funding is retained for reconciliation rather than funding a new order", async () => {
	const h = await harness(),
		o = order();
	await h.bid(o);
	await h.assign(o);
	spyOn(Date, "now").mockReturnValue(Date.now() + 65_000);
	await h.deposit(o);
	expect(checkpoint(h.store, o.id).phase).toBe("blocked");
	expect(h.swap).not.toHaveBeenCalled();
	expect(h.sent.some((m) => m.type === To.OrderDepositAck)).toBe(false);
	await h.bid(order());
	expect(h.quote).toHaveBeenCalledTimes(1);
});

test("cancel arriving during durable intent persistence prevents the following broadcast", async () => {
	const h = await harness(),
		o = order();
	await h.bid(o);
	await h.assign(o);
	let broadcasts = 0,
		cancelled = false,
		cancelDone = Promise.resolve();
	const after = h.evm.afterBroadcast,
		save = h.store.save.bind(h.store);
	h.evm.afterBroadcast = async (tx) => {
		broadcasts++;
		await after?.(tx);
	};
	spyOn(h.store, "save").mockImplementation(async (cp) => {
		await save(cp);
		if (cp.pendingSpend && !cancelled) {
			cancelled = true;
			cancelDone = h.emit({
				type: From.OrderCancelled,
				payload: { orderId: o.id, solverId: 7, reason: "cancel" },
			});
		}
	});
	await h.deposit(o);
	await cancelDone;
	expect(broadcasts).toBe(0);
	expect(h.evm.payout).not.toHaveBeenCalled();
	expect(checkpoint(h.store, o.id).phase).toBe("blocked");
});

test("invalid deposit is disputed; unprofitable fresh quote retains capital without a spend", async () => {
	const h = await harness(),
		o = order();
	await h.bid(o);
	await h.assign(o);
	spyOn(h.evm, "verifyDeposit").mockResolvedValueOnce(
		newFailure(400, { type: "Invalid", reason: "wrong funding" }),
	);
	await h.deposit(o);
	expect(h.sent.some((m) => m.type === To.OrderDepositNotAck)).toBe(true);
	expect(h.swap).not.toHaveBeenCalled();
	const next = order();
	await h.bid(next);
	await h.assign(next);
	h.quote.mockResolvedValueOnce(newSuccess(quoted(900_000n)));
	await h.deposit(next);
	expect(checkpoint(h.store, next.id).phase).toBe("failedMarket");
	expect(h.swap).not.toHaveBeenCalled();
	await h.bid(order());
	expect(h.quote).toHaveBeenCalledTimes(3);
});

test("a confirmed transaction followed by failed receipt semantics is exposure, never a clean retry", async () => {
	const h = await harness(),
		o = order();
	await h.bid(o);
	await h.assign(o);
	h.swap.mockImplementationOnce(async () => {
		await h.evm.send({
			to: config(h.dir).universalRouter,
			data: "0xdeadbeef",
			value: 0n,
		});
		return newFailure(502, "bad receipt movements");
	});
	await h.deposit(o);
	expect(checkpoint(h.store, o.id).phase).toBe("blocked");
	expect(h.evm.payout).not.toHaveBeenCalled();
	await h.deposit(o);
	expect(h.swap).toHaveBeenCalledTimes(1);
});

test("cancel while swap is in flight preempts payout and holds spent exposure", async () => {
	const h = await harness(),
		o = order();
	await h.bid(o);
	await h.assign(o);
	const started = Promise.withResolvers<void>(),
		gate = Promise.withResolvers<void>();
	h.swap.mockImplementationOnce(async () => {
		const r = await h.evm.send({
			to: config(h.dir).universalRouter,
			data: "0xdeadbeef",
			value: 0n,
		});
		started.resolve();
		await gate.promise;
		return r.ok
			? newSuccess({
					hash: r.data.transactionHash,
					amountIn: INPUT,
					amountOut: BID,
				})
			: r;
	});
	const deposited = h.deposit(o);
	await started.promise;
	const cancelled = h.emit({
		type: From.OrderCancelled,
		payload: { orderId: o.id, solverId: 7, reason: "cancel" },
	});
	gate.resolve();
	await deposited;
	await cancelled;
	expect(h.evm.payout).not.toHaveBeenCalled();
	expect(checkpoint(h.store, o.id).phase).toBe("blocked");
});

test("deposit reorg before spend awaits replacement; reorg after swap blocks", async () => {
	const h = await harness(),
		o = order();
	await h.bid(o);
	await h.assign(o);
	await h.emit({
		type: From.OrderDepositReorged,
		payload: { orderId: o.id, txHash: hash(), chain: CHAIN, blockNumber: 1 },
	});
	expect(checkpoint(h.store, o.id).phase).toBe("assigned");
	await h.deposit(o);
	await h.emit({
		type: From.OrderDepositReorged,
		payload: {
			orderId: o.id,
			txHash: checkpoint(h.store, o.id).depositTx!,
			chain: CHAIN,
			blockNumber: 2,
		},
	});
	expect(checkpoint(h.store, o.id).phase).toBe("blocked");
});

test("revocation halts new commitments and any later sends", async () => {
	const h = await harness(),
		o = order();
	await h.bid(o);
	await h.assign(o);
	await h.emit({ type: From.KeyRevoked, payload: { solverId: 7, kid: 2 } });
	await h.deposit(o);
	await h.bid(order());
	expect(h.swap).not.toHaveBeenCalled();
	expect(h.quote).toHaveBeenCalledTimes(1);
});

test("funded and confirmed-spend restart checkpoints require manual reconciliation, never automatic payout", async () => {
	const h = await harness(),
		o = order();
	await h.bid(o);
	await h.assign(o);
	await h.deposit(o);
	const cp = checkpoint(h.store, o.id);
	await h.store.save({ ...cp, phase: "spendIntent" });
	await h.solver.close();
	const restarted = await harness(h.dir, [
		{ ...assigned(o), status: "executing" },
	]);
	expect(checkpoint(restarted.store, o.id).phase).toBe("blocked");
	expect(restarted.swap).not.toHaveBeenCalled();
	expect(restarted.evm.payout).not.toHaveBeenCalled();
});

test("unknown spend restart and missing active checkpoint both fail closed", async () => {
	const h = await harness(),
		o = order();
	await h.bid(o);
	await h.assign(o);
	const cp = checkpoint(h.store, o.id);
	await h.store.save({
		...cp,
		phase: "spendIntent",
		pendingSpend: {
			intent: {
				to: config(h.dir).universalRouter,
				data: "0xdeadbeef",
				value: 0n,
			},
			broadcastHash: null,
			confirmedHash: null,
			at: Date.now(),
		},
	});
	await h.solver.close();
	const restarted = await harness(h.dir);
	expect(checkpoint(restarted.store, o.id).phase).toBe("blocked");
	expect(restarted.swap).not.toHaveBeenCalled();
	const missing = await harness(undefined, [
		{ ...assigned(order()), status: "executing" },
	]);
	expect(missing.hub.start).not.toHaveBeenCalled();
});

test("completed clean restart verifies duplicate receipt before reack and never respends", async () => {
	const h = await harness(),
		o = order();
	await h.bid(o);
	await h.assign(o);
	await h.deposit(o);
	const tx = checkpoint(h.store, o.id).payoutHash!;
	await h.emit({
		type: From.OrderDelivery,
		payload: { orderId: o.id, chain: CHAIN, deliverTx: tx },
	});
	await h.solver.close();
	const restarted = await harness(h.dir);
	await restarted.emit({
		type: From.OrderDelivery,
		payload: { orderId: o.id, chain: CHAIN, deliverTx: tx },
	});
	expect(restarted.evm.verifyDelivery).toHaveBeenCalledTimes(1);
	expect(restarted.sent.some((m) => m.type === To.OrderDeliveryAck)).toBe(true);
	expect(restarted.swap).not.toHaveBeenCalled();
	expect(restarted.evm.payout).not.toHaveBeenCalled();
});

test("corrupt checkpoint and stale PID lock cannot silently authorize a fresh solver", async () => {
	const h = await harness(),
		o = order();
	await h.bid(o);
	await h.solver.close();
	writeFileSync(join(h.dir, "orders", `${o.id}.cbor`), new Uint8Array([0xff]));
	const restarted = await harness(h.dir);
	expect(restarted.hub.start).not.toHaveBeenCalled();
	await restarted.solver.close();
	writeFileSync(
		join(h.dir, ".solver.lock"),
		JSON.stringify({ pid: 2147483647 }),
	);
	await expect(CheckpointStore.open(h.dir)).rejects.toThrow();
});

test("real Hub wire authenticates JWT and canonical bid, preserves CBOR, and accepts heartbeat text", async () => {
	const opened = Promise.withResolvers<void>(),
		received = Promise.withResolvers<void>();
	const o = order();
	let authenticated = false,
		canonical = false;
	const server = Bun.serve({
		port: 0,
		fetch: async (req, srv) => {
			const jwt = parseJwt((req.headers.get("authorization") ?? "").slice(7));
			authenticated = (await verifyJwt(jwt, publicKey)) === null;
			if (!authenticated) return new Response(null, { status: 401 });
			if (new URL(req.url).pathname === "/v1/orders/active")
				return new Response(new Uint8Array(encode({ orders: [] })));
			if (srv.upgrade(req)) return;
			return new Response(null, { status: 400 });
		},
		websocket: {
			open(ws) {
				ws.send("pong");
			},
			async message(_ws, data) {
				if (typeof data === "string") return;
				const msg = decode(new Uint8Array(data)) as ToHubMsg;
				if (msg.type === To.Bid)
					canonical = await verifyCanonicalSig(
						msg.payload,
						new Uint8Array(msg.sig),
						publicKey,
					);
				received.resolve();
			},
		},
	});
	const client = new HubClient({
		hubUrl: `ws://127.0.0.1:${server.port}/connect`,
		solverId: 7,
		kid: 2,
		authKey: key.privateKey,
		onOpen: () => opened.resolve(),
		log: () => {},
	});
	cleanups.push(async () => {
		await client.close();
		server.stop(true);
	});
	client.start();
	await opened.promise;
	const payload = {
		orderId: o.id,
		quote: BID,
		expiresAt: Date.now() + 60_000,
		kid: 2,
		timestamp: Date.now(),
	};
	expect(
		client.send({
			type: To.Bid,
			payload,
			sig: await sign(key.privateKey, deterministicEncode(payload)),
		}),
	).toBe(true);
	await received.promise;
	expect(authenticated && canonical).toBe(true);
	expect((await client.activeOrders()).ok).toBe(true);
});

test("reorg of completed funding or payout blocks subsequent orders rather than disappearing with the old active slot", async () => {
	for (const kind of ["deposit", "delivery"] as const) {
		const h = await harness(),
			o = order();
		await h.bid(o);
		await h.assign(o);
		await h.deposit(o);
		const cp = checkpoint(h.store, o.id);
		await h.emit({
			type: From.OrderDelivery,
			payload: { orderId: o.id, chain: CHAIN, deliverTx: cp.payoutHash! },
		});
		await h.emit({
			type:
				kind === "deposit"
					? From.OrderDepositReorged
					: From.OrderDeliveryReorged,
			payload: {
				orderId: o.id,
				chain: CHAIN,
				txHash: (kind === "deposit" ? cp.depositTx : cp.payoutHash)!,
				blockNumber: 3,
			},
		});
		expect(checkpoint(h.store, o.id).phase).toBe("blocked");
		await h.bid(order());
		expect(h.quote).toHaveBeenCalledTimes(2);
	}
});

test("provider minima cannot weaken the configured maximum slippage at bid or fresh execution", async () => {
	const h = await harness();
	h.quote.mockResolvedValueOnce(newSuccess({ ...quoted(), minOut: BID - 1n }));
	await h.bid(order());
	expect(h.sent).toHaveLength(0);
	const o = order();
	await h.bid(o);
	await h.assign(o);
	h.quote.mockResolvedValueOnce(
		newSuccess({ ...quoted(960_000n), minOut: 950_000n }),
	);
	await h.deposit(o);
	expect(h.swap).not.toHaveBeenCalled();
	expect(checkpoint(h.store, o.id).phase).toBe("failedMarket");
});

test("a stricter fresh protected floor is enforced on the swap without repricing the accepted payout", async () => {
	const h = await harness(),
		o = order();
	await h.bid(o);
	await h.assign(o);
	const fresh = { ...quoted(960_000n), minOut: 955_201n };
	h.quote.mockResolvedValueOnce(newSuccess(fresh));
	await h.deposit(o);
	expect(h.swap.mock.calls[0]?.[1]).toBe(fresh.minOut);
	expect(h.evm.payout).toHaveBeenCalledWith(
		expect.objectContaining({ amountOut: BID }),
	);
});
