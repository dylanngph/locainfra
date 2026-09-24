import type { SystemSetup } from "@/features/system/api/system.api";

/**
 * Docker state behind the mock `/api/system*` routes. `running` answers
 * normally; `stopped` has Colima installed but not running (Start Docker
 * works); `missing` has nothing installed (install plan).
 */
export type MockDockerState = "running" | "stopped" | "missing";

const GENERATED_AT = "2026-09-24T08:00:00.000Z";

const PLATFORM = {
	os: "darwin",
	arch: "arm64",
	hasBrew: true,
	hasSystemd: false,
} as const;

/**
 * `GET /api/system` body for a Docker state.
 *
 * @param state - Mock Docker state.
 * @returns Versions (`docker: null` unless running).
 */
export function mockSystemInfo(state: MockDockerState) {
	return {
		docker:
			state === "running"
				? {
						version: "27.1.1",
						apiVersion: "1.46",
						platformName: "Docker Desktop",
					}
				: null,
		compose: state === "missing" ? null : "2.29.1",
		dashboardVersion: "0.0.0-mock",
	};
}

/**
 * `GET /api/system/setup` body for a Docker state (mirrors core's planner
 * for a Mac with Homebrew).
 *
 * @param state - Mock Docker state.
 * @returns Doctor report and plan.
 */
export function mockSystemSetup(state: MockDockerState): SystemSetup {
	if (state === "running")
		return {
			doctor: {
				ok: true,
				generatedAt: GENERATED_AT,
				checks: [
					{ id: "docker.cli", label: "Docker CLI", status: "ok" },
					{ id: "docker.daemon", label: "Docker daemon", status: "ok" },
				],
				platform: {
					...PLATFORM,
					installedRuntimes: ["colima"],
					runningRuntime: "colima",
				},
				setupNeeded: "none",
			},
			plan: {
				kind: "none",
				alternatives: [],
				reason: "Docker is running.",
				steps: [],
				postNotes: [],
				needsTerminal: false,
			},
		};
	if (state === "stopped")
		return {
			doctor: {
				ok: false,
				generatedAt: GENERATED_AT,
				checks: [
					{
						id: "docker.cli",
						label: "Docker CLI",
						status: "ok",
						detail: "/opt/homebrew/bin/docker",
					},
					{
						id: "docker.daemon",
						label: "Docker daemon",
						status: "fail",
						detail: "not reachable",
						fix: "Start Colima: colima start",
					},
				],
				platform: { ...PLATFORM, installedRuntimes: ["colima"] },
				setupNeeded: "start",
			},
			plan: {
				kind: "start",
				provider: "colima",
				alternatives: [],
				reason: "Colima is installed but not running; start it.",
				steps: [
					{
						id: "colima.start",
						title: "Starting Colima",
						argv: ["colima", "start"],
					},
				],
				postNotes: [],
				needsTerminal: false,
			},
		};
	return {
		doctor: {
			ok: false,
			generatedAt: GENERATED_AT,
			checks: [
				{
					id: "docker.cli",
					label: "Docker CLI",
					status: "fail",
					detail: "not found",
					fix: "Run `locastack setup` to install Colima and the Docker CLI",
				},
				{
					id: "docker.daemon",
					label: "Docker daemon",
					status: "fail",
					detail: "not reachable",
				},
				{
					id: "compose.plugin",
					label: "Compose plugin",
					status: "fail",
					detail: "missing",
				},
			],
			platform: { ...PLATFORM, installedRuntimes: [] },
			setupNeeded: "install",
		},
		plan: {
			kind: "install",
			provider: "colima",
			alternatives: ["docker-desktop", "orbstack"],
			reason:
				"Docker is not installed; install Colima, the Docker CLI and Compose with Homebrew, then start Colima.",
			steps: [
				{
					id: "brew.install-colima",
					title: "Installing Colima, the Docker CLI and Compose",
					argv: [
						"/opt/homebrew/bin/brew",
						"install",
						"colima",
						"docker",
						"docker-compose",
					],
				},
				{
					id: "compose.plugin-dir",
					title: "Creating the Docker CLI plugin folder",
					argv: ["mkdir", "-p", "/Users/dev/.docker/cli-plugins"],
				},
				{
					id: "compose.link",
					title: "Linking the Compose plugin",
					argv: [
						"ln",
						"-sfn",
						"/opt/homebrew/opt/docker-compose/bin/docker-compose",
						"/Users/dev/.docker/cli-plugins/docker-compose",
					],
				},
				{
					id: "colima.start",
					title: "Starting Colima",
					argv: ["colima", "start"],
				},
			],
			postNotes: [],
			needsTerminal: false,
		},
	};
}
