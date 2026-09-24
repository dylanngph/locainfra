import { mkdir } from "node:fs/promises";
import { delimiter, dirname } from "node:path";
import {
	type CommandStep,
	type ProcessRunner,
	type ProcessRunOptions,
	type ProcessRunResult,
	SETUP_STEP_TIMEOUT_MS,
} from "@locastack/core";

/** Captured output kept by {@link BunProcessRunner}: the last 64 KiB. */
export const PROCESS_OUTPUT_MAX_BYTES = 64 * 1024;

/** Time between SIGTERM and SIGKILL when a step is aborted or times out. */
export const PROCESS_KILL_GRACE_MS = 5_000;

/** How long captured pipes may stay open after the child exited (a daemon it forked may hold them). */
const PIPE_DRAIN_GRACE_MS = 500;

/** Options of {@link BunProcessRunner}. */
export interface BunProcessRunnerOptions {
	/**
	 * Base environment the step's `env` is merged over (default `process.env`).
	 * {@link BunProcessRunner.prependPath} edits its `PATH` in place, so with
	 * the default every other spawn and `which` of this process sees it too.
	 */
	readonly env?: Record<string, string | undefined>;
	/** SIGTERM → SIGKILL delay (default {@link PROCESS_KILL_GRACE_MS}). */
	readonly killGraceMs?: number;
	/** Deadline of captured steps without one (default `SETUP_STEP_TIMEOUT_MS`). */
	readonly capturedTimeoutMs?: number;
	/**
	 * Where an attached `tee` step's output is echoed (default this process's
	 * stdout and stderr).
	 */
	readonly echo?: TeeEcho;
}

/** Terminal writers an attached `tee` step's output is echoed to. */
export interface TeeEcho {
	/** Receives the child's stdout chunks. */
	readonly stdout: (chunk: Uint8Array) => void;
	/** Receives the child's stderr chunks. */
	readonly stderr: (chunk: Uint8Array) => void;
}

const PROCESS_ECHO: TeeEcho = {
	stdout: (chunk) => {
		process.stdout.write(chunk);
	},
	stderr: (chunk) => {
		process.stderr.write(chunk);
	},
};

/** Keeps the tail of interleaved output, at most {@link PROCESS_OUTPUT_MAX_BYTES} UTF-8 bytes. */
class OutputTail {
	#text = "";

	push(chunk: string): void {
		this.#text += chunk;
		if (this.#text.length > PROCESS_OUTPUT_MAX_BYTES * 2) {
			this.#text = this.#text.slice(-PROCESS_OUTPUT_MAX_BYTES);
		}
	}

	toString(): string {
		const bytes = new TextEncoder().encode(this.#text);
		if (bytes.length <= PROCESS_OUTPUT_MAX_BYTES) return this.#text;
		return new TextDecoder()
			.decode(bytes.subarray(bytes.length - PROCESS_OUTPUT_MAX_BYTES))
			.replace(/^�+/, "");
	}
}

/** Reads a pipe into `tail` (and `echo`, when teeing) until EOF or cancel. */
function pump(
	stream: ReadableStream<Uint8Array>,
	tail: OutputTail,
	echo?: (chunk: Uint8Array) => void,
): { done: Promise<void>; cancel: () => void } {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const done = (async () => {
		try {
			for (;;) {
				const { done: end, value } = await reader.read();
				if (end) break;
				echo?.(value);
				tail.push(decoder.decode(value, { stream: true }));
			}
		} catch {
			// Cancelled or broken pipe: keep what was read.
		}
		tail.push(decoder.decode());
	})();
	return {
		done,
		cancel: () => {
			void reader.cancel().catch(() => undefined);
		},
	};
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string"
		? error.code
		: undefined;
}

/**
 * {@link ProcessRunner} backed by `Bun.spawn`. Runs `step.argv` exactly as
 * planned and shown (never through a shell, never prefixing `sudo`: a sudo
 * step's argv already starts with it). Attached steps inherit
 * stdin/stdout/stderr so sudo password prompts and installer questions reach
 * the terminal; captured steps get no stdin and their interleaved
 * stdout+stderr tail is returned. `step.env` is merged over the environment.
 * Abort and deadline send SIGTERM, then SIGKILL after a grace period, and
 * report exit code `-1`. A missing binary reports `127`. An attached step
 * with `tee` keeps stdin on the terminal but pipes stdout and stderr, echoing
 * every chunk to the terminal as it arrives and returning the tail too, so
 * a failure can be recognised from its output. For a download step
 * (`remoteScript`), the script's folder is created first (mode 0700) so
 * `curl -o` can write into the per-run temp folder.
 */
export class BunProcessRunner implements ProcessRunner {
	readonly #env: Record<string, string | undefined>;
	readonly #killGraceMs: number;
	readonly #capturedTimeoutMs: number;
	readonly #echo: TeeEcho;

