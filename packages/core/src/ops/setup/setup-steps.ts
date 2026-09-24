import type { PlatformFacts, RuntimeProvider } from "../../ports/platform.port";
import type { CommandStep } from "../../ports/process.port";
import { SETUP_INSTALLER_URLS } from "../ops.model";

/** Human names of the runtimes (prompts, reasons, progress titles). */
export const RUNTIME_LABELS: Readonly<Record<RuntimeProvider, string>> = {
	colima: "Colima",
	"docker-desktop": "Docker Desktop",
	orbstack: "OrbStack",
	"docker-engine": "Docker Engine",
};

/** Runtimes `locastack setup` can install or start on macOS, in offer order. */
export const MAC_RUNTIMES: readonly RuntimeProvider[] = [
	"colima",
	"docker-desktop",
	"orbstack",
];

/**
 * Stable ids of every step `buildSetupPlan` can plan (`CommandStep.id`).
 * Clients may key on them (e.g. the CLI offers the inspect step after a
 * `*.download*` step); `runSetupPlan` uses them to pick a failure's fix.
 */
export const SETUP_STEP = {
	brewDownload: "homebrew.download-installer",
	brewInstall: "homebrew.run-installer",
	intelBrewUninstall: "homebrew.uninstall-intel-formulae",
	colimaInstall: "colima.install",
	cliInstall: "docker-cli.install",
	composeUpgrade: "compose.upgrade",
	composePluginDir: "compose.plugin-dir",
	composePluginLink: "compose.plugin-link",
	colimaStart: "colima.start",
	colimaStartAtLogin: "colima.start-at-login",
	desktopInstall: "docker-desktop.install",
	desktopStart: "docker-desktop.start",
	orbstackInstall: "orbstack.install",
	orbstackStart: "orbstack.start",
	engineDownload: "docker-engine.download-script",
	engineInstall: "docker-engine.run-script",
	engineEnable: "docker-engine.enable",
	engineStart: "docker-engine.start",
	groupAdd: "docker-group.add-user",
} as const;

/** Stable id of a planned step (see {@link SETUP_STEP}). */
export type SetupStepId = (typeof SETUP_STEP)[keyof typeof SETUP_STEP];

/** Where to install Docker by hand, per OS (post notes and fixes). */
export const MANUAL_INSTALL_URLS = {
	windows: "https://docs.docker.com/desktop/setup/install/windows-install/",
	engine: "https://docs.docker.com/engine/install/",
	composeLinux: "https://docs.docker.com/compose/install/linux/",
	homebrew: "https://brew.sh",
	desktopLinux: "https://docs.docker.com/desktop/setup/install/linux/",
} as const;

/**
 * Homebrew's default prefix for this CPU when `brew` is not installed yet.
 *
 * @param arch - `process.arch`.
 * @returns `/opt/homebrew` on Apple silicon, `/usr/local` on Intel.
 */
export function defaultBrewPrefix(arch: string): string {
	return arch === "arm64" ? "/opt/homebrew" : "/usr/local";
}

/** Machine facts the step builders read. */
export type StepFacts = Pick<
	PlatformFacts,
	| "os"
	| "arch"
	| "hasBrew"
	| "hasSystemd"
	| "homeDir"
	| "username"
	| "tmpDir"
	| "brewPrefix"
	| "isRoot"
	| "shell"
	| "brewOnPath"
>;

/**
 * Prefixes `sudo` unless running as root.
 *
 * @param facts - Needs `isRoot`.
 * @param argv - Command without sudo.
 * @returns The argv and the step's `sudo` flag.
 */
export function withSudo(
	facts: Pick<PlatformFacts, "isRoot">,
	argv: readonly string[],
): Pick<CommandStep, "argv" | "sudo"> {
	if (facts.isRoot) return { argv: [...argv] };
	return { argv: ["sudo", ...argv], sudo: true };
}

/** Homebrew prefix: the detected one, else the default for this CPU. */
export function brewPrefixOf(
	facts: Pick<PlatformFacts, "brewPrefix" | "arch">,
): string {
	return facts.brewPrefix ?? defaultBrewPrefix(facts.arch);
}

/** Absolute path of `brew` (works in the same run that installed Homebrew). */
export function brewBin(
	facts: Pick<PlatformFacts, "brewPrefix" | "arch">,
): string {
	return `${brewPrefixOf(facts)}/bin/brew`;
}

