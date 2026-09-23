import {
	type ContainerExec,
	type ExecOptions,
	type ExecResult,
	OpError,
} from "@locainfra/core";
import { dockerApiError } from "./docker-errors";
import type { DockerHijacker } from "./hijack";
import { LogDemuxer, type LogFrame } from "./log-demuxer";
import type { DockerTransport } from "./transport";

/** Default stderr cap of {@link DockerContainerExec} (64 KiB, per the port contract). */
export const EXEC_STDERR_MAX_BYTES = 64 * 1024;

/**
 * Environment variable set on every exec to a fresh random tag, so a
 * timed-out process (and its children, which inherit the environment) can be
 * found and killed from inside the container.
 */
export const EXEC_TAG_ENV = "LOCAINFRA_EXEC_TAG";

/**
 * POSIX `sh` script that SIGKILLs every process whose environment holds
 * `LOCAINFRA_EXEC_TAG=$1`. The tag is passed as a positional argument, never
 * spliced into the script. Needs `sh` and `grep` in the image (busybox or
 * coreutils); a missing tool only makes the kill a no-op.
 */
export const EXEC_KILL_SCRIPT = [
	`n="${EXEC_TAG_ENV}=$1"`,
	// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template.
	'for d in /proc/[0-9]*; do grep -qsF -e "$n" "$d/environ" 2>/dev/null && kill -9 "${d#/proc/}" 2>/dev/null; done',
	"exit 0",
].join("\n");

/** Options for {@link DockerContainerExec}. */
export interface DockerContainerExecOptions {
	/** Upgraded connections for `stdin` (without it, an exec with stdin is `INVALID_INPUT`). */
	readonly hijacker?: DockerHijacker;
	/** stderr cap in bytes (default {@link EXEC_STDERR_MAX_BYTES}). */
	readonly stderrMaxBytes?: number;
	/** Deadline of the best-effort kill exec after a timeout (default 5000 ms). */
	readonly killTimeoutMs?: number;
	/** How long to wait for `GET /exec/{id}/json` to report the exit (default 2000 ms). */
	readonly exitWaitMs?: number;
	/** Tag source (default 18 random bytes, base64url). */
	readonly newTag?: () => string;
}

type StopReason = "timeout" | "abort" | "cap";

/** Collects demultiplexed output under byte caps without splitting UTF-8 characters. */
class OutputCollector {
	stdout = "";
	stderr = "";
	#stdoutBytes = 0;
	#stderrBytes = 0;
	truncated = false;
	readonly #maxStdout: number;
	readonly #maxStderr: number;

	constructor(maxStdout: number, maxStderr: number) {
		this.#maxStdout = Math.max(0, Math.floor(maxStdout));
		this.#maxStderr = Math.max(0, Math.floor(maxStderr));
	}

