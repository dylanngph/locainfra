import type { DockerInfo } from "../../ports/docker.port";
import type {
	PlatformFacts,
	PlatformSummary,
	RuntimeProvider,
} from "../../ports/platform.port";
import { formatCommandStep } from "../../shared/command-format";
import {
	compareVersions,
	MIN_COMPOSE_VERSION,
	MIN_DOCKER_API_VERSION,
	RECOMMENDED_COMPOSE_VERSION,
} from "../../shared/version";
import type { RunDoctor } from "../ops.contract";
import { buildSetupPlan } from "../setup/build-setup-plan.op";
import {
	MANUAL_INSTALL_URLS,
	RUNTIME_LABELS,
	runtimeStartStep,
	startableRuntimes,
} from "../setup/setup-steps";
import {
	DOCTOR_CHECK,
	type DoctorCheck,
	type DoctorCheckId,
	type DoctorReport,
	type SetupNeeded,
} from "./doctor.model";

/** Outcome of one probe: its value, or the reason it failed. */
type Probe<T> = { ok: true; value: T } | { ok: false; error: string };

const SETUP_HINT =
	"Run `locastack setup` to install Docker (it shows every command before running anything).";
const GENERIC_START_FIX =
	"Start your Docker runtime (Docker Desktop, Colima, OrbStack or the Docker daemon) and run `locastack doctor` again.";
const PERMISSION_DENIED = /EACCES|permission denied/i;

async function probe<T>(run: () => Promise<T>): Promise<Probe<T>> {
	try {
		return { ok: true, value: await run() };
	} catch (cause) {
		return { ok: false, error: describe(cause) };
	}
}