/**
 * Homebrew's `bin` and `sbin`: what `runSetupPlan` prepends to this
 * process's PATH (`SetupPlan.pathAdditions`) when brew is not on it.
 */
export function brewPathDirs(
	facts: Pick<PlatformFacts, "brewPrefix" | "arch">,
): string[] {
	const prefix = brewPrefixOf(facts);
	return [`${prefix}/bin`, `${prefix}/sbin`];
}

/**
 * Whether brew-installed binaries are missing from this process's PATH:
 * Homebrew is not installed yet (the plan installs it) or it was only found
 * at its default prefix (its shellenv is not in the shell profile).
 */
export function brewOffPath(
	facts: Pick<PlatformFacts, "hasBrew" | "brewOnPath">,
): boolean {
	return !facts.hasBrew || facts.brewOnPath === false;
}

/**
 * `PATH` for commands run while Homebrew is not on this process's PATH
 * (installed in the same plan, or its shellenv never added).
 */
export function freshBrewEnv(
	facts: Pick<PlatformFacts, "brewPrefix" | "arch">,
): Record<string, string> {
	const prefix = brewPrefixOf(facts);
	return { PATH: `${prefix}/bin:${prefix}/sbin:/usr/bin:/bin:/usr/sbin:/sbin` };
}

/**
 * The command that starts an installed runtime, as a plan step. Colima with
 * `startAtLogin` (and Homebrew) becomes `brew services start colima`.
 *
 * @param provider - Installed runtime.
 * @param facts - Machine facts.
 * @param options - `startAtLogin` (Colima only); `freshBrew` calls Colima
 *   by its Homebrew path with {@link freshBrewEnv} (Homebrew is not on this
 *   process's PATH: installed by the same plan, or see {@link brewOffPath}).
 * @returns The step.
 */
export function runtimeStartStep(
	provider: RuntimeProvider,
	facts: StepFacts,
	options: { startAtLogin?: boolean; freshBrew?: boolean } = {},
): CommandStep {
	const fresh = options.freshBrew === true;
	const env = fresh ? { env: freshBrewEnv(facts) } : {};
	switch (provider) {
		case "colima":
			if (options.startAtLogin && (facts.hasBrew || fresh)) {
				return {
					id: SETUP_STEP.colimaStartAtLogin,
					title: "Starting Colima now and at login",
					argv: [brewBin(facts), "services", "start", "colima"],
					...env,
					tee: true,
				};
			}
			return {
				id: SETUP_STEP.colimaStart,
				title: "Starting Colima (the first start downloads a VM image)",
				argv: [fresh ? `${brewPrefixOf(facts)}/bin/colima` : "colima", "start"],
				...env,
				// Captured even in a terminal: `runSetupPlan` reads the output to
				// recognise a Colima/Lima installed as x86_64 ("running under rosetta").
				tee: true,
			};
		case "orbstack":
			return {
				id: SETUP_STEP.orbstackStart,
				title: "Starting OrbStack",
				argv: ["open", "-a", "OrbStack"],
			};
		case "docker-desktop":
			if (facts.os === "linux") {
				return {
					id: SETUP_STEP.desktopStart,
					title: "Starting Docker Desktop",
					argv: ["systemctl", "--user", "start", "docker-desktop"],
				};
			}
			return {
				id: SETUP_STEP.desktopStart,
				title: "Starting Docker Desktop",
				argv: ["open", "-a", "Docker"],
				note: "Docker Desktop finishes its setup in its own window (terms, permissions); LocaStack waits for the daemon.",
			};
		case "docker-engine":
			return {
				id: SETUP_STEP.engineStart,
				title: "Starting the Docker daemon",
				...withSudo(
					facts,
					facts.hasSystemd
						? ["systemctl", "start", "docker"]
						: ["service", "docker", "start"],
				),
			};
	}
}

/** Default prefix of the native Homebrew on Apple silicon. */
export const NATIVE_BREW_PREFIX = "/opt/homebrew";

/** Intel Homebrew formulae that must go before Colima is reinstalled natively, in uninstall order. */
export const INTEL_COLIMA_FORMULAE: readonly string[] = [
	"colima",
	"lima",
	"docker",
	"docker-compose",
];

/**
 * Whether the only usable Homebrew is the Intel build under Rosetta on an
 * Apple silicon Mac (`brewNative: false`): Colima and Lima installed from it
 * are x86_64 and `colima start` refuses to run.
 *
 * @param facts - Machine facts.
 * @returns `true` on darwin arm64 with a non-native Homebrew.
 */
