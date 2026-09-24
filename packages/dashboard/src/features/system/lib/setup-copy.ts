import type {
	RuntimeProvider,
	SetupPlan,
	SetupStep,
	SystemSetup,
} from "../api/system.api";

/** Words that need no quoting when a command is shown or copied. */
const PLAIN_WORD = /^[A-Za-z0-9_./:=@%+,-]+$/;

/** One word as typed in a POSIX shell: plain as is, else single-quoted. */
const quoteWord = (word: string): string =>
	PLAIN_WORD.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * Shows a step's `argv` as one shell line: plain words as they are, anything
 * else POSIX single-quoted (`it's` → `'it'\''s'`). Display only: the server
 * runs the argv without a shell.
 *
 * @param argv - Command and arguments.
 * @returns The command line.
 */
export function formatArgv(argv: readonly string[]): string {
	return argv.map(quoteWord).join(" ");
}

/**
 * Same line as core's `formatCommandStep` (the CLI shows it too): extra
 * environment variables first as `KEY=value`, then the quoted argv. Kept
 * local because the SPA does not bundle `@locastack/core`.
 *
 * @param step - A setup step.
 * @returns Its command line (see {@link formatArgv}).
 */
export const formatStep = (step: SetupStep): string =>
	[
		...Object.entries(step.env ?? {}).map(
			([key, value]) => `${key}=${quoteWord(String(value))}`,
		),
		formatArgv(step.argv),
	].join(" ");

/** Display names of the runtimes. */
export const RUNTIME_LABEL: Readonly<Record<RuntimeProvider, string>> = {
	colima: "Colima",
	"docker-desktop": "Docker Desktop",
	orbstack: "OrbStack",
	"docker-engine": "Docker Engine",
};

/** The CLI command that installs or starts Docker from a terminal. */
export const SETUP_COMMAND = "locastack setup";

/** Titles of the Docker-unavailable screen. */
export const UNAVAILABLE_TITLE = {
	unsupportedOs: "Docker is not supported on this platform",
	permission: "Docker needs permission",
	notRunning: "Docker is not running",
	unreachable: "LocaStack can't reach Docker",
	notInstalled: "Docker is not installed",
	update: "Docker needs an update",
	compose: "Docker needs the Compose plugin",
	unavailable: "Docker is unavailable",
} as const;

/**
 * Title of the Docker-unavailable screen, from the failing doctor checks and
 * the plan together (a Mac missing only the Compose plugin, a Linux user
 * outside the `docker` group or a running runtime LocaStack cannot reach
 * are not "not installed" or "not supported"). "Not supported" is kept for
 * Windows and other OSes.
 *
 * @param setup - Doctor report and plan.
 * @returns E.g. "Docker is not running".
 */
export function unavailableTitle(setup: SystemSetup): string {
	const { doctor, plan } = setup;
	const failing = new Set(
		doctor.checks.filter((c) => c.status === "fail").map((c) => c.id),
	);
	const need = doctor.setupNeeded ?? plan.kind;
	const os = doctor.platform?.os;
	if (need === "unsupported" && (os === "win32" || os === "other"))
		return UNAVAILABLE_TITLE.unsupportedOs;
	if (failing.has("docker.group")) return UNAVAILABLE_TITLE.permission;
	if (failing.has("docker.daemon") || failing.has("docker.socket")) {
		if (need === "start") return UNAVAILABLE_TITLE.notRunning;
		if (
			doctor.platform?.runningRuntime !== undefined ||
			plan.reason.startsWith("DOCKER_HOST=")
		)
			return UNAVAILABLE_TITLE.unreachable;
		if (failing.has("docker.cli")) return UNAVAILABLE_TITLE.notInstalled;
		if ((doctor.platform?.installedRuntimes.length ?? 0) > 0)
			return UNAVAILABLE_TITLE.notRunning;
		return need === "install"
			? UNAVAILABLE_TITLE.notInstalled
			: UNAVAILABLE_TITLE.unavailable;
	}
	if (failing.has("docker.api")) return UNAVAILABLE_TITLE.update;
	if (failing.has("compose.plugin")) return UNAVAILABLE_TITLE.compose;
	if (failing.has("compose.version")) return UNAVAILABLE_TITLE.update;
	if (failing.has("docker.cli")) return UNAVAILABLE_TITLE.notInstalled;
	if (need === "start") return UNAVAILABLE_TITLE.notRunning;
	return UNAVAILABLE_TITLE.unavailable;
}

/**
 * Whether the dashboard can run the plan itself (Start Docker button): only
 * a start that needs no terminal (no sudo, nothing interactive).
 *
 * @param plan - Setup plan.
 * @returns `true` for a startable plan.
 */
export const canStartFromDashboard = (plan: SetupPlan): boolean =>
	plan.kind === "start" && !plan.needsTerminal && plan.steps.length > 0;

/**
 * `locastack setup --runtime <provider>` for an alternative runtime.
 *
 * @param provider - Runtime.
 * @returns The command.
 */
export const setupCommandFor = (provider: RuntimeProvider): string =>
	`${SETUP_COMMAND} --runtime ${provider}`;
