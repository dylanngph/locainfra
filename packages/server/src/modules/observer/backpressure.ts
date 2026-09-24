import type { LogLine } from "@locastack/core";
import type { Channel, ServerMessage } from "./observer.model";

/** `bufferedAmount` above which a socket's log channels pause (1 MB). */
export const LOG_PAUSE_BUFFERED_BYTES = 1024 * 1024;

/** Bun's per-socket `backpressureLimit` for `/ws` (4 MB); messages beyond it are dropped. */
export const WS_BACKPRESSURE_LIMIT = 4 * 1024 * 1024;

/**
 * One connected WebSocket as the observer sees it (no Elysia types). `send`
 * returns Bun's send status: bytes sent (> 0), `-1` when queued under
 * backpressure, `0` when dropped.
 */
export interface ObserverSink {
	/** Stable connection id. */
	readonly id: string;
	/**
	 * @param message - Message to serialize and send.
	 * @returns Bun's `ServerWebSocketSendStatus`.
	 */
	send(message: ServerMessage): number;
	/** @returns Bytes queued but not yet written to the socket. */
	bufferedAmount(): number;
}

/**
 * Backpressure gate of one `logs:<id>` subscription of one socket. While the
 * socket is congested (a send returned `-1`/`0` or more than
 * {@link LOG_PAUSE_BUFFERED_BYTES} is buffered) batches are dropped and
 * counted; on resume (the socket's `drain`, or a later batch finding the
 * buffer below the threshold) one `{ lines: [], skipped: n }` marker is sent
 * before new lines.
 */
export class LogGate {
	private paused = false;
	private skipped = 0;
	private pendingEnd = false;

	/**
	 * @param sink - Socket to write to.
	 * @param channel - `logs:<containerId>` channel name.
	 * @param threshold - Buffered bytes that pause the gate.
	 */
	constructor(
		private readonly sink: ObserverSink,
		private readonly channel: Channel,
		private readonly threshold = LOG_PAUSE_BUFFERED_BYTES,
	) {}

	/** @returns Whether the gate is currently dropping batches. */
	get isPaused(): boolean {
		return this.paused;
	}

	/** @returns Lines dropped since the gate paused (reported on resume). */
	get skippedCount(): number {
		return this.skipped;
	}

	/**
	 * Sends a batch, or counts it as skipped while paused.
	 *
	 * @param lines - Lines of the batch.
	 * @param ended - The container's log stream ended after these lines.
	 */
	deliver(lines: readonly LogLine[], ended = false): void {
		if (this.paused) {
			this.resume();
			if (this.paused) {
				this.skipped += lines.length;
				this.pendingEnd ||= ended;
				return;
			}
		}
		this.write([...lines], ended);
	}

	/**
	 * Resumes when the socket's buffer is below the threshold, sending the
	 * skipped-lines marker (and a deferred `ended`). Call on the socket's `drain`.
	 */
	resume(): void {
		if (!this.paused || this.sink.bufferedAmount() > this.threshold) return;
		this.paused = false;
		const skipped = this.skipped;
		const ended = this.pendingEnd;
		this.skipped = 0;
		this.pendingEnd = false;
		if (skipped > 0 || ended) this.write([], ended, skipped);
	}

	private write(lines: LogLine[], ended: boolean, skipped = 0): void {
		const status = this.sink.send({
			channel: this.channel,
			type: "log",
			payload: {
				lines,
				...(skipped > 0 ? { skipped } : {}),
				...(ended ? { ended: true } : {}),
			},
		});
		if (status === 0) {
			// Dropped by Bun (backpressure limit): count it and wait for drain.
			this.paused = true;
			this.skipped += lines.length + skipped;
			this.pendingEnd ||= ended;
			return;
		}
		if (status === -1 || this.sink.bufferedAmount() > this.threshold)
			this.paused = true;
	}
}
