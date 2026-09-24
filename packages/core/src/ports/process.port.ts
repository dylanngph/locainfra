import { type Static, Type } from "@sinclair/typebox";

/** A remote installer script fetched by a download step (never piped into a shell). */
export const RemoteScript = Type.Object({
	url: Type.String({
		description:
			"https URL the script is downloaded from, e.g. https://get.docker.com",
	}),
	path: Type.String({
		description: "Absolute temp file the download step writes (`curl -o`)",
	}),
	inspectHint: Type.String({
		description:
			"Command a user can run to read the script before it runs, e.g. `less /tmp/locastack-setup-x/get-docker.sh`",
	}),
});
/** A remote installer script fetched by a download step. */
export type RemoteScript = Static<typeof RemoteScript>;

/**
 * One command of a setup plan. It is shown to the user exactly as `argv`
 * (joined with shell quoting) before anything runs, and executed as that argv
 * with no shell: no `$(…)`, globbing, pipes or `~` expansion; the planner
 * resolves such values from `PlatformFacts` (`homeDir`, `brewPrefix`,
 * `username`, `tmpDir`) up front.
 */
export const CommandStep = Type.Object({
	id: Type.String({
		description:
			"Stable id within a plan, e.g. brew.install-colima, docker.start",
	}),
	title: Type.String({
		description: "Progress label, e.g. Installing Colima and the Docker CLI",
	}),
	argv: Type.Array(Type.String(), {
		minItems: 1,
		description:
			"Exact command run and shown; includes a leading `sudo` when `sudo` is true (the runner never adds anything)",
	}),
	shell: Type.Optional(
		Type.Literal(false, {
			description: "Always false: steps never run through a shell",
		}),
	),
	sudo: Type.Optional(
		Type.Boolean({
			description:
				"argv starts with `sudo`: needs a terminal (attached stdio) for the password prompt; the dashboard cannot run it",
		}),
	),
	attached: Type.Optional(
		Type.Boolean({
			description:
				"Must run with the terminal attached even without sudo (e.g. the Homebrew installer asks questions). Implied by sudo",
		}),
	),
	tee: Type.Optional(
		Type.Boolean({
			description:
				"When run attached, still capture stdout+stderr (echoed to the terminal as it arrives) into `ProcessRunResult.output`, so a failure can be recognised from its output (e.g. `colima start` under Rosetta). The child then writes to pipes, not a TTY, so never set it on a step that asks questions",
		}),
	),
	cwd: Type.Optional(
		Type.String({ description: "Absolute working directory" }),
	),
	env: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description: "Extra environment variables (merged over process.env)",
		}),
	),
	note: Type.Optional(
		Type.String({
			description:
				"Shown under the command before consent, e.g. Docker Desktop finishes setup in its own window",
		}),
	),
	remoteScript: Type.Optional(RemoteScript),
	timeoutMs: Type.Optional(
		Type.Integer({
			minimum: 1,
			description:
				"Kill the command after this long (default: no timeout for attached steps, SETUP_STEP_TIMEOUT_MS otherwise)",
		}),
	),
});
/** One command of a setup plan. */
export type CommandStep = Static<typeof CommandStep>;

/** Options of {@link ProcessRunner.run}. */
export interface ProcessRunOptions {
	/**
	 * `true`: inherit stdin/stdout/stderr (sudo password prompts and installer
	 * questions are visible). `false`: capture output into {@link ProcessRunResult.output}.
	 */
	readonly attached: boolean;
	/** Kills the process (SIGTERM, then SIGKILL after a grace period). */
	readonly signal?: AbortSignal;
	/** Working directory; overrides `step.cwd`. */
	readonly cwd?: string;
	/** Hard deadline in milliseconds; overrides `step.timeoutMs`. */
	readonly timeoutMs?: number;
}

/** Outcome of one {@link ProcessRunner.run}. */
export interface ProcessRunResult {
	/** Process exit code; `127` when the binary was not found, `-1` when killed. */
	readonly exitCode: number;
	/** Killed because the deadline passed. */
	readonly timedOut: boolean;
	/**
	 * Captured stdout+stderr (interleaved, ANSI kept, at most the last 64 KiB).
	 * Absent when attached, unless the step sets `tee`.
	 */
	readonly output?: string;
}

/**
 * Runs one {@link CommandStep} on the host as a plain argv (no shell). The
 * only port that installs software or starts daemons, so it is only ever
 * called after the user consented to the exact commands (or `--yes`).
 * Resolves for every exit code; rejects only when the process cannot be
 * spawned for a reason other than a missing binary.
 */
export interface ProcessRunner {
	/**
	 * @param step - The command.
	 * @param options - Attached or captured stdio, abort signal, cwd, deadline.
	 */
	run(step: CommandStep, options: ProcessRunOptions): Promise<ProcessRunResult>;
	/**
	 * Puts `dirs` in front of the PATH of this process, so later steps, probes
	 * (`docker context inspect`, `which docker`) and `docker compose` calls
	 * find binaries a step just installed outside the old PATH (a fresh
	 * Homebrew prefix). Directories already on PATH are skipped.
	 *
	 * @param dirs - Absolute directories, highest priority first.
	 */
	prependPath(dirs: readonly string[]): void;
}