	/** @returns Whether stdout overflowed with this frame. */
	add(frame: LogFrame): boolean {
		if (frame.stream === "stderr") {
			const kept = clip(frame.text, this.#maxStderr - this.#stderrBytes);
			this.stderr += kept.text;
			this.#stderrBytes += kept.bytes;
			return false;
		}
		if (this.truncated) return true;
		const kept = clip(frame.text, this.#maxStdout - this.#stdoutBytes);
		this.stdout += kept.text;
		this.#stdoutBytes += kept.bytes;
		if (kept.text.length < frame.text.length) this.truncated = true;
		return this.truncated;
	}
}

/**
 * @param text - Decoded text.
 * @param budget - Bytes still allowed.
 * @returns The longest prefix whose UTF-8 encoding fits, and its size.
 */
function clip(text: string, budget: number): { text: string; bytes: number } {
	const size = Buffer.byteLength(text, "utf8");
	if (size <= budget) return { text, bytes: size };
	if (budget <= 0) return { text: "", bytes: 0 };
	const bytes = Buffer.from(text, "utf8");
	let end = budget;
	// Back off to a character boundary (continuation bytes are 10xxxxxx).
	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
	return { text: bytes.subarray(0, end).toString("utf8"), bytes: end };
}

function randomTag(): string {
	const bytes = new Uint8Array(18);
	crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString("base64url");
}

/**
 * {@link ContainerExec} over the Docker Engine API:
 * `POST /containers/{id}/exec` (stdout + stderr attached, no TTY, argv
 * verbatim, never a shell), `POST /exec/{id}/start` (streamed; with stdin it
 * goes through a {@link DockerHijacker}), the multiplexed output demuxed with
 * {@link LogDemuxer}, then `GET /exec/{id}/json` for the exit code.
 *
 * Limits: `timeoutMs` (and the caller's signal) abort the stream; stdout past
 * `maxBytes` is dropped and ends the run early. In both cases the process is
 * killed best-effort with a second exec running {@link EXEC_KILL_SCRIPT}
 * (the Engine API has no exec kill), and `exitCode` is `-1`.
 */
export class DockerContainerExec implements ContainerExec {
	readonly #transport: DockerTransport;
	readonly #hijacker: DockerHijacker | undefined;
	readonly #stderrMax: number;
	readonly #killTimeoutMs: number;
	readonly #exitWaitMs: number;
	readonly #newTag: () => string;

	/**
	 * @param transport - Engine API transport.
	 * @param options - Hijacker (stdin), caps and timings.
	 */
	constructor(
		transport: DockerTransport,
		options: DockerContainerExecOptions = {},
	) {
		this.#transport = transport;
		this.#hijacker = options.hijacker;
		this.#stderrMax = options.stderrMaxBytes ?? EXEC_STDERR_MAX_BYTES;
		this.#killTimeoutMs = options.killTimeoutMs ?? 5000;
		this.#exitWaitMs = options.exitWaitMs ?? 2000;
		this.#newTag = options.newTag ?? randomTag;
	}

	/**
	 * @param containerId - Container id or name.
	 * @param argv - Command and arguments (no shell).
	 * @param options - Deadline, stdout cap, stdin and signal.
	 * @returns Exit code and captured output (`-1` when killed).
	 * @throws {OpError} `SERVICE_NOT_FOUND` (no such container),
	 *   `SERVICE_NOT_RUNNING` (stopped or paused), `DOCKER_UNREACHABLE`,
	 *   `INVALID_INPUT` (empty argv, or stdin without a hijacker).
	 */
	async run(
		containerId: string,
		argv: readonly string[],
		options: ExecOptions,
	): Promise<ExecResult> {
		if (argv.length === 0) {
			throw new OpError("INVALID_INPUT", "The exec command is empty");
		}
		if (options.stdin !== undefined && this.#hijacker === undefined) {
			throw new OpError(
				"INVALID_INPUT",
				"This Docker transport cannot send stdin to an exec",
			);
		}
		const controller = new AbortController();
		let reason: StopReason | undefined;
		const stop = (why: StopReason): void => {
			reason ??= why;
			controller.abort();
		};
		const onAbort = (): void => stop("abort");
		const timer = setTimeout(
			() => stop("timeout"),
			Math.max(0, options.timeoutMs),
		);
		if (options.signal?.aborted) stop("abort");
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const tag = this.#newTag();
		const output = new OutputCollector(options.maxBytes, this.#stderrMax);
		let started = false;
		const killed = (): ExecResult => ({
			exitCode: -1,
			stdout: output.stdout,
			stderr: output.stderr,
			truncated: output.truncated,
			timedOut: reason === "timeout" || reason === "abort",
		});
		try {
			if (reason !== undefined) return killed();
			let execId: string;
			try {
				execId = await this.#create(
					containerId,
					argv,
					tag,
					options.stdin !== undefined,
					controller.signal,
				);
			} catch (error) {
				if (reason !== undefined && !isTypedFailure(error)) return killed();
				throw error;
			}
			started = true;
			try {
				const chunks = await this.#start(
					execId,
					containerId,
					options.stdin,
					controller.signal,
				);
				const demuxer = new LogDemuxer();
				for await (const chunk of chunks) {
					if (collect(output, demuxer.push(chunk))) {
						stop("cap");
						break;
					}
					if (reason !== undefined) break;
				}
				if (reason === undefined) collect(output, demuxer.end());
			} catch (error) {
				if (reason === undefined || isTypedFailure(error)) {
					if (error instanceof OpError) throw error;
					throw new OpError("UNKNOWN", "The exec output stream failed", {
						cause: error,
					});
				}
			}
			if (reason !== undefined) return killed();
			return {
				exitCode: await this.#exitCode(execId),
				stdout: output.stdout,
				stderr: output.stderr,
				truncated: output.truncated,
				timedOut: false,
			};
		} finally {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			controller.abort();
			if (reason !== undefined && started) await this.#kill(containerId, tag);
		}
	}

	async #create(
		containerId: string,
		argv: readonly string[],
		tag: string | undefined,
		stdin: boolean,
		signal: AbortSignal,
	): Promise<string> {
		const path = `/containers/${encodeURIComponent(containerId)}/exec`;
		const response = await this.#transport.request(path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				AttachStdin: stdin,
				AttachStdout: true,
				AttachStderr: true,
				Tty: false,
				Cmd: [...argv],
				...(tag === undefined ? {} : { Env: [`${EXEC_TAG_ENV}=${tag}`] }),
			}),
			signal,
		});
		if (!response.ok) {
			throw await execApiError(response, path, containerId);
		}
		const body: unknown = await response.json().catch(() => undefined);
		const id =
			typeof body === "object" &&
			body !== null &&
			"Id" in body &&
			typeof body.Id === "string"
				? body.Id
				: undefined;
		if (id === undefined) {
			throw new OpError("UNKNOWN", "Docker did not return an exec id");
		}
		return id;
	}

	async #start(
		execId: string,
		containerId: string,
		stdin: string | undefined,
		signal: AbortSignal,
	): Promise<AsyncIterable<Uint8Array>> {
		const path = `/exec/${encodeURIComponent(execId)}/start`;
		const body = JSON.stringify({ Detach: false, Tty: false });
		if (stdin !== undefined && this.#hijacker !== undefined) {
			try {
				const stream = await this.#hijacker.open({
					path,
					body,
					stdin: new TextEncoder().encode(stdin),
					signal,
				});
				return stream.chunks;
			} catch (error) {
				throw remapNotRunning(error, containerId);
			}
		}
		const response = await this.#transport.request(path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
			signal,
		});
		if (!response.ok) {
			throw await execApiError(response, path, containerId);
		}
		return response.body ?? emptyStream();
	}

	/** Polls `GET /exec/{id}/json` until it stops running (bounded). */
	async #exitCode(execId: string): Promise<number> {
		const path = `/exec/${encodeURIComponent(execId)}/json`;
		const deadline = Date.now() + this.#exitWaitMs;
		for (;;) {
			const response = await this.#transport.request(path);
			if (!response.ok) throw await dockerApiError(response, path);
			const body: unknown = await response.json().catch(() => undefined);
			const running =
				typeof body === "object" &&
				body !== null &&
				"Running" in body &&
				body.Running === true;
			const code =
				typeof body === "object" &&
				body !== null &&
				"ExitCode" in body &&
				typeof body.ExitCode === "number"
					? body.ExitCode
					: null;
			if (!running && code !== null) return code;
			if (Date.now() >= deadline) return code ?? -1;
			await Bun.sleep(25);
		}
	}

	/** Best effort: failures (no `sh`, container gone, daemon down) are ignored. */
	async #kill(containerId: string, tag: string): Promise<void> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.#killTimeoutMs);
		try {
			const execId = await this.#create(
				containerId,
				["sh", "-c", EXEC_KILL_SCRIPT, "sh", tag],
				undefined,
				false,
				controller.signal,
			);
			const chunks = await this.#start(
				execId,
				containerId,
				undefined,
				controller.signal,
			);
			for await (const _ of chunks) {
				// Drain until the kill script exits.
			}
		} catch {
			// The process may already be gone; nothing else to do.
		} finally {
			clearTimeout(timer);
		}
	}
}

function collect(
	output: OutputCollector,
	frames: readonly LogFrame[],
): boolean {
	let overflow = false;
	for (const frame of frames) overflow = output.add(frame) || overflow;
	return overflow;
}

/** Typed failures (not the abort itself) propagate even after a stop. */
function isTypedFailure(error: unknown): boolean {
	return error instanceof OpError && error.details.aborted !== true;
}

async function execApiError(
	response: Response,
	path: string,
	containerId: string,
): Promise<OpError> {
	return remapNotRunning(
		await dockerApiError(response, path, containerId),
		containerId,
	);
}

/** Docker answers `409` for an exec in a stopped, paused or restarting container. */
function remapNotRunning<T>(error: T, containerId: string): T | OpError {
	if (!(error instanceof OpError) || error.details.status !== 409) return error;
	return new OpError(
		"SERVICE_NOT_RUNNING",
		`Container ${containerId} is not running`,
		{ details: { container: containerId, status: 409 }, cause: error },
	);
}

function emptyStream(): AsyncIterable<Uint8Array> {
	return (async function* () {})();
}
