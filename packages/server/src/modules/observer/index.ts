import { Elysia } from "elysia";
import type { ObserverSink } from "./backpressure";
import { ObserverModel, type ServerMessage } from "./observer.model";
import type { ObserverService } from "./observer.service";

/**
 * The parts of Bun's `ServerWebSocket` the sink adapter uses
 * (`getBufferedAmount` exists at runtime but is missing from Elysia's copy of
 * the Bun types).
 */
interface RawSocket {
	send(data: string): number;
	getBufferedAmount?: () => number;
}

/**
 * Adapts a WebSocket to the observer's {@link ObserverSink}. Messages are
 * built from typed models, so they are serialized directly (no per-message
 * response validation on the hot log path).
 *
 * @param id - Connection id.
 * @param raw - Bun socket.
 * @returns The sink.
 */
function toSink(id: string, raw: RawSocket): ObserverSink {
	return {
		id,
		send: (message: ServerMessage) => raw.send(JSON.stringify(message)),
		bufferedAmount: () => raw.getBufferedAmount?.() ?? 0,
	};
}

/**
 * Observer controller: the `/ws` WebSocket (auth via `?t=<token>`, since
 * browsers cannot set headers on upgrade). Routes only; channel logic lives in
 * {@link ObserverService}.
 *
 * @param observer - The hub.
 * @returns The `/ws` route.
 */
export const observerModule = (observer: ObserverService) =>
	new Elysia({ name: "Observer.Controller" })
		.model(ObserverModel)
		.prefix("model", "Observer.")
		.ws("/ws", {
			body: "Observer.Client",
			response: "Observer.Server",
			open(ws) {
				observer.connect(toSink(ws.id, ws.raw));
			},
			message(ws, message) {
				observer.message(ws.id, message);
			},
			drain(ws) {
				observer.drain(ws.id);
			},
			close(ws) {
				observer.disconnect(ws.id);
			},
			detail: {
				tags: ["Observer"],
				summary: "Live status, stats, logs and op progress",
			},
		});
