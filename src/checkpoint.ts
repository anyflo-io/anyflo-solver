/**
 * Crash-safe solver state: one atomic, fsynced CBOR checkpoint per order plus
 * completed-order markers and a one-process lock for the state directory.
 *
 * Durability rules (see plan: "small atomic, fsynced per-order checkpoint"):
 * - Every write is write-temp → fsync(file) → rename over target → fsync(directory).
 *   Bigints and hash strings round-trip through cbor-x.
 * - A decoded checkpoint is validated before use; a corrupt file is reported so
 *   the caller can block execution instead of creating a fresh spend.
 * - Phases that consumed capital or carry an unconfirmed spend occupy the serial
 *   one-order slot until an operator reconciles them; `released`/`done`/
 *   `disputed` terminals free the slot.
 */
import {
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	closeSync,
	fsyncSync,
	writeSync,
	writeFileSync,
	existsSync,
	realpathSync,
} from "node:fs";
import { join } from "node:path";

import { decode, encode } from "cbor-x";
import { OrderSchema, type Order } from "@anyflo/lib/order";
import type { UUID } from "@anyflo/lib/uuid";
import type { Hash } from "viem";

import type { SpendIntent } from "./types";

/** Serial lifecycle phase of one order. */
export const PHASES = [
	"bid", // bid persisted and sent; awaiting assignment
	"assigned", // assignment validated and acked; awaiting customer deposit
	"executing", // deposit independently verified and acked; preparing swap
	"spendIntent", // strategy swap attempted; pendingSpend carries the durability evidence
	"swapped", // swap confirmed on-chain
	"payoutIntent", // DeliveryAccount payout attempted; pendingSpend carries the evidence
	"delivered", // payout confirmed and independently verified; DeliveryAck sent
	"done", // hub confirmed delivery — terminal, frees the slot
	"failedMarket", // declined post-deposit (no route at/above accepted minimum) — capital retained
	"disputed", // DepositNotAck sent — terminal, frees the slot
	"released", // reassigned/cancelled/expired/rejected before any broadcast — terminal, frees the slot
	"blocked", // ambiguous or exposure state — operator reconciliation required, occupies the slot
] as const;
export type Phase = (typeof PHASES)[number];

/** Phases that own the serial one-order slot (no new orders may be bid). */
export const SLOT_OCCUPYING: Partial<Record<Phase, true>> = {
	bid: true,
	assigned: true,
	executing: true,
	spendIntent: true,
	swapped: true,
	payoutIntent: true,
	delivered: true,
	failedMarket: true,
	blocked: true,
};

export interface BidRecord {
	quote: bigint;
	expiresAt: number;
	kid: number;
	timestamp: number;
}

export interface AcceptedRecord {
	amountIn: bigint;
	amountOut: bigint;
	depositExpiresAt: number | null;
	fee: bigint | null;
}

/** One journaled EVM send (approval, swap or payout) awaiting/beyond confirmation. */
export interface PendingSpend {
	intent: SpendIntent;
	broadcastHash: string | null;
	confirmedHash: string | null;
	at: number;
}

export interface DepositVerifyState {
	tx: string;
	attempts: number;
	nextAt: number;
}

export interface OrderCheckpoint {
	version: 1;
	orderId: UUID;
	phase: Phase;
	/** Original order exactly as broadcast in NewOrder (quote field still the hub-side value). */
	order: Order;
	bid: BidRecord | null;
	accepted: AcceptedRecord | null;
	depositTx: string | null;
	swapHash: string | null;
	swapOut: bigint | null;
	payoutHash: string | null;
	pendingSpend: PendingSpend | null;
	/** Last spend whose confirmation was observed (pendingSpend is cleared per tx). */
	lastConfirmedSpend: (PendingSpend & { hash: string }) | null;
	depositVerify: DepositVerifyState | null;
	depositReorgedAt: number | null;
	blockedReason: string | null;
	updatedAt: number;
}

export interface CompletedMarker {
	orderId: UUID;
	outcome: string;
	at: number;
}

