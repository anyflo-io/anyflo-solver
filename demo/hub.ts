/**
 * Mock Anyflo Solver Hub for the local demo (`bun run demo`, tests/demo.test.ts).
 *
 * Simulates the EXISTING Anyflo Solver Hub API surface, not an alternate protocol:
 * - `GET /v1/orders/active` (CBOR `ActiveOrdersResp`) and the `/connect` WebSocket on one
 *   Bun.serve port, both authenticated with the real Ed25519 Bearer JWT
 *   (`@anyflo/lib/auth.verifyJwt`, audience `anyflo:solver-hub`, lifetime ≤ 900s).
 * - Strict `ToHubMsg` envelopes from `@anyflo/lib/solverhub` (cbor-x framing); unknown or
 *   malformed frames close the socket; text frames are `ping`/`pong` heartbeats only.
 * - Canonical Ed25519 signatures on `Bid` and `OrderAssignAck`
 *   (`@anyflo/lib/ed25519.verifyCanonicalSig`) with timestamp freshness, kid and duplicate
 *   checks. Ordinary deposit/delivery Ack/NotAck frames stay unsigned, as specified.
 * - Synthetic customer with a fixed-input order: solver-net `amountIn`, protocol fee
 *   separate, 10s bidding window and the unchanged 1.5s accept deadline, `directDeposit: true`.
 * - `OrderDeposit`/`OrderDelivery` notifications are emitted only after REAL local receipts
 *   observed through injected effects. This file never invents tx hashes, balances or
 *   on-chain success.
 * - `revoke()`/`suspend()` exercise the realistic KeyRevoked/SolverSuspended closes.
 *
 * Mock boundary (does NOT prove the real backend): single solver, in-memory state, no
 * reorg/reassignment flows, instruction `signature` field is a mock marker and is not
 * cryptographically verified by this mock.
 */
import { encode, decode } from "cbor-x";

import type { ServerWebSocket } from "bun";
import { parseJwtFromHeader, verifyJwt } from "@anyflo/lib/auth";
import { verifyCanonicalSig } from "@anyflo/lib/ed25519";
import {
	OrderDeadlines,
	OrderSchema,
	OrderType,
	validateQuote,
	type Order,
	type OrderDetails,
	type OrderStatus,
} from "@anyflo/lib/order";
import {
	ActiveOrdersRespSchema,
	FromHubMsgType,
	HEARTBEAT_PING,
	HEARTBEAT_PONG,
	ToHubMsgSchema,
	ToHubMsgType,
	WS_CLOSE_KEY_REVOKED,
	WS_CLOSE_SOLVER_SUSPENDED,
	type MsgToHubOrderAssignAck,
	type MsgToHubBid,
} from "@anyflo/lib/solverhub";

const TIMESTAMP_FRESHNESS_MS = 5_000;
const BIDDING_MS = 10_000; // demo auction configured per plan
const DEPOSIT_WINDOW_MS = 120_000;
const WAIT_POLL_MS = 25;

/** How the synthetic customer funds (or mistakes) the deposit for an order. */
export type DepositMode =
	| { kind: "full" } // solver-net amountIn + fee deposited for the order
	| { kind: "shortfall" }; // half the solver-net amount (fee intact): real receipt that must fail solver verification

export interface DeliveryObserved {
	txHash: string;
	/** bytes16 payout order reference as hex (expected: order UUID bytes) */
	ref: string;
	recipient: string;
	token: string;
	amount: bigint;
}

export interface MockHubOptions {
	port?: number; // default: ephemeral
	solverId: number;
	kid: number;
	/** Registered solver public key (JWT + canonical signatures are verified against it). */
	solverPublicKey: CryptoKey;
	/** Expected signer payout address on OrderAssignAck; mismatch cancels the assignment. */
	expectedSolverAddress: string;
	chain: string; // e.g. "eip155:31337"
	customerAddress: string;
	feeRecipient: string;
	tokenIn: { address: string; symbol: string; decimals: number };
	tokenOut: { address: string; symbol: string; decimals: number };
	depositAccount: string;
	feeBps: number;
	biddingMs?: number;
	acceptMs?: number;
	depositWindowMs?: number;
	/** REAL customer deposit effect. Must resolve only after observing an actual receipt. */
	sendCustomerDeposit(args: {
		orderId: string;
		token: string;
		solverAmount: bigint;
		fee: bigint;
		solver: string;
	}): Promise<{ txHash: string }>;
	/** REAL delivery observation (indexer stand-in): callback fires on actual payout receipts. */
	watchDeliveries(cb: (delivery: DeliveryObserved) => void): () => void;
}

