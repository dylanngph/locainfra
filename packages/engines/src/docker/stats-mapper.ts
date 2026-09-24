import type { StatsSample } from "@locastack/core";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(obj: unknown, key: string): number | undefined {
	if (!isObject(obj)) return undefined;
	const value = obj[key];
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function nonNegativeInt(value: number): number {
	return value > 0 ? Math.round(value) : 0;
}

/** Docker's zero time, sent as `read`/`preread` before a first sample exists. */
const ZERO_TIME_PREFIX = "0001-01-01";

/**
 * Computes a {@link StatsSample} from one `GET /containers/{id}/stats` frame,
 * with `docker stats` semantics:
 * - `cpuPercent = (cpu_delta / system_delta) * online_cpus * 100`, rounded
 *   to 2 decimals; 0 when there is no previous reading (the first frame of a
 *   stream) or either delta is not positive (e.g. a stopped container);
 * - `memBytes = usage - inactive_file` (cgroup v2; `total_inactive_file` on
 *   cgroup v1), never negative;
 * - `netRx`/`netTx` summed over every network interface.
 *
 * @param raw - Untrusted JSON frame.
 * @param now - Fallback sample time when the frame has no usable `read` time.
 * @returns The sample, or `null` when `raw` is not an object.
 */
export function toStatsSample(raw: unknown, now: Date): StatsSample | null {
	if (!isObject(raw)) return null;
	const cpu = raw.cpu_stats;
	const pre = raw.precpu_stats;
	const cpuTotal = num(
		isObject(cpu) ? cpu.cpu_usage : undefined,
		"total_usage",
	);
	const preTotal = num(
		isObject(pre) ? pre.cpu_usage : undefined,
		"total_usage",
	);
	const system = num(cpu, "system_cpu_usage");
	const preSystem = num(pre, "system_cpu_usage");
	const percpu =
		isObject(cpu) &&
		isObject(cpu.cpu_usage) &&
		Array.isArray(cpu.cpu_usage.percpu_usage)
			? cpu.cpu_usage.percpu_usage.length
			: 0;
	const onlineCpus = num(cpu, "online_cpus") || percpu || 1;
	const cpuDelta = (cpuTotal ?? 0) - (preTotal ?? 0);
	const systemDelta = (system ?? 0) - (preSystem ?? 0);
	const cpuPercent =
		cpuTotal !== undefined &&
		system !== undefined &&
		preSystem !== undefined &&
		preSystem > 0 &&
		cpuDelta > 0 &&
		systemDelta > 0
			? (cpuDelta / systemDelta) * onlineCpus * 100
			: 0;

	const memory = raw.memory_stats;
	const usage = num(memory, "usage") ?? 0;
	const detail = isObject(memory) ? memory.stats : undefined;
	const inactive =
		num(detail, "inactive_file") ?? num(detail, "total_inactive_file") ?? 0;
	const memBytes = usage > inactive ? usage - inactive : usage;

	let netRx = 0;
	let netTx = 0;
	if (isObject(raw.networks)) {
		for (const iface of Object.values(raw.networks)) {
			netRx += num(iface, "rx_bytes") ?? 0;
			netTx += num(iface, "tx_bytes") ?? 0;
		}
	}

	const read = typeof raw.read === "string" ? raw.read : "";
	const readMs = read.startsWith(ZERO_TIME_PREFIX)
		? Number.NaN
		: Date.parse(read);
	return {
		cpuPercent: Math.round(Math.max(0, cpuPercent) * 100) / 100,
		memBytes: nonNegativeInt(memBytes),
		memLimitBytes: nonNegativeInt(num(memory, "limit") ?? 0),
		netRx: nonNegativeInt(netRx),
		netTx: nonNegativeInt(netTx),
		at: (Number.isNaN(readMs) ? now : new Date(readMs)).toISOString(),
	};
}