export type LoadResult = OrderCheckpoint | null | "corrupt";

export class CheckpointStore {
	private readonly ordersDir: string;
	private readonly completedDir: string;
	private closed = false;

	private constructor(readonly stateDir: string) {
		this.ordersDir = join(stateDir, "orders");
		this.completedDir = join(stateDir, "completed");
	}

	/** Opens (creates) the state directory, acquires the one-process lock and
	 * prepares sub-directories. Throws when another live process owns the lock. */
	static async open(stateDir: string): Promise<CheckpointStore> {
		mkdirSync(stateDir, { recursive: true });
		stateDir = realpathSync(stateDir);
		await acquireProcessLock(stateDir);
		try {
			mkdirSync(join(stateDir, "orders"), { recursive: true });
			mkdirSync(join(stateDir, "completed"), { recursive: true });
			fsyncDir(stateDir);
			return new CheckpointStore(stateDir);
		} catch (error) {
			releaseProcessLock(stateDir);
			throw error;
		}
	}

	load(orderId: UUID): LoadResult {
		if (!UUID_PATTERN.test(orderId)) return "corrupt";
		const file = join(this.ordersDir, `${orderId}.cbor`);
		if (!existsSync(file)) return null;
		try {
			const cp = decodeCheckpoint(new Uint8Array(readFileSync(file)));
			return cp.orderId === orderId ? cp : "corrupt";
		} catch {
			return "corrupt";
		}
	}

	/** All checkpoints on disk; corrupt files are reported separately so startup
	 * reconciliation can halt instead of guessing. */
	loadAll(): { checkpoints: OrderCheckpoint[]; corrupt: UUID[] } {
		const checkpoints: OrderCheckpoint[] = [];
		const corrupt: UUID[] = [];
		if (!existsSync(this.ordersDir)) return { checkpoints, corrupt };
		for (const name of readdirSync(this.ordersDir).sort()) {
			if (!name.endsWith(".cbor")) continue;
			const cp = this.load(name.slice(0, -".cbor".length) as UUID);
			if (cp === "corrupt")
				corrupt.push(name.slice(0, -".cbor".length) as UUID);
			else if (cp !== null) checkpoints.push(cp);
		}
		return { checkpoints, corrupt };
	}

	async save(cp: OrderCheckpoint): Promise<void> {
		if (this.closed) throw new Error("Checkpoint store is closed");
		if (!UUID_PATTERN.test(cp.orderId) || cp.orderId !== cp.order.id)
			throw new Error("Checkpoint identity mismatch");
		cp.updatedAt = Date.now();
		const bytes = new Uint8Array(encode(checkpointForWire(cp)));
		const file = join(this.ordersDir, `${cp.orderId}.cbor`);
		const tmp = `${file}.tmp`;
		writeFileSyncFsynced(tmp, bytes);
		renameSync(tmp, file);
		fsyncDir(this.ordersDir);
	}

	/** Terminal outcome marker; also rejects replayed messages for this order. */
	async markCompleted(orderId: UUID, outcome: string): Promise<void> {
		if (this.closed || !UUID_PATTERN.test(orderId))
			throw new Error("Invalid completed checkpoint");
		const bytes = new Uint8Array(
			encode({
				orderId,
				outcome,
				at: Date.now(),
			} satisfies CompletedMarker),
		);
		const file = join(this.completedDir, `${orderId}.cbor`);
		const tmp = `${file}.tmp`;
		writeFileSyncFsynced(tmp, bytes);
		renameSync(tmp, file);
		fsyncDir(this.completedDir);
	}

	isCompleted(orderId: UUID): boolean {
		return existsSync(join(this.completedDir, `${orderId}.cbor`));
	}

	completedOutcome(orderId: UUID): string | null {
		const file = join(this.completedDir, `${orderId}.cbor`);
		if (!existsSync(file)) return null;
		try {
			const marker = decode(
				new Uint8Array(readFileSync(file)),
			) as CompletedMarker;
			return typeof marker.outcome === "string" ? marker.outcome : "unknown";
		} catch {
			return "unknown";
		}
	}

