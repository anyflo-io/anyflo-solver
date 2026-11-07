/**
 * Serial fixed-input, one-pair, one-active-order solver lifecycle over the real
 * Anyflo Solver Hub protocol.
 *
 * Flow (see plan step 1): supported NewOrder → strategy quote inside the
 * bidding deadline → conservative signed bid from solver-net amountIn (Anyflo
 * fee already excluded) → prompt signed directDeposit assignment ack (no fresh
 * quote inside the 1.5s accept window) → independently verified deposit under
 * required finality → persist-then-ack → fresh quote must still protect the
 * accepted minimum → real strategy swap → Evm.payout delivery → independently
 * verified delivery → DeliveryAck.
 *
 * Safety invariants:
 * - Every irreversible EVM send (approval/swap/payout) is journaled through the
 *   Evm durability callbacks: intent persisted BEFORE broadcast, broadcast hash
 *   and confirmation persisted after. A spend whose outcome cannot be proven
 *   from the checkpoint blocks the order for operator reconciliation — never a
 *   blind retry.
 * - Urgent hub messages (cancel/reassign/reorg/revocation/suspension) set an
 *   in-memory invalidation flag synchronously; Evm.beforeSpend checks it so a
 *   long-running swap is preempted before its next broadcast. Already-broadcast
 *   receipts cannot be undone, but no later approval or payout may fire.
 * - Duplicate/replayed messages are suppressed or answered idempotently.
 */
import {
	isAddress,
	type Address,
	type Hash,
	type TransactionReceipt,
} from "viem";
import { OrderSchema, OrderType, type Order } from "@anyflo/lib/order";
import { deterministicEncode, sign } from "@anyflo/lib/ed25519";
import type { UUID } from "@anyflo/lib/uuid";
import {
	FromHubMsgType,
	ToHubMsgType,
	type ActiveOrdersResp,
	type FromHubMsg,
	type MsgFromHubBidAck,
	type MsgFromHubNewOrder,
	type MsgFromHubOrderAssigned,
	type MsgFromHubOrderDeposit,
	type MsgFromHubOrderDepositReorged,
	type MsgFromHubOrderDelivery,
	type MsgFromHubOrderDeliveryReorged,
	type ToHubMsg,
} from "@anyflo/lib/solverhub";
import { type PResult } from "@anyflo/lib/result";

import {
	CheckpointStore,
	SLOT_OCCUPYING,
	orderForWire,
	type OrderCheckpoint,
	type Phase,
} from "./checkpoint";
import { Evm } from "./evm";
import { HubClient } from "./hub";
import type { SolverConfig } from "./config";
import type {
	DepositError,
	LiquidityStrategy,
	SpendIntent,
	SwapTransaction,
} from "./types";

const QUOTE_SAFETY_MARGIN_MS = 250;
const MIN_QUOTE_BUDGET_MS = 1_000;
const DEPOSIT_VERIFY_RETRY_MS = 5_000;
const SWEEP_INTERVAL_MS = 5_000;
const DELIVERY_VERIFY_ATTEMPTS = 5;
const DELIVERY_VERIFY_RETRY_MS = 2_000;

export interface EvmLike {
	readonly address: Address;
	beforeSpend?: (intent: SpendIntent) => Promise<void>;
	guardSpend?: () => void;
	afterBroadcast?: (hash: Hash) => Promise<void>;
	afterConfirmed?: (hash: Hash) => Promise<void>;
	send(tx: SwapTransaction): PResult<TransactionReceipt>;
	verifyDeposit(order: Order, hash: Hash): PResult<null, DepositError>;
	payout(order: Order): PResult<TransactionReceipt>;
	verifyDelivery(order: Order, hash: Hash): PResult<null>;
}

export interface HubLike {
	start(): void;
	close(): Promise<void>;
	send(msg: ToHubMsg): boolean;
	activeOrders(): PResult<ActiveOrdersResp>;
	onMessage(handler: (msg: FromHubMsg) => void | Promise<void>): void;
	onOpen(handler: () => void | Promise<void>): void;
	onHalt(handler: (reason: string) => void): void;
}

export interface SolverDeps {
	config: SolverConfig;
	evm: EvmLike;
	strategy: LiquidityStrategy;
	hub: HubLike;
	store: CheckpointStore;
	authKey: CryptoKey;
	log?: (
		level: "info" | "warn" | "error",
		msg: string,
		ctx?: Record<string, unknown>,
	) => void;
}

export class Solver {
	/** In-memory current checkpoint (the serial slot occupant). */
	private current: OrderCheckpoint | null = null;
	private halted: string | null = null;
	/** Orders invalidated by urgent hub messages; checked before every broadcast. */
	private readonly invalidated = new Set<UUID>();
	private chain: Promise<void> = Promise.resolve();
	private sweepTimer: ReturnType<typeof setInterval> | null = null;
	private closed = false;

	constructor(private readonly deps: SolverDeps) {}

	async start(): Promise<void> {
		this.deps.evm.guardSpend = () => this.assertCanSpend();
		this.deps.evm.beforeSpend = (intent) => this.journalIntent(intent);
		this.deps.evm.afterBroadcast = (hash) => this.journalBroadcast(hash);
		this.deps.evm.afterConfirmed = (hash) => this.journalConfirmation(hash);
		await this.resumePersistedState();
		this.deps.hub.onMessage((msg) => {
			// Urgent invalidation happens synchronously at frame receipt: a swap
			// handler occupying the serialized chain must be preempted before its
			// next broadcast, never after the queued takeaway handler runs.
			this.premarkUrgent(msg);
			return this.enqueue(() => this.handleMessage(msg));
		});
		this.deps.hub.onOpen(() => this.enqueue(() => this.reconcileWithHub()));
		this.deps.hub.onHalt((reason) => this.setHalted(reason));
		await this.reconcileWithHub();
		if (this.halted !== null || this.closed) return;
		this.deps.hub.start();
		this.sweepTimer = setInterval(() => {
			void this.enqueue(() => this.sweep()).catch(() => {});
		}, SWEEP_INTERVAL_MS);
	}

