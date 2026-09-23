import type { Progress } from "@locainfra/server";
import { getSessionToken } from "../session-token";
import { terminalEvent } from "./observer-state";
import { useObserverStore } from "./observer-store";

/** Attempts to (re)open an op's event stream before giving up on it. */
export const OP_EVENTS_ATTEMPTS = 2;

/**
 * URL of `GET /api/ops/:opId/events` on the page's origin.
 *
 * @param opId - Operation id.
 * @returns Absolute URL.
 */
export const opEventsUrl = (opId: string): string =>
	new URL(
		`/api/ops/${encodeURIComponent(opId)}/events`,
		window.location.origin,
	).toString();

const applyProgress = (opId: string, payload: Progress) =>
	useObserverStore
		.getState()
		.apply({ channel: `op:${opId}`, type: "progress", payload });

const settled = (opId: string) =>
	terminalEvent(useObserverStore.getState().ops[opId]) !== undefined;

/**
 * Follows one operation over plain HTTP (NDJSON, no WebSocket): each
 * `Progress` line lands in the observer store under `op:<opId>`, exactly
 * like the socket channel would deliver it, and the call resolves when the
 * terminal `done`/`error` arrived. A dropped connection is reopened once;
 * the server replays the op's events, so lines already applied are skipped.
 * When the op cannot be followed, a terminal `error` event is recorded.
 *
 * @param opId - Operation id from a `202 { opId }` response.
 * @param signal - Stops following (nothing is recorded then).
 * @returns Resolves once the op settled, could not be followed, or `signal` aborted.
 */
export async function followOp(
	opId: string,
	signal?: AbortSignal,
): Promise<void> {
	let failure = "Lost the connection to the dashboard server";
	for (let attempt = 0; attempt < OP_EVENTS_ATTEMPTS; attempt++) {
		const already = useObserverStore.getState().ops[opId]?.length ?? 0;
		let index = 0;
		try {
			const token = getSessionToken();
			const response = await fetch(opEventsUrl(opId), {
				headers: token ? { "x-locainfra-token": token } : {},
				...(signal ? { signal } : {}),
			});
			if (!response.ok || !response.body) {
				failure =
					response.status === 404
						? "The operation is no longer known to the server"
						: `Could not follow the operation (HTTP ${response.status})`;
				break;
			}
			const reader = response.body
				.pipeThrough(new TextDecoderStream())
				.getReader();
			let buffered = "";
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buffered += value;
				const lines = buffered.split("\n");
				buffered = lines.pop() ?? "";
				for (const line of lines) {
					if (line.trim() === "") continue;
					index += 1;
					if (index > already)
						applyProgress(opId, JSON.parse(line) as Progress);
				}
				if (settled(opId)) {
					await reader.cancel();
					return;
				}
			}
			if (settled(opId)) return;
		} catch {
			if (signal?.aborted) return;
		}
		if (signal?.aborted) return;
	}
	if (signal?.aborted || settled(opId)) return;
	applyProgress(opId, { kind: "error", message: failure });
}
