import { type Static, Type } from "@sinclair/typebox";

/** Host operating system family (`process.platform`, folded: anything else is `other`). */
export const PlatformOs = Type.Union([
	Type.Literal("darwin"),
	Type.Literal("linux"),
	Type.Literal("win32"),
	Type.Literal("other"),
]);
/** Host operating system family. */
export type PlatformOs = Static<typeof PlatformOs>;

/**
 * A Docker runtime LocaStack knows how to install or start:
 * - `colima`: Colima VM (macOS default, open source, CLI only; installed with Homebrew);
 * - `docker-desktop`: Docker Desktop (macOS cask; also detected on Linux);
 * - `orbstack`: OrbStack (macOS cask);
 * - `docker-engine`: the native Linux daemon (`dockerd`, installed by get.docker.com).
 */
export const RuntimeProvider = Type.Union([
	Type.Literal("colima"),
	Type.Literal("docker-desktop"),
	Type.Literal("orbstack"),
	Type.Literal("docker-engine"),
]);
/** A Docker runtime LocaStack knows how to install or start. */
export type RuntimeProvider = Static<typeof RuntimeProvider>;

/**
 * Public platform summary carried by `DoctorReport.platform` (no paths or
 * user names: it is served over the API and printed by `doctor --json`).
 */
export const PlatformSummary = Type.Object({
	os: PlatformOs,
	arch: Type.String({ description: "process.arch, e.g. arm64 or x64" }),
	hasBrew: Type.Boolean({
		description: "Homebrew found (`brew` on PATH or at its default prefix)",
	}),
	hasSystemd: Type.Boolean({
		description: "systemd is PID 1 (`systemctl` usable); always false on macOS",
	}),
	installedRuntimes: Type.Array(RuntimeProvider, {
		description:
			"Runtimes installed on this machine, most preferred first (Colima binary, Docker.app, OrbStack.app, dockerd). Empty when none",
	}),
	runningRuntime: Type.Optional(
		Type.String({
			description:
				"Runtime whose daemon answers right now (a RuntimeProvider, or a free-form name such as rancher-desktop for runtimes LocaStack does not manage); absent when none runs",
		}),
	),
	inDockerGroup: Type.Optional(
		Type.Boolean({
			description:
				"Linux only: the current user is in the `docker` group (or is root). Absent on other platforms",
		}),
	),
});
/** Public platform summary carried by `DoctorReport.platform`. */
export type PlatformSummary = Static<typeof PlatformSummary>;

/**
 * Everything the setup planner needs about this machine: the
 * {@link PlatformSummary} plus private, local-only facts (never served over
 * the API as is).
 */
export const PlatformFacts = Type.Composite([
	PlatformSummary,
	Type.Object({
		shell: Type.String({
			description:
				"Login shell path from $SHELL (e.g. /bin/zsh); used for post-install notes such as `brew shellenv`. Empty when unknown",
		}),
		homeDir: Type.String({ description: "Absolute home directory" }),
		username: Type.String({
			description: "Current user name (for `usermod -aG docker <user>`)",
		}),
		tmpDir: Type.String({
			description:
				"Absolute directory for downloaded installer scripts (a fresh per-run folder under os.tmpdir())",
		}),
		dockerCliPath: Type.Optional(
			Type.String({
				description:
					"Absolute path of the `docker` binary found on PATH; absent when missing (doctor check `docker.cli`)",
			}),
		),
		brewPrefix: Type.Optional(
			Type.String({
				description:
					"`brew --prefix` (e.g. /opt/homebrew); absent when Homebrew is missing. Planned steps call `<brewPrefix>/bin/brew` by absolute path",
			}),
		),
		brewNative: Type.Optional(
			Type.Boolean({
				description:
					"The Homebrew at `brewPrefix` is built for this CPU. False on Apple silicon when it is the Intel build running under Rosetta (prefix /usr/local, or an x86_64-only `bin/brew`): formulae it installs (Colima, Lima) are x86_64 and cannot start a VM. Absent when Homebrew is missing",
			}),
		),
		nativeBrewPrefix: Type.Optional(
			Type.String({
				description:
					"Apple silicon only: prefix of a native Homebrew found at its default location (/opt/homebrew), also when `brewPrefix` names an Intel one next to it. Absent when there is none",
			}),
		),
		intelBrewFormulae: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Apple silicon with an Intel Homebrew (`brewNative: false`): which of colima, lima, docker and docker-compose that Homebrew has installed (`<brewPrefix>/Cellar/<name>`), in that order. Absent otherwise",
			}),
		),
		isRoot: Type.Boolean({
			description:
				"Running as uid 0 (Linux): steps are planned without `sudo` and the docker-group check is ok",
		}),
		brewOnPath: Type.Optional(
			Type.Boolean({
				description:
					"`brew` resolves on this process's PATH. False when Homebrew was only found at its default prefix (its shellenv is not in the shell profile), so brew-installed binaries (`docker`, `colima`) are not on PATH either; absent when unknown (treated as on PATH)",
			}),
		),
		dockerContext: Type.Optional(
			Type.String({
				description:
					"Name of the active docker context (`docker context inspect`), e.g. desktop-linux, colima, orbstack, default. Read even when the daemon is down; absent when DOCKER_HOST overrides it or the CLI is missing. The planner starts the runtime it names first",
			}),
		),
		dockerHost: Type.Optional(
			Type.String({
				description:
					"DOCKER_HOST as set in the environment (trimmed); absent when unset or empty. The socket locator treats it as authoritative, so the planner never starts or installs a runtime that cannot answer on it",
			}),
		),
	}),
]);
/** Everything the setup planner needs about this machine. */
export type PlatformFacts = Static<typeof PlatformFacts>;

/**
 * Reads the machine facts the doctor and the setup planner need (OS, arch,
 * Homebrew, systemd, installed/running runtimes, docker group). Read only:
 * it may spawn short probes (`brew --prefix`, `id -Gn`, `colima status`,
 * `systemctl is-system-running`) but never changes anything. Never rejects
 * for a failed probe: the fact falls back to "absent"/`false`.
 */
export interface PlatformInspector {
	/** @returns Fresh facts (no caching across calls). */
	inspect(): Promise<PlatformFacts>;
}