	async close(): Promise<void> {
		this.closed = true;
		if (this.current) this.invalidated.add(this.current.orderId);
		if (this.sweepTimer !== null) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = null;
		}
		await this.deps.hub.close();
		await this.chain.catch(() => {});
		await this.deps.store.close();
	}

	// ==================== durability journal ====================

	/** Refuses broadcasting for invalidated/halted orders and persists the spend
	 * intent BEFORE the Evm signs/broadcasts. Evm awaits this before sending. */
	private assertCanSpend(): void {
		const cp = this.current;
		if (
			this.closed ||
			this.halted !== null ||
			cp === null ||
			this.invalidated.has(cp.orderId) ||
			!["spendIntent", "payoutIntent"].includes(cp.phase)
		)
			throw new SpendRefused("spend is no longer authorized");
	}

	private async journalIntent(intent: SpendIntent): Promise<void> {
		this.assertCanSpend();
		const cp = this.current!;
		if (cp.pendingSpend !== null)
			throw new SpendRefused("another spend is already pending");
		cp.pendingSpend = {
			intent,
			broadcastHash: null,
			confirmedHash: null,
			at: Date.now(),
		};
		await this.persist(cp);
		this.assertCanSpend();
	}

	private async journalBroadcast(hash: Hash): Promise<void> {
		const cp = this.current;
		if (cp === null || cp.pendingSpend === null) return;
		cp.pendingSpend.broadcastHash = hash;
		await this.persist(cp);
	}

	/** Per-tx pending entry is cleared on confirmation; the confirmed spend is
	 * retained as evidence while the original phase stays until the flow advances. */
	private async journalConfirmation(hash: Hash): Promise<void> {
		const cp = this.current;
		if (cp === null || cp.pendingSpend === null) return;
		const pending = cp.pendingSpend;
		pending.confirmedHash = hash;
		cp.lastConfirmedSpend = { ...pending, hash };
		cp.pendingSpend = null;
		await this.persist(cp);
	}

	// ==================== message routing ====================

	/** Serializes message work; urgent flags are set synchronously by callers
	 * before the work is queued so preemption does not wait behind an in-flight
	 * swap. */
	private enqueue(task: () => Promise<void>): Promise<void> {
		const run = this.chain.then(task).catch(() => {
			this.setHalted("handler or durable state update failed");
			this.log("error", "Handler failed; operator reconciliation required", {});
		});
		this.chain = run;
		return run;
	}

	/** Dispatches one decoded hub message. Public as the focused-test controller
	 * entry; production traffic arrives exclusively via hub.onMessage. */
	async handleMessage(msg: FromHubMsg): Promise<void> {
		this.premarkUrgent(msg);
		if (this.closed) return;
		switch (msg.type) {
			case FromHubMsgType.NewOrder:
				return this.handleNewOrder(msg.payload);
			case FromHubMsgType.BidAck:
				return this.handleBidAck(msg.payload);
			case FromHubMsgType.OrderAssigned:
				return this.handleOrderAssigned(msg.payload);
			case FromHubMsgType.OrderDeposit:
				return this.handleOrderDeposit(msg.payload);
			case FromHubMsgType.OrderDepositReorged:
				return this.handleDepositReorged(msg.payload);
			case FromHubMsgType.OrderDelivery:
				return this.handleOrderDelivery(msg.payload);
			case FromHubMsgType.OrderDeliveryReorged:
				return this.handleDeliveryReorged(msg.payload);
			case FromHubMsgType.OrderReassigned:
				return this.handleTakeaway(
					msg.payload.orderId,
					"reassigned",
					msg.payload.reason,
				);
			case FromHubMsgType.OrderCancelled:
				return this.handleTakeaway(
					msg.payload.orderId,
					"cancelled",
					msg.payload.reason,
				);
			case FromHubMsgType.KeyRevoked:
				this.setHalted(`key revoked (kid ${msg.payload.kid ?? "all"})`);
				return;
			case FromHubMsgType.SolverSuspended:
				this.setHalted("solver suspended by operator");
				return;
		}
	}

	private setHalted(reason: string): void {
		if (this.halted !== null) return;
		this.halted = reason;
		const cp = this.current;
		if (cp !== null) this.invalidated.add(cp.orderId);
		this.log("warn", `Solver halted: ${reason}; operator restart required`, {});
	}

	/** Synchronous, pre-queue invalidation for messages that must preempt a
	 * long-running swap handler. The matching handler still performs the
	 * durable checkpoint transitions. */
	private premarkUrgent(msg: FromHubMsg): void {
		if (
			"chain" in msg.payload &&
			msg.payload.chain !== `eip155:${this.deps.config.chainId}`
		)
			return;
		const orderId = (msg.payload as { orderId?: UUID }).orderId;
		const relevant =
			orderId !== undefined &&
			this.current !== null &&
			this.current.orderId === orderId;
		switch (msg.type) {
			case FromHubMsgType.OrderCancelled:
			case FromHubMsgType.OrderReassigned:
				if (relevant) this.invalidated.add(orderId);
				return;
			case FromHubMsgType.OrderDepositReorged:
			case FromHubMsgType.OrderDeliveryReorged:
				if (relevant) this.invalidated.add(orderId);
				else if (
					orderId !== undefined &&
					this.deps.store.isCompleted(orderId)
				) {
					const old = this.deps.store.load(orderId);
					if (
						!old ||
						old === "corrupt" ||
						(old.phase === "done" &&
							(msg.type === FromHubMsgType.OrderDepositReorged
								? old.depositTx
								: old.payoutHash) === msg.payload.txHash)
					)
						this.setHalted(
							"completed order reorged; operator reconciliation required",
						);
				}
				return;
			case FromHubMsgType.KeyRevoked:
				this.setHalted(`key revoked (kid ${msg.payload.kid ?? "all"})`);
				return;
			case FromHubMsgType.SolverSuspended:
				this.setHalted("solver suspended by operator");
				return;
			default:
				return;
		}
	}

	// ==================== bidding ====================

	private async handleNewOrder(payload: MsgFromHubNewOrder): Promise<void> {
		if (this.halted !== null || this.closed) return;
		const order = OrderSchema.safeParse(payload.order);
		if (!order.success) {
			this.log("warn", "Ignoring unparseable NewOrder", {
				issues: order.error.issues.length,
			});
			return;
		}
		const o = order.data;
		if (await this.deps.store.isCompleted(o.id)) return;
		if (this.current !== null) return; // serial one order; duplicate broadcast keeps its recorded plan
		if (!this.supportsOrder(o)) return;
		if (o.typ !== OrderType.in) return;

		const now = Date.now();
		const budget = Math.min(
			this.deps.config.quoteTimeoutMs,
			payload.biddingDeadline - now - QUOTE_SAFETY_MARGIN_MS,
		);
		if (budget < MIN_QUOTE_BUDGET_MS) {
			this.log("info", "Skipping bid: quote budget exhausted", {
				orderId: o.id,
				budgetMs: budget,
			});
			return;
		}
		const marginBps = BigInt(this.deps.config.marginBps);
		const swapInput = o.amountIn - (o.amountIn * marginBps) / 10_000n;
		if (swapInput <= 0n) {
			this.log("info", "Skipping bid: margin exceeds solver-net input", {
				orderId: o.id,
			});
			return;
		}
		const quoted = await this.deps.strategy.quote(
			swapInput,
			AbortSignal.timeout(budget),
		);
		if (!quoted.ok) {
			this.log("info", "Skipping bid: quote unavailable", {
				orderId: o.id,
				error: quoted.error,
			});
			return;
		}
		const quote = quoted.data;
		if (
			this.halted !== null ||
			Date.now() >= payload.biddingDeadline - QUOTE_SAFETY_MARGIN_MS ||
			quote.amountIn !== swapInput ||
			quote.expectedOut <= 0n ||
			quote.minOut <= 0n ||
			quote.minOut > quote.expectedOut ||
			quote.expiresAt <= Date.now()
		) {
			this.log("info", "Skipping bid: late or empty quote", {
				orderId: o.id,
				expiresAt: quote.expiresAt,
			});
			return;
		}
		const slippage = BigInt(this.deps.config.slippageBps);
		const protectedOut = (quote.expectedOut * (10_000n - slippage)) / 10_000n;
		if (quote.minOut < protectedOut) return;
		const bidQuote = quote.minOut;
		const cp: OrderCheckpoint = {
			version: 1,
			orderId: o.id,
			phase: "bid",
			order: o,
			bid: {
				quote: bidQuote,
				expiresAt: quote.expiresAt,
				kid: this.deps.config.kid,
				timestamp: now,
			},
			accepted: null,
			depositTx: null,
			swapHash: null,
			swapOut: null,
			payoutHash: null,
			pendingSpend: null,
			lastConfirmedSpend: null,
			depositVerify: null,
			depositReorgedAt: null,
			blockedReason: null,
			updatedAt: now,
		};
		await this.persist(cp);
		this.current = cp;
		const envelope = await this.signedEnvelope({
			orderId: o.id,
			quote: bidQuote,
			expiresAt: quote.expiresAt,
		});
		if (
			this.closed ||
			this.halted !== null ||
			Date.now() >= payload.biddingDeadline ||
			quote.expiresAt <= Date.now()
		) {
			await this.releaseSlot(cp, "bidExpiredBeforeSend");
			return;
		}
		this.sendToHub({
			type: ToHubMsgType.Bid,
			payload: envelope.payload,
			sig: envelope.sig,
		});
		this.log("info", "Bid placed", {
			orderId: o.id,
			quote: bidQuote.toString(),
			expiresAt: quote.expiresAt,
		});
	}

	private supportsOrder(o: Order): boolean {
		const chain = `eip155:${this.deps.config.chainId}`;
		const { tokenIn, tokenOut } = this.deps.config;
		const ambiguous =
			tokenIn.symbol.toLowerCase() === tokenOut.symbol.toLowerCase();
		const matches = (value: string, token: typeof tokenIn) =>
			value.toLowerCase() === token.address.toLowerCase() ||
			(!ambiguous && value.toLowerCase() === token.symbol.toLowerCase());
		return (
			o.amountIn > 0n &&
			isAddress(o.senderAddr) &&
			isAddress(o.recipientAddr) &&
			o.senderChain === chain &&
			o.recipientChain === chain &&
			matches(o.tokenIn, tokenIn) &&
			matches(o.tokenOut, tokenOut)
		);
	}

	private handleBidAck(payload: MsgFromHubBidAck): void {
		if (this.current?.orderId !== payload.orderId) return;
		this.log("info", "Bid acknowledged", {
			orderId: payload.orderId,
			rank: payload.rank,
		});
	}

	// ==================== assignment ====================

	private async handleOrderAssigned(
		payload: MsgFromHubOrderAssigned,
	): Promise<void> {
		if (payload.winnerId !== this.deps.config.solverId) {
			// We lost the auction for an order we may have bid on — free the slot.
			const cp = this.current;
			if (cp !== null && cp.orderId === payload.orderId && cp.phase === "bid") {
				await this.releaseSlot(cp, "outbid");
			}
			return;
		}
		if (this.halted !== null) return; // no new commitments while halted
		const cp = this.current;
		if (cp === null || cp.orderId !== payload.orderId) {
			this.rejectAssignment(payload.orderId, "unbid_order");
			return;
		}
		if (
			cp.phase === "blocked" ||
			cp.phase === "failedMarket" ||
			PHASES_TERMINAL[cp.phase]
		)
			return;
		if (cp.phase !== "bid") {
			// Duplicate/redelivered assignment after we already accepted — re-ack idempotently.
			await this.sendAssignAck(cp);
			return;
		}
		const parsed = OrderSchema.safeParse(payload.order);
		if (!cp.bid || cp.bid.expiresAt <= Date.now()) {
			this.rejectAssignment(payload.orderId, "bid_expired");
			await this.releaseSlot(cp, "bidExpired");
			return;
		}
		if (!parsed.success) {
			this.rejectAssignment(payload.orderId, "malformed_order");
			return;
		}
		if (
			!assignmentMatches(cp.order, cp.bid.quote, parsed.data) ||
			parsed.data.solverId !== this.deps.config.solverId ||
			parsed.data.fee === null ||
			parsed.data.fee < 0n ||
			!parsed.data.depositExpiresAt ||
			parsed.data.depositExpiresAt <= Date.now()
		) {
			this.log("warn", "Assignment does not match our recorded bid", {
				orderId: payload.orderId,
			});
			this.rejectAssignment(payload.orderId, "quote_mismatch");
			await this.releaseSlot(cp, "assignmentMismatch");
			return;
		}
		// No fresh quote here: the 1.5s accept window cannot afford one and the bid
		// was priced moments ago.
		cp.accepted = {
			amountIn: parsed.data.amountIn,
			amountOut: cp.bid?.quote ?? 0n,
			depositExpiresAt: parsed.data.depositExpiresAt,
			fee: parsed.data.fee,
		};
		cp.phase = "assigned";
		await this.persist(cp);
		await this.sendAssignAck(cp);
		this.log("info", "Assignment accepted with direct deposit", {
			orderId: cp.orderId,
			solverAddress: this.deps.evm.address,
		});
	}

	private async sendAssignAck(cp: OrderCheckpoint): Promise<void> {
		const envelope = await this.signedEnvelope({
			orderId: cp.orderId,
			solverAddress: this.deps.evm.address,
			directDeposit: true,
		});
		this.sendToHub({
			type: ToHubMsgType.OrderAssignAck,
			payload: envelope.payload,
			sig: envelope.sig,
		});
	}

	private rejectAssignment(orderId: UUID, reason: string): void {
		if (this.halted !== null) return;
		this.sendToHub({
			type: ToHubMsgType.OrderAssignNotAck,
			payload: { orderId, reason, timestamp: Date.now() },
		});
	}

	// ==================== deposit ====================

	private async handleOrderDeposit(
		payload: MsgFromHubOrderDeposit,
	): Promise<void> {
		const cp = this.current;
		if (cp === null || cp.orderId !== payload.orderId) return;
		if (this.halted !== null || this.invalidated.has(cp.orderId)) return;
		if (payload.chain !== `eip155:${this.deps.config.chainId}`) return;
		if (
			cp.phase === "blocked" ||
			cp.phase === "failedMarket" ||
			PHASES_TERMINAL[cp.phase]
		)
			return;
		if (cp.pendingSpend !== null) return; // spend in flight — urgent handlers own transitions
		if (cp.phase !== "assigned") {
			if (cp.depositTx === payload.depositTx) {
				// Idempotent confirmation for an already-verified deposit.
				this.sendToHub({
					type: ToHubMsgType.OrderDepositAck,
					payload: { orderId: cp.orderId, timestamp: Date.now() },
				});
			}
			return;
		}
		if (cp.depositVerify !== null && cp.depositVerify.tx === payload.depositTx)
			return; // verification already running
		cp.depositTx = payload.depositTx;
		cp.depositVerify = {
			tx: payload.depositTx,
			attempts: 0,
			nextAt: Date.now(),
		};
		await this.persist(cp);
		await this.verifyDepositNow();
	}

	/** One verification round; sweeper re-runs it while the deposit is pending. */
	private async verifyDepositNow(): Promise<void> {
		const cp = this.current;
		if (cp === null || cp.depositVerify === null) return;
		if (this.halted !== null || this.invalidated.has(cp.orderId)) return;
		const { tx } = cp.depositVerify;
		cp.depositVerify.attempts += 1;
		const result = await this.deps.evm.verifyDeposit(
			this.acceptedOrder(cp),
			asHash(tx),
		);
		if (this.closed || this.halted !== null || this.invalidated.has(cp.orderId))
			return;
		if (result.ok) {
			// Expiry guard: a deposit verified after its hub deadline may already be
			// expired hub-side — executing then would spend against a dead order.
			if (Date.now() > verificationDeadline(cp)) {
				this.log(
					"warn",
					"Deposit verified after expiry; capital requires reconciliation",
					{ orderId: cp.orderId },
				);
				await this.blockOrder(cp, "late verified deposit; capital retained");
				return;
			}
			cp.depositVerify = null;
			cp.phase = "executing";
			await this.persist(cp);
			if (
				this.closed ||
				this.halted !== null ||
				this.invalidated.has(cp.orderId)
			)
				return;
			// Persist-before-ack: executing state (with the verified deposit) is durable
			// before the hub learns we accepted the payment.
			this.sendToHub({
				type: ToHubMsgType.OrderDepositAck,
				payload: { orderId: cp.orderId, timestamp: Date.now() },
			});
			this.log("info", "Deposit verified; executing", {
				orderId: cp.orderId,
				depositTx: tx,
			});
			await this.executeOrder();
			return;
		}
		const depositError = result.error;
		if (depositError.type === "Invalid") {
			this.log("warn", "Deposit verification failed; disputing", {
				orderId: cp.orderId,
				reason: depositError.reason,
			});
			cp.phase = "disputed";
			await this.persist(cp);
			this.sendToHub({
				type: ToHubMsgType.OrderDepositNotAck,
				payload: { orderId: cp.orderId, timestamp: Date.now() },
			});
			await this.deps.store.markCompleted(cp.orderId, "depositDispute");
			this.current = null;
			return;
		}
		cp.depositVerify.nextAt = Date.now() + DEPOSIT_VERIFY_RETRY_MS;
		await this.persist(cp);
		if (cp.depositVerify.nextAt > verificationDeadline(cp)) {
			this.log("warn", "Deposit still pending at deadline", {
				orderId: cp.orderId,
			});
			await this.blockOrder(
				cp,
				"unverified funding at expiry; reconcile before releasing capital",
			);
		}
	}

	// ==================== execution: swap then payout ====================

	private async executeOrder(): Promise<void> {
		const cp = this.current;
		if (cp === null || cp.phase !== "executing" || cp.accepted === null) return;
		if (this.halted !== null || this.invalidated.has(cp.orderId)) return;

		// Fresh quote must still protect the accepted minimum out of the same
		// solver-net input. A now-unprofitable route declines; it never reprices.
		const fresh = await this.deps.strategy.quote(
			this.swapInput(cp.accepted.amountIn),
			AbortSignal.timeout(this.deps.config.quoteTimeoutMs),
		);
		if (this.halted !== null || this.invalidated.has(cp.orderId)) return;
		if (!fresh.ok) {
			await this.declinePostDeposit(cp, `quote unavailable: ${fresh.error}`);
			return;
		}
		const q = fresh.data;
		const slippage = BigInt(this.deps.config.slippageBps);
		const protectedOut = (q.expectedOut * (10_000n - slippage)) / 10_000n;
		const expectedInput = this.swapInput(cp.accepted.amountIn);
		if (
			q.expectedOut <= 0n ||
			q.minOut <= 0n ||
			q.expiresAt <= Date.now() ||
			q.amountIn !== expectedInput ||
			q.minOut < protectedOut ||
			q.minOut > q.expectedOut ||
			q.minOut < cp.accepted.amountOut
		) {
			await this.declinePostDeposit(
				cp,
				"fresh quote below accepted minimum or out of bounds",
			);
			return;
		}

		cp.phase = "spendIntent";
		await this.persist(cp);
		const swap = await this.deps.strategy.swap(q, q.minOut);
		if (swap.ok) {
			if (
				swap.data.amountIn !== expectedInput ||
				swap.data.amountOut < q.minOut
			) {
				await this.blockOrder(
					cp,
					"strategy receipt violates accepted input/output bounds",
				);
				return;
			}
			cp.swapHash = swap.data.hash;
			cp.swapOut = swap.data.amountOut;
			cp.phase = "swapped";
			await this.persist(cp);
			this.log("info", "Swap confirmed", {
				orderId: cp.orderId,
				swapHash: swap.data.hash,
			});
		} else if (spendHappened(cp)) {
			await this.blockOrder(cp, `swap outcome unknown: ${swap.error}`);
			return;
		} else if (this.halted !== null || this.invalidated.has(cp.orderId)) {
			return; // urgent handler owns the transition
		} else {
			await this.declinePostDeposit(cp, `swap failed cleanly: ${swap.error}`);
			return;
		}
		if (this.halted !== null) return; // spent exposure remains held for manual reconciliation
		if (this.invalidated.has(cp.orderId)) {
			await this.blockOrder(
				cp,
				"order invalidated after swap; payout withheld",
			);
			return;
		}
		await this.payout(cp);
	}

	private async payout(cp: OrderCheckpoint): Promise<void> {
		cp.phase = "payoutIntent";
		await this.persist(cp);
		const paid = await this.deps.evm.payout(this.acceptedOrder(cp));
		if (paid.ok) {
			cp.payoutHash = paid.data.transactionHash;
			await this.persist(cp);
		} else if (cp.pendingSpend !== null) {
			await this.blockOrder(cp, `payout outcome unknown: ${paid.error}`);
			return;
		} else {
			await this.blockOrder(
				cp,
				`payout failed without broadcast: ${paid.error}`,
			);
			return;
		}
		if (!(await this.verifyDeliveryRetrying(cp, asHash(cp.payoutHash!))))
			return; // blocked inside
		if (this.closed || this.halted !== null || this.invalidated.has(cp.orderId))
			return;
		cp.phase = "delivered";
		await this.persist(cp);
		this.sendToHub({
			type: ToHubMsgType.OrderDeliveryAck,
			payload: { orderId: cp.orderId, timestamp: Date.now() },
		});
		this.log("info", "Delivery verified and acknowledged", {
			orderId: cp.orderId,
			payoutHash: cp.payoutHash,
		});
	}

	private async verifyDeliveryRetrying(
		cp: OrderCheckpoint,
		hash: Hash,
	): Promise<boolean> {
		for (let attempt = 1; attempt <= DELIVERY_VERIFY_ATTEMPTS; attempt++) {
			const check = await this.deps.evm.verifyDelivery(
				this.acceptedOrder(cp),
				hash,
			);
			if (check.ok) return true;
			if (check.code !== 409 || attempt === DELIVERY_VERIFY_ATTEMPTS) {
				await this.blockOrder(
					cp,
					`delivery verification failed: ${check.error}`,
				);
				return false;
			}
			await sleep(DELIVERY_VERIFY_RETRY_MS);
		}
		return true;
	}

	/** Post-deposit decline: no route at/above the accepted minimum. Capital is
	 * retained, the slot stays occupied for operator reconciliation, and no
	 * protocol message exists for this state. */
	private async declinePostDeposit(
		cp: OrderCheckpoint,
		reason: string,
	): Promise<void> {
		this.log("warn", "Declining execution after deposit; capital retained", {
			orderId: cp.orderId,
			reason,
		});
		cp.phase = "failedMarket";
		cp.blockedReason = reason;
		await this.persist(cp);
		await this.deps.store.markCompleted(cp.orderId, "marketDeclined");
	}

	private async blockOrder(cp: OrderCheckpoint, reason: string): Promise<void> {
		this.log("error", "Order blocked for operator reconciliation", {
			orderId: cp.orderId,
			reason,
		});
		cp.phase = "blocked";
		cp.blockedReason = reason;
		if (this.current === null) this.current = cp;
		else if (this.current.orderId !== cp.orderId)
			this.setHalted(
				"multiple order exposures require operator reconciliation",
			);
		await this.persist(cp);
	}

	private async releaseSlot(
		cp: OrderCheckpoint,
		outcome: string,
	): Promise<void> {
		this.log("info", "Releasing order slot", { orderId: cp.orderId, outcome });
		this.invalidated.delete(cp.orderId);
		cp.phase = "released";
		await this.persist(cp);
		await this.deps.store.markCompleted(cp.orderId, outcome);
		if (this.current?.orderId === cp.orderId) this.current = null;
	}

	// ==================== urgent: reorg / takeaway / delivery ====================

	private async handleDepositReorged(
		payload: MsgFromHubOrderDepositReorged,
	): Promise<void> {
		const cp = this.current;
		if (payload.chain !== `eip155:${this.deps.config.chainId}`) return;
		if (cp === null || cp.orderId !== payload.orderId)
			return this.blockCompletedReorg(
				payload.orderId,
				payload.txHash,
				"deposit",
			);
		this.invalidated.add(cp.orderId);
		if (cp.phase === "blocked" || PHASES_TERMINAL[cp.phase]) return;
		if (spendHappened(cp)) {
			await this.blockOrder(
				cp,
				"deposit reorged after spend; exposure requires operator reconciliation",
			);
			return;
		}
		// Nothing broadcast: await a replacement deposit notification; the old
		// verification state is void.
		cp.depositTx = null;
		cp.depositVerify = null;
		cp.depositReorgedAt = Date.now();
		cp.phase = "assigned";
		await this.persist(cp);
		this.invalidated.delete(cp.orderId);
		this.log(
			"warn",
			"Deposit reorged before spend; awaiting replacement notification",
			{ orderId: cp.orderId },
		);
	}

	private async handleDeliveryReorged(
		payload: MsgFromHubOrderDeliveryReorged,
	): Promise<void> {
		const cp = this.current;
		if (payload.chain !== `eip155:${this.deps.config.chainId}`) return;
		if (cp === null || cp.orderId !== payload.orderId)
			return this.blockCompletedReorg(
				payload.orderId,
				payload.txHash,
				"delivery",
			);
		if (cp.payoutHash !== null && cp.payoutHash === payload.txHash) {
			this.invalidated.add(cp.orderId);
			await this.blockOrder(cp, "delivery reorged; payout outcome ambiguous");
		}
	}

	private async blockCompletedReorg(
		orderId: UUID,
		txHash: string,
		kind: "deposit" | "delivery",
	): Promise<void> {
		const cp = this.deps.store.load(orderId);
		if (
			cp === "corrupt" ||
			(cp === null && this.deps.store.isCompleted(orderId))
		) {
			this.setHalted("completed order reorg lacks a valid local checkpoint");
			return;
		}
		if (
			!cp ||
			cp.phase !== "done" ||
			(kind === "deposit" ? cp.depositTx : cp.payoutHash) !== txHash
		)
			return;
		this.setHalted(
			`completed ${kind} reorged; operator reconciliation required`,
		);
		await this.blockOrder(cp, `completed ${kind} reorged`);
	}

	/** Cancellation and reassignment share the same policy: nothing spent →
	 * release; anything broadcast → blocked for operator reconciliation. */
	private async handleTakeaway(
		orderId: UUID,
		kind: "cancelled" | "reassigned",
		reason: string,
	): Promise<void> {
		const cp = this.current;
		if (cp === null || cp.orderId !== orderId) return;
		this.invalidated.add(orderId);
		if (cp.phase === "blocked" || PHASES_TERMINAL[cp.phase]) return;
		if (spendHappened(cp)) {
			await this.blockOrder(
				cp,
				`order ${kind} after spend (${reason}); operator reconciliation required`,
			);
			return;
		}
		await this.releaseSlot(cp, kind);
	}

	private async handleOrderDelivery(
		payload: MsgFromHubOrderDelivery,
	): Promise<void> {
		if (payload.chain !== `eip155:${this.deps.config.chainId}`) return;
		const cp = this.current;
		if (cp === null || cp.orderId !== payload.orderId) {
			// Completed orders get an idempotent re-ack for duplicate notifications.
			const completed = this.deps.store.load(payload.orderId);
			if (
				(await this.deps.store.completedOutcome(payload.orderId)) ===
					"delivered" &&
				completed &&
				completed !== "corrupt" &&
				completed.payoutHash === payload.deliverTx &&
				(
					await this.deps.evm.verifyDelivery(
						this.acceptedOrder(completed),
						asHash(payload.deliverTx),
					)
				).ok
			) {
				this.sendToHub({
					type: ToHubMsgType.OrderDeliveryAck,
					payload: { orderId: payload.orderId, timestamp: Date.now() },
				});
			}
			return;
		}
		if (this.halted !== null) return;
		if (cp.phase === "blocked" || PHASES_TERMINAL[cp.phase]) return;
		if (cp.payoutHash === payload.deliverTx) {
			if (!(await this.verifyDeliveryRetrying(cp, asHash(payload.deliverTx))))
				return;
			await this.completeOrder(cp);
			return;
		}
		// A hash other than our recorded payout: accept it only when it verifies
		// on-chain as our own matching delivery (e.g. reorged re-mining); dispute
		// otherwise. Never dispute deliveries of orders we do not owe.
		const check = await this.deps.evm.verifyDelivery(
			this.acceptedOrder(cp),
			asHash(payload.deliverTx),
		);
		if (check.ok) {
			cp.payoutHash = payload.deliverTx;
			await this.completeOrder(cp);
			return;
		}
		if (!spendObligation(cp)) return; // not ours to dispute
		this.log("warn", "Delivery transaction unrecognized; disputing", {
			orderId: cp.orderId,
			expected: cp.payoutHash,
			observed: payload.deliverTx,
		});
		this.sendToHub({
			type: ToHubMsgType.OrderDeliveryNotAck,
			payload: {
				orderId: cp.orderId,
				deliverTx: payload.deliverTx,
				timestamp: Date.now(),
			},
		});
	}

	private async completeOrder(cp: OrderCheckpoint): Promise<void> {
		this.invalidated.delete(cp.orderId);
		cp.phase = "done";
		await this.persist(cp);
		await this.deps.store.markCompleted(cp.orderId, "delivered");
		this.sendToHub({
			type: ToHubMsgType.OrderDeliveryAck,
			payload: { orderId: cp.orderId, timestamp: Date.now() },
		});
		this.current = null;
		this.log("info", "Order complete", { orderId: cp.orderId });
	}

	// ==================== startup / reconciliation / sweep ====================

	private async resumePersistedState(): Promise<void> {
		const { checkpoints, corrupt } = this.deps.store.loadAll();
		if (corrupt.length > 0) {
			this.setHalted(
				`corrupt checkpoint(s) for order(s): ${corrupt.join(", ")}`,
			);
			return;
		}
		const occupying = checkpoints
			.filter((cp) => SLOT_OCCUPYING[cp.phase])
			.sort((a, b) => a.updatedAt - b.updatedAt);
		if (occupying.length > 1) {
			this.setHalted(
				`multiple active checkpoints: ${occupying.map((c) => c.orderId).join(", ")}`,
			);
			return;
		}
		this.current = occupying[0] ?? null;
		if (
			this.current !== null &&
			(this.current.pendingSpend !== null ||
				this.current.lastConfirmedSpend !== null ||
				this.current.depositTx !== null ||
				["executing", "spendIntent", "swapped", "payoutIntent"].includes(
					this.current.phase,
				)) &&
			this.current.phase !== "delivered"
		) {
			await this.blockOrder(
				this.current,
				"restart of funded or spent order requires manual reconciliation",
			);
		}
	}

	/** Startup and per-reconnect catch-up: a hub-active order we cannot account
	 * for (missing/corrupt checkpoint) blocks execution — never a fresh spend. */
	private async reconcileWithHub(): Promise<void> {
		if (this.halted !== null || this.closed) return;
		const resp = await this.deps.hub.activeOrders();
		if (!resp.ok) {
			this.log("warn", "Active orders sync failed", { error: resp.error });
			this.setHalted("cannot reconcile active hub orders");
			return;
		}
		for (const details of resp.data.orders) {
			const remote = details.order;
			if (remote.solverId !== this.deps.config.solverId) continue;
			if (!HUB_ACTIVE_STATUSES[remote.status]) continue;
			const local = this.deps.store.load(remote.id);
			if (local === "corrupt") {
				this.setHalted(`corrupt checkpoint for active hub order ${remote.id}`);
				return;
			}
			if (local === null) {
				this.setHalted(
					`active hub order ${remote.id} (${remote.status}) without a local checkpoint`,
				);
				return;
			}
			const cp = local;
			if (
				(cp.phase === "delivered" || cp.phase === "done") &&
				cp.payoutHash &&
				["executing", "deliveredNotAck"].includes(remote.status)
			) {
				if (
					!this.supportsOrder(remote) ||
					remote.amountIn !== cp.accepted?.amountIn ||
					remote.amountOut !== cp.accepted?.amountOut ||
					remote.recipientAddr.toLowerCase() !==
						cp.order.recipientAddr.toLowerCase() ||
					!(
						await this.deps.evm.verifyDelivery(
							this.acceptedOrder(cp),
							asHash(cp.payoutHash),
						)
					).ok
				) {
					await this.blockOrder(
						cp,
						"restart delivery cannot be independently verified",
					);
				} else {
					this.sendToHub({
						type: ToHubMsgType.OrderDeliveryAck,
						payload: { orderId: cp.orderId, timestamp: Date.now() },
					});
				}
			}
		}
	}

	/** One sweeper round; also invoked directly by focused tests. */
	async sweep(): Promise<void> {
		const cp = this.current;
		if (cp === null || this.halted !== null) return;
		if (cp.phase === "bid" && cp.bid && Date.now() >= cp.bid.expiresAt) {
			await this.releaseSlot(cp, "bidExpired");
			return;
		}
		if (
			cp.phase === "assigned" &&
			cp.depositVerify !== null &&
			Date.now() >= cp.depositVerify.nextAt
		) {
			await this.verifyDepositNow();
			return;
		}
		if (
			cp.phase === "assigned" &&
			cp.depositVerify === null &&
			cp.depositTx === null &&
			cp.accepted !== null &&
			Date.now() > verificationDeadline(cp)
		) {
			await this.releaseSlot(cp, "depositExpired");
		}
	}

	// ==================== helpers ====================

	private swapInput(acceptedAmountIn: bigint): bigint {
		const marginBps = BigInt(this.deps.config.marginBps);
		return acceptedAmountIn - (acceptedAmountIn * marginBps) / 10_000n;
	}

	/** The order as accepted, rebuilt for on-chain verification and payout. */
	private acceptedOrder(cp: OrderCheckpoint): Order {
		const accepted = cp.accepted;
		if (accepted === null)
			throw new Error(`Order ${cp.orderId} has no accepted record`);
		return {
			...cp.order,
			tokenIn: this.deps.config.tokenIn.address,
			tokenOut: this.deps.config.tokenOut.address,
			status: "executing",
			solverId: this.deps.config.solverId,
			solverAddress: this.deps.evm.address,
			directDeposit: true,
			amountIn: accepted.amountIn,
			amountOut: accepted.amountOut,
			fee: accepted.fee,
			depositExpiresAt: accepted.depositExpiresAt,
			depositTx: cp.depositTx,
			deliverTx: cp.payoutHash,
		};
	}

	private async signedEnvelope<T extends object>(
		base: T,
	): Promise<{
		payload: T & { kid: number; timestamp: number };
		sig: Uint8Array;
	}> {
		const payload = {
			...base,
			kid: this.deps.config.kid,
			timestamp: Date.now(),
		};
		const sig = await sign(this.deps.authKey, deterministicEncode(payload));
		return { payload, sig };
	}

	private sendToHub(msg: ToHubMsg): void {
		if (
			this.closed ||
			this.halted !== null ||
			("orderId" in msg.payload && this.invalidated.has(msg.payload.orderId))
		)
			return;
		if (!this.deps.hub.send(msg))
			this.log("warn", "Hub frame dropped (socket not open)", {
				type: msg.type,
			});
	}

	private async persist(cp: OrderCheckpoint): Promise<void> {
		cp.updatedAt = Date.now();
		try {
			await this.deps.store.save(cp);
		} catch (error) {
			this.setHalted("durable checkpoint update failed");
			throw error;
		}
	}

	private log(
		level: "info" | "warn" | "error",
		msg: string,
		ctx: Record<string, unknown>,
	): void {
		if (this.deps.log) {
			this.deps.log(level, msg, ctx);
		} else {
			console[level === "info" ? "log" : level](
				`[solver ${this.deps.config.solverId}]`,
				msg,
				ctx,
			);
		}
	}
}

