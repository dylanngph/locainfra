import type { ClientMessage, ServerMessage } from "@locastack/server";

/** Connection state of the observer socket. */
export type ConnectionState = "idle" | "connecting" | "open" | "closed";

/** The subset of the browser `WebSocket` the observer uses. */
export interface SocketLike {
	readonly readyState: number;
	send(data: string): void;
	close(): void;
	onopen: ((event: Event) => void) | null;
	onmessage: ((event: MessageEvent) => void) | null;
	onclose: ((event: CloseEvent) => void) | null;
	onerror: ((event: Event) => void) | null;
}

/** Opens a socket for a URL (swap for tests). */
export type SocketFactory = (url: string) => SocketLike;

/** Construction options of {@link ObserverSocket}. */
export interface ObserverSocketOptions {
	/** Builds the `/ws?t=` URL at connect time (the token may arrive late). */
	readonly url: () => string;
	/** Called with every parsed server message. */
	readonly onMessage: (message: ServerMessage) => void;
	/** Called when the connection state changes. */
	readonly onState?: (state: ConnectionState) => void;
	/** Socket constructor; defaults to the global `WebSocket`. */
	readonly factory?: SocketFactory;
	/** Reconnect delays in ms (last value repeats). */
	readonly backoff?: readonly number[];
	/**
	 * How long the socket stays open after its last subscriber leaves, so a
	 * quick unsubscribe/resubscribe (route change, StrictMode) reuses it.
	 * Defaults to {@link IDLE_CLOSE_MS}.
	 */
	readonly idleCloseMs?: number;
	/** Called when a channel loses its last subscriber. */
	readonly onRelease?: (channel: string) => void;
}

/** Default grace period before an unused socket closes. */
export const IDLE_CLOSE_MS = 1_000;

const OPEN = 1;
const DEFAULT_BACKOFF = [500, 1_000, 2_000, 5_000, 10_000];

interface Subscription {
	count: number;
	tail: number | undefined;
}

const isServerMessage = (value: unknown): value is ServerMessage =>
	typeof value === "object" &&
	value !== null &&
	"type" in value &&
	"channel" in value &&
	typeof value.type === "string" &&
	typeof value.channel === "string";

/**
 * Reference-counted subscriptions over one reconnecting WebSocket to `/ws`.
 * Connects lazily on the first subscription, re-subscribes every active
 * channel after a reconnect, and closes once nothing has been subscribed for
 * `idleCloseMs` (the dashboard is opt-in live: no socket while idle).
 */
export class ObserverSocket {
	readonly #options: ObserverSocketOptions;
	readonly #subs = new Map<string, Subscription>();
	#socket: SocketLike | null = null;
	#attempt = 0;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#idleTimer: ReturnType<typeof setTimeout> | null = null;
	#disposed = false;

	/** @param options - URL builder, message sink and socket factory. */
	constructor(options: ObserverSocketOptions) {
		this.#options = options;
	}

	/** Channels with at least one subscriber. */
	get channels(): readonly string[] {
		return [...this.#subs.keys()];
	}

	/** Whether a socket exists (connecting or open). */
	get connected(): boolean {
		return this.#socket !== null;
	}

	/**
	 * Subscribes to a channel; the returned function releases this subscriber.
	 *
	 * @param channel - `status:<project>`, `stats:<id>`, `logs:<id>` or `op:<id>`.
	 * @param tail - Log history lines (logs channels only).
	 * @returns Unsubscribe function (idempotent).
	 */
	subscribe(channel: string, tail?: number): () => void {
		const existing = this.#subs.get(channel);
		if (existing) existing.count += 1;
		else {
			this.#subs.set(channel, { count: 1, tail });
			this.#send({ type: "subscribe", channel, tail });
		}
		this.#cancelIdleClose();
		this.#ensureConnected();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const sub = this.#subs.get(channel);
			if (!sub) return;
			sub.count -= 1;
			if (sub.count <= 0) {
				this.#subs.delete(channel);
				this.#send({ type: "unsubscribe", channel });
				this.#options.onRelease?.(channel);
				if (this.#subs.size === 0) this.#scheduleIdleClose();
			}
		};
	}

	/** Closes the socket and stops reconnecting. */
	dispose(): void {
		this.#disposed = true;
		if (this.#timer) clearTimeout(this.#timer);
		this.#cancelIdleClose();
		this.#socket?.close();
		this.#socket = null;
		this.#subs.clear();
	}

	#scheduleIdleClose(): void {
		this.#cancelIdleClose();
		this.#idleTimer = setTimeout(() => {
			this.#idleTimer = null;
			if (this.#subs.size > 0) return;
			if (this.#timer) {
				clearTimeout(this.#timer);
				this.#timer = null;
			}
			this.#attempt = 0;
			const socket = this.#socket;
			if (!socket) return;
			// Detach first so onclose does not schedule a reconnect.
			this.#socket = null;
			socket.close();
			this.#options.onState?.("idle");
		}, this.#options.idleCloseMs ?? IDLE_CLOSE_MS);
	}

	#cancelIdleClose(): void {
		if (!this.#idleTimer) return;
		clearTimeout(this.#idleTimer);
		this.#idleTimer = null;
	}

	#ensureConnected(): void {
		if (this.#socket || this.#timer || this.#disposed) return;
		this.#connect();
	}

	#connect(): void {
		this.#timer = null;
		const factory =
			this.#options.factory ??
			((url: string) => new WebSocket(url) as SocketLike);
		let socket: SocketLike;
		try {
			socket = factory(this.#options.url());
		} catch {
			this.#scheduleReconnect();
			return;
		}
		this.#socket = socket;
		this.#options.onState?.("connecting");
		socket.onopen = () => {
			this.#attempt = 0;
			this.#options.onState?.("open");
			for (const [channel, sub] of this.#subs) {
				this.#send({ type: "subscribe", channel, tail: sub.tail });
			}
		};
		socket.onmessage = (event) => {
			if (typeof event.data !== "string") return;
			let parsed: unknown;
			try {
				parsed = JSON.parse(event.data);
			} catch {
				return;
			}
			if (isServerMessage(parsed)) this.#options.onMessage(parsed);
		};
		socket.onclose = () => {
			if (this.#socket !== socket) return;
			this.#socket = null;
			this.#options.onState?.("closed");
			if (!this.#disposed && this.#subs.size > 0) this.#scheduleReconnect();
		};
		socket.onerror = () => {
			// onclose follows and handles reconnecting.
		};
	}

	#scheduleReconnect(): void {
		if (this.#disposed || this.#timer) return;
		const delays = this.#options.backoff ?? DEFAULT_BACKOFF;
		const delay = delays[Math.min(this.#attempt, delays.length - 1)] ?? 10_000;
		this.#attempt += 1;
		this.#timer = setTimeout(() => this.#connect(), delay);
	}

	#send(message: ClientMessage): void {
		const socket = this.#socket;
		if (!socket || socket.readyState !== OPEN) return;
		const payload: ClientMessage =
			message.tail === undefined
				? { type: message.type, channel: message.channel }
				: message;
		socket.send(JSON.stringify(payload));
	}
}
