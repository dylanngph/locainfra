import type {
	ChannelError,
	LogLine,
	Progress,
	ProjectStatus,
	ServerMessage,
	ServiceStatus,
	StatsSample,
} from "@locainfra/server";

/** Most samples kept per container (≈ 5 min at one per 1.5 s). */
export const MAX_STATS_SAMPLES = 200;
/** Most log entries kept per container. */
export const MAX_LOG_ENTRIES = 5_000;

/** One rendered row of a log pane. */
export type LogEntry =
	| ({ readonly id: number; readonly kind: "line" } & LogLine)
	| { readonly id: number; readonly kind: "skipped"; readonly count: number };

/** Log lines of one container. */
export interface LogBuffer {
	readonly entries: readonly LogEntry[];
	/** Id the next entry gets (stable React keys). */
	readonly nextId: number;
	/** The container stopped and the stream ended. */
	readonly ended: boolean;
}

/** Everything the observer WebSocket has told us, keyed by channel id. */
export interface ObserverData {
	/** `status:<project>` → latest project status. */
	readonly status: Readonly<Record<string, ProjectStatus>>;
	/** `stats:<containerId>` → samples, oldest first. */
	readonly stats: Readonly<Record<string, readonly StatsSample[]>>;
	/** `logs:<containerId>` → buffered lines. */
	readonly logs: Readonly<Record<string, LogBuffer>>;
	/** `op:<opId>` → progress events in arrival order. */
	readonly ops: Readonly<Record<string, readonly Progress[]>>;
	/** Channel → last `error` message received on it. */
	readonly errors: Readonly<Record<string, ChannelError>>;
}

/** Empty observer data. */
export const EMPTY_OBSERVER_DATA: ObserverData = {
	status: {},
	stats: {},
	logs: {},
	ops: {},
	errors: {},
};

/** An empty log buffer. */
export const EMPTY_LOG_BUFFER: LogBuffer = {
	entries: [],
	nextId: 0,
	ended: false,
};

/**
 * Splits `kind:id` into its parts.
 *
 * @param channel - Channel name.
 * @returns Kind and id (id is empty when the channel has no colon).
 */
export function parseChannel(channel: string): { kind: string; id: string } {
	const at = channel.indexOf(":");
	return at < 0
		? { kind: channel, id: "" }
		: { kind: channel.slice(0, at), id: channel.slice(at + 1) };
}

const mergeServices = (
	current: readonly ServiceStatus[],
	changed: readonly ServiceStatus[],
	removed: readonly string[],
): ServiceStatus[] => {
	const gone = new Set(removed);
	const byName = new Map(changed.map((s) => [s.name, s]));
	const merged = current
		.filter((s) => !gone.has(s.name))
		.map((s) => byName.get(s.name) ?? s);
	const known = new Set(merged.map((s) => s.name));
	for (const s of changed) if (!known.has(s.name)) merged.push(s);
	return merged;
};

const appendLogs = (
	buffer: LogBuffer,
	lines: readonly LogLine[],
	skipped: number | undefined,
	ended: boolean | undefined,
): LogBuffer => {
	let nextId = buffer.nextId;
	const added: LogEntry[] = [];
	if (skipped) added.push({ id: nextId++, kind: "skipped", count: skipped });
	for (const line of lines) added.push({ id: nextId++, kind: "line", ...line });
	const entries = [...buffer.entries, ...added];
	return {
		entries:
			entries.length > MAX_LOG_ENTRIES
				? entries.slice(entries.length - MAX_LOG_ENTRIES)
				: entries,
		nextId,
		ended: ended ?? (added.length > 0 ? false : buffer.ended),
	};
};

/**
 * Applies one server message to the observer data (pure).
 *
 * @param state - Current data.
 * @param message - Parsed server message.
 * @returns The next data (the same object when nothing changed).
 */
export function reduceServerMessage(
	state: ObserverData,
	message: ServerMessage,
): ObserverData {
	const { id } = parseChannel(message.channel);
	switch (message.type) {
		case "snapshot":
			return {
				...state,
				status: { ...state.status, [id]: message.payload },
			};
		case "delta": {
			const current = state.status[id];
			if (!current) return state;
			return {
				...state,
				status: {
					...state.status,
					[id]: {
						...current,
						services: mergeServices(
							current.services,
							message.payload.services,
							message.payload.removed,
						),
					},
				},
			};
		}
		case "stats": {
			const known = state.stats[id] ?? [];
			// A re-subscribe replays recent history: skip samples already kept.
			const lastAt = known.at(-1)?.at;
			const fresh =
				lastAt === undefined
					? message.payload.samples
					: message.payload.samples.filter((s) => s.at > lastAt);
			if (fresh.length === 0) return state;
			const samples = [...known, ...fresh];
			return {
				...state,
				stats: {
					...state.stats,
					[id]:
						samples.length > MAX_STATS_SAMPLES
							? samples.slice(samples.length - MAX_STATS_SAMPLES)
							: samples,
				},
			};
		}
		case "log":
			return {
				...state,
				logs: {
					...state.logs,
					[id]: appendLogs(
						state.logs[id] ?? EMPTY_LOG_BUFFER,
						message.payload.lines,
						message.payload.skipped,
						message.payload.ended,
					),
				},
			};
		case "progress":
			return {
				...state,
				ops: {
					...state.ops,
					[id]: [...(state.ops[id] ?? []), message.payload],
				},
			};
		case "error":
			return {
				...state,
				errors: { ...state.errors, [message.channel]: message.payload },
			};
		default:
			return state;
	}
}

/**
 * Whether a progress list has reached its terminal event.
 *
 * @param events - Progress events of one op.
 * @returns The terminal event, if any.
 */
export function terminalEvent(
	events: readonly Progress[] | undefined,
): Progress | undefined {
	return events?.find((e) => e.kind === "done" || e.kind === "error");
}

/**
 * Drops what a released channel left behind when it must not outlive its
 * subscription: a project's status snapshot (stale once nobody listens) and
 * the channel's last error. Stats and log buffers stay as "last known".
 *
 * @param state - Current data.
 * @param channel - Channel that lost its last subscriber.
 * @returns The next data (the same object when nothing changed).
 */
export function forgetChannel(
	state: ObserverData,
	channel: string,
): ObserverData {
	const { kind, id } = parseChannel(channel);
	const hasStatus = kind === "status" && id in state.status;
	const hasError = channel in state.errors;
	if (!hasStatus && !hasError) return state;
	const status = { ...state.status };
	if (hasStatus) delete status[id];
	const errors = { ...state.errors };
	delete errors[channel];
	return { ...state, status, errors };
}
