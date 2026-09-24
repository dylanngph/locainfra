import type { ProjectStatus, ProjectSummary } from "@locastack/server";
import { describe, expect, it } from "vitest";
import { projectHealth } from "../project-health";

const summary: ProjectSummary = {
	name: "shop",
	root: "/p/shop",
	serviceCount: 2,
	running: 2,
	errors: 0,
	types: ["postgres", "redis"],
};

const row = (
	name: string,
	usage: { cpuPercent?: number; memBytes?: number },
): ProjectStatus["services"][number] => ({
	name,
	type: "postgres",
	version: "16",
	image: "postgres:16",
	hostPort: 5433,
	containerPort: 5432,
	containerName: `ls-shop-${name}`,
	persist: "volume",
	state: "running",
	health: "healthy",
	...usage,
});

describe("projectHealth", () => {
	it("has no CPU/MEM when the summary carries none (Live off), never 0", () => {
		const health = projectHealth(summary);
		expect(health.cpuPercent).toBeUndefined();
		expect(health.memBytes).toBeUndefined();
	});

	it("uses the summary's usage when the server sent it", () => {
		const health = projectHealth({ ...summary, cpuPercent: 1.5, memBytes: 42 });
		expect(health.cpuPercent).toBe(1.5);
		expect(health.memBytes).toBe(42);
	});

	it("sums only known readings of a live status, undefined when none", () => {
		const live = (services: ProjectStatus["services"]): ProjectStatus => ({
			project: "shop",
			network: "ls-shop",
			services,
		});
		const none = projectHealth(summary, live([row("a", {}), row("b", {})]));
		expect(none.cpuPercent).toBeUndefined();
		expect(none.memBytes).toBeUndefined();
		const some = projectHealth(
			summary,
			live([row("a", { cpuPercent: 2, memBytes: 10 }), row("b", {})]),
		);
		expect(some.cpuPercent).toBe(2);
		expect(some.memBytes).toBe(10);
	});
});
