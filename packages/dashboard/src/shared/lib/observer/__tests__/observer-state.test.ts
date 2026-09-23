import type { ProjectStatus, ServiceStatus } from "@locainfra/server";
import { describe, expect, it } from "vitest";
import {
	EMPTY_OBSERVER_DATA,
	forgetChannel,
	MAX_STATS_SAMPLES,
	parseChannel,
	reduceServerMessage,
	terminalEvent,
} from "../observer-state";

const row = (
	name: string,
	patch: Partial<ServiceStatus> = {},
): ServiceStatus => ({
	name,
	type: "postgres",
	version: "17",
	image: "postgres:17-alpine",
	hostPort: 5433,
	containerPort: 5432,
	containerName: `li-shop-${name}`,
	persist: "volume",
	state: "running",
	health: "healthy",
	...patch,
});

const snapshot: ProjectStatus = {
	project: "shop",
	network: "li-shop",
	services: [row("db"), row("cache")],
};

describe("reduceServerMessage", () => {
	it("stores snapshots and merges deltas in place", () => {
		let state = reduceServerMessage(EMPTY_OBSERVER_DATA, {
			channel: "status:shop",
			type: "snapshot",
			payload: snapshot,
		});
		expect(state.status.shop).toBe(snapshot);
		state = reduceServerMessage(state, {
			channel: "status:shop",
			type: "delta",
			payload: {
				services: [row("cache", { state: "stopped" }), row("queue")],
				removed: ["db"],
			},
		});
		expect(state.status.shop?.services.map((s) => [s.name, s.state])).toEqual([
			["cache", "stopped"],
			["queue", "running"],
		]);
	});

	it("ignores deltas before the first snapshot", () => {
		const state = reduceServerMessage(EMPTY_OBSERVER_DATA, {
			channel: "status:shop",
			type: "delta",
			payload: { services: [row("db")], removed: [] },
		});
		expect(state).toBe(EMPTY_OBSERVER_DATA);
	});

	it("appends stats with a cap", () => {
		const sample = {
			cpuPercent: 1,
			memBytes: 1,
			memLimitBytes: 2,
			netRx: 0,
			netTx: 0,
			at: "t",
		};
		const state = reduceServerMessage(EMPTY_OBSERVER_DATA, {
			channel: "stats:abc",
			type: "stats",
			payload: {
				samples: Array.from({ length: MAX_STATS_SAMPLES + 5 }, () => sample),
			},
		});
		expect(state.stats.abc).toHaveLength(MAX_STATS_SAMPLES);
	});

	it("buffers log lines with skip markers and stable ids", () => {
		let state = reduceServerMessage(EMPTY_OBSERVER_DATA, {
			channel: "logs:abc",
			type: "log",
			payload: { lines: [{ stream: "stdout", text: "a" }] },
		});
		state = reduceServerMessage(state, {
			channel: "logs:abc",
			type: "log",
			payload: {
				lines: [{ stream: "stderr", text: "b" }],
				skipped: 3,
				ended: true,
			},
		});
		expect(state.logs.abc?.entries).toEqual([
			{ id: 0, kind: "line", stream: "stdout", text: "a" },
			{ id: 1, kind: "skipped", count: 3 },
			{ id: 2, kind: "line", stream: "stderr", text: "b" },
		]);
		expect(state.logs.abc?.ended).toBe(true);
	});

	it("collects op progress until a terminal event", () => {
		let state = reduceServerMessage(EMPTY_OBSERVER_DATA, {
			channel: "op:42",
			type: "progress",
			payload: { kind: "step", message: "Pulling" },
		});
		expect(terminalEvent(state.ops["42"])).toBeUndefined();
		state = reduceServerMessage(state, {
			channel: "op:42",
			type: "progress",
			payload: { kind: "done", message: "Started" },
		});
		expect(terminalEvent(state.ops["42"])?.message).toBe("Started");
	});

	it("records channel errors", () => {
		const state = reduceServerMessage(EMPTY_OBSERVER_DATA, {
			channel: "logs:zzz",
			type: "error",
			payload: { code: "NOT_IMPLEMENTED", message: "Not implemented" },
		});
		expect(state.errors["logs:zzz"]?.code).toBe("NOT_IMPLEMENTED");
	});

	it("splits channel names at the first colon", () => {
		expect(parseChannel("op:a:b")).toEqual({ kind: "op", id: "a:b" });
	});

	it("skips replayed stats samples on re-subscribe", () => {
		const at = (t: string) => ({
			cpuPercent: 1,
			memBytes: 1,
			memLimitBytes: 2,
			netRx: 0,
			netTx: 0,
			at: t,
		});
		const first = reduceServerMessage(EMPTY_OBSERVER_DATA, {
			channel: "stats:abc",
			type: "stats",
			payload: {
				samples: [at("2026-01-01T00:00:01Z"), at("2026-01-01T00:00:02Z")],
			},
		});
		const replay = reduceServerMessage(first, {
			channel: "stats:abc",
			type: "stats",
			payload: {
				samples: [at("2026-01-01T00:00:02Z"), at("2026-01-01T00:00:03Z")],
			},
		});
		expect(replay.stats.abc?.map((s) => s.at)).toEqual([
			"2026-01-01T00:00:01Z",
			"2026-01-01T00:00:02Z",
			"2026-01-01T00:00:03Z",
		]);
		const nothingNew = reduceServerMessage(replay, {
			channel: "stats:abc",
			type: "stats",
			payload: { samples: [at("2026-01-01T00:00:03Z")] },
		});
		expect(nothingNew).toBe(replay);
	});
});

describe("forgetChannel", () => {
	it("drops a released project's status and the channel's error only", () => {
		const withStatus = reduceServerMessage(EMPTY_OBSERVER_DATA, {
			channel: "status:shop",
			type: "snapshot",
			payload: snapshot,
		});
		const withError = reduceServerMessage(withStatus, {
			channel: "status:shop",
			type: "error",
			payload: { code: "DOCKER_UNREACHABLE", message: "down" },
		});
		const forgotten = forgetChannel(withError, "status:shop");
		expect(forgotten.status.shop).toBeUndefined();
		expect(forgotten.errors["status:shop"]).toBeUndefined();
		expect(forgetChannel(forgotten, "stats:abc")).toBe(forgotten);
	});
});
