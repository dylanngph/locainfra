import type {
	ContainerStreams,
	OpError,
	ProjectStatus,
	Result,
	ServiceStatus,
} from "@locainfra/core";
import type { ChannelError, StatusDelta } from "../observer.model";
import { later, type Timer } from "./channel.types";
import type { StatsChannel } from "./stats.channel";

/** Loads a project's live status (core's `statusForProject` bound to its ports). */
export type StatusSource = (
	project: string,
) => Promise<Result<ProjectStatus, OpError>>;

/** Tuning of {@link StatusChannel}. */
export interface StatusChannelOptions {
	/** Poll interval per watched project, in ms. Default 2000. */
	readonly intervalMs?: number;
	/** Coalescing window for Docker events, in ms. Default 100. */
	readonly debounceMs?: number;
	/** Delay before reopening the Docker events stream after it failed. Default 5000. */
	readonly retryMs?: number;
}

/** Receives a project's status messages. */
export interface StatusListener {
	/** Full status (first message of a subscription). */
	onSnapshot(status: ProjectStatus): void;
	/** Rows that changed since the previous message. */
	onDelta(delta: StatusDelta): void;
	/** Loading the status failed (sent once per distinct error code). */
	onError(error: ChannelError): void;
}

interface StatusEntry {
	readonly listeners: Set<StatusListener>;
	/** Listeners still waiting for their first snapshot. */
	readonly fresh: Set<StatusListener>;
	last?: ProjectStatus;
	lastErrorCode?: string;
	refreshing: boolean;
	dirty: boolean;
	interval?: ReturnType<typeof setInterval>;
	debounce?: Timer;
	/** Internal stats subscriptions of running containers (CPU/MEM overlay). */
	readonly stats: Map<string, () => void>;
}

/** The label compose puts on every LocaInfra container, naming its project. */
export const STACK_LABEL = "locainfra.stack";

/**
 * `status:<project>`: while a project is watched it is reloaded every
 * `intervalMs` and on Docker events of its containers (one shared events
 * subscription for all projects, filtered by the `locainfra.stack` label).
 * A subscriber first gets a `snapshot`, then `delta`s holding only the rows
 * that changed. Running containers of watched projects are kept on the
 * {@link StatsChannel} so rows carry `cpuPercent`/`memBytes`.
 */
export class StatusChannel {
	private readonly entries = new Map<string, StatusEntry>();
	private readonly owners = new Map<string, string>();
	private readonly intervalMs: number;
	private readonly debounceMs: number;
	private readonly retryMs: number;
	private events?: AbortController;
	private eventsRetry?: Timer;

	/**
	 * @param source - Status loader.
	 * @param streams - Docker streams (events).
	 * @param stats - Stats channel (overlay).
	 * @param options - Timings.
	 */
	constructor(
		private readonly source: StatusSource,
		private readonly streams: ContainerStreams,
		private readonly stats: StatsChannel,
		options: StatusChannelOptions = {},
	) {
		this.intervalMs = options.intervalMs ?? 2000;
		this.debounceMs = options.debounceMs ?? 100;
		this.retryMs = options.retryMs ?? 5000;
	}

	/**
	 * Attaches a listener. It gets the cached snapshot right away when one
	 * exists, otherwise after the first load.
	 *
	 * @param project - Project name.
	 * @param listener - Receives messages.
	 * @returns Detaches the listener (polling stops with the last one).
	 */
	subscribe(project: string, listener: StatusListener): () => void {
		let entry = this.entries.get(project);
		if (entry === undefined) {
			entry = {
				listeners: new Set(),
				fresh: new Set(),
				refreshing: false,
				dirty: false,
				stats: new Map(),
			};
			this.entries.set(project, entry);
			const watched = entry;
			entry.interval = setInterval(
				() => void this.refresh(project, watched),
				this.intervalMs,
			);
			(entry.interval as { unref?: () => void }).unref?.();
			this.ensureEvents();
		}
		entry.listeners.add(listener);
		if (entry.last !== undefined) listener.onSnapshot(entry.last);
		else entry.fresh.add(listener);
		if (entry.last === undefined) void this.refresh(project, entry);
		return () => this.detach(project, listener);
	}