export type HubEventKind =
	| "wsOpened"
	| "wsClosed"
	| "frameRejected"
	| "heartbeat"
	| "activeOrdersServed"
	| "unauthorized"
	| "keyRevokedSent"
	| "solverSuspendedSent"
	| "newOrderEmitted"
	| "bidReceived"
	| "bidRejected"
	| "bidAckSent"
	| "biddingClosed"
	| "orderAssignedSent"
	| "assignAckReceived"
	| "assignAckRejected"
	| "orderCancelledSent"
	| "statusChanged"
	| "customerDepositSent"
	| "orderDepositSent"
	| "depositAckReceived"
	| "depositNotAckReceived"
	| "deliveryObserved"
	| "deliveryAnomaly"
	| "orderDeliverySent"
	| "deliveryAckReceived"
	| "deliveryNotAckReceived";

export interface HubEvent {
	seq: number;
	at: number;
	kind: HubEventKind;
	orderId?: string;
	detail?: Record<string, unknown>;
}

export interface HubBidRecord {
	solverId: number;
	quote: bigint;
	expiresAt: number;
	kid: number;
	timestamp: number;
	revision: number;
	sigValid: boolean;
	receivedAt: number;
}

export interface HubOrderReport {
	order: Order;
	bids: HubBidRecord[];
	winnerBid: HubBidRecord | null;
	assignAckedAt: number | null;
	depositAckedAt: number | null;
	depositNotAckedAt: number | null;
	deliveryAckedAt: number | null;
	deliveryNotAckedAt: number | null;
	deliverTx: string | null;
	customerDeposits: Array<{
		mode: DepositMode["kind"];
		solverAmount: bigint;
		fee: bigint;
		txHash: string;
	}>;
	timeline: HubEvent[];
}

interface HubOrderState extends HubOrderReport {
	acceptTimer: ReturnType<typeof setTimeout> | undefined;
	biddingTimer: ReturnType<typeof setTimeout> | undefined;
	biddingCloseAt: number;
	acceptDeadline: number;
}

export interface MockHubHandle {
	port: number;
	/** WebSocket URL of the /connect endpoint (the config `hubUrl` shape). */
	url: string;
	createOrder(args: { amountIn: bigint; recipientAddr: string }): Order;
	customerDeposit(orderId: string, mode: DepositMode): Promise<void>;
	/** Replay the existing real payout notification, without another deposit or transaction. */
	replayDelivery(orderId: string): void;
	/** True while the solver's authenticated WebSocket is open. */
	connected(): boolean;
	activeSyncs(): number;
	waitFor(
		predicate: (hub: MockHubHandle) => boolean | Promise<boolean>,
		timeoutMs: number,
		label: string,
	): Promise<void>;
	/** Send KeyRevoked and close the socket with the reserved close code (4001). */
	revoke(): void;
	/** Send SolverSuspended and close the socket with the reserved close code (4002). */
	suspend(): void;
	report(): { orders: HubOrderReport[] };
	stop(): Promise<void>;
}

interface WsData {
	solverId: number;
}

