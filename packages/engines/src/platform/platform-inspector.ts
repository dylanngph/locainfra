import {
	access,
	constants,
	realpath as fsRealpath,
	stat,
} from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import {
	INTEL_COLIMA_FORMULAE,
	NATIVE_BREW_PREFIX,
	type PlatformFacts,
	type PlatformInspector,
	type PlatformOs,
	type RuntimeProvider,
} from "@locastack/core";
import {
	defaultSocketCandidates,
	unixSocketPathFromHost,
} from "../docker/socket-locator";
import {
	BunCommandRunner,
	type CommandRunner,
	runToCompletion,
} from "../process/command-runner";

/** Deadline of one read-only probe command (`brew --prefix`, `id -nG`, `docker context inspect`). */
export const PLATFORM_PROBE_TIMEOUT_MS = 5_000;

/** Deadline of the Engine API `/_ping` used to tell which runtime answers. */
export const PLATFORM_PING_TIMEOUT_MS = 2_000;

/**
 * Answer of {@link PlatformProbe.ping}: `answers` (2xx), `denied` (the socket
 * exists but this user may not connect: EACCES, e.g. Linux without the
 * `docker` group; the daemon, or its socket activation, is there) or `down`.
 */
export type SocketPing = "answers" | "denied" | "down";

/** Output of one {@link PlatformProbe.exec}. */
export interface ProbeOutput {
	/** Exit code. */
	readonly exitCode: number;
	/** Entire stdout, UTF-8 decoded. */
	readonly stdout: string;
}

/**
 * The read-only machine access {@link HostPlatformInspector} needs. Every
 * method must resolve (never reject) and must not change anything; injectable
 * so tests can record exactly what is probed.
 */
export interface PlatformProbe {
	/**
	 * @param name - Executable name.
	 * @returns Its absolute path on `PATH`, or `undefined`.
	 */
	which(name: string): Promise<string | undefined>;
	/**
	 * @param path - Absolute file or directory path.
	 * @returns Whether it exists.
	 */
	exists(path: string): Promise<boolean>;
	/**
	 * @param path - Absolute path.
	 * @returns The symlink-resolved path, or `undefined` when it does not exist.
	 */
	realpath(path: string): Promise<string | undefined>;
	/**
	 * Runs a short read-only command (no shell) with a deadline.
	 *
	 * @param argv - Executable and arguments.
	 * @returns Exit code and stdout, or `undefined` when it cannot start or times out.
	 */
	exec(argv: readonly string[]): Promise<ProbeOutput | undefined>;
	/**
	 * @param socketPath - Docker unix socket.
	 * @returns `answers` when `GET /_ping` answers 2xx, `denied` when the
	 *   connection is refused with EACCES, else `down`.
	 */
	ping(socketPath: string): Promise<SocketPing>;
}

/** Options of {@link HostPlatformProbe}. */
export interface HostPlatformProbeOptions {
	/** Spawns probe commands (default `Bun.spawn`). */
	readonly runner?: CommandRunner;
	/** `PATH` used by {@link PlatformProbe.which} (default `process.env.PATH`, read on every call). */
	readonly path?: string;
	/** Probe command deadline (default {@link PLATFORM_PROBE_TIMEOUT_MS}). */
	readonly execTimeoutMs?: number;
	/** `/_ping` deadline (default {@link PLATFORM_PING_TIMEOUT_MS}). */
	readonly pingTimeoutMs?: number;
}

/** {@link PlatformProbe} on the real machine: `Bun.which`, `fs.stat`, `Bun.spawn` and Bun's unix-socket `fetch`. */
export class HostPlatformProbe implements PlatformProbe {
	readonly #runner: CommandRunner;
	readonly #path: string | undefined;
	readonly #execTimeoutMs: number;
	readonly #pingTimeoutMs: number;

	/** @param options - Overrides for tests. */
	constructor(options: HostPlatformProbeOptions = {}) {
		this.#runner = options.runner ?? new BunCommandRunner();
		this.#path = options.path;
		this.#execTimeoutMs = options.execTimeoutMs ?? PLATFORM_PROBE_TIMEOUT_MS;
		this.#pingTimeoutMs = options.pingTimeoutMs ?? PLATFORM_PING_TIMEOUT_MS;
	}

	/** @inheritdoc */
	async which(name: string): Promise<string | undefined> {
		// Bun.which without `PATH` uses the PATH the process started with; read
		// it live so a PATH prepended after a fresh Homebrew install counts.
		const PATH = this.#path ?? process.env.PATH ?? "";
		return Bun.which(name, { PATH }) ?? undefined;
	}

