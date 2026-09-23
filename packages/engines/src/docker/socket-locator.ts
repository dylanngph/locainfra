import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SocketLocator } from "@locainfra/core";
import {
	BunCommandRunner,
	type CommandRunner,
	runToCompletion,
} from "../process/command-runner";

/** Dependencies of {@link DockerSocketLocator}; every field is optional and defaults to the real process. */
export interface DockerSocketLocatorOptions {
	/** Environment to read `DOCKER_HOST` from (default `process.env`). */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** `process.platform` value (default the current platform). */
	readonly platform?: NodeJS.Platform;
	/** Home directory (default `os.homedir()`). */
	readonly home?: string;
	/** Runs `docker context inspect` (default `Bun.spawn`). */
	readonly runner?: CommandRunner;
	/** Checks that a socket path exists (default `fs.stat`). */
	readonly exists?: (path: string) => Promise<boolean>;
}

/**
 * Converts a Docker host URL to a unix socket path.
 *
 * @param host - `DOCKER_HOST`-style value (`unix:///path` or a bare absolute path).
 * @returns The socket path, or `null` for non-unix hosts (`tcp://`, `npipe://`, `ssh://`) or empty input.
 */
export function unixSocketPathFromHost(
	host: string | undefined,
): string | null {
	const value = host?.trim();
	if (value === undefined || value === "") return null;
	if (value.startsWith("unix://")) {
		const path = value.slice("unix://".length);
		return path === "" ? null : path;
	}
	if (value.startsWith("/")) return value;
	return null;
}

/**
 * Platform default Docker socket candidates, most specific first.
 *
 * @param platform - `process.platform` value.
 * @param home - Home directory.
 * @returns Candidate socket paths.
 */
export function defaultSocketCandidates(
	platform: NodeJS.Platform,
	home: string,
): string[] {
	if (platform === "darwin") {
		return [join(home, ".docker/run/docker.sock"), "/var/run/docker.sock"];
	}
	if (platform === "linux") {
		return ["/var/run/docker.sock", join(home, ".docker/desktop/docker.sock")];
	}
	return [];
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * {@link SocketLocator} following Docker's own precedence:
 * `DOCKER_HOST` → current `docker context` endpoint → platform default.
 *
 * `DOCKER_HOST`, when set, is authoritative: a non-unix or missing socket yields `null`
 * rather than silently talking to a different daemon.
 */
export class DockerSocketLocator implements SocketLocator {
	readonly #env: Readonly<Record<string, string | undefined>>;
	readonly #platform: NodeJS.Platform;
	readonly #home: string;
	readonly #runner: CommandRunner;
	readonly #exists: (path: string) => Promise<boolean>;

	/** @param options - Overrides for tests. */
	constructor(options: DockerSocketLocatorOptions = {}) {
		this.#env = options.env ?? process.env;
		this.#platform = options.platform ?? process.platform;
		this.#home = options.home ?? homedir();
		this.#runner = options.runner ?? new BunCommandRunner();
		this.#exists = options.exists ?? pathExists;
	}

	/** @returns The Docker socket path, or `null` when no socket exists. */
	async locate(): Promise<string | null> {
		const dockerHost = this.#env.DOCKER_HOST?.trim();
		if (dockerHost !== undefined && dockerHost !== "") {
			const path = unixSocketPathFromHost(dockerHost);
			return path !== null && (await this.#exists(path)) ? path : null;
		}
		const fromContext = unixSocketPathFromHost(await this.#contextHost());
		if (fromContext !== null && (await this.#exists(fromContext))) {
			return fromContext;
		}
		for (const candidate of defaultSocketCandidates(
			this.#platform,
			this.#home,
		)) {
			if (await this.#exists(candidate)) return candidate;
		}
		return null;
	}

	async #contextHost(): Promise<string | undefined> {
		try {
			const out = await runToCompletion(this.#runner, [
				"docker",
				"context",
				"inspect",
				"--format",
				"{{.Endpoints.docker.Host}}",
			]);
			return out.exitCode === 0 ? out.stdout.trim() : undefined;
		} catch {
			return undefined;
		}
	}
}
