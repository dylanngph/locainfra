import {
	LogLine,
	Progress,
	ProjectStatus,
	ServiceStatus,
	StatsSample,
} from "@locainfra/core";
import { t } from "elysia";

/**
 * A subscription channel:
 * - `status:<project>`: project status (snapshot on subscribe, then deltas);
 * - `stats:<containerId>`: resource samples (history on subscribe, then ~1/s);
 * - `logs:<containerId>`: log lines (tail on subscribe, then batched 50–100 ms);
 * - `op:<opId>`: progress of a long-running action (buffered events replayed).
 */
export const Channel = t.String({
	pattern: "^(status|stats|logs|op):[A-Za-z0-9][A-Za-z0-9_.-]*$",
	description:
		"status:<project> | stats:<containerId> | logs:<containerId> | op:<opId>",
});
/** A subscription channel name. */
export type Channel = typeof Channel.static;

/** Client → server message. */
export const ClientMessage = t.Object({
	type: t.Union([t.Literal("subscribe"), t.Literal("unsubscribe")]),
	channel: Channel,
	tail: t.Optional(
		t.Integer({
			minimum: 0,
			maximum: 5000,
			description: "logs: lines of history to send first (default 200)",
		}),
	),
});
/** Client → server message. */
export type ClientMessage = typeof ClientMessage.static;

/** `delta` payload on `status:<project>`: changed rows and removed instance names. */
export const StatusDelta = t.Object({
	services: t.Array(ServiceStatus, { description: "Changed or added rows" }),
	removed: t.Array(t.String(), {
		description: "Instance names no longer in the project",
	}),
});
/** `delta` payload on `status:<project>`. */
export type StatusDelta = typeof StatusDelta.static;

/** `log` payload on `logs:<containerId>`: a batch of lines. */
export const LogBatch = t.Object({
	lines: t.Array(LogLine),
	skipped: t.Optional(
		t.Integer({
			minimum: 1,
			description:
				"Lines dropped under backpressure before this batch (render a “N lines skipped” marker)",
		}),
	),
	ended: t.Optional(
		t.Boolean({ description: "The container stopped; the stream ended" }),
	),
});
/** `log` payload. */
export type LogBatch = typeof LogBatch.static;

/** `stats` payload on `stats:<containerId>`: samples, oldest first (the first message carries up to 5 min of history). */
export const StatsBatch = t.Object({ samples: t.Array(StatsSample) });
/** `stats` payload. */
export type StatsBatch = typeof StatsBatch.static;

/** `error` payload on any channel (bad channel, unknown project/container, daemon unreachable). */
export const ChannelError = t.Object({
	code: t.String({
		description: "An OpErrorCode or NOT_IMPLEMENTED / BAD_CHANNEL",
	}),
	message: t.String(),
});
/** `error` payload. */
export type ChannelError = typeof ChannelError.static;

/** Server → client message, discriminated by `type`. */
export const ServerMessage = t.Union([
	t.Object({
		channel: Channel,
		type: t.Literal("snapshot"),
		payload: ProjectStatus,
	}),
	t.Object({
		channel: Channel,
		type: t.Literal("delta"),
		payload: StatusDelta,
	}),
	t.Object({ channel: Channel, type: t.Literal("log"), payload: LogBatch }),
	t.Object({ channel: Channel, type: t.Literal("stats"), payload: StatsBatch }),
	t.Object({
		channel: Channel,
		type: t.Literal("progress"),
		payload: Progress,
	}),
	t.Object({
		channel: Channel,
		type: t.Literal("error"),
		payload: ChannelError,
	}),
]);
/** Server → client message. */
export type ServerMessage = typeof ServerMessage.static;

/** Reference models of the observer controller, registered under `Observer.`. */
export const ObserverModel = {
	client: ClientMessage,
	server: ServerMessage,
};