	/**
	 * Reloads a watched project now (e.g. after an operation settled). No-op
	 * for projects nobody watches.
	 *
	 * @param project - Project name.
	 */
	poke(project: string): void {
		const entry = this.entries.get(project);
		if (entry !== undefined) void this.refresh(project, entry);
	}

	/**
	 * @param containerId - Container id.
	 * @returns The watched project owning the container, if known.
	 */
	ownerOf(containerId: string): string | undefined {
		return this.owners.get(containerId);
	}

	/**
	 * @param project - Project name.
	 * @returns Container ids of the project seen by the last load.
	 */
	containersOf(project: string): string[] {
		const ids: string[] = [];
		for (const [id, owner] of this.owners) if (owner === project) ids.push(id);
		return ids;
	}

	/** @returns Whether the shared Docker events stream is open. */
	get eventsOpen(): boolean {
		return this.events !== undefined;
	}

	/** Stops all polling, stats subscriptions and the events stream. */
	close(): void {
		for (const entry of this.entries.values()) this.stop(entry);
		this.entries.clear();
		this.stopEvents();
	}

	private detach(project: string, listener: StatusListener): void {
		const entry = this.entries.get(project);
		if (entry === undefined || !entry.listeners.delete(listener)) return;
		entry.fresh.delete(listener);
		if (entry.listeners.size > 0) return;
		this.stop(entry);
		this.entries.delete(project);
		for (const [id, owner] of this.owners)
			if (owner === project) this.owners.delete(id);
		if (this.entries.size === 0) this.stopEvents();
	}

	private stop(entry: StatusEntry): void {
		if (entry.interval !== undefined) clearInterval(entry.interval);
		if (entry.debounce !== undefined) clearTimeout(entry.debounce);
		entry.interval = undefined;
		entry.debounce = undefined;
		for (const unsubscribe of entry.stats.values()) unsubscribe();
		entry.stats.clear();
		entry.listeners.clear();
		entry.fresh.clear();
	}

	private async refresh(project: string, entry: StatusEntry): Promise<void> {
		if (entry.refreshing) {
			entry.dirty = true;
			return;
		}
		entry.refreshing = true;
		try {
			const result = await this.source(project);
			if (this.entries.get(project) !== entry) return;
			if (!result.ok) {
				this.fail(entry, {
					code: result.error.code,
					message: result.error.message,
				});
				return;
			}
			this.publish(project, entry, this.overlay(project, entry, result.value));
		} catch {
			if (this.entries.get(project) === entry)
				this.fail(entry, {
					code: "UNKNOWN",
					message: "Could not load the project status",
				});
		} finally {
			entry.refreshing = false;
			if (entry.dirty && this.entries.get(project) === entry) {
				entry.dirty = false;
				void this.refresh(project, entry);
			}
		}
	}

	private fail(entry: StatusEntry, error: ChannelError): void {
		if (entry.lastErrorCode === error.code) return;
		entry.lastErrorCode = error.code;
		for (const listener of [...entry.listeners]) listener.onError(error);
	}

	private publish(
		project: string,
		entry: StatusEntry,
		next: ProjectStatus,
	): void {
		entry.lastErrorCode = undefined;
		const previous = entry.last;
		entry.last = next;
		for (const listener of [...entry.fresh]) listener.onSnapshot(next);
		const delta = previous === undefined ? undefined : diff(previous, next);
		if (delta !== undefined)
			for (const listener of [...entry.listeners])
				if (!entry.fresh.has(listener)) listener.onDelta(delta);
		entry.fresh.clear();
		for (const [id, owner] of this.owners)
			if (owner === project) this.owners.delete(id);
		for (const service of next.services)
			if (service.containerId !== undefined)
				this.owners.set(service.containerId, project);
	}

