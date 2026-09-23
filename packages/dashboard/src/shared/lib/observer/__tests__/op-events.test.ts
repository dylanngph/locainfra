import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { mockDb } from "@/test/msw/mock-db";
import { server } from "@/test/msw/node";
import { useObserverStore } from "../observer-store";
import { followOp } from "../op-events";

const kinds = (opId: string) =>
	(useObserverStore.getState().ops[opId] ?? []).map((e) => e.kind);

describe("followOp", () => {
	it("streams an op's progress into the store over HTTP until done", async () => {
		const opId = mockDb.runOp(
			[
				{ message: "Pulling", delay: 5 },
				{ message: "Starting", delay: 5 },
			],
			"Running",
		);
		await followOp(opId);
		expect(
			useObserverStore.getState().ops[opId]?.map((e) => e.message),
		).toEqual(["Pulling", "Starting", "Running"]);
		expect(kinds(opId).at(-1)).toBe("done");
	});

	it("records an error when the op is unknown", async () => {
		await followOp("ghost");
		expect(kinds("ghost")).toEqual(["error"]);
		expect(useObserverStore.getState().ops.ghost?.[0]?.message).toMatch(
			/no longer known/,
		);
	});

	it("reopens a dropped stream once and skips replayed lines", async () => {
		const line = (kind: string, message: string) =>
			`${JSON.stringify({ kind, message, opId: "op-x" })}\n`;
		let calls = 0;
		server.use(
			http.get("*/api/ops/:opId/events", () => {
				calls += 1;
				const body =
					calls === 1
						? line("step", "Pulling")
						: line("step", "Pulling") + line("done", "Running");
				return new HttpResponse(body, {
					headers: { "content-type": "application/x-ndjson" },
				});
			}),
		);
		await followOp("op-x");
		expect(calls).toBe(2);
		expect(
			useObserverStore.getState().ops["op-x"]?.map((e) => e.message),
		).toEqual(["Pulling", "Running"]);
	});

	it("records nothing once aborted", async () => {
		const opId = mockDb.runOp([{ message: "Pulling", delay: 50 }], "Running");
		const abort = new AbortController();
		const following = followOp(opId, abort.signal);
		abort.abort();
		await following;
		expect(kinds(opId).filter((k) => k === "error")).toEqual([]);
	});
});
