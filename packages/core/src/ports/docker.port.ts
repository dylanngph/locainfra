import { type Static, Type } from "@sinclair/typebox";

/** Docker daemon identity as reported by the Engine API `/version` + `/info`. */
export const DockerInfo = Type.Object({
	serverVersion: Type.String(),
	apiVersion: Type.String(),
	platformName: Type.Optional(
		Type.String({ description: "e.g. Docker Desktop 4.82.0 (212345)" }),
	),
	os: Type.String(),
	arch: Type.String(),
});
/** Docker daemon identity. */
export type DockerInfo = Static<typeof DockerInfo>;

/** Reads daemon identity; failure to reach the daemon rejects the promise. */
export interface DockerInfoPort {
	/** Fetches daemon version and platform information. */
	info(): Promise<DockerInfo>;
}

/** Container health as surfaced by Docker (`none` when no healthcheck is defined). */
export const ContainerHealth = Type.Union([
	Type.Literal("healthy"),
	Type.Literal("unhealthy"),
	Type.Literal("starting"),
	Type.Literal("none"),
]);
/** Container health as surfaced by Docker. */
export type ContainerHealth = Static<typeof ContainerHealth>;

/** A published port mapping on the host (always bound to 127.0.0.1 for LocaStack services). */
export const PortMapping = Type.Object({
	host: Type.Integer(),
	container: Type.Integer(),
});
/** A published port mapping. */
export type PortMapping = Static<typeof PortMapping>;

/** Summary of one container as returned by the Engine API list endpoint. */
export const ContainerSummary = Type.Object({
	id: Type.String(),
	name: Type.String({
		description: "Container name without the leading slash",
	}),
	image: Type.String(),
	state: Type.String({
		description:
			"Docker state: created | running | paused | restarting | removing | exited | dead",
	}),
	health: Type.Optional(ContainerHealth),
	labels: Type.Record(Type.String(), Type.String()),
	ports: Type.Array(PortMapping),
});
/** Summary of one container. */
export type ContainerSummary = Static<typeof ContainerSummary>;

/** Filter for {@link ContainerReader.list}. */
export interface ContainerFilter {
	/** Only containers carrying all of these labels (exact value match). */
	readonly labels?: Readonly<Record<string, string>>;
}

/** Read-only container listing (Engine API). */
export interface ContainerReader {
	/**
	 * Lists containers (running and stopped) matching the filter.
	 *
	 * @param filter - Label filter.
	 */
	list(filter: ContainerFilter): Promise<ContainerSummary[]>;
}

/** Finds the Docker Engine socket (`DOCKER_HOST` → docker context → platform default). */
export interface SocketLocator {
	/** @returns The socket path, or `null` when none is found. */
	locate(): Promise<string | null>;
}

/** Container details from the Engine API inspect endpoint (fields the dashboard needs). */
export const ContainerDetails = Type.Object({
	id: Type.String(),
	name: Type.String({
		description: "Container name without the leading slash",
	}),
	image: Type.String(),
	state: Type.String({
		description:
			"Docker state: created | running | paused | restarting | removing | exited | dead",
	}),
	health: Type.Optional(ContainerHealth),
	startedAt: Type.Optional(
		Type.String({ description: "ISO-8601; absent when never started" }),
	),
	exitCode: Type.Optional(Type.Integer()),
	error: Type.Optional(
		Type.String({
			description:
				'Docker\'s State.Error, e.g. a port bind failure ("port is already allocated")',
		}),
	),
	labels: Type.Record(Type.String(), Type.String()),
	ports: Type.Array(PortMapping),
});
/** Container details from inspect. */
export type ContainerDetails = Static<typeof ContainerDetails>;

/** Reads one container's details (Engine API inspect). */
export interface ContainerInspector {
	/**
	 * @param id - Container id or name.
	 * @returns The details, or `null` when no such container exists.
	 */
	inspect(id: string): Promise<ContainerDetails | null>;
}

/** Output stream of a log line. */
export const LogStream = Type.Union([
	Type.Literal("stdout"),
	Type.Literal("stderr"),
]);
/** Output stream of a log line. */
export type LogStream = Static<typeof LogStream>;

