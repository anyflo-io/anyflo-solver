/**
 * Anyflo Solver Hub client: authenticated WebSocket push channel plus the
 * active-orders REST call.
 *
 * Protocol (published `@anyflo/lib/solverhub` + docs/05-solverhub-auth.md):
 * - `GET {hubUrl}/connect` upgrade carries an Ed25519-signed JWT
 *   (`Authorization: Bearer`, alg EdDSA, aud `anyflo:solver-hub`, lifetime ≤ 900s).
 * - Frames are cbor-x CBOR envelopes (`FromHubMsg` down, `ToHubMsg` up); the
 *   heartbeat is plain text `ping`/`pong` on the solver→hub side, answered by
 *   the hub runtime without waking its Durable Object.
 * - Close 4001 = key revoked, 4002 = solver suspended: halt and stop
 *   reconnecting (operator action required). Any other transport failure
 *   reconnects with capped exponential backoff.
 */
import { decode, encode } from "cbor-x";
import { signJwt, MAX_JWT_LIFETIME_SEC } from "@anyflo/lib/auth";
import {
	ActiveOrdersRespSchema,
	FromHubMsgSchema,
	HEARTBEAT_INTERVAL_MS,
	HEARTBEAT_PING,
	HEARTBEAT_PONG,
	WS_CLOSE_KEY_REVOKED,
	WS_CLOSE_SOLVER_SUSPENDED,
	type ActiveOrdersResp,
	type FromHubMsg,
	type ToHubMsg,
} from "@anyflo/lib/solverhub";
import { newFailure, newSuccess, type PResult } from "@anyflo/lib/result";

const JWT_TTL_SEC = Math.min(600, MAX_JWT_LIFETIME_SEC);
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;
/** Solver's liveness window: hub must send some frame within this bound. */
const HEARTBEAT_STALE_MS = 2 * HEARTBEAT_INTERVAL_MS;

export interface HubClientOptions {
	/** WS URL including the `/connect` upgrade path (base URL also accepted). */
	hubUrl: string;
	solverId: number;
	kid: number;
	authKey: CryptoKey;
	onMessage?: (msg: FromHubMsg) => void | Promise<void>;
	/** Socket is open (also after every successful reconnect). */
	onOpen?: () => void | Promise<void>;
	/** Terminal shutdown: key revoked or solver suspended. No reconnect follows. */
	onHalt?: (reason: string) => void;
	log?: (
		level: "info" | "warn" | "error",
		msg: string,
		ctx?: Record<string, unknown>,
	) => void;
}

export class HubClient {
	private ws: WebSocket | null = null;
	private stopped = false;
	private haltedReason: string | null = null;
	private attempts = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private lastFrameAt = 0;
	private messageHandler: ((msg: FromHubMsg) => void | Promise<void>) | null =
		null;
	private openHandler: (() => void | Promise<void>) | null = null;
	private haltHandler: ((reason: string) => void) | null = null;
	private readonly wsUrl: string;
	private readonly restBase: string;

	constructor(private readonly opts: HubClientOptions) {
		const url = new URL(opts.hubUrl);
		url.pathname = url.pathname.replace(/\/+$/, "");
		if (!url.pathname.endsWith("/connect")) url.pathname += "/connect";
		if (url.protocol === "http:") url.protocol = "ws:";
		if (url.protocol === "https:") url.protocol = "wss:";
		this.wsUrl = url.toString();
		url.pathname = url.pathname.slice(0, -"/connect".length);
		this.restBase = toHttpUrl(url.toString()).replace(/\/+$/, "");
	}

	/** Solver-facing registration surface (satisfies HubLike). */
	onMessage(handler: (msg: FromHubMsg) => void | Promise<void>): void {
		this.messageHandler = handler;
	}

	onOpen(handler: () => void | Promise<void>): void {
		this.openHandler = handler;
	}

	onHalt(handler: (reason: string) => void): void {
		this.haltHandler = handler;
	}

	get connected(): boolean {
		return this.ws?.readyState === WebSocket.OPEN;
	}

	get halted(): string | null {
		return this.haltedReason;
	}

	start(): void {
		if (this.stopped || this.ws !== null) return;
		void this.connect();
		this.heartbeatTimer = setInterval(
			() => this.heartbeatTick(),
			HEARTBEAT_INTERVAL_MS,
		);
	}

	/** Sends a ToHubMsg frame; false when the socket is not open (the caller
	 * decides semantics — the protocol has no ack for lost solver frames, the
	 * hub's own deadlines/mailbox recover them). */
	send(msg: ToHubMsg): boolean {
		if (!this.connected) return false;
		try {
			this.ws!.send(new Uint8Array(encode(msg)));
			return true;
		} catch (e) {
			this.log("warn", "Failed to send hub frame", {
				error: String(e),
				type: msg.type,
			});
			return false;
		}
	}

	/** REST catch-up: active orders assigned to this solver. */
	async activeOrders(): PResult<ActiveOrdersResp> {
		let parsed;
		try {
			const jwt = await signJwt(
				this.opts.solverId,
				this.opts.kid,
				this.opts.authKey,
				JWT_TTL_SEC,
			);
			const res = await fetch(`${this.restBase}/v1/orders/active`, {
				headers: { authorization: `Bearer ${jwt}`, accept: "application/cbor" },
				redirect: "error",
				signal: AbortSignal.timeout(10_000),
			});
			if (!res.ok) {
				if (res.status === 401 || res.status === 403)
					this.halt("hub authentication rejected");
				return newFailure(res.status, "Active orders rejected");
			}
			parsed = ActiveOrdersRespSchema.safeParse(
				decode(new Uint8Array(await res.arrayBuffer())),
			);
		} catch {
			return newFailure(502, "Active orders response unavailable or malformed");
		}
		if (!parsed.success)
			return newFailure(502, "Invalid ActiveOrdersResp from hub");
		return newSuccess(parsed.data);
	}

