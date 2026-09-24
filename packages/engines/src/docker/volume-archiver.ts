import { mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
	type Clock,
	OpError,
	type Progress,
	toProgressError,
	type VolumeArchiver,
} from "@locastack/core";
import {
	BunCommandRunner,
	type CommandRunner,
	mergeAsync,
	readLines,
	runToCompletion,
} from "../process/command-runner";
import { SystemClock } from "../util/clock";

/** Image of the throw-away snapshot helper (busybox `tar`, `sh`). */
export const SNAPSHOT_HELPER_IMAGE = "alpine:3.20";

/** Label set on every helper container (`<key>=snapshot`), for diagnostics and cleanup. */
export const SNAPSHOT_HELPER_LABEL = "io.locastack.helper";

/**
 * Helper script writing the archive. `$1` is the archive path inside the
 * helper, `$2` an optional `uid:gid` owner; both are positional arguments,
 * never spliced into the script. `umask 077` keeps the archive private.
 */
export const ARCHIVE_SCRIPT =
	'umask 077 && tar czf "$1" -C /from . && if [ -n "$2" ]; then chown "$2" "$1" 2>/dev/null || true; fi';

/** Staging folder inside the volume that {@link RESTORE_SCRIPT} extracts into. */
export const RESTORE_STAGING_DIR = ".locastack-restore";

/**
 * Helper script restoring the archive `$1` without ever leaving the volume
 * empty: it extracts the whole archive (numeric owners and modes preserved)
 * into {@link RESTORE_STAGING_DIR} inside the volume first, and only once
 * that succeeded deletes the old contents (dotfiles included), moves the
 * staged entries into place (same filesystem: renames) and gives the volume
 * root the archived owner and mode. A corrupt archive, or one deleted while
 * the restore runs, fails the extraction (exit 3) with the old data intact.
 */
export const RESTORE_SCRIPT = [
	`S=/from/${RESTORE_STAGING_DIR}`,
	'rm -rf "$S" && mkdir "$S" || exit 4',
	'if ! tar xzpf "$1" --numeric-owner -C "$S"; then rm -rf "$S"; exit 3; fi',
	// A staging folder left by a crashed restore may have been archived.
	`rm -rf "$S/${RESTORE_STAGING_DIR}"`,
	`find /from -mindepth 1 -maxdepth 1 ! -name ${RESTORE_STAGING_DIR} -exec rm -rf {} \\; || exit 5`,
	'find "$S" -mindepth 1 -maxdepth 1 -exec mv {} /from/ \\; || exit 5',
	'chown "$(stat -c %u:%g "$S")" /from && chmod "$(stat -c %a "$S")" /from && rmdir "$S"',
].join("; ");

/** Docker named-volume names accepted by the archiver (never a host path). */
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