export function rosettaBrew(
	facts: Pick<PlatformFacts, "os" | "arch" | "hasBrew" | "brewNative">,
): boolean {
	return (
		facts.os === "darwin" &&
		facts.arch === "arm64" &&
		facts.hasBrew &&
		facts.brewNative === false
	);
}

/**
 * The same facts with the native Homebrew as `brewPrefix` (installed by the
 * plan, or already at `nativeBrewPrefix`), for the step builders.
 *
 * @param facts - Machine facts with an Intel Homebrew.
 * @returns Facts whose brew is `<native prefix>/bin/brew`.
 */
export function withNativeBrew<T extends StepFacts>(
	facts: T & Pick<PlatformFacts, "nativeBrewPrefix">,
): T {
	return {
		...facts,
		hasBrew: true,
		brewPrefix: facts.nativeBrewPrefix ?? NATIVE_BREW_PREFIX,
		brewOnPath: false,
	};
}

/**
 * `<intel prefix>/bin/brew uninstall …` for the Intel Colima, Lima, Docker
 * CLI and Compose that Homebrew installed (only those present), so the
 * native ones take over; `undefined` when none is installed.
 *
 * @param facts - Machine facts with an Intel Homebrew.
 * @returns The step, or `undefined`.
 */
export function intelBrewUninstallStep(
	facts: Pick<PlatformFacts, "brewPrefix" | "arch" | "intelBrewFormulae">,
): CommandStep | undefined {
	const present = INTEL_COLIMA_FORMULAE.filter((name) =>
		(facts.intelBrewFormulae ?? []).includes(name),
	);
	if (present.length === 0) return undefined;
	const prefix = brewPrefixOf(facts);
	return {
		id: SETUP_STEP.intelBrewUninstall,
		title: `Removing the Intel ${present.join(", ")} installed by the Homebrew at ${prefix}`,
		argv: [`${prefix}/bin/brew`, "uninstall", ...present],
		note: "They were built for Intel and run under Rosetta, which Colima refuses; the native Homebrew reinstalls them next.",
	};
}

/**
 * Downloads the Homebrew installer, then runs it as arm64 (`arch -arm64`),
 * attached, so it installs the native Homebrew at /opt/homebrew even when
 * the shell or LocaStack itself runs under Rosetta.
 *
 * @param facts - Machine facts.
 * @returns The download and install steps.
 */
export function nativeHomebrewSteps(facts: StepFacts): CommandStep[] {
	const [download, install] = homebrewSteps(facts);
	if (download === undefined || install === undefined) return [];
	return [
		download,
		{
			...install,
			title: `Installing the native Homebrew at ${NATIVE_BREW_PREFIX}`,
			argv: ["arch", "-arm64", ...install.argv],
			note: `Runs the installer as arm64 so it installs Apple silicon Homebrew at ${NATIVE_BREW_PREFIX} (the Intel one at /usr/local stays). It asks for your password and a confirmation in this terminal.`,
		},
	];
}

/**
 * Post note: put the native Homebrew before the Intel one on PATH.
 *
 * @param facts - Needs `shell`.
 * @returns The note.
 */
export function nativeBrewPathNote(facts: Pick<StepFacts, "shell">): string {
	return `Put the native Homebrew first on your PATH: echo 'eval "$(${NATIVE_BREW_PREFIX}/bin/brew shellenv)"' >> ${shellProfile(facts)} (below any line that adds /usr/local), then open a new terminal, so ${NATIVE_BREW_PREFIX}/bin comes before /usr/local/bin.`;
}

function shellProfile(facts: Pick<StepFacts, "shell">): string {
	const shell = facts.shell.split("/").pop() ?? "";
	return shell === "zsh"
		? "~/.zprofile"
		: shell === "bash"
			? "~/.bash_profile"
			: "your shell profile";
}

/** Downloads the Homebrew installer, then runs it attached. */
export function homebrewSteps(facts: StepFacts): CommandStep[] {
	const path = `${facts.tmpDir}/brew-install.sh`;
	return [
		downloadStep(
			SETUP_STEP.brewDownload,
			"Downloading the Homebrew installer",
			SETUP_INSTALLER_URLS.homebrew,
			path,
		),
		{
			id: SETUP_STEP.brewInstall,
			title: "Installing Homebrew",
			argv: ["/bin/bash", path],
			attached: true,
			note: "The Homebrew installer asks for your password and a confirmation in this terminal.",
		},
	];
}

