import { type Static, Type } from "@sinclair/typebox";
import { PlatformSummary } from "../../ports/platform.port";

/** Outcome of a single doctor check. */
export const DoctorCheckStatus = Type.Union([
	Type.Literal("ok"),
	Type.Literal("warn"),
	Type.Literal("fail"),
]);
/** Outcome of a single doctor check. */
export type DoctorCheckStatus = Static<typeof DoctorCheckStatus>;

/**
 * Stable ids of every doctor check, in report order. Statuses each check can
 * take (a check that does not apply is left out of the report, never `ok`):
 *
 * | id | when present | ok | warn | fail |
 * |---|---|---|---|---|
 * | `docker.cli` | always | `docker` on PATH (detail: path) | — | not found |
 * | `docker.socket` | always | socket located (detail: path) | — | none found |
 * | `docker.daemon` | always | Engine answers (detail: version, platform) | — | not reachable (stopped, or permission denied) |
 * | `docker.api` | daemon ok | API ≥ `MIN_DOCKER_API_VERSION` | unrecognised version | older |
 * | `compose.plugin` | always | `docker compose` works | — | missing or failing |
 * | `compose.version` | plugin ok | ≥ `RECOMMENDED_COMPOSE_VERSION` | ≥ min, < recommended, or unrecognised | < `MIN_COMPOSE_VERSION` |
 * | `docker.group` | Linux | in `docker` group or root | not in the group but the daemon answers anyway | not in the group and the socket refuses the user |
 * | `homebrew` | macOS | `brew` found | missing (informational: setup installs it first) | never |
 *
 * `docker.daemon` replaces the pre-0.2 `docker.reachable`, `compose.plugin`
 * replaces `compose.installed`.
 */
export const DOCTOR_CHECK = {
	dockerCli: "docker.cli",
	socket: "docker.socket",
	daemon: "docker.daemon",
	api: "docker.api",
	composePlugin: "compose.plugin",
	composeVersion: "compose.version",
	dockerGroup: "docker.group",
	homebrew: "homebrew",
} as const;

/** Stable id of a doctor check (see {@link DOCTOR_CHECK}). */
export const DoctorCheckId = Type.Union([
	Type.Literal(DOCTOR_CHECK.dockerCli),
	Type.Literal(DOCTOR_CHECK.socket),
	Type.Literal(DOCTOR_CHECK.daemon),
	Type.Literal(DOCTOR_CHECK.api),
	Type.Literal(DOCTOR_CHECK.composePlugin),
	Type.Literal(DOCTOR_CHECK.composeVersion),
	Type.Literal(DOCTOR_CHECK.dockerGroup),
	Type.Literal(DOCTOR_CHECK.homebrew),
]);
/** Stable id of a doctor check. */
export type DoctorCheckId = Static<typeof DoctorCheckId>;

/** One diagnostic check performed by `doctor`. */
export const DoctorCheck = Type.Object({
	id: Type.String({
		description:
			"Stable identifier, one of DoctorCheckId (docker.cli, docker.socket, docker.daemon, docker.api, compose.plugin, compose.version, docker.group, homebrew)",
	}),
	label: Type.String(),
	status: DoctorCheckStatus,
	detail: Type.Optional(Type.String()),
	fix: Type.Optional(
		Type.String({ description: "Human-readable remediation" }),
	),
});
/** One diagnostic check performed by `doctor`. */
export type DoctorCheck = Static<typeof DoctorCheck>;

/**
 * What `locastack setup` would have to do, derived from the checks and the
 * platform (cheapest remedy first):
 * - `none`: no check fails (warnings allowed);
 * - `start`: a runtime is installed with the CLI and compose, only its daemon is stopped;
 * - `install`: something must be installed or configured (runtime, Docker CLI,
 *   compose plugin or its link, Homebrew, docker group membership), possibly
 *   followed by a start;
 * - `unsupported`: a check fails and no automated remedy exists (Windows,
 *   other OSes, Linux without a way to install); `fix` hints still apply.
 */
export const SetupNeeded = Type.Union([
	Type.Literal("none"),
	Type.Literal("start"),
	Type.Literal("install"),
	Type.Literal("unsupported"),
]);
/** What `locastack setup` would have to do. */
export type SetupNeeded = Static<typeof SetupNeeded>;

/**
 * Full doctor report (served by `GET /api/doctor`, printed by `locastack doctor`).
 * `platform` and `setupNeeded` are always set by `runDoctor` since 0.2; they
 * are optional so reports from older servers (and hand-built fixtures) still
 * validate, and clients treat an absent value as unknown.
 */
export const DoctorReport = Type.Object({
	ok: Type.Boolean({ description: "True when no check has status `fail`" }),
	checks: Type.Array(DoctorCheck),
	generatedAt: Type.String({ description: "ISO-8601 timestamp" }),
	platform: Type.Optional(PlatformSummary),
	setupNeeded: Type.Optional(SetupNeeded),
});
/** Full doctor report. */
export type DoctorReport = Static<typeof DoctorReport>;
