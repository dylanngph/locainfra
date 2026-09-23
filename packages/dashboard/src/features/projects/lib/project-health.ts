import type { ProjectStatus, ProjectSummary } from "@locainfra/server";
import type { StatusTone } from "@/shared/components/status";

/** Numbers a project card shows, from its summary or live status. */
export interface ProjectHealth {
	readonly total: number;
	readonly running: number;
	readonly errors: number;
	/** Summed CPU, `undefined` without a reading (Live off). */
	readonly cpuPercent: number | undefined;
	/** Summed memory, `undefined` without a reading (Live off). */
	readonly memBytes: number | undefined;
	readonly tone: StatusTone;
	readonly label: string;
}

/** Sum of the known readings, `undefined` when none is known. */
const sumReadings = (values: readonly (number | undefined)[]) =>
	values.reduce<number | undefined>(
		(sum, v) => (v === undefined ? sum : (sum ?? 0) + v),
		undefined,
	);

/**
 * Card/switcher status of a project: live status wins over the summary.
 *
 * @param summary - `GET /api/projects` row.
 * @param live - Latest `status:<project>` snapshot, if subscribed.
 * @returns Counts, resources, tone and pill label.
 */
export function projectHealth(
	summary: ProjectSummary,
	live?: ProjectStatus,
): ProjectHealth {
	const services = live?.services;
	const total = services ? services.length : summary.serviceCount;
	const running = services
		? services.filter((s) => s.state === "running").length
		: summary.running;
	const errors = services
		? services.filter((s) => s.state === "port-conflict" || s.state === "error")
				.length
		: summary.errors;
	const cpuPercent = services
		? sumReadings(services.map((s) => s.cpuPercent))
		: summary.cpuPercent;
	const memBytes = services
		? sumReadings(services.map((s) => s.memBytes))
		: summary.memBytes;
	if (summary.issue) {
		return {
			total,
			running: 0,
			errors: 0,
			cpuPercent: undefined,
			memBytes: undefined,
			tone: "error",
			label: "Unavailable",
		};
	}
	if (errors > 0) {
		return {
			total,
			running,
			errors,
			cpuPercent,
			memBytes,
			tone: "error",
			label: `${running}/${total} running, ${errors} ${errors === 1 ? "error" : "errors"}`,
		};
	}
	if (running > 0) {
		return {
			total,
			running,
			errors,
			cpuPercent,
			memBytes,
			tone: "running",
			label: `${running}/${total} running`,
		};
	}
	return {
		total,
		running,
		errors,
		cpuPercent,
		memBytes,
		tone: "stopped",
		label: "Stopped",
	};
}

/**
 * Suggested folder for a new project: next to existing projects, else `~/Developer`.
 *
 * @param name - New project name.
 * @param roots - Roots of registered projects.
 * @returns e.g. `/Users/me/Developer/my-app` or `~/Developer/my-app`.
 */
export function suggestedRoot(name: string, roots: readonly string[]): string {
	const first = roots.find((r) => r.startsWith("/"));
	const parent = first ? first.slice(0, first.lastIndexOf("/")) : "~/Developer";
	return `${parent || "~/Developer"}/${name || "my-app"}`;
}
