import type { ContainerStreams, StatsSample } from "@locastack/core";
import type { ChannelError } from "../observer.model";
import { later, streamFailure, type Timer } from "./channel.types";

/** Tuning of {@link StatsChannel}. */
export interface StatsChannelOptions {
	/** History kept per container, in ms (ring buffer). Default 5 min. */
	readonly historyMs?: number;
	/** Samples sent to a fresh subscriber. Default 24 (the Metrics tab's bars). */
	readonly historyPoints?: number;
	/** Minimum interval between two sends to subscribers (latest value wins). Default 1000 ms. */
	readonly flushMs?: number;
	/** Delay before reopening an upstream that ended while subscribed. Default 2000 ms. */
	readonly retryMs?: number;
	/** A sample older than this is not reported by {@link StatsChannel.latest}. Default 10 s. */
	readonly freshMs?: number;
	/** Millisecond clock. Default `Date.now`. */
	readonly now?: () => number;
}

/** Receives a container's samples. */
export interface StatsListener {
	/** History on subscribe, then coalesced new samples (oldest first). */
	onSamples(samples: StatsSample[]): void;
	/** The upstream failed. */
	onError(error: ChannelError): void;
}

interface StatsEntry {
	readonly ring: StatsSample[];
	readonly listeners: Set<StatsListener>;
	controller?: AbortController;
	pending?: StatsSample;
	flushTimer?: Timer;
	retryTimer?: Timer;
}

const MAX_RING = 600;

/**
 * `stats:<containerId>`: one shared upstream `ContainerStreams.stats` per
 * container while at least one listener is attached (refcounted; aborted when
 * the last leaves). Samples go into a 5-minute ring buffer that outlives
 * subscriptions, so a fresh subscriber first gets the last 24 samples; live
 * samples are throttled to one send per `flushMs` (latest value only).
 */
export class StatsChannel {
	private readonly entries = new Map<string, StatsEntry>();
	private readonly historyMs: number;
	private readonly historyPoints: number;
	private readonly flushMs: number;
	private readonly retryMs: number;
	private readonly freshMs: number;
	private readonly now: () => number;

	/**
	 * @param streams - Docker streams.
	 * @param options - Timings.
	 */
	constructor(
		private readonly streams: ContainerStreams,
		options: StatsChannelOptions = {},
	) {
		this.historyMs = options.historyMs ?? 5 * 60_000;
		this.historyPoints = options.historyPoints ?? 24;
		this.flushMs = options.flushMs ?? 1000;
		this.retryMs = options.retryMs ?? 2000;
		this.freshMs = options.freshMs ?? 10_000;
		this.now = options.now ?? Date.now;
	}

	/**
	 * Attaches a listener; sends the history right away.
	 *
	 * @param id - Container id.
	 * @param listener - Receives samples.
	 * @returns Detaches the listener (the upstream closes with the last one).
	 */
	subscribe(id: string, listener: StatsListener): () => void {
		this.sweep();
		const entry = this.entry(id);
		this.trim(entry);
		entry.listeners.add(listener);
		listener.onSamples(entry.ring.slice(-this.historyPoints));
		if (entry.controller === undefined && entry.retryTimer === undefined)
			this.open(id, entry);
		return () => this.detach(id, listener);
	}

	/**
	 * @param id - Container id.
	 * @returns The newest sample when it is fresh, else `undefined`.
	 */
	latest(id: string): StatsSample | undefined {
		const last = this.entries.get(id)?.ring.at(-1);
		if (last === undefined) return undefined;
		return this.now() - Date.parse(last.at) <= this.freshMs ? last : undefined;
	}

	/** @returns Number of open upstream streams (for tests and diagnostics). */
	get openUpstreams(): number {
		let open = 0;
		for (const entry of this.entries.values())
			if (entry.controller !== undefined) open++;
		return open;
	}

	/** Aborts every upstream and drops all listeners. */
	close(): void {
		for (const entry of this.entries.values()) {
			entry.listeners.clear();
			this.stop(entry);
		}
		this.entries.clear();
	}

	private entry(id: string): StatsEntry {
		let entry = this.entries.get(id);
		if (entry === undefined) {
			entry = { ring: [], listeners: new Set() };
			this.entries.set(id, entry);
		}
		return entry;
	}

	private detach(id: string, listener: StatsListener): void {
		const entry = this.entries.get(id);
		if (entry === undefined || !entry.listeners.delete(listener)) return;
		if (entry.listeners.size === 0) this.stop(entry);
	}

	private stop(entry: StatsEntry): void {
		entry.controller?.abort();
		entry.controller = undefined;
		if (entry.flushTimer !== undefined) clearTimeout(entry.flushTimer);
		if (entry.retryTimer !== undefined) clearTimeout(entry.retryTimer);
		entry.flushTimer = undefined;
		entry.retryTimer = undefined;
		entry.pending = undefined;
	}

	private open(id: string, entry: StatsEntry): void {
		const controller = new AbortController();
		entry.controller = controller;
		void this.pump(id, entry, controller);
	}

	private async pump(
		id: string,
		entry: StatsEntry,
		controller: AbortController,
	): Promise<void> {
		try {
			for await (const sample of this.streams.stats(id, controller.signal)) {
				if (controller.signal.aborted) break;
				entry.ring.push(sample);
				this.trim(entry);
				this.offer(entry, sample);
			}
		} catch (error) {
			if (!controller.signal.aborted)
				for (const listener of [...entry.listeners])
					listener.onError(streamFailure(error));
		}
		if (entry.controller !== controller) return;
		entry.controller = undefined;
		if (controller.signal.aborted || entry.listeners.size === 0) return;
		// Ended while watched (container stopped or recreated): try again later.
		entry.retryTimer = later(() => {
			entry.retryTimer = undefined;
			if (entry.listeners.size > 0 && entry.controller === undefined)
				this.open(id, entry);
		}, this.retryMs);
	}

	/** Leading + trailing throttle: send now, then at most once per `flushMs`. */
	private offer(entry: StatsEntry, sample: StatsSample): void {
		if (entry.flushTimer !== undefined) {
			entry.pending = sample;
			return;
		}
		this.send(entry, sample);
		const tick = () => {
			const pending = entry.pending;
			entry.pending = undefined;
			if (pending === undefined || entry.listeners.size === 0) {
				entry.flushTimer = undefined;
				return;
			}
			this.send(entry, pending);
			entry.flushTimer = later(tick, this.flushMs);
		};
		entry.flushTimer = later(tick, this.flushMs);
	}

	private send(entry: StatsEntry, sample: StatsSample): void {
		for (const listener of [...entry.listeners]) listener.onSamples([sample]);
	}

	private trim(entry: StatsEntry): void {
		const cutoff = this.now() - this.historyMs;
		let drop = 0;
		while (
			drop < entry.ring.length &&
			Date.parse(entry.ring[drop]?.at ?? "") < cutoff
		)
			drop++;
		if (entry.ring.length - drop > MAX_RING)
			drop = entry.ring.length - MAX_RING;
		if (drop > 0) entry.ring.splice(0, drop);
	}

	/** Forgets containers nobody watches whose history has expired. */
	private sweep(): void {
		for (const [id, entry] of this.entries) {
			if (entry.listeners.size > 0) continue;
			this.trim(entry);
			if (entry.ring.length === 0) this.entries.delete(id);
		}
	}
}
