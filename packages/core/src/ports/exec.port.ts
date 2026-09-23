/** Options of {@link ContainerExec.run}. */
export interface ExecOptions {
	/**
	 * Hard deadline in milliseconds. When it passes the exec is killed and the
	 * result has `timedOut: true` (the promise still resolves).
	 */
	readonly timeoutMs: number;
	/**
	 * Most bytes of stdout kept. Output beyond it is discarded (the process
	 * may be killed early) and the result has `truncated: true`. stderr is
	 * capped separately at 64 KiB.
	 */
	readonly maxBytes: number;
	/** Written to the process's stdin, which is then closed (`docker exec -i`). */
	readonly stdin?: string;
	/** Aborts the exec; the promise then resolves like a timeout. */
	readonly signal?: AbortSignal;
}

/** Outcome of one {@link ContainerExec.run}. */
export interface ExecResult {
	/** Process exit code; `-1` when it was killed (timeout, abort, output cap). */
	readonly exitCode: number;
	/** Captured stdout (UTF-8), at most `maxBytes`. */
	readonly stdout: string;
	/** Captured stderr (UTF-8), capped. May hold secrets echoed by tools: never log it verbatim. */
	readonly stderr: string;
	/** Whether stdout exceeded `maxBytes` and was cut. */
	readonly truncated: boolean;
	/** Whether the deadline passed or the signal aborted before the process exited. */
	readonly timedOut: boolean;
}

/**
 * Runs a command inside a running container (`docker exec`, no TTY, never
 * through a shell). Used by the Data tab (query runner) and seeding.
 * Implementations reject only when the daemon is unreachable or the container
 * does not exist / is not running; a failing command resolves with its exit
 * code.
 */
export interface ContainerExec {
	/**
	 * @param containerId - Container id or name (`li-<project>-<service>`).
	 * @param argv - Command and arguments, passed verbatim (no shell).
	 * @param options - Deadline, output cap, stdin and abort signal.
	 * @returns Exit code and captured output.
	 */
	run(
		containerId: string,
		argv: readonly string[],
		options: ExecOptions,
	): Promise<ExecResult>;
}