/**
 * Wrapper export: builds the real hub client and checkpoint store, wires the
 * shared Evm durability callbacks to fsynced checkpoints, and runs the serial
 * lifecycle. Returns a running handle; close() is operator shutdown.
 */
export async function runSolver(
	config: SolverConfig,
	evm: Evm,
	strategy: LiquidityStrategy,
	authKey: CryptoKey,
): Promise<{ close(): Promise<void> }> {
	const store = await CheckpointStore.open(config.stateDir);
	const hub = new HubClient({
		hubUrl: config.hubUrl,
		solverId: config.solverId,
		kid: config.kid,
		authKey,
	});
	const solver = new Solver({ config, evm, strategy, hub, store, authKey });
	try {
		await solver.start();
	} catch (error) {
		await solver.close();
		throw error;
	}
	return { close: () => solver.close() };
}

// ==================== pure helpers ====================

const PHASES_TERMINAL: Partial<Record<Phase, true>> = {
	done: true,
	disputed: true,
	released: true,
	failedMarket: true,
};

const HUB_ACTIVE_STATUSES: Record<string, true | undefined> = {
	selected: true,
	accepted: true,
	executing: true,
	depositNotAck: true,
	deliveredNotAck: true,
};

function asHash(tx: string): Hash {
	if (!/^0x[0-9a-fA-F]{64}$/.test(tx))
		throw new Error("Expected a 32-byte transaction hash");
	return tx as Hash;
}