function describe(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function check(
	id: DoctorCheckId,
	label: string,
	status: DoctorCheck["status"],
	detail?: string,
	fix?: string,
): DoctorCheck {
	return {
		id,
		label,
		status,
		...(detail === undefined ? {} : { detail }),
		...(fix === undefined ? {} : { fix }),
	};
}

/** Public part of the facts (no paths, no user name). */
function summarize(facts: PlatformFacts): PlatformSummary {
	return {
		os: facts.os,
		arch: facts.arch,
		hasBrew: facts.hasBrew,
		hasSystemd: facts.hasSystemd,
		installedRuntimes: [...facts.installedRuntimes],
		...(facts.runningRuntime === undefined
			? {}
			: { runningRuntime: facts.runningRuntime }),
		...(facts.inDockerGroup === undefined
			? {}
			: { inDockerGroup: facts.inDockerGroup }),
	};
}

const UNKNOWN_PLATFORM: PlatformSummary = {
	os: "other",
	arch: "unknown",
	hasBrew: false,
	hasSystemd: false,
	installedRuntimes: [],
};

/** Fix for "Docker is missing entirely" on this OS. */
function installFix(facts: PlatformFacts | null): string {
	if (facts?.os === "win32")
		return `Install Docker Desktop: ${MANUAL_INSTALL_URLS.windows}`;
	if (facts === null || facts.os === "other")
		return `Install Docker Engine and the Compose v2 plugin: ${MANUAL_INSTALL_URLS.engine}`;
	return SETUP_HINT;
}

/** Fix for "the daemon does not answer", cheapest remedy first. */
function daemonFix(facts: PlatformFacts | null): string {
	if (facts === null) return GENERIC_START_FIX;
	if (facts.os === "win32" || facts.os === "other") {
		return facts.dockerCliPath ? GENERIC_START_FIX : installFix(facts);
	}
	const running = facts.runningRuntime;
	if (running !== undefined) {
		const label =
			running in RUNTIME_LABELS
				? RUNTIME_LABELS[running as RuntimeProvider]
				: running;
		return `${label} is running but its Docker socket is not reachable: check \`docker context ls\` or set DOCKER_HOST.`;
	}
	// Same pick as the setup planner: the runtime the docker context names,
	// then a desktop app before Colima.
	const stopped = startableRuntimes(facts)[0];
	if (stopped !== undefined) {
		const step = runtimeStartStep(stopped, facts, {
			freshBrew: facts.hasBrew && facts.brewOnPath === false,
		});
		return `Start ${RUNTIME_LABELS[stopped]} (\`${formatCommandStep(step)}\`) or run \`locastack setup\`.`;
	}
	return facts.dockerCliPath ? GENERIC_START_FIX : SETUP_HINT;
}

function groupFix(facts: PlatformFacts): string {
	return `Run \`locastack setup\` (it runs \`sudo usermod -aG docker ${facts.username}\`), then log out and back in (or run \`newgrp docker\`).`;
}

function updateRuntimeFix(facts: PlatformFacts | null): string {
	const running = facts?.runningRuntime;
	if (running !== undefined && running in RUNTIME_LABELS)
		return `Update ${RUNTIME_LABELS[running as RuntimeProvider]} to the latest version.`;
	return "Update Docker (Docker Desktop, Colima, OrbStack or Docker Engine) to the latest version.";
}

function composeInstallFix(facts: PlatformFacts | null): string {
	if (facts?.os === "darwin")
		return "Run `locastack setup` (installs docker-compose with Homebrew and links it into ~/.docker/cli-plugins).";
	if (facts?.os === "linux")
		return `Install the \`docker-compose-plugin\` package from Docker's repository (${MANUAL_INSTALL_URLS.composeLinux}).`;
	return "Install the Docker Compose v2 plugin (bundled with Docker Desktop).";
}

function composeUpgradeFix(facts: PlatformFacts | null): string {
	const running = facts?.runningRuntime;
	if (facts?.os === "darwin") {
		if (running === "docker-desktop" || running === "orbstack")
			return updateRuntimeFix(facts);
		return "Run `brew upgrade docker-compose` (or `locastack setup`).";
	}
	if (facts?.os === "linux")
		return "Upgrade the `docker-compose-plugin` package with your package manager.";
	return updateRuntimeFix(facts);
}

function cliCheck(
	facts: Probe<PlatformFacts>,
	compose: Probe<string | null>,
): DoctorCheck {
	const label = "Docker CLI";
	if (facts.ok) {
		const path = facts.value.dockerCliPath;
		if (path) return check(DOCTOR_CHECK.dockerCli, label, "ok", path);
		return check(
			DOCTOR_CHECK.dockerCli,
			label,
			"fail",
			"`docker` was not found on PATH",
			installFix(facts.value),
		);
	}
	if (compose.ok && compose.value !== null) {
		return check(
			DOCTOR_CHECK.dockerCli,
			label,
			"ok",
			"`docker compose` answers",
		);
	}
	return check(
		DOCTOR_CHECK.dockerCli,
		label,
		"fail",
		`Could not look up \`docker\` on PATH: ${facts.error}`,
		installFix(null),
	);
}

function socketCheck(
	socket: Probe<string | null>,
	facts: PlatformFacts | null,
): DoctorCheck {
	const label = "Docker socket";
	if (socket.ok && socket.value)
		return check(DOCTOR_CHECK.socket, label, "ok", socket.value);
	const detail = socket.ok
		? "No Docker socket found (DOCKER_HOST, docker context, default path)"
		: `Socket lookup failed: ${socket.error}`;
	return check(
		DOCTOR_CHECK.socket,
		label,
		"fail",
		detail,
		`${daemonFix(facts)} If Docker uses a custom socket, set DOCKER_HOST.`,
	);
}

function daemonChecks(
	info: Probe<DockerInfo>,
	facts: PlatformFacts | null,
): DoctorCheck[] {
	const label = "Docker daemon";
	if (!info.ok) {
		const denied =
			facts?.os === "linux" &&
			!facts.isRoot &&
			facts.inDockerGroup !== true &&
			PERMISSION_DENIED.test(info.error);
		if (denied) {
			return [
				check(
					DOCTOR_CHECK.daemon,
					label,
					"fail",
					`Permission denied on the Docker socket: ${facts.username} is not in the \`docker\` group`,
					groupFix(facts),
				),
			];
		}
		return [
			check(
				DOCTOR_CHECK.daemon,
				label,
				"fail",
				`Docker is not reachable: ${info.error}`,
				daemonFix(facts),
			),
		];
	}
	const value = info.value;
	const platform = value.platformName ? ` (${value.platformName})` : "";
	const checks = [
		check(
			DOCTOR_CHECK.daemon,
			label,
			"ok",
			`Engine ${value.serverVersion}${platform}, ${value.os}/${value.arch}`,
		),
	];
	const apiLabel = "Docker Engine API";
	const diff = compareVersions(value.apiVersion, MIN_DOCKER_API_VERSION);
	if (diff === null) {
		checks.push(
			check(
				DOCTOR_CHECK.api,
				apiLabel,
				"warn",
				`Unrecognised API version "${value.apiVersion}"`,
			),
		);
	} else if (diff < 0) {
		checks.push(
			check(
				DOCTOR_CHECK.api,
				apiLabel,
				"fail",
				`API ${value.apiVersion} is older than ${MIN_DOCKER_API_VERSION}`,
				updateRuntimeFix(facts),
			),
		);
	} else {
		checks.push(
			check(DOCTOR_CHECK.api, apiLabel, "ok", `API ${value.apiVersion}`),
		);
	}
	return checks;
}

function composeChecks(
	compose: Probe<string | null>,
	facts: PlatformFacts | null,
): DoctorCheck[] {
	const label = "Docker Compose";
	const cliMissing = facts !== null && !facts.dockerCliPath;
	if (!compose.ok || compose.value === null) {
		if (cliMissing) {
			return [
				check(
					DOCTOR_CHECK.composePlugin,
					label,
					"fail",
					"`docker compose` needs the docker CLI, which is missing",
					installFix(facts),
				),
			];
		}
		const detail = compose.ok
			? "The docker CLI is installed but the `docker compose` v2 plugin was not found"
			: `\`docker compose version\` failed: ${compose.error}`;
		return [
			check(
				DOCTOR_CHECK.composePlugin,
				label,
				"fail",
				detail,
				composeInstallFix(facts),
			),
		];
	}
	const version = compose.value;
	const versionLabel = "Compose version";
	const checks = [
		check(DOCTOR_CHECK.composePlugin, label, "ok", `docker compose ${version}`),
	];
	const minDiff = compareVersions(version, MIN_COMPOSE_VERSION);
	const recDiff = compareVersions(version, RECOMMENDED_COMPOSE_VERSION);
	if (minDiff === null || recDiff === null) {
		checks.push(
			check(
				DOCTOR_CHECK.composeVersion,
				versionLabel,
				"warn",
				`Unrecognised compose version "${version}"`,
			),
		);
	} else if (minDiff < 0) {
		checks.push(
			check(
				DOCTOR_CHECK.composeVersion,
				versionLabel,
				"fail",
				`Compose ${version} is older than ${MIN_COMPOSE_VERSION}`,
				composeUpgradeFix(facts),
			),
		);
	} else if (recDiff < 0) {
		checks.push(
			check(
				DOCTOR_CHECK.composeVersion,
				versionLabel,
				"warn",
				`Compose ${version} works; ${RECOMMENDED_COMPOSE_VERSION} or newer is recommended`,
				composeUpgradeFix(facts),
			),
		);
	} else {
		checks.push(
			check(
				DOCTOR_CHECK.composeVersion,
				versionLabel,
				"ok",
				`Compose ${version}`,
			),
		);
	}
	return checks;
}

/** `docker.group` (Linux only). */
function groupCheck(facts: PlatformFacts, daemonOk: boolean): DoctorCheck {
	const label = "docker group";
	if (facts.isRoot)
		return check(DOCTOR_CHECK.dockerGroup, label, "ok", "Running as root");
	if (facts.inDockerGroup === true) {
		return check(
			DOCTOR_CHECK.dockerGroup,
			label,
			"ok",
			`${facts.username} is in the \`docker\` group`,
		);
	}
	if (facts.inDockerGroup === undefined) {
		return check(
			DOCTOR_CHECK.dockerGroup,
			label,
			"warn",
			"Could not determine the groups of the current user",
		);
	}
	const notInGroup = `${facts.username} is not in the \`docker\` group`;
	if (daemonOk) {
		return check(
			DOCTOR_CHECK.dockerGroup,
			label,
			"warn",
			`${notInGroup}, but the daemon answers anyway (rootless Docker or a custom socket)`,
		);
	}
	const desktopOnly =
		facts.installedRuntimes.includes("docker-desktop") &&
		!facts.installedRuntimes.includes("docker-engine");
	if (desktopOnly) {
		return check(
			DOCTOR_CHECK.dockerGroup,
			label,
			"warn",
			`${notInGroup} (not needed by Docker Desktop's per-user socket)`,
		);
	}
	return check(
		DOCTOR_CHECK.dockerGroup,
		label,
		"fail",
		`${notInGroup}: the Docker socket will refuse this user`,
		groupFix(facts),
	);
}

/** `homebrew` (macOS only, informational). */
function homebrewCheck(facts: PlatformFacts): DoctorCheck {
	const label = "Homebrew";
	if (facts.hasBrew)
		return check(
			DOCTOR_CHECK.homebrew,
			label,
			"ok",
			facts.brewPrefix ?? "brew found",
		);
	return check(
		DOCTOR_CHECK.homebrew,
		label,
		"warn",
		"Homebrew was not found",
		`Only needed to install Docker: \`locastack setup\` installs Homebrew first (${MANUAL_INSTALL_URLS.homebrew}).`,
	);
}

/**
 * Diagnoses Docker: the checks of {@link DOCTOR_CHECK} in order — Docker CLI
 * on PATH, socket located, daemon reachable (engine version), Engine API ≥
 * {@link MIN_DOCKER_API_VERSION}, compose plugin, compose ≥
 * {@link MIN_COMPOSE_VERSION} (warn below {@link RECOMMENDED_COMPOSE_VERSION}),
 * docker group (Linux) and Homebrew (macOS). The API check is omitted when
 * the daemon is unreachable, the version check when compose is missing.
 * Fixes name the cheapest remedy (start an installed runtime before
 * installing one). Adds `platform` and `setupNeeded` (the kind of
 * `buildSetupPlan` for these checks). Never throws; `ok` is false when any
 * check fails.
 */
export const runDoctor: RunDoctor = async (deps) => {
	const [factsProbe, socket, info, compose] = await Promise.all([
		probe(() => deps.platform.inspect()),
		probe(() => deps.socket.locate()),
		probe(() => deps.docker.info()),
		probe(() => deps.compose.version()),
	]);
	const facts = factsProbe.ok ? factsProbe.value : null;
	const daemon = daemonChecks(info, facts);
	const checks: DoctorCheck[] = [
		cliCheck(factsProbe, compose),
		socketCheck(socket, facts),
		...daemon,
		...composeChecks(compose, facts),
	];
	if (facts?.os === "linux") checks.push(groupCheck(facts, info.ok));
	if (facts?.os === "darwin") checks.push(homebrewCheck(facts));
	const ok = checks.every((c) => c.status !== "fail");
	const report: DoctorReport = {
		ok,
		checks,
		generatedAt: deps.clock.now().toISOString(),
		platform: facts ? summarize(facts) : UNKNOWN_PLATFORM,
	};
	let setupNeeded: SetupNeeded = ok ? "none" : "unsupported";
	if (facts) setupNeeded = buildSetupPlan(facts, report, {}).kind;
	return { ...report, setupNeeded };
};