	async close(): Promise<void> {
		this.stopped = true;
		if (this.heartbeatTimer !== null) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
		if (this.reconnectTimer !== null) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		const ws = this.ws;
		this.ws = null;
		if (ws && ws.readyState < WebSocket.CLOSING)
			ws.close(1000, "solver shutdown");
	}

	// ==================== internals ====================

	private async connect(): Promise<void> {
		if (this.stopped || this.haltedReason !== null) return;
		// Fresh JWT per connection attempt: `exp` may lapse while retrying.
		let ws: WebSocket;
		try {
			const jwt = await signJwt(
				this.opts.solverId,
				this.opts.kid,
				this.opts.authKey,
				JWT_TTL_SEC,
			);
			if (this.stopped || this.haltedReason !== null) return;
			ws = new WebSocket(this.wsUrl, {
				headers: { Authorization: `Bearer ${jwt}` },
			});
		} catch {
			this.scheduleReconnect(0, "connection setup failed");
			return;
		}
		this.ws = ws;
		ws.binaryType = "arraybuffer";
		ws.addEventListener("open", () => {
			if (this.ws !== ws) return;
			this.lastFrameAt = Date.now();
			this.attempts = 0;
			this.log("info", "Connected to Solver Hub", { url: this.wsUrl });
			void Promise.resolve(this.openHandler?.() ?? this.opts.onOpen?.()).catch(
				(e) => this.log("error", "onOpen handler failed", { error: String(e) }),
			);
		});
		ws.addEventListener("message", (event: MessageEvent) => {
			if (this.ws !== ws) return;
			this.lastFrameAt = Date.now();
			this.handleFrame(event.data).catch((e) =>
				this.log("error", "Message handler failed", { error: String(e) }),
			);
		});
		ws.addEventListener("close", (event: CloseEvent) => {
			if (this.ws !== ws) return;
			this.ws = null;
			if (event.code === WS_CLOSE_KEY_REVOKED) {
				this.halt("key revoked");
				return;
			}
			if (event.code === WS_CLOSE_SOLVER_SUSPENDED) {
				this.halt("solver suspended");
				return;
			}
			this.scheduleReconnect(event.code, event.reason);
		});
		ws.addEventListener("error", () => {
			// close follows; nothing to do beyond logging
		});
	}

	private async handleFrame(data: unknown): Promise<void> {
		if (typeof data === "string") {
			// Heartbeat pongs (and any stray text) are not envelopes.
			if (data !== HEARTBEAT_PONG)
				this.log("warn", "Unexpected text frame from hub", {
					length: data.length,
				});
			return;
		}
		if (!(data instanceof ArrayBuffer)) return;
		let parsed: unknown;
		try {
			parsed = decode(new Uint8Array(data));
		} catch (e) {
			this.log("warn", "Undecodable CBOR frame from hub", { error: String(e) });
			return;
		}
		const result = FromHubMsgSchema.safeParse(parsed);
		if (!result.success) {
			this.log("warn", "Invalid FromHubMsg from hub", {
				issues: result.error.issues.length,
			});
			return;
		}
		const handler = this.messageHandler ?? this.opts.onMessage;
		if (handler) await handler(result.data);
	}

	private heartbeatTick(): void {
		if (this.stopped || this.haltedReason !== null) return;
		const ws = this.ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		if (Date.now() - this.lastFrameAt > HEARTBEAT_STALE_MS) {
			this.log("warn", "Hub connection blackholed; forcing reconnect", {
				silentMs: Date.now() - this.lastFrameAt,
			});
			ws.close(4003, "heartbeat timeout");
			return;
		}
		try {
			ws.send(HEARTBEAT_PING);
		} catch (e) {
			this.log("warn", "Heartbeat ping failed", { error: String(e) });
		}
	}

	private scheduleReconnect(code: number, reason: string): void {
		if (this.stopped || this.haltedReason !== null) return;
		this.attempts += 1;
		const delay =
			Math.min(RECONNECT_BASE_MS * 2 ** (this.attempts - 1), RECONNECT_MAX_MS) +
			Math.floor(Math.random() * 250);
		this.log("info", "Scheduling hub reconnect", {
			code,
			reason,
			delayMs: delay,
			attempt: this.attempts,
		});
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			void this.connect();
		}, delay);
	}

	private halt(reason: string): void {
		if (this.haltedReason !== null) return;
		this.haltedReason = reason;
		this.stopped = true;
		if (this.heartbeatTimer !== null) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
		if (this.reconnectTimer !== null) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.log(
			"warn",
			`Hub connection halted: ${reason}; operator action required`,
			{},
		);
		(this.haltHandler ?? this.opts.onHalt)?.(reason);
	}

	private log(
		level: "info" | "warn" | "error",
		msg: string,
		ctx: Record<string, unknown>,
	): void {
		if (this.opts.log) this.opts.log(level, msg, ctx);
		else console[level === "info" ? "log" : level](msg, ctx);
	}
}

function toHttpUrl(wsOrHttpUrl: string): string {
	let url = wsOrHttpUrl;
	if (url.startsWith("wss://")) url = `https://${url.slice("wss://".length)}`;
	else if (url.startsWith("ws://")) url = `http://${url.slice("ws://".length)}`;
	return url.replace(/\/+$/, "");
}
