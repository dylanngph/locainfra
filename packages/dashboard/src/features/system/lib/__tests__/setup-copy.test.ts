import { describe, expect, it } from "vitest";
import type { SystemSetup } from "@/features/system/api/system.api";
import { mockSystemSetup } from "@/test/msw/mock-system";
import {
	canStartFromDashboard,
	formatArgv,
	formatStep,
	unavailableTitle,
} from "../setup-copy";

describe("formatArgv", () => {
	it("keeps plain words and single-quotes the rest", () => {
		expect(formatArgv(["colima", "start"])).toBe("colima start");
		expect(formatArgv(["ln", "-sfn", "/opt/a b/docker-compose", "it's"])).toBe(
			"ln -sfn '/opt/a b/docker-compose' 'it'\\''s'",
		);
		expect(formatArgv(["sudo", "usermod", "-aG", "docker", "$USER"])).toBe(
			"sudo usermod -aG docker '$USER'",
		);
	});
});

describe("formatStep", () => {
	it("puts extra environment variables first, like the CLI", () => {
		expect(
			formatStep({
				id: "colima.start",
				title: "Starting Colima",
				argv: ["/opt/homebrew/bin/colima", "start"],
				env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin" },
			}),
		).toBe(
			"PATH=/opt/homebrew/bin:/usr/bin:/bin /opt/homebrew/bin/colima start",
		);
	});
});

describe("unavailableTitle", () => {
	const unsupported = (
		base: SystemSetup,
		reason = "Docker answers but a check fails.",
	): SystemSetup => ({
		doctor: { ...base.doctor, setupNeeded: "unsupported" },
		plan: { ...base.plan, kind: "unsupported", reason, steps: [] },
	});
	const withChecks = (
		base: SystemSetup,
		fails: readonly string[],
		platform: Partial<NonNullable<SystemSetup["doctor"]["platform"]>> = {},
	): SystemSetup => ({
		...base,
		doctor: {
			...base.doctor,
			checks: fails.map((id) => ({ id, label: id, status: "fail" as const })),
			platform: {
				...(base.doctor.platform ?? {
					os: "darwin",
					arch: "arm64",
					hasBrew: true,
					hasSystemd: false,
					installedRuntimes: [],
				}),
				...platform,
			},
		},
	});

	it("stopped and missing Docker", () => {
		expect(unavailableTitle(mockSystemSetup("stopped"))).toBe(
			"Docker is not running",
		);
		expect(unavailableTitle(mockSystemSetup("missing"))).toBe(
			"Docker is not installed",
		);
	});

	it("keeps 'not supported' for Windows and other OSes only", () => {
		const windows = withChecks(
			unsupported(mockSystemSetup("missing")),
			["docker.cli", "docker.daemon"],
			{ os: "win32" },
		);
		expect(unavailableTitle(windows)).toBe(
			"Docker is not supported on this platform",
		);
		const macUnreachable = withChecks(
			unsupported(
				mockSystemSetup("stopped"),
				"Colima is running but LocaStack cannot reach its Docker socket.",
			),
			["docker.socket", "docker.daemon"],
			{ runningRuntime: "colima", installedRuntimes: ["colima"] },
		);
		expect(unavailableTitle(macUnreachable)).toBe(
			"LocaStack can't reach Docker",
		);
		const dockerHost = withChecks(
			unsupported(
				mockSystemSetup("missing"),
				"DOCKER_HOST=tcp://10.0.0.2:2375 does not answer; start that daemon or unset DOCKER_HOST.",
			),
			["docker.socket", "docker.daemon"],
		);
		expect(unavailableTitle(dockerHost)).toBe("LocaStack can't reach Docker");
	});

	it("names the actual problem of install and unsupported plans", () => {
		const running = mockSystemSetup("stopped");
		expect(unavailableTitle(withChecks(running, ["compose.plugin"]))).toBe(
			"Docker needs the Compose plugin",
		);
		expect(
			unavailableTitle(withChecks(unsupported(running), ["docker.api"])),
		).toBe("Docker needs an update");
		expect(
			unavailableTitle(withChecks(unsupported(running), ["compose.version"])),
		).toBe("Docker needs an update");
		expect(
			unavailableTitle(
				withChecks(running, ["docker.group", "docker.daemon"], { os: "linux" }),
			),
		).toBe("Docker needs permission");
	});
});

describe("canStartFromDashboard", () => {
	it("only for start plans that need no terminal", () => {
		const start = mockSystemSetup("stopped").plan;
		expect(canStartFromDashboard(start)).toBe(true);
		expect(canStartFromDashboard({ ...start, needsTerminal: true })).toBe(
			false,
		);
		expect(canStartFromDashboard(mockSystemSetup("missing").plan)).toBe(false);
	});
});
