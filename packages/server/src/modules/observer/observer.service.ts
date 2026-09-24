import type {
	ContainerStreams,
	ProjectStatus,
	ServiceStatus,
} from "@locastack/core";
import { LogGate, type ObserverSink } from "./backpressure";
import {
	DEFAULT_LOG_TAIL,
	LogsChannel,
	type LogsChannelOptions,
} from "./channels/logs.channel";
import {
	StatsChannel,
	type StatsChannelOptions,
} from "./channels/stats.channel";
import {
	StatusChannel,
	type StatusChannelOptions,
	type StatusSource,
	withUsage,
} from "./channels/status.channel";
import type { Channel, ChannelError, ClientMessage } from "./observer.model";
import type { OpRegistry } from "./op-registry";

/** Timings of every channel (defaults match `docs/api.md`). */
export interface ObserverOptions {
	/** `status:` polling and events. */
	readonly status?: StatusChannelOptions;
	/** `stats:` history and throttling. */
	readonly stats?: StatsChannelOptions;
	/** `logs:` batching. */
	readonly logs?: LogsChannelOptions;
	/** Buffered bytes that pause a socket's log channels. Default 1 MB. */
	readonly logPauseBytes?: number;
}

/** What the observer reads from. */
export interface ObserverDeps {
	/** Project status loader. */
	readonly status: StatusSource;
	/** Docker logs/stats/events streams. */
	readonly streams: ContainerStreams;
	/** Long-running operations (`op:` channels). */
	readonly ops: OpRegistry;
}

/** CPU and memory summed over a project's running containers. */
export interface ProjectUsage {
	/** Sum of CPU percent. */
	readonly cpuPercent: number;
	/** Sum of memory bytes. */
	readonly memBytes: number;
}

interface SocketState {
	readonly sink: ObserverSink;
	readonly subscriptions: Map<Channel, () => void>;
	readonly gates: Map<Channel, LogGate>;
}

type ChannelKind = "status" | "stats" | "logs" | "op";

/**
 * The `/ws` hub: routes each socket's `subscribe`/`unsubscribe` messages to
 * the channels, fans upstream data out to sockets, applies log backpressure
 * per socket, and cleans everything up when a socket closes. No Elysia types:
 * the controller adapts a WebSocket into an {@link ObserverSink}.
 */
export class ObserverService {
	/** `stats:` channel (also used for CPU/MEM overlays). */
	readonly stats: StatsChannel;
	/** `logs:` channel. */
	readonly logs: LogsChannel;
	/** `status:` channel. */
	readonly status: StatusChannel;
	private readonly sockets = new Map<string, SocketState>();
	private readonly logPauseBytes: number | undefined;
	private readonly unhookOps: () => void;

	/**
	 * @param deps - Status loader, streams and op registry.
	 * @param options - Channel timings.
	 */
	constructor(
		private readonly deps: ObserverDeps,
		options: ObserverOptions = {},
	) {
		this.stats = new StatsChannel(deps.streams, options.stats);
		this.logs = new LogsChannel(deps.streams, options.logs);
		this.status = new StatusChannel(
			deps.status,
			deps.streams,
			this.stats,
			options.status,
		);
		this.logPauseBytes = options.logPauseBytes;
		this.unhookOps = deps.ops.onSettled((op) => {
			if (op.project !== undefined) this.status.poke(op.project);
		});
	}

	/**
	 * Registers a newly opened socket.
	 *
	 * @param sink - The socket.
	 */
	connect(sink: ObserverSink): void {
		this.sockets.set(sink.id, {
			sink,
			subscriptions: new Map(),
			gates: new Map(),
		});
	}

	/**
	 * Handles one client message. Subscribing twice to a channel restarts the
	 * subscription (fresh snapshot/history/tail).
	 *
	 * @param socketId - Sender.
	 * @param message - Validated client message.
	 */
	message(socketId: string, message: ClientMessage): void {
		const socket = this.sockets.get(socketId);
		if (socket === undefined) return;
		this.unsubscribe(socket, message.channel);
		if (message.type === "subscribe")
			this.subscribe(socket, message.channel, message.tail);
	}

	/**
	 * The socket's send buffer drained: resume its paused log channels.
	 *
	 * @param socketId - Socket id.
	 */
	drain(socketId: string): void {
		const socket = this.sockets.get(socketId);
		if (socket === undefined) return;
		for (const gate of socket.gates.values()) gate.resume();
	}

