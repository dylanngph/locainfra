import type { PlatformFacts, RuntimeProvider } from "../../ports/platform.port";
import type { CommandStep } from "../../ports/process.port";
import { MIN_DOCKER_API_VERSION } from "../../shared/version";
import {
	DOCTOR_CHECK,
	type DoctorCheckId,
	type DoctorReport,
} from "../doctor/doctor.model";
import type { BuildSetupPlan } from "../ops.contract";
import {
	DEFAULT_MAC_RUNTIME,
	SETUP_INSTALLER_URLS,
	type SetupOptions,
	type SetupPlan,
} from "../ops.model";
import {
	brewBin,
	brewOffPath,
	brewPathDirs,
	brewPrefixOf,
	brewShellenvNote,
	composeLinkSteps,
	dockerGroupStep,
	downloadStep,
	homebrewSteps,
	intelBrewUninstallStep,
	MAC_RUNTIMES,
	MANUAL_INSTALL_URLS,
	NATIVE_BREW_PREFIX,
	nativeBrewPathNote,
	nativeHomebrewSteps,
	RUNTIME_LABELS,
	rosettaBrew,
	runtimeOfContext,
	runtimeStartStep,
	SETUP_STEP,
	startableRuntimes,
	withNativeBrew,
	withSudo,
} from "./setup-steps";

/** What the report says is broken (a missing check counts as not failing). */
interface Problems {
	readonly cliMissing: boolean;
	readonly daemonDown: boolean;
	readonly apiOld: boolean;
	readonly composeMissing: boolean;
	readonly composeOld: boolean;
}

const RELOGIN_NOTE =
	"Log out and back in (or run `newgrp docker`) so the docker group applies to your shell, then run `locastack doctor`.";

function failed(report: DoctorReport, id: DoctorCheckId): boolean | undefined {
	const check = report.checks.find((c) => c.id === id);
	return check === undefined ? undefined : check.status === "fail";
}

function problemsOf(facts: PlatformFacts, report: DoctorReport): Problems {
	return {
		cliMissing:
			failed(report, DOCTOR_CHECK.dockerCli) ??
			facts.dockerCliPath === undefined,
		daemonDown:
			failed(report, DOCTOR_CHECK.daemon) === true ||
			failed(report, DOCTOR_CHECK.socket) === true,
		apiOld: failed(report, DOCTOR_CHECK.api) === true,
		composeMissing: failed(report, DOCTOR_CHECK.composePlugin) === true,
		composeOld: failed(report, DOCTOR_CHECK.composeVersion) === true,
	};
}

/** Fixes of the failing checks, deduplicated (notes of `unsupported` plans). */
function failingFixes(report: DoctorReport): string[] {
	const fixes = report.checks
		.filter((c) => c.status === "fail")
		.map((c) => c.fix ?? c.detail ?? c.label);
	return [...new Set(fixes)];
}

function plan(
	fields: Omit<SetupPlan, "needsTerminal" | "alternatives" | "postNotes"> &
		Partial<Pick<SetupPlan, "alternatives" | "postNotes">>,
): SetupPlan {
	const postNotes = [
		...new Set((fields.postNotes ?? []).filter((note) => note.length > 0)),
	];
	return {
		...fields,
		alternatives: fields.alternatives ?? [],
		postNotes,
		needsTerminal: fields.steps.some(
			(step) => step.sudo === true || step.attached === true,
		),
	};
}

function unsupported(reason: string, postNotes: string[]): SetupPlan {
	return plan({ kind: "unsupported", reason, steps: [], postNotes });
}

function label(runtime: string): string {
	return runtime in RUNTIME_LABELS
		? RUNTIME_LABELS[runtime as RuntimeProvider]
		: runtime;
}

