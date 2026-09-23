import {
	type Clock,
	type ComposeDownInput,
	type ComposeInfoPort,
	type ComposePsInput,
	type ComposeRemoveInput,
	type ComposeServiceStatus,
	type ComposeServicesInput,
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

/** Compose subcommands that act on existing containers of named services. */
export type ServiceAction = "start" | "stop" | "restart";

/**
 * Subcommand arguments for `start` / `stop` / `restart` of named services.
 *
 * @param action - Compose subcommand.
 * @param services - Compose service keys (instance names).
 * @returns e.g. `['restart', '--', 'main-db']`.
 */
export function serviceActionArgs(
	action: ServiceAction,
	services: readonly string[],
): string[] {
	return [action, "--", ...services];
}

/**
 * Subcommand arguments for removing service containers
 * (`rm --stop --force -v`). `-v` also deletes the containers' anonymous
 * volumes: images such as postgres and redis declare `VOLUME`s, so an
 * `ephemeral` instance (no named volume) would otherwise leave its data
 * behind in a hex-named volume on every add/remove cycle. Named volumes
 * (`li-<project>-<name>-<vol>`) are never touched here; they are deleted
 * separately, and only on request.
 *
 * @param services - Compose service keys.
 * @returns e.g. `['rm', '--stop', '--force', '-v', '--', 'cache']`.
 */
export function removeArgs(services: readonly string[]): string[] {
	return ["rm", "--stop", "--force", "-v", "--", ...services];
}

/**
 * Full argv deleting Docker networks. `--force` makes missing networks a no-op.
 *
 * @param docker - Docker CLI executable.
 * @param networks - Network names.
 * @returns e.g. `['docker', 'network', 'rm', '--force', 'li-shop']`.
 */
export function networkRemoveArgv(
	docker: string,
	networks: readonly string[],
): string[] {
	return [docker, "network", "rm", "--force", ...networks];
}

/**
 * Full argv deleting named Docker volumes. `--force` makes missing volumes a no-op.
 *
 * @param docker - Docker CLI executable.
 * @param volumes - Volume names.
 * @returns e.g. `['docker', 'volume', 'rm', '--force', 'li-shop-db-data']`.
 */
export function volumeRemoveArgv(
	docker: string,
	volumes: readonly string[],
): string[] {
	return [docker, "volume", "rm", "--force", ...volumes];
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
	 * `docker compose start -- <services>` (existing containers only), streaming output.
	 *
	 * @param input - Project, file and at least one service.
	 * @returns Progress ending with exactly one `done` or `error` event
	 *   (`INVALID_INPUT` when `services` is empty, so nothing acts on the whole project by accident).
	 */
	start(input: ComposeServicesInput): AsyncIterable<Progress> {
		return this.#serviceAction(input, "start");
	}

	/**
	 * `docker compose stop -- <services>`, streaming output.
	 *
	 * @param input - Project, file and at least one service.
	 * @returns Progress ending with exactly one `done` or `error` event.
	 */
	stop(input: ComposeServicesInput): AsyncIterable<Progress> {
		return this.#serviceAction(input, "stop");
	}

	/**
	 * `docker compose restart -- <services>`, streaming output.
	 *
	 * @param input - Project, file and at least one service.
	 * @returns Progress ending with exactly one `done` or `error` event.
	 */
	restart(input: ComposeServicesInput): AsyncIterable<Progress> {
		return this.#serviceAction(input, "restart");
	}

	/**
	 * `docker compose rm --stop --force -v -- <services>`, then
	 * `docker volume rm --force <volumes>` when volumes are listed, then
	 * `docker network rm --force <networks>` when networks are listed.
	 *
	 * Network removal is best effort: the container (and volumes) are already
	 * gone, and a network can stay busy for reasons outside the project (a
	 * container attached by hand, a renamed service's leftover container). A
	 * failure there becomes a `log` event and the run still ends with `done`,
	 * so the caller can finish removing the service; the next `down` retries.
	 *
	 * @param input - Project, file, at least one service, and volumes/networks to delete.
	 * @returns Progress ending with exactly one `done` or `error` event; volumes
	 *   are only deleted after the containers were removed successfully.
	 */
	async *remove(input: ComposeRemoveInput): AsyncGenerator<Progress> {
		const invalid = this.#requireServices(input.services, "rm");
		if (invalid) {
			yield invalid;
			return;
		}
		const volumes = input.volumes ?? [];
		const networks = input.networks ?? [];
		const phases: (() => AsyncGenerator<Progress>)[] = [
			() => this.#stream(input, removeArgs(input.services), "rm"),
		];
		if (volumes.length > 0) phases.push(() => this.#removeVolumes(volumes));
		for (const [index, phase] of phases.entries()) {
			const last = index === phases.length - 1 && networks.length === 0;
			for await (const event of phase()) {
				if (event.kind === "error") {
					yield event;
					return;
				}
				if (event.kind === "done" && !last) continue;
				yield event;
			}
		}
		if (networks.length > 0) yield* this.#removeNetworks(networks);
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

	async *#removeVolumes(volumes: readonly string[]): AsyncGenerator<Progress> {
		yield this.#event("step", `Deleting ${volumes.length} volume(s)`);
		yield* this.#run(volumeRemoveArgv(this.#docker, volumes), "volume rm", {
			done: "docker compose rm finished; volumes deleted",
			command: "docker",
		});
	}

	/** Best effort: a failure is reported as a `log` event, then `done`. */
	async *#removeNetworks(
		networks: readonly string[],
	): AsyncGenerator<Progress> {
		const names = networks.join(", ");
		yield this.#event("step", `Deleting network ${names}`);
		for await (const event of this.#run(
			networkRemoveArgv(this.#docker, networks),
			"network rm",
			{
				done: "docker compose rm finished; network deleted",
				command: "docker",
			},
		)) {
			if (event.kind !== "error") {
				yield event;
				continue;
			}
			yield this.#event(
				"log",
				`Network ${names} was not deleted (${event.message}); the next \`down\` retries it`,
			);
			yield this.#event(
				"done",
				`docker compose rm finished; network ${names} kept`,
			);
		}
	}

	#serviceAction(
		input: ComposeServicesInput,
		action: ServiceAction,
	): AsyncIterable<Progress> {
		const invalid = this.#requireServices(input.services, action);
		if (invalid) return single(invalid);
		return this.#stream(
			input,
			serviceActionArgs(action, input.services),
			action,
		);
	}

	#requireServices(
		services: readonly string[],
		action: string,
	): Progress | undefined {
		if (services.length > 0) return undefined;
		const error = new OpError(
			"INVALID_INPUT",
			`docker compose ${action} needs at least one service`,
		);
		return this.#event("error", error.message, error);
	}

	#stream(
		target: ComposeTarget,
		subcommand: readonly string[],
		action: string,
	): AsyncGenerator<Progress> {
		return this.#run(
			composeArgv(this.#docker, target, subcommand, true),
			action,
		);
	}

	/**
	 * Spawns `argv`, yielding each non-empty output line as a `log` event, then
	 * exactly one `done` or classified `error` event.
	 */
	async *#run(
		argv: readonly string[],
		action: string,
		messages: { readonly done?: string; readonly command?: string } = {},
	): AsyncGenerator<Progress> {
		let child: ReturnType<CommandRunner["spawn"]>;
		try {
			child = this.#runner.spawn(argv);
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
			yield this.#event(
				"done",
				messages.done ?? `docker compose ${action} finished`,
			);
			return;
		}
		const error = classifyComposeFailure(
			retained,
			exitCode,
			action,
			messages.command,
		);
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

async function* single<T>(value: T): AsyncGenerator<T> {
	yield value;
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