	/**
	 * Drops every subscription of a closed socket.
	 *
	 * @param socketId - Socket id.
	 */
	disconnect(socketId: string): void {
		const socket = this.sockets.get(socketId);
		if (socket === undefined) return;
		for (const channel of [...socket.subscriptions.keys()])
			this.unsubscribe(socket, channel);
		this.sockets.delete(socketId);
	}

	/**
	 * @param socketId - Socket id.
	 * @returns The socket's current channels (for tests and diagnostics).
	 */
	channelsOf(socketId: string): Channel[] {
		return [...(this.sockets.get(socketId)?.subscriptions.keys() ?? [])];
	}

	/**
	 * @param project - Project name.
	 * @returns CPU/MEM summed over the project's running containers seen by the
	 *   observer, or `undefined` when none has a fresh sample (nobody watches
	 *   the project), so callers never show a made-up 0.
	 */
	usageOf(project: string): ProjectUsage | undefined {
		let cpuPercent = 0;
		let memBytes = 0;
		let samples = 0;
		for (const id of this.status.containersOf(project)) {
			const sample = this.stats.latest(id);
			if (sample === undefined) continue;
			samples += 1;
			cpuPercent += sample.cpuPercent;
			memBytes += sample.memBytes;
		}
		if (samples === 0) return undefined;
		return { cpuPercent: Math.round(cpuPercent * 10) / 10, memBytes };
	}

	/**
	 * Copies the latest stats samples onto status rows (REST responses).
	 *
	 * @param status - Status from core.
	 * @returns The status with `cpuPercent`/`memBytes` where known.
	 */
	withUsage(status: ProjectStatus): ProjectStatus {
		return {
			...status,
			services: status.services.map((s) => this.rowWithUsage(s)),
		};
	}

	/**
	 * @param row - A service row (or detail) from core.
	 * @returns The row with `cpuPercent`/`memBytes` when a fresh sample exists.
	 */
	rowWithUsage<T extends ServiceStatus>(row: T): T {
		return withUsage(row, this.stats);
	}

	/** Closes every socket subscription and upstream stream. */
	close(): void {
		for (const id of [...this.sockets.keys()]) this.disconnect(id);
		this.unhookOps();
		this.status.close();
		this.logs.close();
		this.stats.close();
	}

	private subscribe(
		socket: SocketState,
		channel: Channel,
		tail: number | undefined,
	): void {
		const split = channel.indexOf(":");
		const kind = channel.slice(0, split) as ChannelKind;
		const key = channel.slice(split + 1);
		const { sink } = socket;
		const error = (payload: ChannelError) =>
			sink.send({ channel, type: "error", payload });
		switch (kind) {
			case "status":
				socket.subscriptions.set(
					channel,
					this.status.subscribe(key, {
						onSnapshot: (payload) =>
							sink.send({ channel, type: "snapshot", payload }),
						onDelta: (payload) =>
							sink.send({ channel, type: "delta", payload }),
						onError: error,
					}),
				);
				return;
			case "stats":
				socket.subscriptions.set(
					channel,
					this.stats.subscribe(key, {
						onSamples: (samples) =>
							sink.send({ channel, type: "stats", payload: { samples } }),
						onError: error,
					}),
				);
				return;
			case "logs": {
				const gate = new LogGate(sink, channel, this.logPauseBytes);
				socket.gates.set(channel, gate);
				socket.subscriptions.set(
					channel,
					this.logs.subscribe(key, tail ?? DEFAULT_LOG_TAIL, {
						onLines: (lines, ended) => gate.deliver(lines, ended),
						onError: error,
					}),
				);
				return;
			}
			case "op": {
				const unsubscribe = this.deps.ops.subscribe(key, (payload) =>
					sink.send({ channel, type: "progress", payload }),
				);
				if (unsubscribe === undefined)
					error({
						code: "BAD_CHANNEL",
						message: `Unknown or expired operation ${key}`,
					});
				else socket.subscriptions.set(channel, unsubscribe);
				return;
			}
			default:
				error({ code: "BAD_CHANNEL", message: `Unknown channel ${channel}` });
		}
	}

	private unsubscribe(socket: SocketState, channel: Channel): void {
		socket.subscriptions.get(channel)?.();
		socket.subscriptions.delete(channel);
		socket.gates.delete(channel);
	}
}