/**
 * A download step (never piped into a shell: the file is run by a separate
 * step, after the user could inspect it).
 */
export function downloadStep(
	id: SetupStepId,
	title: string,
	url: string,
	path: string,
): CommandStep {
	return {
		id,
		title,
		argv: ["curl", "-fsSL", "--create-dirs", "-o", path, url],
		remoteScript: { url, path, inspectHint: `less ${path}` },
		note: `Downloads ${url} to ${path}; you can read it before it runs.`,
	};
}

/** `mkdir -p ~/.docker/cli-plugins` and the docker-compose plugin symlink. */
export function composeLinkSteps(facts: StepFacts): CommandStep[] {
	const dir = `${facts.homeDir}/.docker/cli-plugins`;
	return [
		{
			id: SETUP_STEP.composePluginDir,
			title: "Creating the Docker CLI plugin folder",
			argv: ["mkdir", "-p", dir],
		},
		{
			id: SETUP_STEP.composePluginLink,
			title: "Linking docker-compose as the `docker compose` plugin",
			argv: [
				"ln",
				"-sfn",
				`${brewPrefixOf(facts)}/opt/docker-compose/bin/docker-compose`,
				`${dir}/docker-compose`,
			],
			note: `Replaces any docker-compose plugin already in ${dir}.`,
		},
	];
}

/**
 * Runtime a docker context name points at: `colima`/`colima-*`,
 * `desktop-linux` (Docker Desktop), `orbstack`, and on Linux `default`
 * (the native engine). `undefined` for anything else.
 *
 * @param os - Host OS.
 * @param context - Context name (`PlatformFacts.dockerContext`).
 * @returns The runtime, if the name tells.
 */
export function runtimeOfContext(
	os: PlatformFacts["os"],
	context: string | undefined,
): RuntimeProvider | undefined {
	const name = context?.trim().toLowerCase() ?? "";
	if (name === "colima" || name.startsWith("colima-")) return "colima";
	if (name === "desktop-linux") return "docker-desktop";
	if (name === "orbstack") return "orbstack";
	if (os === "linux" && name === "default") return "docker-engine";
	return undefined;
}

/** Start preference per OS when the docker context does not name a runtime. */
const START_ORDER: Readonly<Record<"darwin" | "linux", RuntimeProvider[]>> = {
	// A desktop app over Colima: `colima start` also switches the docker
	// context, so it must never be the silent pick for a Desktop user.
	darwin: ["docker-desktop", "orbstack", "colima"],
	linux: ["docker-engine", "docker-desktop"],
};

/**
 * Installed runtimes setup can start on this OS, most preferred first: the
 * one the active docker context names, then Docker Desktop, OrbStack,
 * Colima on macOS (Docker Engine, Docker Desktop on Linux).
 *
 * @param facts - Machine facts.
 * @returns Startable runtimes (empty when none is installed).
 */
export function startableRuntimes(
	facts: Pick<PlatformFacts, "os" | "installedRuntimes" | "dockerContext">,
): RuntimeProvider[] {
	if (facts.os !== "darwin" && facts.os !== "linux") return [];
	const order = START_ORDER[facts.os];
	const fromContext = runtimeOfContext(facts.os, facts.dockerContext);
	const ranked = order.filter((r) => facts.installedRuntimes.includes(r));
	if (fromContext === undefined || !ranked.includes(fromContext)) return ranked;
	return [fromContext, ...ranked.filter((r) => r !== fromContext)];
}

/** `sudo usermod -aG docker <user>`. */
export function dockerGroupStep(facts: StepFacts): CommandStep {
	return {
		id: SETUP_STEP.groupAdd,
		title: `Adding ${facts.username} to the docker group`,
		...withSudo(facts, ["usermod", "-aG", "docker", facts.username]),
		note: "Takes effect after you log out and back in (or run `newgrp docker`).",
	};
}

/** Post note telling the user to put a freshly installed Homebrew on PATH (none for /usr/local). */
export function brewShellenvNote(facts: StepFacts): string | undefined {
	const prefix = brewPrefixOf(facts);
	if (prefix === "/usr/local") return undefined;
	const profile = shellProfile(facts);
	return `Add Homebrew to your PATH: echo 'eval "$(${prefix}/bin/brew shellenv)"' >> ${profile}, then open a new terminal.`;
}