	/** Releases the one-process lock. In-flight fsyncs have already completed
	 * because every save is synchronous. */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		releaseProcessLock(this.stateDir);
	}
}

// ==================== decode + validation ====================

/** Decodes and validates a checkpoint; throws on any structural problem so the
 * caller can treat the file as corrupt and block instead of spending. */
export function decodeCheckpoint(bytes: Uint8Array): OrderCheckpoint {
	const raw = decode(bytes) as Record<string, unknown>;
	if (raw?.version !== 1) throw new Error("Unsupported checkpoint version");
	const orderId = raw.orderId;
	if (typeof orderId !== "string" || !orderId)
		throw new Error("Missing orderId");
	const phase = raw.phase;
	if (typeof phase !== "string" || !PHASES.includes(phase as Phase)) {
		throw new Error(`Unknown phase: ${String(phase)}`);
	}
	const order = OrderSchema.parse(raw.order);
	if (orderId !== order.id || !UUID_PATTERN.test(orderId))
		throw new Error("Checkpoint identity mismatch");
	const cp: OrderCheckpoint = {
		version: 1,
		orderId,
		phase: phase as Phase,
		order,
		bid: record(raw.bid, (b) => ({
			quote: bigi(b.quote),
			expiresAt: num(b.expiresAt),
			kid: num(b.kid),
			timestamp: num(b.timestamp),
		})),
		accepted: record(raw.accepted, (a) => ({
			amountIn: bigi(a.amountIn),
			amountOut: bigi(a.amountOut),
			depositExpiresAt:
				a.depositExpiresAt === null ? null : num(a.depositExpiresAt),
			fee: a.fee === null ? null : bigi(a.fee),
		})),
		depositTx: hashOrNull(raw.depositTx),
		swapHash: hashOrNull(raw.swapHash),
		swapOut:
			raw.swapOut === null || raw.swapOut === undefined
				? null
				: bigi(raw.swapOut),
		payoutHash: hashOrNull(raw.payoutHash),
		pendingSpend: record(raw.pendingSpend, (p) => ({
			intent: intent(p.intent),
			broadcastHash: hashOrNull(p.broadcastHash),
			confirmedHash: hashOrNull(p.confirmedHash),
			at: num(p.at),
		})),
		lastConfirmedSpend: record(raw.lastConfirmedSpend, (p) => ({
			intent: intent(p.intent),
			broadcastHash: hashOrNull(p.broadcastHash),
			confirmedHash: hashOrNull(p.confirmedHash),
			at: num(p.at),
			hash: hashOrThrow(p.hash),
		})),
		depositVerify: record(raw.depositVerify, (d) => ({
			tx: hashOrThrow(d.tx),
			attempts: num(d.attempts),
			nextAt: num(d.nextAt),
		})),
		depositReorgedAt:
			raw.depositReorgedAt === null || raw.depositReorgedAt === undefined
				? null
				: num(raw.depositReorgedAt),
		blockedReason: strOrNull(raw.blockedReason),
		updatedAt: num(raw.updatedAt),
	};
	if (cp.bid && (cp.bid.quote <= 0n || !Number.isSafeInteger(cp.bid.expiresAt)))
		throw new Error("Invalid bid");
	if (
		cp.accepted &&
		(cp.accepted.amountIn !== order.amountIn ||
			cp.accepted.amountOut <= 0n ||
			cp.accepted.fee === null ||
			cp.accepted.fee < 0n)
	)
		throw new Error("Invalid accepted monetary terms");
	if (
		[
			"assigned",
			"executing",
			"spendIntent",
			"swapped",
			"payoutIntent",
			"delivered",
			"done",
			"failedMarket",
		].includes(cp.phase) &&
		!cp.accepted
	)
		throw new Error("Accepted terms missing");
	if (
		cp.lastConfirmedSpend &&
		(cp.lastConfirmedSpend.hash !== cp.lastConfirmedSpend.confirmedHash ||
			cp.lastConfirmedSpend.hash !== cp.lastConfirmedSpend.broadcastHash)
	)
		throw new Error("Confirmed spend identity mismatch");
	return cp;
}

