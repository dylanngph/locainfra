import { describe, expect, it } from "bun:test";
import type { Progress } from "@locastack/core";
import {
	createTestDeps,
	HOST,
	TOKEN,
} from "../../../__tests__/support/fixtures";
import { createApp, createRuntime } from "../../../app";
import { OpRegistry } from "../../observer/op-registry";
import { OpEventsService } from "../ops.service";

/** A progress stream the test pushes into and ends. */
function manual() {
	const queue: Progress[] = [];
	let wake: (() => void) | undefined;
	let ended = false;
	return {
		push(event: Progress) {
			queue.push(event);
			wake?.();
		},
		end() {
			ended = true;
			wake?.();
		},
		async *run(): AsyncIterable<Progress> {
			while (true) {
				const next = queue.shift();
				if (next !== undefined) {
					yield next;
					continue;
				}
				if (ended) return;
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
			}
		},
	};
}

const parse = (text: string): Progress[] =>
	text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as Progress);

function setup() {
	const deps = createTestDeps();
	const runtime = createRuntime(deps);
	const app = createApp(deps, runtime);
	const get = (path: string, token: string | undefined = TOKEN) =>
		app.handle(
			new Request(`http://${HOST}${path}`, {
				headers: {
					host: HOST,
					...(token ? { "x-locastack-token": token } : {}),
				},
			}),
		);
	return { runtime, get };
}

describe("GET /api/ops/:opId/events", () => {
	it("replays buffered events, streams live ones and ends after done", async () => {
		const { runtime, get } = setup();
		const op = manual();
		const opId = runtime.ops.start({ kind: "test", run: () => op.run() });
		op.push({ kind: "step", message: "Pulling postgres:17-alpine" });
		await new Promise((resolve) => setTimeout(resolve, 0));

		const res = await get(`/api/ops/${opId}/events`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/x-ndjson");
		const body = res.text();
		op.push({ kind: "step", message: "Starting main-db" });
		op.end();
		const events = parse(await body);
		expect(events.map((e) => e.message)).toEqual([
			"Pulling postgres:17-alpine",
			"Starting main-db",
			"Done",
		]);
		expect(events.every((e) => e.opId === opId)).toBe(true);
		expect(events.at(-1)?.kind).toBe("done");
	});

	it("answers a finished op with its whole history", async () => {
		const { runtime, get } = setup();
		const opId = runtime.ops.start({
			kind: "test",
			run: async function* () {
				yield { kind: "error", message: "Port busy" } satisfies Progress;
			},
		});
		await runtime.ops.settled(opId);
		const events = parse(await (await get(`/api/ops/${opId}/events`)).text());
		expect(events.map((e) => e.kind)).toEqual(["error"]);
	});

	it("404s an unknown op and 401s without the token", async () => {
		const { get } = setup();
		const missing = await get("/api/ops/nope/events");
		expect(missing.status).toBe(404);
		expect(await missing.json()).toMatchObject({ code: "OP_NOT_FOUND" });
		expect((await get("/api/ops/nope/events", "")).status).toBe(401);
	});

	it("sends blank keep-alive lines while the op is quiet and stops on cancel", async () => {
		const registry = new OpRegistry({ newId: () => "op1" });
		const op = manual();
		registry.start({ kind: "test", run: () => op.run() });
		const stream = new OpEventsService(registry, 5).stream("op1");
		if (stream === undefined) throw new Error("no stream");
		const reader = stream.getReader();
		const { value } = await reader.read();
		expect(new TextDecoder().decode(value)).toBe("\n");
		await reader.cancel();
		op.end();
		await registry.settled("op1");
	});
});