	/** @inheritdoc */
	async exists(path: string): Promise<boolean> {
		try {
			await stat(path);
			return true;
		} catch {
			return false;
		}
	}

	/** @inheritdoc */
	async realpath(path: string): Promise<string | undefined> {
		try {
			return await fsRealpath(path);
		} catch {
			return undefined;
		}
	}

	/** @inheritdoc */
	async exec(argv: readonly string[]): Promise<ProbeOutput | undefined> {
		const signal = AbortSignal.timeout(this.#execTimeoutMs);
		try {
			const out = await runToCompletion(this.#runner, argv, { signal });
			if (signal.aborted) return undefined;
			return { exitCode: out.exitCode, stdout: out.stdout };
		} catch {
			return undefined;
		}
	}

	/** @inheritdoc */
	async ping(socketPath: string): Promise<SocketPing> {
		try {
			const response = await fetch("http://localhost/_ping", {
				unix: socketPath,
				signal: AbortSignal.timeout(this.#pingTimeoutMs),
			});
			await response.body?.cancel();
			return response.ok ? "answers" : "down";
		} catch (error) {
			if (isPermissionDenied(error)) return "denied";
			// Connecting to a unix socket needs read+write on it; Bun's fetch
			// error does not always carry the errno, so check it directly.
			try {
				await access(socketPath, constants.R_OK | constants.W_OK);
				return "down";
			} catch (accessError) {
				return isPermissionDenied(accessError) ? "denied" : "down";
			}
		}
	}
}

function isPermissionDenied(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const code = "code" in error ? String(error.code) : "";
	const message = error instanceof Error ? error.message : "";
	return (
		code === "EACCES" ||
		code === "EPERM" ||
		/EACCES|permission denied/i.test(message)
	);
}

/** Options of {@link HostPlatformInspector}; every field defaults to the current process. */
export interface HostPlatformInspectorOptions {
	/** Machine access (default {@link HostPlatformProbe}). */
	readonly probe?: PlatformProbe;
	/** `process.platform` value. */
	readonly platform?: NodeJS.Platform;
	/** `process.arch` value. */
	readonly arch?: string;
	/** Environment (`SHELL`, `DOCKER_HOST`, `USER`). */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** Home directory (default `os.homedir()`). */
	readonly homeDir?: string;
	/** User name (default `os.userInfo().username`, then `$USER`). */
	readonly username?: string;
	/** Effective uid (default `process.getuid()`; `-1` where unsupported). */
	readonly uid?: number;
	/** Parent of the per-run `tmpDir` (default `os.tmpdir()`). */
	readonly tmpRoot?: string;
	/** Suffix generator for `tmpDir` (default 12 random hex chars). */
	readonly randomId?: () => string;
}

/**
 * Folds `process.platform` into {@link PlatformOs}.
 *
 * @param platform - `process.platform` value.
 * @returns `darwin`, `linux`, `win32` or `other`.
 */
export function toPlatformOs(platform: NodeJS.Platform): PlatformOs {
	if (platform === "darwin" || platform === "linux" || platform === "win32") {
		return platform;
	}
	return "other";
}

/**
 * Tells which runtime serves a Docker endpoint from the docker context name
 * and the socket path(s).
 *
 * @param os - Host OS.
 * @param contextName - Active docker context (`undefined` when `DOCKER_HOST` overrides it or the CLI is missing).
 * @param socketPaths - The endpoint socket and its symlink-resolved target.
 * @returns A {@link RuntimeProvider}, a free-form name (`rancher-desktop`,
 *   `podman`, or a custom context name), or `unknown`.
 */
export function classifyRuntime(
	os: PlatformOs,
	contextName: string | undefined,
	socketPaths: readonly string[],
): string {
	const name = contextName?.trim().toLowerCase() ?? "";
	const has = (fragment: string): boolean =>
		socketPaths.some((path) => path.includes(fragment));
	if (name === "colima" || name.startsWith("colima-") || has("/.colima/")) {
		return "colima";
	}
	if (name === "orbstack" || has("/.orbstack/") || has("/OrbStack/")) {
		return "orbstack";
	}
	if (
		name === "desktop-linux" ||
		has("/.docker/run/docker.sock") ||
		has("/.docker/desktop/")
	) {
		return "docker-desktop";
	}
	if (name === "rancher-desktop" || has("/.rd/")) return "rancher-desktop";
	if (name.includes("podman") || has("podman")) return "podman";
	if (
		os === "linux" &&
		socketPaths.some(
			(path) => path === "/var/run/docker.sock" || path === "/run/docker.sock",
		)
	) {
		return "docker-engine";
	}
	if (name !== "" && name !== "default") return name;
	return "unknown";
}

/**
 * Parses `id -nG` output.
 *
 * @param output - Space-separated group names.
 * @returns Whether `docker` is among them.
 */
export function hasDockerGroup(output: string): boolean {
	return output.split(/\s+/).includes("docker");
}

function brewCandidates(os: PlatformOs, home: string): string[] {
	if (os === "darwin") return ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];
	if (os === "linux") {
		return [
			"/home/linuxbrew/.linuxbrew/bin/brew",
			join(home, ".linuxbrew/bin/brew"),
		];
	}
	return [];
}

/** What {@link HostPlatformInspector} learns about Homebrew. */
interface BrewFacts {
	readonly prefix: string;
	readonly onPath: boolean;
	/** Only on macOS. */
	readonly native?: boolean;
	readonly nativeBrewPrefix?: string;
	readonly intelBrewFormulae?: string[];
}

/**
 * Parses `file -b <path>` output.
 *
 * @param output - e.g. `Mach-O 64-bit executable x86_64`.
 * @returns Whether it describes an Intel-only Mach-O binary (no arm64 slice).
 */
export function isIntelOnlyBinary(output: string): boolean {
	return /x86_64/.test(output) && !/arm64/.test(output);
}

const SYSTEMD_UNIT_FILES = [
	"/lib/systemd/system/docker.service",
	"/usr/lib/systemd/system/docker.service",
	"/etc/systemd/system/docker.service",
];

const DOCKERD_BINARIES = ["/usr/bin/dockerd", "/usr/local/bin/dockerd"];

function defaultUsername(env: Readonly<Record<string, string | undefined>>) {
	try {
		return userInfo().username;
	} catch {
		return env.USER ?? env.LOGNAME ?? "";
	}
}

function randomHex(): string {
	return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

/**
 * {@link PlatformInspector} for the host: OS/arch, Homebrew (`brew` on PATH
 * or its default prefix, then `brew --prefix`), systemd (`/run/systemd/system`),
 * the `docker` binary, installed runtimes (Colima binary, `Docker.app`,
 * `OrbStack.app`, `/opt/docker-desktop`, a `docker.service` unit or `dockerd`),
 * the runtime answering on the active docker context's socket (`/_ping`; a
 * socket refusing this user with EACCES counts as running), the context name,
 * `DOCKER_HOST`, whether `brew` is on PATH, and on Linux the `docker` group
 * (`id -nG`: the groups of this login session).
 * Read only; never rejects.
 */
export class HostPlatformInspector implements PlatformInspector {
	readonly #probe: PlatformProbe;
	readonly #os: PlatformOs;
	readonly #arch: string;
	readonly #env: Readonly<Record<string, string | undefined>>;
	readonly #homeDir: string;
	readonly #username: string;
	readonly #uid: number;
	readonly #tmpRoot: string;
	readonly #randomId: () => string;

	/** @param options - Overrides for tests. */
	constructor(options: HostPlatformInspectorOptions = {}) {
		this.#probe = options.probe ?? new HostPlatformProbe();
		this.#os = toPlatformOs(options.platform ?? process.platform);
		this.#arch = options.arch ?? process.arch;
		this.#env = options.env ?? process.env;
		this.#homeDir = options.homeDir ?? homedir();
		this.#username = options.username ?? defaultUsername(this.#env);
		this.#uid = options.uid ?? process.getuid?.() ?? -1;
		this.#tmpRoot = options.tmpRoot ?? tmpdir();
		this.#randomId = options.randomId ?? randomHex;
	}

	/** @returns Fresh facts; a failed probe reads as absent/`false`. */
	async inspect(): Promise<PlatformFacts> {
		const os = this.#os;
		const isRoot = this.#uid === 0;
		const base = {
			os,
			arch: this.#arch,
			shell: this.#env.SHELL ?? "",
			homeDir: this.#homeDir,
			username: this.#username,
			tmpDir: join(this.#tmpRoot, `locastack-setup-${this.#randomId()}`),
			isRoot,
		};
		if (os !== "darwin" && os !== "linux") {
			return {
				...base,
				hasBrew: false,
				hasSystemd: false,
				installedRuntimes: [],
			};
		}
		const [brew, dockerCliPath, hasSystemd, inDockerGroup] = await Promise.all([
			this.#brew(),
			this.#safe(() => this.#probe.which("docker"), undefined),
			os === "linux"
				? this.#safe(() => this.#probe.exists("/run/systemd/system"), false)
				: Promise.resolve(false),
			os === "linux" ? this.#inDockerGroup(isRoot) : Promise.resolve(),
		]);
		const brewPrefix = brew?.prefix;
		const dockerHost = this.#env.DOCKER_HOST?.trim() ?? "";
		const [installedRuntimes, endpoint] = await Promise.all([
			this.#installedRuntimes(brewPrefix),
			this.#endpoint(os, dockerCliPath, dockerHost),
		]);
		const { runningRuntime, dockerContext } = endpoint;
		return {
			...base,
			hasBrew: brewPrefix !== undefined,
			...(brew === undefined ? {} : { brewOnPath: brew.onPath }),
			...(brew?.native === undefined ? {} : { brewNative: brew.native }),
			...(brew?.nativeBrewPrefix === undefined
				? {}
				: { nativeBrewPrefix: brew.nativeBrewPrefix }),
			...(brew?.intelBrewFormulae === undefined
				? {}
				: { intelBrewFormulae: brew.intelBrewFormulae }),
			...(dockerContext === undefined ? {} : { dockerContext }),
			...(dockerHost === "" ? {} : { dockerHost }),
			hasSystemd,
			installedRuntimes,
			...(runningRuntime === undefined ? {} : { runningRuntime }),
			...(inDockerGroup === undefined ? {} : { inDockerGroup }),
			...(dockerCliPath === undefined ? {} : { dockerCliPath }),
			...(brewPrefix === undefined ? {} : { brewPrefix }),
		};
	}

	async #safe<T>(probe: () => Promise<T>, fallback: T): Promise<T> {
		try {
			return await probe();
		} catch {
			return fallback;
		}
	}

	async #firstExisting(paths: readonly string[]): Promise<string | undefined> {
		for (const path of paths) {
			if (await this.#safe(() => this.#probe.exists(path), false)) return path;
		}
		return undefined;
	}

	async #exec(argv: readonly string[]): Promise<ProbeOutput | undefined> {
		return this.#safe(() => this.#probe.exec(argv), undefined);
	}

	/**
	 * Homebrew's prefix, whether `brew` is on PATH and, on macOS, whether it
	 * is built for this CPU (`undefined`: no Homebrew). On Apple silicon it
	 * also looks for a native Homebrew at /opt/homebrew and, when the one
	 * found is the Intel build, for the Colima formulae it installed.
	 */
	async #brew(): Promise<BrewFacts | undefined> {
		const onPath = await this.#safe(() => this.#probe.which("brew"), undefined);
		const brew =
			onPath ??
			(await this.#firstExisting(brewCandidates(this.#os, this.#homeDir)));
		if (brew === undefined) return undefined;
		const out = await this.#exec([brew, "--prefix"]);
		const printed = out?.exitCode === 0 ? out.stdout.trim() : "";
		const prefix = printed.startsWith("/") ? printed : dirname(dirname(brew));
		const found = { prefix, onPath: onPath !== undefined };
		if (this.#os !== "darwin") return found;
		if (this.#arch !== "arm64") return { ...found, native: true };
		const native = !(await this.#intelBrew(prefix, brew));
		const nativeBrewPrefix = (await this.#firstExisting([
			`${NATIVE_BREW_PREFIX}/bin/brew`,
		]))
			? NATIVE_BREW_PREFIX
			: undefined;
		const intelBrewFormulae = native
			? undefined
			: await this.#installedFormulae(prefix, INTEL_COLIMA_FORMULAE);
		return {
			...found,
			native,
			...(nativeBrewPrefix === undefined ? {} : { nativeBrewPrefix }),
			...(intelBrewFormulae === undefined ? {} : { intelBrewFormulae }),
		};
	}

	/**
	 * On Apple silicon: Homebrew at /usr/local is the Intel build (it installs
	 * there only under Rosetta). `bin/brew` is a shell script, so for any
	 * other prefix `file` only tells when it is an x86_64-only binary.
	 */
	async #intelBrew(prefix: string, brew: string): Promise<boolean> {
		if (prefix === "/usr/local") return true;
		if (prefix === NATIVE_BREW_PREFIX) return false;
		const out = await this.#exec(["file", "-b", brew]);
		return out?.exitCode === 0 && isIntelOnlyBinary(out.stdout);
	}

	/** The `names` with a keg in `<prefix>/Cellar` (in `names` order). */
	async #installedFormulae(
		prefix: string,
		names: readonly string[],
	): Promise<string[]> {
		const found = await Promise.all(
			names.map((name) =>
				this.#safe(
					() => this.#probe.exists(join(prefix, "Cellar", name)),
					false,
				),
			),
		);
		return names.filter((_, index) => found[index] === true);
	}

