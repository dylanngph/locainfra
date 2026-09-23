import {
	type Clock,
	type ComposeDownInput,
	type ComposeInfoPort,
	type ComposePsInput,
	type ComposeServiceStatus,
	type ComposeTarget,
	type ComposeUpInput,
	type LifecycleRunner,
	OpError,
	type Progress,
	toProgressError,
} from "@locainfra/core";
import {
	BunCommandRunner,
	type CommandRunner,
	mergeAsync,
	readLines,
	runToCompletion,
} from "../process/command-runner";
import { SystemClock } from "../util/clock";
import { classifyComposeFailure } from "./compose-errors";
import { parseComposePs } from "./ps-parser";

/** Options for {@link ComposeRunner}. */
export interface ComposeRunnerOptions {
	/** Spawns processes (default `Bun.spawn`). */
	readonly runner?: CommandRunner;
	/** Docker CLI executable (default `docker`). */
	readonly dockerBinary?: string;
	/** Timestamps progress events (default system clock). */
	readonly clock?: Clock;
	/** Output lines retained for error classification (default 50). */
	readonly retainLines?: number;
}

/**
 * Builds the argument vector for a compose subcommand (no shell involved).
 *
 * @param docker - Docker CLI executable.
 * @param target - Project name and compose file.
 * @param subcommand - Subcommand and its arguments.
 * @param streaming - Adds `--ansi never --progress plain` for line-oriented output.
 * @returns The full argv.
 */
export function composeArgv(
	docker: string,
	target: ComposeTarget,
	subcommand: readonly string[],
	streaming = false,
): string[] {
	return [
		docker,
		"compose",
		...(streaming ? ["--ansi", "never", "--progress", "plain"] : []),
		"-p",
		target.projectName,
		"-f",
		target.composeFile,
		...subcommand,
	];
}

/**
 * Subcommand arguments for `up`.
 *
 * @param input - Up options.
 * @returns e.g. `['up', '-d', '--wait', '--wait-timeout', '60', '--', 'db']`.
 */
export function upArgs(input: ComposeUpInput): string[] {
	const args = ["up", "-d", "--remove-orphans"];
	if (input.wait) args.push("--wait");
	if (input.waitTimeoutSec !== undefined) {
		args.push(
			"--wait-timeout",
			String(Math.max(1, Math.floor(input.waitTimeoutSec))),
		);
	}
	if (input.services !== undefined && input.services.length > 0) {
		args.push("--", ...input.services);
	}
	return args;
}

/**
 * Subcommand arguments for `down`.
 *
 * @param input - Down options.
 * @returns e.g. `['down', '--remove-orphans', '--volumes']`.
 */
export function downArgs(input: ComposeDownInput): string[] {
	const args = ["down", "--remove-orphans"];
	if (input.volumes) args.push("--volumes");
	return args;
}

/**
 * `docker compose` adapter: implements {@link ComposeInfoPort} and {@link LifecycleRunner}.
 * The only component that mutates containers. `error` events carry the
 * classified failure (e.g. `PORT_CONFLICT`) as a serializable `ProgressError`.
 */
export class ComposeRunner implements ComposeInfoPort, LifecycleRunner {
	readonly #runner: CommandRunner;
	readonly #docker: string;
	readonly #clock: Clock;
	readonly #retainLines: number;

	/** @param options - Process runner, binary and clock overrides. */
	constructor(options: ComposeRunnerOptions = {}) {
		this.#runner = options.runner ?? new BunCommandRunner();
		this.#docker = options.dockerBinary ?? "docker";
		this.#clock = options.clock ?? new SystemClock();
		this.#retainLines = options.retainLines ?? 50;
	}

	/** @returns `docker compose version --short` without a leading `v`, or `null` when compose is unavailable. */
	async version(): Promise<string | null> {
		try {
			const out = await runToCompletion(this.#runner, [
				this.#docker,
				"compose",
				"version",
				"--short",
			]);
			const version = out.stdout.trim().replace(/^v/, "");
			return out.exitCode === 0 && version !== "" ? version : null;
		} catch {
			return null;
		}
	}

	/**
	 * `docker compose up -d --remove-orphans [--wait]`, streaming each output line as a `log` event.
	 *
	 * @param input - Project, file and options.
	 * @returns Progress ending with exactly one `done` or `error` event.
	 */
	up(input: ComposeUpInput): AsyncIterable<Progress> {
		return this.#stream(input, upArgs(input), "up");
	}

	/**
	 * `docker compose down --remove-orphans [--volumes]`, streaming output.
	 *
	 * @param input - Project, file and options.
	 * @returns Progress ending with exactly one `done` or `error` event.
	 */
	down(input: ComposeDownInput): AsyncIterable<Progress> {
		return this.#stream(input, downArgs(input), "down");
	}

	/**
	 * `docker compose ps --all --format json`.
	 *
	 * @param input - Project and file.
	 * @returns One status per container, sorted by service.
	 * @throws {OpError} Classified failure when compose exits non-zero or cannot start.
	 */
	async ps(input: ComposePsInput): Promise<ComposeServiceStatus[]> {
		let out: Awaited<ReturnType<typeof runToCompletion>>;
		try {
			out = await runToCompletion(
				this.#runner,
				composeArgv(this.#docker, input, ["ps", "--all", "--format", "json"]),
			);
		} catch (cause) {
			throw dockerMissing(cause);
		}
		if (out.exitCode !== 0) {
			throw classifyComposeFailure(
				out.stderr.split(/\r?\n/),
				out.exitCode,
				"ps",
			);
		}
		try {
			return parseComposePs(out.stdout);
		} catch (cause) {
			throw new OpError("UNKNOWN", "Could not parse docker compose ps output", {
				cause,
			});
		}
	}

	async *#stream(
		target: ComposeTarget,
		subcommand: readonly string[],
		action: string,
	): AsyncGenerator<Progress> {
		let child: ReturnType<CommandRunner["spawn"]>;
		try {
			child = this.#runner.spawn(
				composeArgv(this.#docker, target, subcommand, true),
			);
		} catch (cause) {
			const error = dockerMissing(cause);
			yield this.#event("error", error.message, error);
			return;
		}
		const retained: string[] = [];
		for await (const line of mergeAsync(
			readLines(child.stdout),
			readLines(child.stderr),
		)) {
			const text = line.trim();
			if (text === "") continue;
			retained.push(text);
			if (retained.length > this.#retainLines) retained.shift();
			yield this.#event("log", text);
		}
		const exitCode = await child.exited;
		if (exitCode === 0) {
			yield this.#event("done", `docker compose ${action} finished`);
			return;
		}
		const error = classifyComposeFailure(retained, exitCode, action);
		yield this.#event("error", error.message, error);
	}

	/**
	 * Builds a contract-compliant {@link Progress} event: a typed failure is
	 * carried in its JSON-safe {@link toProgressError} form, never as the
	 * `OpError` instance (which loses `message` and leaks `cause` when serialized).
	 */
	#event(kind: Progress["kind"], message: string, error?: OpError): Progress {
		const at = this.#clock.now().toISOString();
		return error === undefined
			? { kind, message, at }
			: { kind, message, at, error: toProgressError(error) };
	}
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
