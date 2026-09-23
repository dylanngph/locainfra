import { describe, expect, test } from "bun:test";
import { collect } from "../../testing/collect";
import { withOpId, withService } from "../progress";
import type { Progress } from "../progress.model";

async function* events(): AsyncIterable<Progress> {
	yield { kind: "step", message: "a" };
	yield { kind: "log", message: "b", service: "other", opId: "kept" };
	yield { kind: "done", message: "c" };
}

describe("progress tagging", () => {
	test("withOpId stamps events that have no opId", async () => {
		expect(
			(await collect(withOpId(events(), "op-1"))).map((e) => e.opId),
		).toEqual(["op-1", "kept", "op-1"]);
	});

	test("withService stamps events that name no service", async () => {
		expect(
			(await collect(withService(events(), "main-db"))).map((e) => e.service),
		).toEqual(["main-db", "other", "main-db"]);
	});
});
