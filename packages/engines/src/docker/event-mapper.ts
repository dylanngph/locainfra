import {
	type DockerEvent,
	type EventFilter,
	LABEL_STACK,
} from "@locainfra/core";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Query string for `GET /events`: container events only, filtered by label.
 *
 * Label semantics: `{ key: "value" }` matches that exact value and
 * `{ key: "" }` matches containers that carry the label at all. When
 * `filter.labels` is omitted or empty, only LocaInfra containers are
 * watched (presence of `locainfra.stack`).
 *
 * @param filter - Label filter.
 * @returns Query without the leading `?`.
 */
export function buildEventsQuery(filter: EventFilter): string {
	const entries = Object.entries(filter.labels ?? {});
	const labels =
		entries.length === 0
			? [LABEL_STACK]
			: entries.map(([key, value]) => (value === "" ? key : `${key}=${value}`));
	return new URLSearchParams({
		filters: JSON.stringify({ type: ["container"], label: labels }),
	}).toString();
}

/**
 * Maps one `GET /events` JSON line to a {@link DockerEvent}.
 *
 * @param raw - Untrusted JSON value.
 * @param now - Fallback event time when the line carries none.
 * @returns The event, or `null` for non-container or malformed events.
 */
export function toDockerEvent(
	raw: unknown,
	now: Date = new Date(),
): DockerEvent | null {
	if (!isObject(raw)) return null;
	const type = raw.Type ?? raw.type;
	if (type !== undefined && type !== "container") return null;
	const action =
		typeof raw.Action === "string"
			? raw.Action
			: typeof raw.status === "string"
				? raw.status
				: undefined;
	const actor = isObject(raw.Actor) ? raw.Actor : {};
	const id =
		typeof actor.ID === "string" && actor.ID !== ""
			? actor.ID
			: typeof raw.id === "string"
				? raw.id
				: undefined;
	if (action === undefined || id === undefined) return null;
	const attributes: Record<string, string> = {};
	if (isObject(actor.Attributes)) {
		for (const [key, value] of Object.entries(actor.Attributes)) {
			if (typeof value === "string") attributes[key] = value;
		}
	}
	return { action, id, at: eventTime(raw, now), attributes };
}

function eventTime(raw: JsonObject, now: Date): string {
	if (typeof raw.timeNano === "number" && Number.isFinite(raw.timeNano)) {
		return new Date(Math.floor(raw.timeNano / 1e6)).toISOString();
	}
	if (typeof raw.time === "number" && Number.isFinite(raw.time)) {
		return new Date(raw.time * 1000).toISOString();
	}
	return now.toISOString();
}
