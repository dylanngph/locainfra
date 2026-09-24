import type { Progress } from "@locastack/core";
import type { OpRegistry } from "../observer/op-registry";

/**
 * Blank line sent while an operation is quiet, so neither Bun's idle timeout
 * (10 s) nor a proxy closes the response during a long image pull.
 */
export const OP_EVENTS_HEARTBEAT_MS = 5_000;

const isTerminal = (event: Progress) =>
	event.kind === "done" || event.kind === "error";

/**
 * Streams one operation's progress over plain HTTP (NDJSON): the buffered
 * events first, then live ones, and the response ends after the terminal
 * `done`/`error`. Lets the dashboard follow an action it started without
 * opening the observer WebSocket.
 */
export class OpEventsService {
	/**
	 * @param registry - Operation registry (replay + live events).
	 * @param heartbeatMs - Quiet-time keep-alive interval.
	 */
	constructor(
		private readonly registry: Pick<OpRegistry, "get" | "subscribe">,
		private readonly heartbeatMs: number = OP_EVENTS_HEARTBEAT_MS,
	) {}

	/**
	 * @param opId - Operation id.
	 * @returns NDJSON byte stream, or `undefined` when the id is unknown or expired.
	 */
	stream(opId: string): ReadableStream<Uint8Array> | undefined {
		if (this.registry.get(opId) === undefined) return undefined;
		const encoder = new TextEncoder();
		const registry = this.registry;
		const heartbeatMs = this.heartbeatMs;
		let closed = false;
		let unsubscribe: (() => void) | undefined;
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		const stop = () => {
			closed = true;
			clearInterval(heartbeat);
			unsubscribe?.();
		};
		return new ReadableStream<Uint8Array>({
			start(controller) {
				const finish = () => {
					if (closed) return;
					stop();
					controller.close();
				};
				unsubscribe = registry.subscribe(opId, (event) => {
					if (closed) return;
					controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
					if (isTerminal(event)) finish();
				});
				// Expired between `get` and `subscribe`, or already replayed to the end.
				if (unsubscribe === undefined) return finish();
				if (closed) return unsubscribe();
				heartbeat = setInterval(() => {
					if (!closed) controller.enqueue(encoder.encode("\n"));
				}, heartbeatMs);
			},
			cancel() {
				stop();
			},
		});
	}
}
