import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { toStatsSample } from "../stats-mapper";

const now = new Date("2026-09-23T00:00:00.000Z");
const frames = (
	await Bun.file(join(import.meta.dir, "fixtures/redis-stats.ndjson")).text()
)
	.trim()
	.split("\n")
	.map((line) => JSON.parse(line) as unknown);

describe("toStatsSample", () => {
	test("first frame of a stream (no previous reading) reports 0% CPU", () => {
		const sample = toStatsSample(frames[0], now);
		expect(sample).toEqual({
			cpuPercent: 0,
			memBytes: 10125312 - 4096,
			memLimitBytes: 8321232896,
			netRx: 4449,
			netTx: 1766,
			at: "2026-09-23T06:04:54.886Z",
		});
	});

	test("recorded frame: cpu delta / system delta * online cpus * 100", () => {
		const sample = toStatsSample(frames[1], now);
		// (9_724_000 / 12_130_000_000) * 12 * 100 = 0.9619…
		expect(sample?.cpuPercent).toBe(0.96);
		expect(sample?.memBytes).toBe(10387456 - 4096);
		expect(sample?.at).toBe("2026-09-23T06:04:55.893Z");
	});

	test("cgroup v1 fields, percpu fallback and summed networks", () => {
		const sample = toStatsSample(
			{
				read: "2026-09-23T01:00:00.5Z",
				cpu_stats: {
					cpu_usage: { total_usage: 300, percpu_usage: [1, 2] },
					system_cpu_usage: 2000,
				},
				precpu_stats: {
					cpu_usage: { total_usage: 100 },
					system_cpu_usage: 1000,
				},
				memory_stats: {
					usage: 5000,
					limit: 10000,
					stats: { total_inactive_file: 1000 },
				},
				networks: {
					eth0: { rx_bytes: 10, tx_bytes: 1 },
					eth1: { rx_bytes: 5, tx_bytes: 2 },
				},
			},
			now,
		);
		expect(sample).toEqual({
			cpuPercent: 40,
			memBytes: 4000,
			memLimitBytes: 10000,
			netRx: 15,
			netTx: 3,
			at: "2026-09-23T01:00:00.500Z",
		});
	});

	test("stopped container (empty stats, zero time) yields zeros at `now`", () => {
		expect(
			toStatsSample(
				{
					read: "0001-01-01T00:00:00Z",
					cpu_stats: { cpu_usage: { total_usage: 0 } },
					precpu_stats: { cpu_usage: { total_usage: 0 } },
					memory_stats: {},
				},
				now,
			),
		).toEqual({
			cpuPercent: 0,
			memBytes: 0,
			memLimitBytes: 0,
			netRx: 0,
			netTx: 0,
			at: now.toISOString(),
		});
		expect(toStatsSample("nope", now)).toBeNull();
	});
});
