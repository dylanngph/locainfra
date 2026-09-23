import type { ClientMessage, ServerMessage } from "@locainfra/server";
import { ws } from "msw";
import { type MockDb, mockDb } from "./mock-db";

const STATUS_EVERY_MS = 2_000;
const STATS_EVERY_MS = 1_500;
const LOG_EVERY_MS = 2_500;

/**
 * WebSocket handler for `/ws` over the {@link MockDb}: status snapshots every
 * 2 s plus deltas, stats and log streams for running containers, and op
 * progress with replay of buffered events.
 *
 * @param db - Backend state (defaults to the shared instance).
 * @returns MSW WebSocket handlers.
 */
export const createWsHandlers = (db: MockDb = mockDb) => {
	const observer = ws.link(/^wss?:\/\/[^/]+\/ws(\?.*)?$/);
	return [
		observer.addEventListener("connection", ({ client }) => {
			const subscribed = new Map<string, () => void>();
			const send = (message: ServerMessage) =>
				client.send(JSON.stringify(message));
			const stopForwarding = db.listen((message) => {
				if (subscribed.has(message.channel)) send(message);
			});

			const findContainer = (id: string) => {
				for (const p of db.projects)
					for (const s of p.services)
						if (db.containerId(p.name, s.name) === id) return { p, s };
				return undefined;
			};

			const startChannel = (channel: string, tail: number): (() => void) => {
				const [kind, id = ""] = channel.split(/:(.*)/s);
				if (kind === "status") {
					const tick = () => {
						const p = db.project(id);
						if (p)
							send({ channel, type: "snapshot", payload: db.projectStatus(p) });
						else
							send({
								channel,
								type: "error",
								payload: {
									code: "PROJECT_NOT_FOUND",
									message: `Unknown project ${id}`,
								},
							});
					};
					tick();
					const timer = setInterval(tick, STATUS_EVERY_MS);
					return () => clearInterval(timer);
				}
				if (kind === "op") {
					for (const payload of db.ops.get(id) ?? [])
						send({ channel, type: "progress", payload });
					return () => {};
				}
				if (kind === "stats") {
					const sample = () => {
						const found = findContainer(id);
						return found ? db.statsSample(found.s) : undefined;
					};
					const history = Array.from({ length: 24 }, sample).filter(
						(x) => x !== undefined,
					);
					if (history.length)
						send({ channel, type: "stats", payload: { samples: history } });
					const timer = setInterval(() => {
						const s = sample();
						if (s) send({ channel, type: "stats", payload: { samples: [s] } });
					}, STATS_EVERY_MS);
					return () => clearInterval(timer);
				}
				if (kind === "logs") {
					const found = findContainer(id);
					if (!found) {
						send({
							channel,
							type: "error",
							payload: {
								code: "SERVICE_NOT_FOUND",
								message: `Unknown container ${id}`,
							},
						});
						return () => {};
					}
					send({
						channel,
						type: "log",
						payload: { lines: db.logLines(found.s.type, Math.min(tail, 40)) },
					});
					let n = 0;
					const timer = setInterval(() => {
						if (found.s.state !== "running") return;
						n += 1;
						const [line] = db
							.logLines(found.s.type, 6)
							.slice(n % 6, (n % 6) + 1);
						if (line)
							send({
								channel,
								type: "log",
								payload: { lines: [{ ...line, at: new Date().toISOString() }] },
							});
					}, LOG_EVERY_MS);
					return () => clearInterval(timer);
				}
				return () => {};
			};

			client.addEventListener("message", (event) => {
				if (typeof event.data !== "string") return;
				let message: ClientMessage;
				try {
					message = JSON.parse(event.data) as ClientMessage;
				} catch {
					return;
				}
				if (message.type === "subscribe" && !subscribed.has(message.channel)) {
					subscribed.set(message.channel, () => {});
					subscribed.set(
						message.channel,
						startChannel(message.channel, message.tail ?? 200),
					);
				} else if (message.type === "unsubscribe") {
					subscribed.get(message.channel)?.();
					subscribed.delete(message.channel);
				}
			});
			client.addEventListener("close", () => {
				stopForwarding();
				for (const stop of subscribed.values()) stop();
				subscribed.clear();
			});
		}),
	];
};