function bytes16ToUuid(ref: string): string | null {
	const hex = ref.startsWith("0x") ? ref.slice(2) : ref;
	if (!/^[0-9a-fA-F]{32}$/.test(hex)) return null;
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** cbor-x returns Uint8Array views over possibly-shared buffers; copy so WebCrypto type checks
 * see a plain ArrayBuffer-backed view. */
function sigBytes(sig: Uint8Array): Uint8Array<ArrayBuffer> {
	return new Uint8Array(sig);
}

function isFreshTimestamp(timestamp: number, now: number): boolean {
	return Math.abs(now - timestamp) <= TIMESTAMP_FRESHNESS_MS;
}

function replayKey(payload: object, sig: Uint8Array): string {
	const payloadJson = JSON.stringify(payload, (_k, v) =>
		typeof v === "bigint" ? `#bigint:${v}` : v,
	);
	return `${payloadJson}|${Buffer.from(sig).toString("hex")}`;
}

export function startMockHub(opts: MockHubOptions): MockHubHandle {
	const biddingMs = opts.biddingMs ?? BIDDING_MS;
	const acceptMs = opts.acceptMs ?? OrderDeadlines.accept;
	const depositWindowMs = opts.depositWindowMs ?? DEPOSIT_WINDOW_MS;
	const customerUuid = crypto.randomUUID();

	const orders = new Map<string, HubOrderState>();
	const events: HubEvent[] = [];
	let seq = 0;
	let activeSyncs = 0;
	let socket: import("bun").ServerWebSocket<WsData> | null = null;
	const acceptedBidSignatures = new Set<string>();
	let stopWatchingDeliveries: (() => void) | null = null;
	let closed = false;
	let frameQueue = Promise.resolve();

	function record(
		kind: HubEventKind,
		orderId?: string,
		detail?: Record<string, unknown>,
	): void {
		const event: HubEvent = {
			seq: ++seq,
			at: Date.now(),
			kind,
			orderId,
			detail,
		};
		events.push(event);
		if (orderId) orders.get(orderId)?.timeline.push(event);
	}

	function send(msg: Record<string, unknown>): void {
		if (!socket || socket.readyState !== WebSocket.OPEN) return;
		socket.sendBinary(encode(msg));
	}

	function patchStatus(
		order: HubOrderState,
		to: OrderStatus,
		detail?: Record<string, unknown>,
	): void {
		const from = order.order.status;
		order.order.status = to;
		order.order.updatedAt = Date.now();
		record("statusChanged", order.order.id, { from, to, ...detail });
	}

	function cancelOrder(order: HubOrderState, reason: string): void {
		patchStatus(order, "cancelled", { reason });
		send({
			type: FromHubMsgType.OrderCancelled,
			payload: { orderId: order.order.id, solverId: opts.solverId, reason },
		});
		record("orderCancelledSent", order.order.id, { reason });
	}

	function buildInstructions(order: HubOrderState) {
		return {
			target: opts.depositAccount,
			tokens: [opts.tokenIn.address],
			amounts: [order.order.amountIn + (order.order.fee ?? 0n)],
			fees: [order.order.fee ?? 0n],
			directDeposit: true,
			solverAddress: order.order.solverAddress ?? opts.expectedSolverAddress,
			depositExpiresAt:
				order.order.depositExpiresAt ?? Date.now() + depositWindowMs,
			// Mock marker only — this mock does not reproduce the coordinator's instruction signature.
			signature: `mock-instructions:${order.order.id}`,
		};
	}

	function toDetails(order: HubOrderState): OrderDetails {
		const active = ["accepted", "executing", "depositNotAck"].includes(
			order.order.status,
		);
		return {
			order: { ...order.order },
			instructions: active ? buildInstructions(order) : undefined,
			txs: {
				depositTxs: order.order.depositTx
					? [{ txHash: order.order.depositTx, timestamp: Date.now() }]
					: [],
				deliverTxs: order.deliverTx
					? [{ txHash: order.deliverTx, timestamp: Date.now() }]
					: [],
			},
		};
	}

	async function handleBid(
		payload: MsgToHubBid,
		sig: Uint8Array,
	): Promise<void> {
		const order = orders.get(payload.orderId);
		if (!order || order.order.status !== "bidding") {
			record("bidRejected", payload.orderId, {
				reason: "order not in bidding",
			});
			return;
		}
		const now = Date.now();
		if (payload.kid !== opts.kid) {
			record("bidRejected", payload.orderId, {
				reason: `kid mismatch: ${payload.kid}`,
			});
			return;
		}
		if (!isFreshTimestamp(payload.timestamp, now)) {
			record("bidRejected", payload.orderId, { reason: "stale bid timestamp" });
			return;
		}
		if (
			payload.expiresAt <= now ||
			payload.expiresAt > now + biddingMs + TIMESTAMP_FRESHNESS_MS
		) {
			record("bidRejected", payload.orderId, {
				reason: "quote expiry out of bounds",
			});
			return;
		}
		if (now > order.biddingCloseAt) {
			record("bidRejected", payload.orderId, { reason: "late bid" });
			return;
		}
		const key = replayKey(payload, sig);
		if (
			!(await verifyCanonicalSig(payload, sigBytes(sig), opts.solverPublicKey))
		) {
			record("bidRejected", payload.orderId, {
				reason: "invalid canonical signature",
			});
			return;
		}
		if (
			order.order.status !== "bidding" ||
			Date.now() > order.biddingCloseAt ||
			payload.expiresAt <= Date.now()
		) {
			record("bidRejected", payload.orderId, {
				reason: "auction or bid expired during signature verification",
			});
			return;
		}
		if (acceptedBidSignatures.has(key)) {
			record("bidRejected", payload.orderId, {
				reason: "duplicate bid replay",
			});
			return;
		}
		const quoteError = validateQuote(
			order.order,
			payload.quote,
			opts.tokenIn.decimals,
			opts.tokenOut.decimals,
		);
		if (quoteError) {
			record("bidRejected", payload.orderId, { reason: quoteError });
			return;
		}
		const existingIdx = order.bids.findIndex(
			(b) => b.solverId === opts.solverId,
		);
		const revision =
			existingIdx >= 0 ? order.bids[existingIdx]!.revision + 1 : 1;
		const bidRecord: HubBidRecord = {
			solverId: opts.solverId,
			quote: payload.quote,
			expiresAt: payload.expiresAt,
			kid: payload.kid,
			timestamp: payload.timestamp,
			revision,
			sigValid: true,
			receivedAt: now,
		};
		if (existingIdx >= 0) order.bids[existingIdx] = bidRecord;
		else order.bids.push(bidRecord);
		acceptedBidSignatures.add(key);
		record("bidReceived", payload.orderId, {
			quote: payload.quote.toString(),
			revision,
		});
		send({
			type: FromHubMsgType.BidAck,
			payload: {
				orderId: payload.orderId,
				solverId: opts.solverId,
				quote: payload.quote,
				rank: 1,
			},
		});
		record("bidAckSent", payload.orderId, { quote: payload.quote.toString() });
	}

	function closeBidding(order: HubOrderState): void {
		if (order.order.status !== "bidding") return;
		const ranked = order.bids
			.filter((bid) => bid.expiresAt > Date.now())
			.sort((a, b) =>
				b.quote === a.quote
					? a.receivedAt - b.receivedAt
					: b.quote > a.quote
						? 1
						: -1,
			);
		const winner = ranked[0] ?? null;
		order.winnerBid = winner;
		record("biddingClosed", order.order.id, {
			bids: order.bids.length,
			winnerQuote: winner?.quote.toString() ?? null,
		});
		if (!winner) {
			patchStatus(order, "expired", { reason: "no bids" });
			return;
		}
		order.order.amountOut = winner.quote;
		order.order.solverId = winner.solverId;
		order.order.depositExpiresAt = Date.now() + depositWindowMs;
		patchStatus(order, "selected", { winnerQuote: winner.quote.toString() });
		order.acceptDeadline = Date.now() + acceptMs;
		send({
			type: FromHubMsgType.OrderAssigned,
			payload: {
				orderId: order.order.id,
				winnerId: winner.solverId,
				order: { ...order.order },
			},
		});
		record("orderAssignedSent", order.order.id, {
			winnerQuote: winner.quote.toString(),
		});
		order.acceptTimer = setTimeout(() => {
			if (order.order.status === "selected") {
				cancelOrder(
					order,
					"accept deadline expired without a signed OrderAssignAck",
				);
			}
		}, acceptMs);
	}

	async function handleToHub(data: unknown): Promise<void> {
		const parsed = ToHubMsgSchema.safeParse(data);
		if (!parsed.success) {
			record("frameRejected", undefined, {
				reason: parsed.error.issues
					.map((i) => `${i.path.join(".")}: ${i.message}`)
					.slice(0, 3),
			});
			socket?.close(1008, "invalid envelope");
			return;
		}
		const msg = parsed.data;
		switch (msg.type) {
			case ToHubMsgType.Bid:
				await handleBid(msg.payload, msg.sig);
				return;
			case ToHubMsgType.OrderAssignAck:
				await handleAssignAck(msg.payload, msg.sig);
				return;
			case ToHubMsgType.OrderDepositAck: {
				const order = orders.get(msg.payload.orderId);
				if (!order || order.depositAckedAt) return; // idempotent re-ack
				order.depositAckedAt = Date.now();
				record("depositAckReceived", order.order.id);
				if (order.order.status === "depositNotAck")
					patchStatus(order, "executing", {
						reason: "deposit re-acknowledged after re-verification",
					});
				return;
			}
			case ToHubMsgType.OrderDepositNotAck: {
				const order = orders.get(msg.payload.orderId);
				if (!order || order.depositNotAckedAt) return;
				order.depositNotAckedAt = Date.now();
				record("depositNotAckReceived", order.order.id);
				if (order.order.status === "executing")
					patchStatus(order, "depositNotAck", {
						reason: "solver deposit verification failed",
					});
				return;
			}
			case ToHubMsgType.OrderDeliveryAck: {
				const order = orders.get(msg.payload.orderId);
				if (!order) return;
				// The solver acks after verifying its own payout receipt; the hub's OrderDelivery
				// observation may arrive later and triggers an idempotent re-ack from the solver.
				if (order.deliveryAckedAt) {
					record("deliveryAckReceived", order.order.id, { idempotent: true });
					return;
				}
				order.deliveryAckedAt = Date.now();
				record("deliveryAckReceived", order.order.id, {
					beforeHubObservation: order.order.status !== "delivered",
				});
				return;
			}
			case ToHubMsgType.OrderDeliveryNotAck: {
				const order = orders.get(msg.payload.orderId);
				if (!order || order.deliveryNotAckedAt) return;
				order.deliveryNotAckedAt = Date.now();
				record("deliveryNotAckReceived", order.order.id, {
					deliverTx: msg.payload.deliverTx,
				});
				if (order.order.status === "delivered")
					patchStatus(order, "deliveredNotAck");
				return;
			}
			case ToHubMsgType.OrderAssignNotAck: {
				const order = orders.get(msg.payload.orderId);
				if (order && order.order.status === "selected") {
					cancelOrder(
						order,
						`solver declined assignment: ${msg.payload.reason}`,
					);
				}
				return;
			}
		}
	}

	async function handleAssignAck(
		payload: MsgToHubOrderAssignAck,
		sig: Uint8Array,
	): Promise<void> {
		const order = orders.get(payload.orderId);
		if (!order || order.order.status !== "selected") {
			record("assignAckRejected", payload.orderId, {
				reason: "order not awaiting acceptance",
			});
			return;
		}
		if (Date.now() > order.acceptDeadline) {
			cancelOrder(order, "accept deadline expired");
			return;
		}
		if (payload.kid !== opts.kid) {
			record("assignAckRejected", payload.orderId, {
				reason: `kid mismatch: ${payload.kid}`,
			});
			return;
		}
		if (!isFreshTimestamp(payload.timestamp, Date.now())) {
			record("assignAckRejected", payload.orderId, {
				reason: "stale ack timestamp",
			});
			return;
		}
		if (!payload.directDeposit) {
			record("assignAckRejected", payload.orderId, {
				reason: "directDeposit flag mismatch",
			});
			cancelOrder(
				order,
				"assignment accepted without the required directDeposit flag",
			);
			return;
		}
		if (
			payload.solverAddress.toLowerCase() !==
			opts.expectedSolverAddress.toLowerCase()
		) {
			record("assignAckRejected", payload.orderId, {
				reason: "solverAddress mismatch",
			});
			cancelOrder(
				order,
				"assigned solver address does not match the registered payout address",
			);
			return;
		}
		if (
			!(await verifyCanonicalSig(payload, sigBytes(sig), opts.solverPublicKey))
		) {
			record("assignAckRejected", payload.orderId, {
				reason: "invalid canonical signature",
			});
			cancelOrder(
				order,
				"OrderAssignAck failed canonical signature verification",
			);
			return;
		}
		if (
			order.order.status !== "selected" ||
			Date.now() > order.acceptDeadline
		) {
			record("assignAckRejected", payload.orderId, {
				reason: "assignment expired during signature verification",
			});
			return;
		}
		order.assignAckedAt = Date.now();
		order.order.solverAddress = payload.solverAddress;
		patchStatus(order, "accepted");
		record("assignAckReceived", order.order.id, { directDeposit: true });
		clearTimeout(order.acceptTimer);
		order.acceptTimer = undefined;
	}

	async function verifyUpgradeJwt(
		req: Request,
	): Promise<{ ok: true; solverId: number } | { ok: false; reason: string }> {
		try {
			const jwt = parseJwtFromHeader(req.headers);
			const err = await verifyJwt(jwt, opts.solverPublicKey);
			if (err) return { ok: false, reason: err.message };
			if (
				jwt.header.kid !== opts.kid ||
				jwt.claims.sub !== String(opts.solverId)
			)
				return { ok: false, reason: "registered subject/kid mismatch" };
			const solverId = opts.solverId;
			return { ok: true, solverId };
		} catch (e) {
			return {
				ok: false,
				reason: `missing or malformed Bearer JWT: ${String(e)}`,
			};
		}
	}

	const server = Bun.serve<WsData>({
		hostname: "127.0.0.1",
		port: opts.port ?? 0,
		fetch: async (req, server): Promise<Response | undefined> => {
			const url = new URL(req.url);
			if (
				url.pathname === "/connect" &&
				req.headers.get("upgrade") === "websocket"
			) {
				const auth = await verifyUpgradeJwt(req);
				if (!auth.ok || auth.solverId !== opts.solverId) {
					record("unauthorized", undefined, {
						path: "/connect",
						reason: auth.ok ? "subject mismatch" : auth.reason,
					});
					return new Response("unauthorized", { status: 401 });
				}
				const upgraded = server.upgrade(req, {
					data: { solverId: auth.solverId },
				});
				if (!upgraded) return new Response("upgrade failed", { status: 500 });
				return;
			}
			if (url.pathname === "/v1/orders/active") {
				const auth = await verifyUpgradeJwt(req);
				if (!auth.ok || auth.solverId !== opts.solverId) {
					record("unauthorized", undefined, {
						path: "/v1/orders/active",
						reason: auth.ok ? "subject mismatch" : auth.reason,
					});
					return new Response("unauthorized", { status: 401 });
				}
				const active = [...orders.values()]
					.filter((o) =>
						["selected", "accepted", "executing", "depositNotAck"].includes(
							o.order.status,
						),
					)
					.map(toDetails);
				const resp = ActiveOrdersRespSchema.parse({ orders: active });
				record("activeOrdersServed", undefined, { count: active.length });
				activeSyncs += 1;
				return new Response(encode(resp), {
					headers: { "content-type": "application/cbor" },
				});
			}
			return new Response("not found", { status: 404 });
		},
		websocket: {
			open(ws) {
				socket = ws;
				record("wsOpened", undefined, { solverId: ws.data.solverId });
			},
			message(ws, message) {
				if (typeof message === "string") {
					if (message === HEARTBEAT_PING) {
						ws.sendText(HEARTBEAT_PONG);
						record("heartbeat");
						return;
					}
					record("frameRejected", undefined, {
						reason: `unexpected text frame: ${JSON.stringify(message.slice(0, 32))}`,
					});
					ws.close(1008, "text frames are heartbeats only");
					return;
				}
				let decoded: unknown;
				try {
					decoded = decode(message);
				} catch (e) {
					record("frameRejected", undefined, {
						reason: `undecodable frame: ${String(e)}`,
					});
					ws.close(1008, "undecodable frame");
					return;
				}
				frameQueue = frameQueue
					.then(() => handleToHub(decoded))
					.catch((e) => {
						record("frameRejected", undefined, {
							reason: `handler error: ${String(e)}`,
						});
					});
			},
			close(ws, code, reason) {
				if (socket === ws) socket = null;
				record("wsClosed", undefined, { code, reason: reason || undefined });
			},
		},
	});

	stopWatchingDeliveries = opts.watchDeliveries((delivery) => {
		const orderId = bytes16ToUuid(delivery.ref);
		const order = orderId ? orders.get(orderId) : undefined;
		if (!order) {
			record("deliveryAnomaly", orderId ?? undefined, {
				reason: "payout for unknown order ref",
				txHash: delivery.txHash,
			});
			return;
		}
		const matches =
			order.order.status === "executing" &&
			delivery.recipient.toLowerCase() ===
				order.order.recipientAddr.toLowerCase() &&
			delivery.token.toLowerCase() === opts.tokenOut.address.toLowerCase() &&
			delivery.amount === order.order.amountOut;
		if (!matches) {
			record("deliveryAnomaly", order.order.id, {
				reason: "payout does not match the accepted order",
				status: order.order.status,
				recipient: delivery.recipient,
				token: delivery.token,
				amount: delivery.amount.toString(),
				expectedRecipient: order.order.recipientAddr,
				expectedAmount: order.order.amountOut.toString(),
			});
			return;
		}
		order.deliverTx = delivery.txHash;
		patchStatus(order, "delivered");
		send({
			type: FromHubMsgType.OrderDelivery,
			payload: {
				orderId: order.order.id,
				deliverTx: delivery.txHash,
				chain: opts.chain,
			},
		});
		record("deliveryObserved", order.order.id, { txHash: delivery.txHash });
		record("orderDeliverySent", order.order.id, { deliverTx: delivery.txHash });
	});

	function cleanupOrderTimers(order: HubOrderState): void {
		clearTimeout(order.acceptTimer);
		clearTimeout(order.biddingTimer);
		order.acceptTimer = undefined;
		order.biddingTimer = undefined;
	}

	const handle: MockHubHandle = {
		port: server.port as number,
		url: `ws://127.0.0.1:${server.port}/connect`,
		createOrder({ amountIn, recipientAddr }) {
			if (amountIn <= 0n) throw new Error("amountIn must be positive");
			const fee = (amountIn * BigInt(opts.feeBps)) / 10000n;
			const now = Date.now();
			const order = OrderSchema.parse({
				id: crypto.randomUUID(),
				senderId: customerUuid,
				recipientId: null,
				senderAddr: opts.customerAddress,
				recipientAddr,
				senderChain: opts.chain,
				recipientChain: opts.chain,
				tokenIn: opts.tokenIn.address,
				amountIn,
				tokenOut: opts.tokenOut.address,
				amountOut: 0n,
				typ: OrderType.in,
				status: "bidding",
				solverId: null,
				solverAddress: null,
				directDeposit: true,
				fee,
				feeRecipient: opts.feeRecipient,
				depositExpiresAt: null,
				createdAt: now,
				updatedAt: now,
			});
			const state: HubOrderState = {
				order,
				bids: [],
				winnerBid: null,
				assignAckedAt: null,
				depositAckedAt: null,
				depositNotAckedAt: null,
				deliveryAckedAt: null,
				deliveryNotAckedAt: null,
				deliverTx: null,
				customerDeposits: [],
				timeline: [],
				acceptTimer: undefined,
				biddingTimer: undefined,
				biddingCloseAt: now + biddingMs,
				acceptDeadline: 0,
			};
			orders.set(order.id, state);
			state.biddingTimer = setTimeout(() => closeBidding(state), biddingMs);
			send({
				type: FromHubMsgType.NewOrder,
				payload: { order: { ...order }, biddingDeadline: now + biddingMs },
			});
			record("newOrderEmitted", order.id, {
				amountIn: amountIn.toString(),
				fee: fee.toString(),
				biddingDeadline: now + biddingMs,
			});
			return { ...order };
		},
		async customerDeposit(orderId, mode) {
			const order = orders.get(orderId);
			if (!order) throw new Error(`unknown order ${orderId}`);
			if (order.order.status !== "accepted") {
				throw new Error(
					`order ${orderId} not awaiting deposit (status ${order.order.status})`,
				);
			}
			const orderFee = order.order.fee ?? 0n;
			// Shortfall keeps the protocol fee intact and halves only the solver-net amount, so the
			// real receipt genuinely mismatches the accepted order and solver verification must fail.
			const solverAmount =
				mode.kind === "shortfall"
					? order.order.amountIn / 2n
					: order.order.amountIn;
			if (solverAmount <= 0n)
				throw new Error("computed solver deposit amount is not positive");
			const { txHash } = await opts.sendCustomerDeposit({
				orderId,
				token: opts.tokenIn.address,
				solverAmount,
				fee: orderFee,
				solver: opts.expectedSolverAddress,
			});
			order.order.depositTx = txHash;
			order.customerDeposits.push({
				mode: mode.kind,
				solverAmount,
				fee: orderFee,
				txHash,
			});
			record("customerDepositSent", orderId, {
				mode: mode.kind,
				solverAmount: solverAmount.toString(),
				fee: orderFee.toString(),
				txHash,
			});
			patchStatus(order, "executing");
			send({
				type: FromHubMsgType.OrderDeposit,
				payload: { orderId, depositTx: txHash, chain: opts.chain },
			});
			record("orderDepositSent", orderId, { depositTx: txHash });
		},
		replayDelivery(orderId) {
			const order = orders.get(orderId);
			if (!order || order.order.status !== "delivered" || !order.deliverTx)
				throw new Error("No completed real delivery to replay");
			send({
				type: FromHubMsgType.OrderDelivery,
				payload: { orderId, deliverTx: order.deliverTx, chain: opts.chain },
			});
			record("orderDeliverySent", orderId, {
				deliverTx: order.deliverTx,
				replay: true,
			});
		},
		async waitFor(predicate, timeoutMs, label) {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				if (await predicate(handle)) return;
				const failed = [...orders.values()].find(
					(order) =>
						order.order.status === "expired" ||
						order.order.status === "cancelled",
				);
				if (failed)
					throw new Error(
						`Demo order ${failed.order.id} ${failed.order.status} while waiting for ${label}`,
					);
				if (Date.now() > deadline) {
					throw new Error(
						`mock hub wait "${label}" timed out after ${timeoutMs}ms; recent events: ${JSON.stringify(events.slice(-12))}`,
					);
				}
				await Bun.sleep(WAIT_POLL_MS);
			}
		},
		connected() {
			return socket != null && socket.readyState === WebSocket.OPEN;
		},
		activeSyncs: () => activeSyncs,
		revoke() {
			send({
				type: FromHubMsgType.KeyRevoked,
				payload: { solverId: opts.solverId, kid: opts.kid },
			});
			record("keyRevokedSent", undefined, { kid: opts.kid });
			socket?.close(WS_CLOSE_KEY_REVOKED, "key revoked");
		},
		suspend() {
			send({
				type: FromHubMsgType.SolverSuspended,
				payload: { solverId: opts.solverId },
			});
			record("solverSuspendedSent");
			socket?.close(WS_CLOSE_SOLVER_SUSPENDED, "solver suspended");
		},
		report() {
			return {
				orders: [...orders.values()].map((o) => ({
					order: { ...o.order },
					bids: [...o.bids],
					winnerBid: o.winnerBid,
					assignAckedAt: o.assignAckedAt,
					depositAckedAt: o.depositAckedAt,
					depositNotAckedAt: o.depositNotAckedAt,
					deliveryAckedAt: o.deliveryAckedAt,
					deliveryNotAckedAt: o.deliveryNotAckedAt,
					deliverTx: o.deliverTx,
					customerDeposits: [...o.customerDeposits],
					timeline: [...o.timeline],
				})),
			};
		},
		async stop() {
			if (closed) return;
			closed = true;
			for (const order of orders.values()) cleanupOrderTimers(order);
			stopWatchingDeliveries?.();
			await server.stop(true);
		},
	};

	return handle;
}