/** True once ANY broadcast may have happened for this order (durable evidence:
 * an unconfirmed pendingSpend, a recorded swap/payout hash, or a confirmed
 * journal entry that has not yet been folded into a phase). */
function spendHappened(cp: OrderCheckpoint): boolean {
	if (cp.pendingSpend !== null || cp.lastConfirmedSpend !== null) return true;
	return cp.swapHash !== null || cp.payoutHash !== null;
}

/** Phases where we accepted funding and therefore owe delivery (or already paid). */
function spendObligation(cp: OrderCheckpoint): boolean {
	return SLOT_OCCUPYING[cp.phase] === true;
}

function verificationDeadline(cp: OrderCheckpoint): number {
	const base = cp.accepted?.depositExpiresAt;
	if (base !== null && base !== undefined) return base;
	return 0;
}

/** Assignment equality against the bid/original: the received order must equal
 * the stored NewOrder except for hub-owned bookkeeping fields, and the quote
 * field must be exactly our bid. */
export function assignmentMatches(
	original: Order,
	bidQuote: bigint,
	received: Order,
): boolean {
	if (received.typ !== OrderType.in) return false;
	const expected: Record<string, unknown> = orderForWire(original);
	expected.status = received.status;
	expected.solverId = received.solverId;
	expected.fee = received.fee ?? null;
	expected.feeRecipient = received.feeRecipient ?? null;
	expected.depositExpiresAt = received.depositExpiresAt ?? null;
	expected.createdAt = received.createdAt;
	expected.updatedAt = received.updatedAt;
	expected.amountOut = bidQuote;
	const actual = orderForWire(received);
	const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
	for (const key of keys) {
		if (!valueEquals(expected[key], actual[key])) return false;
	}
	return true;
}

function valueEquals(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if ((a === null || a === undefined) && (b === null || b === undefined))
		return true;
	if (typeof a === "bigint" && typeof b === "bigint") return a === b;
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((v, i) => valueEquals(v, b[i]));
	}
	return false;
}

class SpendRefused extends Error {}

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}
