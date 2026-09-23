import type { Writable } from "node:stream";
import type {
	DiscoverStack,
	DiscoverStackDeps,
	DownStack,
	DownStackDeps,
	EnvForStack,
	EnvForStackDeps,
	RunDoctor,
	RunDoctorDeps,
	UpStack,
	UpStackDeps,
} from "@locainfra/core";

/** Process exit codes used by every command. */
export const ExitCode = {
	/** Success. */
	Ok: 0,
	/** An operation failed (Docker down, stack invalid, compose error, user abort). */
	OpError: 1,
	/** Bad flags or arguments, or a destructive action without `--yes` when non-interactive. */
	Usage: 2,
} as const;

/** One of the {@link ExitCode} values. */
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** The core operations the CLI calls. Swappable in tests. */
export interface CliOps {
	/** Diagnoses Docker, compose and the socket. */
	readonly runDoctor: RunDoctor;
	/** Starts a stack. */
	readonly upStack: UpStack;
	/** Stops a stack. */
	readonly downStack: DownStack;
	/** Prints a stack's connection variables. */
	readonly envForStack: EnvForStack;
	/** Finds the stack for the current directory, or the global one. */
	readonly discoverStack: DiscoverStack;
}

/**
 * Everything the commands need: the ops plus the port bundles each op takes.
 * Built by `composeDeps()` in `composition.ts`; tests build it from fakes.
 */
export interface CliDeps {
	/** Operation implementations. */
	readonly ops: CliOps;
	/** Deps for {@link CliOps.runDoctor}. */
	readonly doctor: RunDoctorDeps;
	/** Deps for {@link CliOps.upStack}. */
	readonly up: UpStackDeps;
	/** Deps for {@link CliOps.downStack}. */
	readonly down: DownStackDeps;
	/** Deps for {@link CliOps.envForStack}. */
	readonly env: EnvForStackDeps;
	/** Deps for {@link CliOps.discoverStack}. */
	readonly discover: DiscoverStackDeps;
}

/**
 * Lazily builds {@link CliDeps}. Called only when a command actually runs, so
 * `--version` and `--help` never load engines.
 */
export type CliDepsLoader = () => Promise<CliDeps>;

/** Interactive prompts, injectable so tests never touch a TTY. */
export interface CliPrompter {
	/**
	 * Asks a yes/no question.
	 *
	 * @param message - Question shown to the user.
	 * @returns `true` only when the user explicitly confirmed; `false` on "no" or cancel.
	 */
	confirm(message: string): Promise<boolean>;
}

/** Process boundary of the CLI: streams, TTY detection, cwd and exit code. */
export interface CliIo {
	/** Standard output (machine-readable output goes here). */
	readonly stdout: Writable;
	/** Standard error (diagnostics, usage errors). */
	readonly stderr: Writable;
	/** Whether stdout and stdin are interactive terminals (spinners and prompts allowed). */
	readonly isTTY: boolean;
	/** Interactive prompts. */
	readonly prompter: CliPrompter;
	/** @returns The directory stack discovery starts from. */
	cwd(): string;
	/**
	 * Records the process exit code.
	 *
	 * @param code - Exit code to report when the process ends.
	 */
	setExitCode(code: ExitCode): void;
}

/** Options shared by every command (declared on the root program). */
export interface GlobalOptions {
	/** Print machine-readable JSON and suppress spinners and colors. */
	readonly json?: boolean;
}

/** What every command registration receives. */
export interface CommandContext {
	/** Process boundary. */
	readonly io: CliIo;
	/** Lazily builds the composition root. */
	readonly loadDeps: CliDepsLoader;
}