	/** Keeps stats flowing for running containers and copies their latest sample. */
	private overlay(
		project: string,
		entry: StatusEntry,
		status: ProjectStatus,
	): ProjectStatus {
		const running = new Set<string>();
		for (const service of status.services)
			if (service.containerId !== undefined && service.state === "running")
				running.add(service.containerId);
		for (const [id, unsubscribe] of entry.stats)
			if (!running.has(id)) {
				unsubscribe();
				entry.stats.delete(id);
			}
		for (const id of running)
			if (!entry.stats.has(id))
				entry.stats.set(
					id,
					this.stats.subscribe(id, {
						onSamples: (samples) => {
							// A first sample for a row that has none yet is worth a delta.
							if (samples.length > 0 && entry.last !== undefined) {
								const row = entry.last.services.find(
									(s) => s.containerId === id,
								);
								if (row !== undefined && row.cpuPercent === undefined)
									this.poke(project);
							}
						},
						onError: () => {},
					}),
				);
		return {
			...status,
			services: status.services.map((service) =>
				withUsage(service, this.stats),
			),
		};
	}

	private ensureEvents(): void {
		if (this.events !== undefined || this.eventsRetry !== undefined) return;
		const controller = new AbortController();
		this.events = controller;
		void this.pumpEvents(controller);
	}

	private stopEvents(): void {
		this.events?.abort();
		this.events = undefined;
		if (this.eventsRetry !== undefined) clearTimeout(this.eventsRetry);
		this.eventsRetry = undefined;
	}

	private async pumpEvents(controller: AbortController): Promise<void> {
		try {
			for await (const event of this.streams.events({}, controller.signal)) {
				if (controller.signal.aborted) break;
				const project = event.attributes[STACK_LABEL];
				if (project === undefined) continue;
				const entry = this.entries.get(project);
				if (entry === undefined) continue;
				entry.debounce ??= later(() => {
					entry.debounce = undefined;
					if (this.entries.get(project) === entry)
						void this.refresh(project, entry);
				}, this.debounceMs);
			}
		} catch {
			// Daemon unreachable: polling continues; retry the stream below.
		}
		if (this.events !== controller) return;
		this.events = undefined;
		if (controller.signal.aborted || this.entries.size === 0) return;
		this.eventsRetry = later(() => {
			this.eventsRetry = undefined;
			if (this.entries.size > 0) this.ensureEvents();
		}, this.retryMs);
	}
}

/**
 * Copies a running container's latest (fresh) stats sample onto its row.
 *
 * @param service - Row from core (no usage).
 * @param stats - Stats channel holding the samples.
 * @returns The row with `cpuPercent`/`memBytes` when a fresh sample exists.
 */
export function withUsage<T extends ServiceStatus>(
	service: T,
	stats: StatsChannel,
): T {
	if (service.containerId === undefined || service.state !== "running")
		return service;
	const sample = stats.latest(service.containerId);
	if (sample === undefined) return service;
	return {
		...service,
		cpuPercent: Math.round(sample.cpuPercent * 10) / 10,
		memBytes: sample.memBytes,
	};
}

/**
 * @param previous - Status last sent.
 * @param next - New status.
 * @returns Changed/added rows and removed names, or `undefined` when nothing changed.
 */
export function diff(
	previous: ProjectStatus,
	next: ProjectStatus,
): StatusDelta | undefined {
	const before = new Map(
		previous.services.map((s) => [s.name, JSON.stringify(s)]),
	);
	const services = next.services.filter(
		(s) => before.get(s.name) !== JSON.stringify(s),
	);
	const names = new Set(next.services.map((s) => s.name));
	const removed = previous.services
		.map((s) => s.name)
		.filter((name) => !names.has(name));
	return services.length === 0 && removed.length === 0
		? undefined
		: { services, removed };
}
