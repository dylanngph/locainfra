import type { ContainerStreams, LogLine } from "@locastack/core";
import type { ChannelError } from "../observer.model";
import { later, streamFailure, type Timer } from "./channel.types";

/** Tuning of {@link LogsChannel}. */
export interface LogsChannelOptions {
	/** Batch window, in ms (the API promises 50–100 ms). Default 75. */
	readonly batchMs?: number;
	/** Lines remembered per container for later subscribers' `tail`. Default 5000 (the max `tail`). */
	readonly bufferLines?: number;
}

/** Receives a container's log batches. */
export interface LogsListener {
	/**
	 * @param lines - Lines of the batch (the first batch is the tail).
	 * @param ended - The stream ended (container stopped) after these lines.
	 */
	onLines(lines: readonly LogLine[], ended: boolean): void;
	/** The upstream failed; the subscription is over. */
	onError(error: ChannelError): void;
}

interface LogsEntry {
	readonly listeners: Set<LogsListener>;
	readonly buffer: LogLine[];
	pending: LogLine[];
	timer?: Timer;
	readonly controller: AbortController;
}

/** Default number of history lines sent on subscribe. */
export const DEFAULT_LOG_TAIL = 200;

/**
 * `logs:<containerId>`: one shared, following upstream
 * `ContainerStreams.logs` per container while at least one listener is
 * attached (refcounted; aborted when the last leaves). Lines are batched
 * every `batchMs`. The first listener's `tail` opens the upstream; later
 * listeners get their tail from the lines seen since (at most `bufferLines`).
 */
export class LogsChannel {
	private readonly entries = new Map<string, LogsEntry>();
	private readonly batchMs: number;
	private readonly bufferLines: number;

	/**
	 * @param streams - Docker streams.
	 * @param options - Batch window and buffer size.
	 */
	constructor(
		private readonly streams: ContainerStreams,
		options: LogsChannelOptions = {},
	) {
		this.batchMs = options.batchMs ?? 75;
		this.bufferLines = options.bufferLines ?? 5000;
	}

	/**
	 * Attaches a listener.
	 *
	 * @param id - Container id.
	 * @param tail - Lines of history wanted first.
	 * @param listener - Receives batches.
	 * @returns Detaches the listener (the upstream closes with the last one).
	 */
	subscribe(id: string, tail: number, listener: LogsListener): () => void {
		const existing = this.entries.get(id);
		if (existing !== undefined) {
			// Deliver what is pending to current listeners first, so the newcomer
			// sees each line exactly once (in its tail).
			this.flush(existing);
			existing.listeners.add(listener);
			listener.onLines(tail === 0 ? [] : existing.buffer.slice(-tail), false);
		} else {
			const entry: LogsEntry = {
				listeners: new Set([listener]),
				buffer: [],
				pending: [],
				controller: new AbortController(),
			};
			this.entries.set(id, entry);
			void this.pump(id, entry, tail);
		}
		return () => this.detach(id, listener);
	}

	/** @returns Number of open upstream streams (for tests and diagnostics). */
	get openUpstreams(): number {
		return this.entries.size;
	}

	/** Aborts every upstream and drops all listeners. */
	close(): void {
		for (const entry of this.entries.values()) this.stop(entry);
		this.entries.clear();
	}

	private detach(id: string, listener: LogsListener): void {
		const entry = this.entries.get(id);
		if (entry === undefined || !entry.listeners.delete(listener)) return;
		if (entry.listeners.size > 0) return;
		this.stop(entry);
		this.entries.delete(id);
	}

	private stop(entry: LogsEntry): void {
		entry.controller.abort();
		if (entry.timer !== undefined) clearTimeout(entry.timer);
		entry.timer = undefined;
		entry.listeners.clear();
	}

	private async pump(
		id: string,
		entry: LogsEntry,
		tail: number,
	): Promise<void> {
		const { signal } = entry.controller;
		try {
			for await (const line of this.streams.logs(id, {
				follow: true,
				tail,
				signal,
			})) {
				if (signal.aborted) return;
				entry.buffer.push(line);
				if (entry.buffer.length > this.bufferLines) entry.buffer.shift();
				entry.pending.push(line);
				entry.timer ??= later(() => this.flush(entry), this.batchMs);
			}
		} catch (error) {
			if (signal.aborted) return;
			this.flush(entry);
			for (const listener of [...entry.listeners])
				listener.onError(streamFailure(error));
			this.end(id, entry);
			return;
		}
		if (signal.aborted) return;
		// The container stopped: flush and tell every listener the stream ended.
		const lines = this.take(entry);
		for (const listener of [...entry.listeners]) listener.onLines(lines, true);
		this.end(id, entry);
	}

	private end(id: string, entry: LogsEntry): void {
		this.stop(entry);
		if (this.entries.get(id) === entry) this.entries.delete(id);
	}

	private take(entry: LogsEntry): LogLine[] {
		if (entry.timer !== undefined) clearTimeout(entry.timer);
		entry.timer = undefined;
		const lines = entry.pending;
		entry.pending = [];
		return lines;
	}

	private flush(entry: LogsEntry): void {
		const lines = this.take(entry);
		if (lines.length === 0) return;
		for (const listener of [...entry.listeners]) listener.onLines(lines, false);
	}
}