	async #inDockerGroup(isRoot: boolean): Promise<boolean> {
		if (isRoot) return true;
		const out = await this.#exec(["id", "-nG"]);
		return out?.exitCode === 0 && hasDockerGroup(out.stdout);
	}

	async #installedRuntimes(
		brewPrefix: string | undefined,
	): Promise<RuntimeProvider[]> {
		const home = this.#homeDir;
		const colima = async (): Promise<boolean> =>
			(await this.#safe(() => this.#probe.which("colima"), undefined)) !==
				undefined ||
			(brewPrefix !== undefined &&
				(await this.#firstExisting([join(brewPrefix, "bin/colima")])) !==
					undefined);
		const app = async (name: string): Promise<boolean> =>
			(await this.#firstExisting([
				`/Applications/${name}`,
				join(home, "Applications", name),
			])) !== undefined;
		const checks: [RuntimeProvider, () => Promise<boolean>][] =
			this.#os === "darwin"
				? [
						["colima", colima],
						["docker-desktop", () => app("Docker.app")],
						["orbstack", () => app("OrbStack.app")],
					]
				: [
						["colima", colima],
						[
							"docker-desktop",
							async () =>
								(await this.#firstExisting(["/opt/docker-desktop"])) !==
								undefined,
						],
						[
							"docker-engine",
							async () =>
								(await this.#firstExisting([
									...SYSTEMD_UNIT_FILES,
									...DOCKERD_BINARIES,
								])) !== undefined ||
								(await this.#safe(
									() => this.#probe.which("dockerd"),
									undefined,
								)) !== undefined,
						],
					];
		const found = await Promise.all(checks.map(([, check]) => check()));
		return checks
			.filter((_, index) => found[index] === true)
			.map(([provider]) => provider);
	}

	/**
	 * The active docker context's name (read even when the daemon is down) and
	 * the runtime answering on the endpoint. A socket refusing this user
	 * (EACCES) counts as running: its daemon (or socket activation) is there.
	 */
	async #endpoint(
		os: "darwin" | "linux",
		dockerCliPath: string | undefined,
		dockerHost: string,
	): Promise<{ runningRuntime?: string; dockerContext?: string }> {
		let contextName: string | undefined;
		let socket: string | null = null;
		if (dockerHost !== "") {
			socket = unixSocketPathFromHost(dockerHost);
			if (socket === null) return {};
		} else {
			if (dockerCliPath !== undefined) {
				const out = await this.#exec([
					dockerCliPath,
					"context",
					"inspect",
					"--format",
					"{{.Name}} {{.Endpoints.docker.Host}}",
				]);
				if (out?.exitCode === 0) {
					const line = out.stdout.trim();
					const space = line.indexOf(" ");
					const name = space === -1 ? line : line.slice(0, space);
					contextName = name === "" ? undefined : name;
					const fromContext = unixSocketPathFromHost(
						space === -1 ? "" : line.slice(space + 1),
					);
					if (
						fromContext !== null &&
						(await this.#firstExisting([fromContext])) !== undefined
					) {
						socket = fromContext;
					}
				}
			}
			socket ??=
				(await this.#firstExisting(
					defaultSocketCandidates(os, this.#homeDir),
				)) ?? null;
		}
		const context =
			contextName === undefined ? {} : { dockerContext: contextName };
		if (socket === null) return context;
		const path = socket;
		const ping = await this.#safe<SocketPing>(
			() => this.#probe.ping(path),
			"down",
		);
		if (ping === "down") return context;
		const resolved = await this.#safe(
			() => this.#probe.realpath(path),
			undefined,
		);
		const paths = resolved === undefined ? [path] : [path, resolved];
		return {
			...context,
			runningRuntime: classifyRuntime(os, contextName, paths),
		};
	}
}