	/** @param options - Overrides for tests. */
	constructor(options: BunProcessRunnerOptions = {}) {
		this.#env = options.env ?? process.env;
		this.#killGraceMs = options.killGraceMs ?? PROCESS_KILL_GRACE_MS;
		this.#capturedTimeoutMs =
			options.capturedTimeoutMs ?? SETUP_STEP_TIMEOUT_MS;
		this.#echo = options.echo ?? PROCESS_ECHO;
	}

	/**
	 * Prepends `dirs` to the base environment's `PATH` (by default
	 * `process.env.PATH`, read live by `BunCommandRunner` and
	 * `HostPlatformProbe.which`). Directories already on it are skipped.
	 *
	 * @param dirs - Absolute directories, highest priority first.
	 */
	prependPath(dirs: readonly string[]): void {
		const current = (this.#env.PATH ?? "").split(delimiter).filter(Boolean);
		const added = dirs.filter((dir) => dir !== "" && !current.includes(dir));
		if (added.length === 0) return;
		this.#env.PATH = [...added, ...current].join(delimiter);
	}

	/**
	 * @param step - The command (argv run verbatim).
	 * @param options - Attached or captured stdio, abort signal, cwd, deadline.
	 * @returns Exit code, whether the deadline killed it, and captured output.
	 * @throws When the process cannot be spawned for a reason other than a missing binary.
	 */
	async run(
		step: CommandStep,
		options: ProcessRunOptions,
	): Promise<ProcessRunResult> {
		const { attached, signal } = options;
		// Attached steps inherit the terminal and keep no output, except `tee`
		// steps (e.g. `colima start`): their output is still shown live but also
		// piped through here, so runSetupPlan can match known failures in it.
		const tee = attached && step.tee === true;
		const captured = (output: string): ProcessRunResult["output"] =>
			attached && !tee ? undefined : output;
		if (signal?.aborted) {
			return { exitCode: -1, timedOut: false, output: captured("") };
		}
		if (step.remoteScript !== undefined) {
			await mkdir(dirname(step.remoteScript.path), {
				recursive: true,
				mode: 0o700,
			}).catch(() => undefined);
		}
		const timeoutMs =
			options.timeoutMs ??
			step.timeoutMs ??
			(attached ? undefined : this.#capturedTimeoutMs);
		const stdio = attached && !tee ? "inherit" : "pipe";
		let child: Bun.Subprocess<"inherit" | "ignore", typeof stdio, typeof stdio>;
		try {
			child = Bun.spawn([...step.argv], {
				cwd: options.cwd ?? step.cwd,
				env: { ...this.#env, ...step.env },
				stdin: attached ? "inherit" : "ignore",
				stdout: stdio,
				stderr: stdio,
			});
		} catch (error) {
			if (errorCode(error) === "ENOENT") {
				const message = error instanceof Error ? error.message : String(error);
				return {
					exitCode: 127,
					timedOut: false,
					output: captured(`${step.argv[0]}: ${message}\n`),
				};
			}
			throw error;
		}

		let killedBy: "timeout" | "abort" | undefined;
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		const kill = (reason: "timeout" | "abort"): void => {
			if (killedBy !== undefined || child.exitCode !== null) return;
			killedBy = reason;
			child.kill("SIGTERM");
			graceTimer = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) {
					child.kill("SIGKILL");
				}
			}, this.#killGraceMs);
		};
		const deadline =
			timeoutMs === undefined
				? undefined
				: setTimeout(() => kill("timeout"), timeoutMs);
		const onAbort = (): void => kill("abort");
		signal?.addEventListener("abort", onAbort, { once: true });

		const tail = new OutputTail();
		const pipes =
			child.stdout instanceof ReadableStream &&
			child.stderr instanceof ReadableStream
				? [
						pump(child.stdout, tail, tee ? this.#echo.stdout : undefined),
						pump(child.stderr, tail, tee ? this.#echo.stderr : undefined),
					]
				: [];
		try {
			const exitCode = await child.exited;
			if (pipes.length > 0) {
				let drainTimer: ReturnType<typeof setTimeout> | undefined;
				await Promise.race([
					Promise.all(pipes.map((pipe) => pipe.done)),
					new Promise<void>((resolve) => {
						drainTimer = setTimeout(resolve, PIPE_DRAIN_GRACE_MS);
					}),
				]);
				clearTimeout(drainTimer);
				for (const pipe of pipes) pipe.cancel();
			}
			return {
				exitCode: killedBy === undefined ? exitCode : -1,
				timedOut: killedBy === "timeout",
				output: captured(tail.toString()),
			};
		} finally {
			clearTimeout(deadline);
			clearTimeout(graceTimer);
			signal?.removeEventListener("abort", onAbort);
		}
	}
}
