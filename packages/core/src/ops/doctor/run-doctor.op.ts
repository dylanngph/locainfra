import type { ComposeInfoPort } from "../../ports/compose.port";
import type { DockerInfo, DockerInfoPort } from "../../ports/docker.port";
import {
	compareVersions,
	MIN_COMPOSE_VERSION,
	MIN_DOCKER_API_VERSION,
	RECOMMENDED_COMPOSE_VERSION,
} from "../../shared/version";
import type { RunDoctor } from "../ops.contract";
import type { DoctorCheck } from "./doctor.model";

/** Stable ids of the checks produced by {@link runDoctor}. */
export const DOCTOR_CHECK_IDS = {
	socket: "docker.socket",
	reachable: "docker.reachable",
	api: "docker.api",
	composeInstalled: "compose.installed",
	composeVersion: "compose.version",
} as const;

const START_DOCKER_FIX =
	"Start Docker Desktop (or your Docker daemon) and run `locainfra doctor` again.";
const UPDATE_DOCKER_FIX = "Update Docker Desktop to the latest version.";

async function socketCheck(
	locate: () => Promise<string | null>,
): Promise<DoctorCheck> {
	const base = { id: DOCTOR_CHECK_IDS.socket, label: "Docker socket" };
	try {
		const path = await locate();
		if (path) return { ...base, status: "ok", detail: path };
		return {
			...base,
			status: "fail",
			detail:
				"No Docker socket found (DOCKER_HOST, docker context, default path)",
			fix: `${START_DOCKER_FIX} If Docker uses a custom socket, set DOCKER_HOST.`,
		};
	} catch (cause) {
		return {
			...base,
			status: "fail",
			detail: `Socket lookup failed: ${describe(cause)}`,
			fix: START_DOCKER_FIX,
		};
	}
}

async function dockerChecks(docker: DockerInfoPort): Promise<DoctorCheck[]> {
	const reachable = { id: DOCTOR_CHECK_IDS.reachable, label: "Docker daemon" };
	let info: DockerInfo;
	try {
		info = await docker.info();
	} catch (cause) {
		return [
			{
				...reachable,
				status: "fail",
				detail: `Docker is not reachable: ${describe(cause)}`,
				fix: START_DOCKER_FIX,
			},
		];
	}
	const platform = info.platformName ? ` (${info.platformName})` : "";
	const checks: DoctorCheck[] = [
		{
			...reachable,
			status: "ok",
			detail: `Engine ${info.serverVersion}${platform}, ${info.os}/${info.arch}`,
		},
	];
	const api = { id: DOCTOR_CHECK_IDS.api, label: "Docker Engine API" };
	const diff = compareVersions(info.apiVersion, MIN_DOCKER_API_VERSION);
	if (diff === null) {
		checks.push({
			...api,
			status: "warn",
			detail: `Unrecognised API version "${info.apiVersion}"`,
		});
	} else if (diff < 0) {
		checks.push({
			...api,
			status: "fail",
			detail: `API ${info.apiVersion} is older than ${MIN_DOCKER_API_VERSION}`,
			fix: UPDATE_DOCKER_FIX,
		});
	} else {
		checks.push({ ...api, status: "ok", detail: `API ${info.apiVersion}` });
	}
	return checks;
}

async function composeChecks(compose: ComposeInfoPort): Promise<DoctorCheck[]> {
	const installed = {
		id: DOCTOR_CHECK_IDS.composeInstalled,
		label: "Docker Compose",
	};
	let version: string | null;
	try {
		version = await compose.version();
	} catch (cause) {
		return [
			{
				...installed,
				status: "fail",
				detail: `\`docker compose version\` failed: ${describe(cause)}`,
				fix: "Install the Docker Compose v2 plugin (bundled with Docker Desktop).",
			},
		];
	}
	if (version === null) {
		return [
			{
				...installed,
				status: "fail",
				detail: "The `docker compose` plugin was not found",
				fix: "Install the Docker Compose v2 plugin (bundled with Docker Desktop).",
			},
		];
	}
	const versionCheck = {
		id: DOCTOR_CHECK_IDS.composeVersion,
		label: "Compose version",
	};
	const checks: DoctorCheck[] = [
		{ ...installed, status: "ok", detail: `docker compose ${version}` },
	];
	const minDiff = compareVersions(version, MIN_COMPOSE_VERSION);
	const recDiff = compareVersions(version, RECOMMENDED_COMPOSE_VERSION);
	if (minDiff === null || recDiff === null) {
		checks.push({
			...versionCheck,
			status: "warn",
			detail: `Unrecognised compose version "${version}"`,
		});
	} else if (minDiff < 0) {
		checks.push({
			...versionCheck,
			status: "fail",
			detail: `Compose ${version} is older than ${MIN_COMPOSE_VERSION}`,
			fix: UPDATE_DOCKER_FIX,
		});
	} else if (recDiff < 0) {
		checks.push({
			...versionCheck,
			status: "warn",
			detail: `Compose ${version} works; ${RECOMMENDED_COMPOSE_VERSION} or newer is recommended`,
			fix: UPDATE_DOCKER_FIX,
		});
	} else {
		checks.push({
			...versionCheck,
			status: "ok",
			detail: `Compose ${version}`,
		});
	}
	return checks;
}

function describe(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Diagnoses the Docker setup: socket located, daemon reachable (with engine
 * version), Engine API ≥ {@link MIN_DOCKER_API_VERSION}, compose installed,
 * compose ≥ {@link MIN_COMPOSE_VERSION} (warn below
 * {@link RECOMMENDED_COMPOSE_VERSION}). The API check is omitted when the
 * daemon is unreachable, the version check when compose is missing.
 * Never throws; `ok` is false when any check fails.
 */
export const runDoctor: RunDoctor = async (deps) => {
	const [socket, docker, compose] = await Promise.all([
		socketCheck(() => deps.socket.locate()),
		dockerChecks(deps.docker),
		composeChecks(deps.compose),
	]);
	const checks = [socket, ...docker, ...compose];
	return {
		ok: checks.every((check) => check.status !== "fail"),
		checks,
		generatedAt: deps.clock.now().toISOString(),
	};
};