function record<T>(
	value: unknown,
	f: (v: Record<string, unknown>) => T,
): T | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "object") throw new Error("Expected object field");
	return f(value as Record<string, unknown>);
}

function bigi(value: unknown): bigint {
	if (typeof value === "bigint") return value;
	if (typeof value === "string" && /^[0-9]+$/.test(value)) return BigInt(value);
	throw new Error(`Expected bigint field, got: ${String(value)}`);
}

function num(value: unknown): number {
	if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
		return value;
	throw new Error(`Expected number field, got: ${String(value)}`);
}

function strOrNull(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string") throw new Error("Expected string field");
	return value;
}

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

function hashOrNull(value: unknown): Hash | null {
	const s = strOrNull(value);
	if (s === null) return null;
	return hashOrThrow(s);
}

function hashOrThrow(value: unknown): Hash {
	if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
		throw new Error(`Expected tx-hash field, got: ${String(value)}`);
	}
	return value as Hash;
}

function intent(value: unknown): SpendIntent {
	if (
		typeof value !== "object" ||
		value === null ||
		!("to" in value) ||
		!("data" in value) ||
		!("value" in value)
	) {
		throw new Error("Expected spend intent");
	}
	if (
		typeof value.to !== "string" ||
		!/^0x[0-9a-fA-F]{40}$/.test(value.to) ||
		typeof value.data !== "string" ||
		!/^0x(?:[0-9a-fA-F]{2})*$/.test(value.data)
	)
		throw new Error("Invalid spend address or calldata");
	const amount = bigi(value.value);
	if (amount < 0n) throw new Error("Invalid native spend");
	return {
		to: value.to as SpendIntent["to"],
		data: value.data as SpendIntent["data"],
		value: amount,
	};
}

/**
 * cbor-x skips `undefined` object values, so normalize optional Order fields to
 * explicit nulls before encoding — keeps checkpoints byte-stable and the
 * assignment equality comparison meaningful.
 */
function checkpointForWire(cp: OrderCheckpoint): Record<string, unknown> {
	return { ...cp, order: orderForWire(cp.order) };
}

export function orderForWire(order: Order): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(order)) {
		out[key] = value === undefined ? null : value;
	}
	return out;
}

// ==================== fsync helpers ====================

function writeFileSyncFsynced(path: string, bytes: Uint8Array): void {
	const fd = openSync(path, "w", 0o600);
	try {
		writeFileSync(fd, bytes);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function fsyncDir(dir: string): void {
	const fd = openSync(dir, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

// ==================== one-process lock ====================

const LOCK_FILE = ".solver.lock";
const heldLocks = new Set<string>();

function errorCode(e: unknown): string | null {
	if (
		typeof e === "object" &&
		e !== null &&
		"code" in e &&
		typeof e.code === "string"
	) {
		return e.code;
	}
	return null;
}

async function acquireProcessLock(stateDir: string): Promise<void> {
	const file = join(stateDir, LOCK_FILE);
	if (heldLocks.has(file)) {
		throw new Error(
			`State directory is already locked by this process: ${stateDir}`,
		);
	}
	try {
		const fd = openSync(file, "wx", 0o600);
		try {
			writeSync(
				fd,
				new TextEncoder().encode(
					`${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`,
				),
			);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		heldLocks.add(file);
	} catch (e) {
		if (errorCode(e) !== "EEXIST") throw e;
		throw new Error(
			`State directory is locked (pid ${readLockPid(file) ?? "unknown"}). A stale process lock must be removed manually after checking its PID and pending receipts; removing it does not reconcile order checkpoints.`,
		);
	}
}

function releaseProcessLock(stateDir: string): void {
	const file = join(stateDir, LOCK_FILE);
	if (!heldLocks.has(file)) return;
	heldLocks.delete(file);
	rmSync(file, { force: true });
}

function readLockPid(file: string): number | null {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as { pid?: number };
		return typeof parsed.pid === "number" ? parsed.pid : null;
	} catch {
		return null;
	}
}