/** Characters that would break a `--mount` value (CSV) or the helper's argv. */
const UNSAFE_MOUNT_PATH = /[,"\n\r\0]/;

/** Options for {@link DockerVolumeArchiver}. */
export interface DockerVolumeArchiverOptions {
	/** Spawns the docker CLI (default `Bun.spawn`). */
	readonly runner?: CommandRunner;
	/** Docker CLI executable (default `docker`). */
	readonly dockerBinary?: string;
	/** Helper image (default {@link SNAPSHOT_HELPER_IMAGE}). */
	readonly image?: string;
	/** Timestamps progress events (default system clock). */
	readonly clock?: Clock;
	/** Helper container / temp file suffix source (default random hex). */
	readonly newSuffix?: () => string;
	/**
	 * Owner (`uid:gid`) given to new archives. Default: the current user on
	 * Linux (the helper writes as root); `null` elsewhere (Docker Desktop maps
	 * bind-mount owners itself).
	 */
	readonly owner?: string | null;
}

function randomSuffix(): string {
	const bytes = new Uint8Array(6);
	crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString("hex");
}

function defaultOwner(): string | null {
	if (process.platform !== "linux") return null;
	const uid = process.getuid?.();
	const gid = process.getgid?.();
	return uid === undefined || gid === undefined ? null : `${uid}:${gid}`;
}

/**
 * Classifies a failed docker CLI call from its output.
 *
 * @param lines - Retained output lines (stderr and stdout).
 * @param exitCode - Exit code.
 * @param action - What was attempted, for the message.
 * @returns `DOCKER_UNREACHABLE` when the daemon is down, otherwise `UNKNOWN`
 *   with the last output line (truncated) in the message.
 */
export function classifyHelperFailure(
	lines: readonly string[],
	exitCode: number,
	action: string,
): OpError {
	const text = lines.join("\n");
	if (
		/Cannot connect to the Docker daemon|failed to connect to the docker API|Is the docker daemon running/i.test(
			text,
		)
	) {
		return new OpError("DOCKER_UNREACHABLE", "Docker is not running", {
			details: { exitCode },
		});
	}
	if (/bind source path does not exist/i.test(text)) {
		return new OpError(
			"IO",
			`${action} failed: Docker cannot see the snapshot folder`,
			{
				details: {
					exitCode,
					fix: "Make sure LOCASTACK_HOME is inside a folder Docker shares with its VM (Docker Desktop: Settings → Resources → File sharing), then try again.",
				},
			},
		);
	}
	// `docker run` ends a daemon error with a usage hint; the error is the line before.
	const last = lines
		.filter((l) => l.trim() !== "" && !/^Run 'docker run --help'/.test(l))
		.at(-1)
		?.slice(0, 200);
	return new OpError(
		"UNKNOWN",
		last === undefined
			? `${action} failed (exit ${exitCode})`
			: `${action} failed (exit ${exitCode}): ${last}`,
		{ details: { exitCode } },
	);
}

/**
 * {@link VolumeArchiver} using a throw-away helper container
 * (`docker run --rm`, {@link SNAPSHOT_HELPER_IMAGE}, `--network none`):
 *
 * - `archive`: the volume is mounted read-only at `/from`, the archive's
 *   folder at `/to`; the helper writes a temp file that is renamed into place
 *   only on success (a failed or aborted run leaves no partial file).
 * - `restore`: the volume is mounted read-write at `/from`, the archive's
 *   folder read-only at `/to`, and {@link RESTORE_SCRIPT} runs (extract into
 *   a staging folder first, swap only after a successful extraction).
 *
 * The helper image is pulled when missing (`docker pull` output becomes
 * `log` events). Commands are argv arrays, never shell strings built from
 * input; the volume name must be a plain Docker volume name, so a host path
 * can never be mounted. The helper is `--rm` and additionally
 * `docker rm -f`-ed after any failure or abort, so none outlives the stream.
 */
export class DockerVolumeArchiver implements VolumeArchiver {
	readonly #runner: CommandRunner;
	readonly #docker: string;
	readonly #image: string;
	readonly #clock: Clock;
	readonly #newSuffix: () => string;
	readonly #owner: string | null;

	/** @param options - Runner, binary, image, clock and owner overrides. */
	constructor(options: DockerVolumeArchiverOptions = {}) {
		this.#runner = options.runner ?? new BunCommandRunner();
		this.#docker = options.dockerBinary ?? "docker";
		this.#image = options.image ?? SNAPSHOT_HELPER_IMAGE;
		this.#clock = options.clock ?? new SystemClock();
		this.#newSuffix = options.newSuffix ?? randomSuffix;
		this.#owner = options.owner === undefined ? defaultOwner() : options.owner;
	}

	/**
	 * @param volume - Docker volume name.
	 * @param destPath - Absolute archive path (folder created, 0700).
	 * @param signal - Aborts the run.
	 * @returns Progress ending with exactly one `done` or `error` event.
	 */
	async *archive(
		volume: string,
		destPath: string,
		signal: AbortSignal,
	): AsyncGenerator<Progress> {
		const invalid = validate(volume, destPath);
		if (invalid !== undefined) {
			yield this.#error(invalid);
			return;
		}
		const exists = await this.#volumeExists(volume);
		if (exists instanceof OpError) {
			yield this.#error(exists);
			return;
		}
		if (!exists) {
			yield this.#error(
				new OpError("SERVICE_NOT_FOUND", `Volume ${volume} does not exist`, {
					details: { volume },
				}),
			);
			return;
		}
		const dir = dirname(destPath);
		try {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		} catch (cause) {
			yield this.#error(
				new OpError("IO", `Could not create ${dir}`, {
					cause,
					details: { path: dir },
				}),
			);
			return;
		}
		const suffix = this.#newSuffix();
		const temp = `.${basename(destPath)}.partial-${suffix}`;
		let success = false;
		try {
			const helper = this.#helper(
				suffix,
				[
					`type=volume,src=${volume},dst=/from,readonly`,
					`type=bind,src=${dir},dst=/to`,
				],
				["sh", "-c", ARCHIVE_SCRIPT, "sh", `/to/${temp}`, this.#owner ?? ""],
			);
			for await (const event of this.#withImage(signal, () =>
				this.#runHelper(helper, `Archiving volume ${volume}`, signal),
			)) {
				if (event.kind !== "done") {
					yield event;
					continue;
				}
				try {
					renameSync(join(dir, temp), destPath);
				} catch (cause) {
					yield this.#error(
						new OpError("IO", `Could not write ${destPath}`, {
							cause,
							details: { path: destPath },
						}),
					);
					return;
				}
				success = true;
				yield this.#event("done", `Archived volume ${volume}`);
			}
		} finally {
			if (!success) rmSync(join(dir, temp), { force: true });
		}
	}

	/**
	 * @param volume - Docker volume name (created by Docker when missing).
	 * @param srcPath - Absolute archive path.
	 * @param signal - Aborts the run.
	 * @returns Progress ending with exactly one `done` or `error` event
	 *   (`SNAPSHOT_NOT_FOUND` when the archive is missing).
	 */
	async *restore(
		volume: string,
		srcPath: string,
		signal: AbortSignal,
	): AsyncGenerator<Progress> {
		const invalid = validate(volume, srcPath);
		if (invalid !== undefined) {
			yield this.#error(invalid);
			return;
		}
		if (!isFile(srcPath)) {
			yield this.#error(
				new OpError("SNAPSHOT_NOT_FOUND", "The snapshot file is missing", {
					details: { path: srcPath },
				}),
			);
			return;
		}
		const helper = this.#helper(
			this.#newSuffix(),
			[
				`type=volume,src=${volume},dst=/from`,
				`type=bind,src=${dirname(srcPath)},dst=/to,readonly`,
			],
			["sh", "-c", RESTORE_SCRIPT, "sh", `/to/${basename(srcPath)}`],
		);
		for await (const event of this.#withImage(signal, () =>
			this.#runHelper(helper, `Restoring volume ${volume}`, signal),
		)) {
			yield event.kind === "done"
				? this.#event("done", `Restored volume ${volume}`)
				: event;
		}
	}

	/**
	 * @param path - Absolute archive path.
	 * @returns Size in bytes.
	 * @throws {OpError} `SNAPSHOT_NOT_FOUND` when missing; `IO` otherwise.
	 */
	async sizeOf(path: string): Promise<number> {
		try {
			return (await stat(path)).size;
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
				throw new OpError(
					"SNAPSHOT_NOT_FOUND",
					"The snapshot file is missing",
					{
						cause,
						details: { path },
					},
				);
			}
			throw new OpError("IO", `Could not read ${path}`, {
				cause,
				details: { path },
			});
		}
	}

	/**
	 * @param path - Absolute archive path; a missing file is not an error.
	 * @throws {OpError} `IO` when the file exists but cannot be deleted.
	 */
	async removeArchive(path: string): Promise<void> {
		try {
			await rm(path, { force: true });
		} catch (cause) {
			throw new OpError("IO", `Could not delete ${path}`, {
				cause,
				details: { path },
			});
		}
	}

	#helper(
		suffix: string,
		mounts: readonly string[],
		command: readonly string[],
	): { readonly name: string; readonly argv: readonly string[] } {
		const name = `ls-snapshot-helper-${suffix}`;
		return {
			name,
			argv: [
				this.#docker,
				"run",
				"--rm",
				"--name",
				name,
				"--label",
				`${SNAPSHOT_HELPER_LABEL}=snapshot`,
				"--network",
				"none",
				...mounts.flatMap((m) => ["--mount", m]),
				this.#image,
				...command,
			],
		};
	}

	/** `docker volume inspect`: `true`/`false`, or the failure. */
	async #volumeExists(volume: string): Promise<boolean | OpError> {
		try {
			const out = await runToCompletion(this.#runner, [
				this.#docker,
				"volume",
				"inspect",
				"--format",
				"{{.Name}}",
				volume,
			]);
			if (out.exitCode === 0) return true;
			if (/no such volume/i.test(out.stderr)) return false;
			return classifyHelperFailure(
				out.stderr.split(/\r?\n/).filter((l) => l.trim() !== ""),
				out.exitCode,
				"docker volume inspect",
			);
		} catch (cause) {
			return dockerMissing(cause);
		}
	}

	/** Pulls the helper image when missing, then runs `next`. */
	async *#withImage(
		signal: AbortSignal,
		next: () => AsyncGenerator<Progress>,
	): AsyncGenerator<Progress> {
		let present: boolean;
		try {
			const out = await runToCompletion(this.#runner, [
				this.#docker,
				"image",
				"inspect",
				"--format",
				"{{.Id}}",
				this.#image,
			]);
			present = out.exitCode === 0;
		} catch (cause) {
			yield this.#error(dockerMissing(cause));
			return;
		}
		if (!present) {
			yield this.#event("step", `Pulling ${this.#image}`);
			for await (const event of this.#stream(
				[this.#docker, "pull", this.#image],
				`docker pull ${this.#image}`,
				signal,
			)) {
				if (event.kind === "error") {
					yield event;
					return;
				}
				if (event.kind === "log") yield event;
			}
		}
		yield* next();
	}

	/** Runs the helper; removes it (`docker rm -f`) unless it exited cleanly. */
	async *#runHelper(
		helper: { readonly name: string; readonly argv: readonly string[] },
		step: string,
		signal: AbortSignal,
	): AsyncGenerator<Progress> {
		yield this.#event("log", step);
		let clean = false;
		try {
			for await (const event of this.#stream(helper.argv, step, signal)) {
				if (event.kind === "done") clean = true;
				yield event;
			}
		} finally {
			if (!clean) await this.#removeHelper(helper.name);
		}
	}

	async #removeHelper(name: string): Promise<void> {
		try {
			await runToCompletion(this.#runner, [this.#docker, "rm", "-f", name]);
		} catch {
			// The CLI is gone too; `--rm` still removes the helper when it exits.
		}
	}

	/**
	 * Spawns `argv`, yielding output lines as `log` events, then exactly one
	 * `done` or `error` event (`error` too when `signal` aborted).
	 */
	async *#stream(
		argv: readonly string[],
		action: string,
		signal: AbortSignal,
	): AsyncGenerator<Progress> {
		if (signal.aborted) {
			yield this.#error(cancelled(action));
			return;
		}
		let child: ReturnType<CommandRunner["spawn"]>;
		try {
			child = this.#runner.spawn(argv, { signal });
		} catch (cause) {
			yield this.#error(dockerMissing(cause));
			return;
		}
		const retained: string[] = [];
		try {
			for await (const line of mergeAsync(
				readLines(child.stdout),
				readLines(child.stderr),
			)) {
				const text = line.trim();
				if (text === "") continue;
				retained.push(text);
				if (retained.length > 20) retained.shift();
				yield this.#event("log", text);
			}
		} catch {
			// Streams error out when the child is killed on abort.
		}
		const exitCode = await child.exited;
		if (signal.aborted) {
			yield this.#error(cancelled(action));
			return;
		}
		if (exitCode === 0) {
			yield this.#event("done", `${action} finished`);
			return;
		}
		yield this.#error(classifyHelperFailure(retained, exitCode, action));
	}

	#error(error: OpError): Progress {
		return this.#event("error", error.message, error);
	}

	#event(kind: Progress["kind"], message: string, error?: OpError): Progress {
		const at = this.#clock.now().toISOString();
		return error === undefined
			? { kind, message, at }
			: { kind, message, at, error: toProgressError(error) };
	}
}

function validate(volume: string, path: string): OpError | undefined {
	if (!VOLUME_NAME.test(volume)) {
		return new OpError("INVALID_INPUT", "Invalid Docker volume name", {
			details: { volume },
		});
	}
	if (!isAbsolute(path) || UNSAFE_MOUNT_PATH.test(path)) {
		return new OpError(
			"INVALID_INPUT",
			"The snapshot path must be absolute and must not contain commas, quotes or line breaks",
			{ details: { path } },
		);
	}
	return undefined;
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function cancelled(action: string): OpError {
	return new OpError("UNKNOWN", `${action} was cancelled`, {
		details: { cancelled: true },
	});
}

function dockerMissing(cause: unknown): OpError {
	return new OpError(
		"COMPOSE_MISSING",
		"The docker CLI was not found on PATH",
		{
			cause,
		},
	);
}