function list(parts: readonly string[]): string {
	if (parts.length <= 1) return parts.join("");
	return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

/** Homebrew install steps when missing, plus the post note (also when brew is only off PATH). */
function ensureBrew(facts: PlatformFacts): {
	steps: CommandStep[];
	notes: string[];
} {
	const note = brewOffPath(facts) ? brewShellenvNote(facts) : undefined;
	const notes = note ? [note] : [];
	if (facts.hasBrew) return { steps: [], notes };
	return { steps: homebrewSteps(facts), notes };
}

/**
 * A macOS plan whose steps call binaries under the Homebrew prefix while
 * brew is not on this process's PATH: `runSetupPlan` must prepend the
 * prefix (`pathAdditions`) before it waits for the daemon and re-runs
 * doctor, or neither finds the new `docker`.
 */
function macPlan(
	facts: PlatformFacts,
	fields: Parameters<typeof plan>[0],
): SetupPlan {
	const prefix = `${brewPrefixOf(facts)}/`;
	const usesBrew = fields.steps.some((step) =>
		(step.argv[0] ?? "").startsWith(prefix),
	);
	if (!usesBrew || !brewOffPath(facts)) return plan(fields);
	return plan({ ...fields, pathAdditions: brewPathDirs(facts) });
}

/**
 * Brew steps that repair the Docker CLI and the compose plugin (install
 * missing formulae, upgrade an old compose, link the plugin).
 */
function cliComposeSteps(
	facts: PlatformFacts,
	problems: Problems,
): { steps: CommandStep[]; missing: string[] } {
	const brew = brewBin(facts);
	const formulae: string[] = [];
	const missing: string[] = [];
	if (problems.cliMissing) {
		formulae.push("docker");
		missing.push("the Docker CLI");
	}
	if (problems.composeMissing && !problems.cliMissing) {
		missing.push("the Compose plugin");
	}
	if (problems.composeMissing || problems.cliMissing) {
		formulae.push("docker-compose");
	}
	const steps: CommandStep[] = [];
	const upgrade =
		problems.composeOld &&
		!formulae.includes("docker-compose") &&
		facts.installedRuntimes.includes("colima");
	if (problems.composeOld && !formulae.includes("docker-compose") && !upgrade) {
		formulae.push("docker-compose");
	}
	if (problems.composeOld) missing.push("a newer Compose plugin");
	if (formulae.length > 0) {
		steps.push({
			id: SETUP_STEP.cliInstall,
			title: `Installing ${formulae.join(" and ")} with Homebrew`,
			argv: [brew, "install", ...formulae],
		});
	}
	if (upgrade) {
		steps.push({
			id: SETUP_STEP.composeUpgrade,
			title: "Upgrading docker-compose with Homebrew",
			argv: [brew, "upgrade", "docker-compose"],
		});
	}
	if (problems.cliMissing || problems.composeMissing || problems.composeOld) {
		steps.push(...composeLinkSteps(facts));
	}
	return { steps, missing };
}

/** Docker Desktop and OrbStack ship their own `docker` CLI. */
const CLI_OWNERS: readonly RuntimeProvider[] = ["docker-desktop", "orbstack"];

/**
 * `brew install colima [docker] [docker-compose]` plus the plugin link:
 * a `docker` CLI already on PATH (e.g. Docker Desktop's) is kept, and a
 * working compose plugin is left alone, so Homebrew never fights another
 * runtime's links.
 */
function colimaInstallSteps(
	facts: PlatformFacts,
	problems: Problems,
): { steps: CommandStep[]; notes: string[] } {
	const keepCli = facts.dockerCliPath !== undefined;
	const needsCompose =
		!keepCli || problems.composeMissing || problems.composeOld;
	const formulae = [
		"colima",
		...(keepCli ? [] : ["docker"]),
		...(needsCompose ? ["docker-compose"] : []),
	];
	const notes: string[] = [];
	if (keepCli) {
		notes.push(
			`Keeps the Docker CLI at ${facts.dockerCliPath}: Homebrew's \`docker\` formula is left out so it does not replace it.`,
		);
	} else if (CLI_OWNERS.some((r) => facts.installedRuntimes.includes(r))) {
		const owner = CLI_OWNERS.find((r) => facts.installedRuntimes.includes(r));
		notes.push(
			`Homebrew installs its own \`docker\` CLI into ${brewPrefixOf(facts)}/bin, which may clash with ${label(owner ?? "docker-desktop")}'s. If \`brew install\` reports a link conflict, run \`brew link --overwrite docker\` yourself, or start ${label(owner ?? "docker-desktop")} instead (\`locastack setup --runtime ${owner ?? "docker-desktop"}\`).`,
		);
	}
	const title =
		formulae.length === 3
			? "Installing Colima, the Docker CLI and Compose with Homebrew"
			: `Installing ${formulae.join(" and ")} with Homebrew`;
	return {
		steps: [
			{
				id: SETUP_STEP.colimaInstall,
				title,
				argv: [brewBin(facts), "install", ...formulae],
			},
			...(needsCompose ? composeLinkSteps(facts) : []),
		],
		notes,
	};
}

/** Tells the user that `colima start` moves the docker context off the one in use. */
function withContextNote(facts: PlatformFacts, step: CommandStep): CommandStep {
	const context = facts.dockerContext;
	if (context === undefined || runtimeOfContext(facts.os, context) === "colima")
		return step;
	const note = `\`colima start\` switches the docker context from \`${context}\` to \`colima\` (switch back with \`docker context use ${context}\`).`;
	return { ...step, note: step.note ? `${step.note} ${note}` : note };
}

/** Why Colima is reinstalled from the native Homebrew (`SetupPlan.reason`). */
export const ROSETTA_BREW_REASON = `Homebrew at /usr/local is the Intel build running under Rosetta; Colima needs the native one at ${NATIVE_BREW_PREFIX}.`;

/**
 * Colima on an Apple silicon Mac whose Homebrew is the Intel build: remove
 * the Intel colima/lima/docker/docker-compose, install the native Homebrew
 * (unless it already sits at /opt/homebrew), install Colima, the CLI and
 * Compose with it, link the plugin and start `/opt/homebrew/bin/colima`
 * with `/opt/homebrew/bin` first on PATH.
 */
function rosettaColimaPlan(
	facts: PlatformFacts,
	options: SetupOptions,
	reasonPrefix: string,
): SetupPlan {
	const native = withNativeBrew(facts);
	const uninstall = intelBrewUninstallStep(facts);
	const hasNative = facts.nativeBrewPrefix !== undefined;
	const steps: CommandStep[] = [
		...(uninstall === undefined ? [] : [uninstall]),
		...(hasNative ? [] : nativeHomebrewSteps(facts)),
		{
			id: SETUP_STEP.colimaInstall,
			title: `Installing Colima, the Docker CLI and Compose with the native Homebrew`,
			argv: [brewBin(native), "install", "colima", "docker", "docker-compose"],
		},
		...composeLinkSteps(native),
		withContextNote(
			facts,
			runtimeStartStep("colima", native, {
				freshBrew: true,
				...(options.startAtLogin === undefined
					? {}
					: { startAtLogin: options.startAtLogin }),
			}),
		),
	];
	const notes = [nativeBrewPathNote(facts)];
	if (!options.startAtLogin) {
		notes.push(
			`Colima does not start at login: run \`colima start\` after a reboot (or \`${brewBin(native)} services start colima\` to start it at login).`,
		);
	}
	const using = hasNative
		? ` Uses the native Homebrew already at ${brewPrefixOf(native)}.`
		: "";
	return plan({
		kind: "install",
		provider: "colima",
		alternatives: MAC_RUNTIMES.filter((r) => r !== "colima"),
		reason: [reasonPrefix, `${ROSETTA_BREW_REASON}${using}`]
			.filter((part) => part.length > 0)
			.join(" "),
		steps,
		postNotes: notes,
		pathAdditions: brewPathDirs(native),
	});
}

/**
 * The installed Colima came from the Intel Homebrew (or it cannot be told):
 * starting it would fail with "limactl is running under rosetta".
 */
function intelColima(facts: PlatformFacts): boolean {
	const formulae = facts.intelBrewFormulae;
	return (
		formulae === undefined ||
		formulae.includes("colima") ||
		formulae.includes("lima")
	);
}

function macInstallPlan(
	facts: PlatformFacts,
	problems: Problems,
	provider: RuntimeProvider,
	options: SetupOptions,
	reasonPrefix: string,
): SetupPlan {
	if (provider === "colima" && rosettaBrew(facts))
		return rosettaColimaPlan(facts, options, reasonPrefix);
	const brew = ensureBrew(facts);
	const bin = brewBin(facts);
	const freshBrew = brewOffPath(facts);
	const steps: CommandStep[] = [...brew.steps];
	const notes = [...brew.notes];
	if (provider === "colima") {
		const install = colimaInstallSteps(facts, problems);
		steps.push(
			...install.steps,
			withContextNote(
				facts,
				runtimeStartStep("colima", facts, {
					freshBrew,
					...(options.startAtLogin === undefined
						? {}
						: { startAtLogin: options.startAtLogin }),
				}),
			),
		);
		notes.push(...install.notes);
		if (!options.startAtLogin) {
			notes.push(
				"Colima does not start at login: run `colima start` after a reboot (or `brew services start colima` to start it at login).",
			);
		}
	} else if (provider === "docker-desktop") {
		steps.push(
			{
				id: SETUP_STEP.desktopInstall,
				title: "Installing Docker Desktop with Homebrew",
				argv: [bin, "install", "--cask", "docker"],
				attached: true,
				note: "Homebrew may ask for your password to link the Docker CLI.",
			},
			runtimeStartStep("docker-desktop", facts),
		);
	} else {
		steps.push(
			{
				id: SETUP_STEP.orbstackInstall,
				title: "Installing OrbStack with Homebrew",
				argv: [bin, "install", "--cask", "orbstack"],
				attached: true,
				note: "Homebrew may ask for your password.",
			},
			runtimeStartStep("orbstack", facts),
		);
	}
	const install = facts.hasBrew
		? `Install ${RUNTIME_LABELS[provider]} with Homebrew and start it.`
		: `Install Homebrew first, then ${RUNTIME_LABELS[provider]} with Homebrew, and start it.`;
	return macPlan(facts, {
		kind: "install",
		provider,
		alternatives: MAC_RUNTIMES.filter((r) => r !== provider),
		reason: `${reasonPrefix} ${install}`,
		steps,
		postNotes: notes,
	});
}

function macStartPlan(
	facts: PlatformFacts,
	problems: Problems,
	provider: RuntimeProvider,
	options: SetupOptions,
	alternatives: RuntimeProvider[],
): SetupPlan {
	const name = RUNTIME_LABELS[provider];
	if (provider !== "colima") {
		// Docker Desktop and OrbStack link their own CLI and compose on start.
		return plan({
			kind: "start",
			provider,
			alternatives,
			reason: `${name} is installed but not running; start it.`,
			steps: [runtimeStartStep(provider, facts)],
		});
	}
	if (rosettaBrew(facts) && intelColima(facts))
		return rosettaColimaPlan(
			facts,
			options,
			`${name} is installed from the Intel Homebrew and cannot start.`,
		);
	const repair =
		problems.cliMissing || problems.composeMissing || problems.composeOld;
	// Homebrew is installed but not on PATH: call Colima by its brew path.
	const offPath = facts.hasBrew && facts.brewOnPath === false;
	const start = withContextNote(
		facts,
		runtimeStartStep("colima", facts, {
			freshBrew: offPath,
			...(options.startAtLogin === undefined
				? {}
				: { startAtLogin: options.startAtLogin }),
		}),
	);
	if (!repair) {
		return macPlan(facts, {
			kind: "start",
			provider,
			alternatives,
			reason: `${name} is installed but not running; start it.`,
			steps: [start],
			postNotes: offPath ? ensureBrew(facts).notes : [],
		});
	}
	const brew = ensureBrew(facts);
	const fix = cliComposeSteps(facts, problems);
	return macPlan(facts, {
		kind: "install",
		provider,
		reason: `${name} is installed but not running and needs ${list(fix.missing)}; install with Homebrew and start ${name}.`,
		steps: [...brew.steps, ...fix.steps, start],
		postNotes: brew.notes,
	});
}

/**
 * The runtime serving a unix `DOCKER_HOST` socket, from its path (Colima,
 * OrbStack, Docker Desktop; on Linux the native engine's default socket).
 * `undefined` for tcp/ssh hosts and sockets that do not name a runtime.
 */
function runtimeOfDockerHost(
	facts: PlatformFacts,
	host: string,
): RuntimeProvider | undefined {
	const path = host.startsWith("unix://")
		? host.slice("unix://".length)
		: host.startsWith("/")
			? host
			: "";
	if (path === "") return undefined;
	if (path.includes("/.colima/")) return "colima";
	if (path.includes("/.orbstack/")) return "orbstack";
	if (
		path === `${facts.homeDir}/.docker/run/docker.sock` ||
		path.includes("/.docker/desktop/")
	)
		return "docker-desktop";
	if (
		facts.os === "linux" &&
		(path === "/var/run/docker.sock" || path === "/run/docker.sock")
	)
		return "docker-engine";
	return undefined;
}

/**
 * DOCKER_HOST is set and does not answer. The socket locator treats it as
 * authoritative, so starting or installing any other runtime cannot help.
 * Returns the installed runtime its socket belongs to (only that one may be
 * started), or the `unsupported` plan.
 */
function dockerHostGate(
	facts: PlatformFacts,
	options: SetupOptions,
	host: string,
): RuntimeProvider | SetupPlan {
	const runtime = runtimeOfDockerHost(facts, host);
	if (
		runtime !== undefined &&
		facts.installedRuntimes.includes(runtime) &&
		(options.runtime === undefined || options.runtime === runtime)
	)
		return runtime;
	return unsupported(
		`DOCKER_HOST=${host} does not answer; start that daemon or unset DOCKER_HOST.`,
		[
			"LocaStack only talks to the daemon DOCKER_HOST names, so it will not start or install another runtime while it is set.",
			"Start the daemon it points at, or run `unset DOCKER_HOST` (and remove it from your shell profile) to use the active docker context, then run `locastack doctor`.",
		],
	);
}

function planMac(
	facts: PlatformFacts,
	report: DoctorReport,
	options: SetupOptions,
): SetupPlan {
	const problems = problemsOf(facts, report);
	const running = facts.runningRuntime;
	if (!problems.daemonDown) {
		if (problems.apiOld) {
			return unsupported(
				`The running Docker Engine is older than API ${MIN_DOCKER_API_VERSION}; update it.`,
				failingFixes(report),
			);
		}
		if (
			problems.composeOld &&
			!problems.composeMissing &&
			(running === "docker-desktop" || running === "orbstack")
		) {
			return unsupported(
				`The Compose plugin bundled with ${label(running)} is too old.`,
				[`Update ${label(running)} to the latest version.`],
			);
		}
		const brew = ensureBrew(facts);
		const fix = cliComposeSteps(facts, problems);
		if (fix.steps.length === 0) {
			return unsupported(
				"Docker answers but a check fails that setup cannot fix automatically.",
				failingFixes(report),
			);
		}
		return macPlan(facts, {
			kind: "install",
			reason: `Docker is running but needs ${list(fix.missing)}; install with Homebrew.`,
			steps: [...brew.steps, ...fix.steps],
			postNotes: brew.notes,
		});
	}
	if (
		running !== undefined &&
		(options.runtime === undefined || options.runtime === running)
	) {
		const hint =
			running === "colima"
				? `Run \`docker context use colima\` (or set DOCKER_HOST=unix://${facts.homeDir}/.colima/default/docker.sock), then \`locastack doctor\`.`
				: "Check `docker context ls` and DOCKER_HOST, then run `locastack doctor`.";
		return unsupported(
			`${label(running)} is running but LocaStack cannot reach its Docker socket.`,
			[hint],
		);
	}
	const gate =
		facts.dockerHost === undefined
			? undefined
			: dockerHostGate(facts, options, facts.dockerHost);
	if (typeof gate === "object") return gate;
	const installed = startableRuntimes(facts);
	const stopped =
		gate ??
		(options.runtime === undefined
			? installed[0]
			: installed.find((r) => r === options.runtime));
	if (stopped !== undefined)
		return macStartPlan(
			facts,
			problems,
			stopped,
			options,
			gate === undefined ? installed.filter((r) => r !== stopped) : [],
		);
	const provider = options.runtime ?? DEFAULT_MAC_RUNTIME;
	const prefix =
		installed.length > 0
			? `${label(installed[0] ?? "")} is installed but ${RUNTIME_LABELS[provider]} was requested.`
			: "Docker is not installed.";
	return macInstallPlan(facts, problems, provider, options, prefix);
}

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------

function groupNotes(steps: readonly CommandStep[]): string[] {
	return steps.some((s) => s.id === SETUP_STEP.groupAdd) ? [RELOGIN_NOTE] : [];
}

function planLinux(
	facts: PlatformFacts,
	report: DoctorReport,
	options: SetupOptions,
): SetupPlan {
	const problems = problemsOf(facts, report);
	const needsGroup = !facts.isRoot && facts.inDockerGroup === false;
	if (!problems.daemonDown) {
		if (problems.apiOld) {
			return unsupported(
				`The running Docker Engine is older than API ${MIN_DOCKER_API_VERSION}; update it.`,
				failingFixes(report),
			);
		}
		if (problems.cliMissing || problems.composeMissing || problems.composeOld) {
			return unsupported(
				"Docker answers but the Docker CLI or its Compose plugin is missing or too old.",
				[
					`Install or upgrade the \`docker-ce-cli\` and \`docker-compose-plugin\` packages from Docker's repository (${MANUAL_INSTALL_URLS.composeLinux}).`,
				],
			);
		}
		return unsupported(
			"Docker answers but a check fails that setup cannot fix automatically.",
			failingFixes(report),
		);
	}
	const running = facts.runningRuntime;
	if (
		running !== undefined &&
		(options.runtime === undefined || options.runtime === running)
	) {
		if (running === "docker-engine" && needsGroup) {
			const steps = [dockerGroupStep(facts)];
			return plan({
				kind: "install",
				reason: `Docker Engine is running but ${facts.username} is not in the docker group; add them.`,
				steps,
				postNotes: groupNotes(steps),
				requiresRelogin: true,
			});
		}
		return unsupported(
			`${label(running)} is running but LocaStack cannot reach its Docker socket.`,
			[
				"Check `docker context ls` and DOCKER_HOST, then run `locastack doctor`.",
			],
		);
	}
	const gate =
		facts.dockerHost === undefined
			? undefined
			: dockerHostGate(facts, options, facts.dockerHost);
	if (typeof gate === "object") return gate;
	const installed = startableRuntimes(facts);
	const stopped =
		gate ??
		(options.runtime === undefined
			? installed[0]
			: installed.find((r) => r === options.runtime));
	const others =
		gate === undefined ? installed.filter((r) => r !== stopped) : [];
	if (stopped === "docker-desktop") {
		return plan({
			kind: "start",
			provider: stopped,
			alternatives: others,
			reason: "Docker Desktop is installed but not running; start it.",
			steps: [runtimeStartStep(stopped, facts)],
		});
	}
	if (stopped === "docker-engine") {
		const steps = [runtimeStartStep(stopped, facts)];
		if (needsGroup) steps.push(dockerGroupStep(facts));
		return plan({
			kind: needsGroup ? "install" : "start",
			provider: stopped,
			...(needsGroup ? {} : { alternatives: others }),
			reason: needsGroup
				? `Docker Engine is installed but not running and ${facts.username} is not in the docker group; start it and add them.`
				: "Docker Engine is installed but not running; start it.",
			steps,
			postNotes: groupNotes(steps),
			...(needsGroup ? { requiresRelogin: true } : {}),
		});
	}
	const provider = options.runtime ?? "docker-engine";
	if (provider !== "docker-engine") {
		return unsupported(
			`LocaStack cannot install ${label(provider)} on Linux.`,
			[
				`Install Docker Desktop for Linux from its package (${MANUAL_INSTALL_URLS.desktopLinux}), or run \`locastack setup\` without --runtime to install Docker Engine.`,
			],
		);
	}
	const script = `${facts.tmpDir}/get-docker.sh`;
	const steps: CommandStep[] = [
		downloadStep(
			SETUP_STEP.engineDownload,
			"Downloading Docker's install script",
			SETUP_INSTALLER_URLS.getDocker,
			script,
		),
		{
			id: SETUP_STEP.engineInstall,
			title: "Installing Docker Engine, the CLI and Compose",
			...withSudo(facts, ["sh", script]),
		},
		facts.hasSystemd
			? {
					id: SETUP_STEP.engineEnable,
					title: "Starting Docker now and at boot",
					...withSudo(facts, ["systemctl", "enable", "--now", "docker"]),
				}
			: runtimeStartStep("docker-engine", facts),
	];
	const addGroup = !facts.isRoot && facts.inDockerGroup !== true;
	if (addGroup) steps.push(dockerGroupStep(facts));
	return plan({
		kind: "install",
		provider,
		reason:
			"Docker is not installed; install Docker Engine with Docker's official script.",
		steps,
		postNotes: [
			...groupNotes(steps),
			...(facts.hasSystemd
				? []
				: [
						"Without systemd, Docker does not start at boot: run `sudo service docker start` after a reboot.",
					]),
		],
		...(addGroup ? { requiresRelogin: true } : {}),
	});
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function osLabel(facts: PlatformFacts): string {
	return facts.os === "darwin"
		? "macOS"
		: facts.os === "linux"
			? "Linux"
			: "this OS";
}

function runtimeFits(runtime: RuntimeProvider, facts: PlatformFacts): boolean {
	if (facts.os === "darwin") return runtime !== "docker-engine";
	return runtime === "docker-engine" || runtime === "docker-desktop";
}

/**
 * Pure planner: turns machine facts and a doctor report into the commands
 * that fix the failing checks, cheapest remedy first (start a stopped
 * runtime before installing anything). Runs nothing and never throws. See
 * `BuildSetupPlan` in `ops.contract.ts` and `docs/setup.md` for every shape.
 */
export const buildSetupPlan: BuildSetupPlan = (facts, report, options) => {
	if (report.ok) {
		return plan({
			kind: "none",
			reason: "Docker is ready; nothing to set up.",
			steps: [],
		});
	}
	if (facts.os === "win32") {
		return unsupported(
			"LocaStack cannot set up Docker on Windows automatically.",
			[
				`Install Docker Desktop for Windows: ${MANUAL_INSTALL_URLS.windows}`,
				"Then run `locastack doctor` again.",
			],
		);
	}
	if (facts.os === "other") {
		return unsupported("LocaStack can only set up Docker on macOS and Linux.", [
			`Install Docker Engine and the Compose v2 plugin: ${MANUAL_INSTALL_URLS.engine}`,
			"Then run `locastack doctor` again.",
		]);
	}
	if (options.runtime !== undefined && !runtimeFits(options.runtime, facts)) {
		const choices =
			facts.os === "darwin"
				? MAC_RUNTIMES.join(", ")
				: "docker-engine, docker-desktop (start only)";
		return unsupported(
			`${label(options.runtime)} is not available on ${osLabel(facts)}.`,
			[`Choose one of: ${choices}.`],
		);
	}
	return facts.os === "darwin"
		? planMac(facts, report, options)
		: planLinux(facts, report, options);
};