/** One demultiplexed container log line (ANSI escapes kept; the dashboard renders them). */
export const LogLine = Type.Object({
	stream: LogStream,
	text: Type.String({ description: "Line without the trailing newline" }),
	at: Type.Optional(
		Type.String({
			description: "ISO-8601 Docker timestamp (when requested with timestamps)",
		}),
	),
});
/** One container log line. */
export type LogLine = Static<typeof LogLine>;

/** Options of {@link ContainerStreams.logs}. */
export interface LogOptions {
	/** Keep streaming new lines (`follow=1`). */
	readonly follow: boolean;
	/** Number of trailing lines to start with (`tail`); all when omitted. */
	readonly tail?: number;
	/** Only lines after this ISO-8601 instant or Unix timestamp (`since`). */
	readonly since?: string;
	/** Aborts the stream; the iterator then ends without throwing. */
	readonly signal?: AbortSignal;
}

/** One resource-usage sample of a container (Engine API stats, computed). */
export const StatsSample = Type.Object({
	cpuPercent: Type.Number({
		minimum: 0,
		description: "Percent of one CPU (docker stats semantics; may exceed 100)",
	}),
	memBytes: Type.Integer({
		minimum: 0,
		description: "Memory usage minus page cache",
	}),
	memLimitBytes: Type.Integer({ minimum: 0 }),
	netRx: Type.Integer({
		minimum: 0,
		description: "Bytes received, cumulative",
	}),
	netTx: Type.Integer({ minimum: 0, description: "Bytes sent, cumulative" }),
	at: Type.String({ description: "ISO-8601 sample time" }),
});
/** One resource-usage sample of a container. */
export type StatsSample = Static<typeof StatsSample>;

/** One Docker daemon event (container scope). */
export const DockerEvent = Type.Object({
	action: Type.String({
		description: "e.g. start | die | stop | health_status: healthy | destroy",
	}),
	id: Type.String({ description: "Container id" }),
	at: Type.String({ description: "ISO-8601 event time" }),
	attributes: Type.Record(Type.String(), Type.String(), {
		description: "Actor attributes: labels, name, image, exitCode…",
	}),
});
/** One Docker daemon event. */
export type DockerEvent = Static<typeof DockerEvent>;

/** Filter for {@link ContainerStreams.events}. */
export interface EventFilter {
	/** Only events of containers carrying all of these labels. */
	readonly labels?: Readonly<Record<string, string>>;
}

/**
 * Long-lived Engine API streams. Every iterator ends (without throwing) when
 * its signal aborts, and rejects when the daemon is unreachable.
 */
export interface ContainerStreams {
	/**
	 * Demultiplexed logs of one container.
	 *
	 * @param id - Container id or name.
	 * @param options - Follow, tail, since and abort signal.
	 */
	logs(id: string, options: LogOptions): AsyncIterable<LogLine>;
	/**
	 * Resource-usage samples (about one per second while running).
	 *
	 * @param id - Container id or name.
	 * @param signal - Aborts the stream.
	 */
	stats(id: string, signal: AbortSignal): AsyncIterable<StatsSample>;
	/**
	 * Container events from the daemon.
	 *
	 * @param filter - Label filter.
	 * @param signal - Aborts the stream.
	 */
	events(filter: EventFilter, signal: AbortSignal): AsyncIterable<DockerEvent>;
}

/**
 * Waits for a Docker daemon to come up after a runtime was started
 * (`colima start`, `open -a Docker`, `systemctl start docker`). Polls the
 * socket (via {@link SocketLocator}, re-located on every attempt because a
 * fresh runtime may create its socket or docker context late) and the Engine
 * API (`/_ping`) about once a second.
 */
export interface DaemonWaiter {
	/**
	 * @param timeoutMs - Give up after this long.
	 * @param signal - Stops waiting early (resolves `false`).
	 * @returns `true` as soon as the Engine API answers, `false` on timeout or abort. Never rejects.
	 */
	waitForDocker(timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
}
