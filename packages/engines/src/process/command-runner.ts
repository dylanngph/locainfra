/** Options for {@link CommandRunner.spawn}. */
export interface SpawnOptions {
	/** Working directory (default: current). */
	readonly cwd?: string;
	/** Aborting kills the child process. */
	readonly signal?: AbortSignal;
}

/** A child process with piped output. */
export interface RunningCommand {
	/** Child's stdout. */
	readonly stdout: ReadableStream<Uint8Array>;
	/** Child's stderr. */
	readonly stderr: ReadableStream<Uint8Array>;
	/** Resolves with the exit code once the child exits. */
	readonly exited: Promise<number>;
}

/** Result of {@link runToCompletion}. */
export interface CommandOutput {
	/** Process exit code. */
	readonly exitCode: number;
	/** Entire stdout, UTF-8 decoded. */
	readonly stdout: string;
	/** Entire stderr, UTF-8 decoded. */
	readonly stderr: string;
}

/**
 * Spawns external commands. Abstracted so compose/context logic can be tested
 * with scripted fakes instead of a real Docker install.
 */
export interface CommandRunner {
	/**
	 * Starts `argv[0]` with the remaining arguments (no shell).
	 *
	 * @param argv - Executable and arguments.
	 * @param options - Working directory and abort signal.
	 * @throws When the executable cannot be started (e.g. not on `PATH`).
	 */
	spawn(argv: readonly string[], options?: SpawnOptions): RunningCommand;
}

/** {@link CommandRunner} backed by `Bun.spawn` (stdin ignored, stdout/stderr piped). */
export class BunCommandRunner implements CommandRunner {
	/**
	 * @param argv - Executable and arguments.
	 * @param options - Working directory and abort signal.
	 * @returns The running child.
	 */
	spawn(argv: readonly string[], options: SpawnOptions = {}): RunningCommand {
		const child = Bun.spawn([...argv], {
			cwd: options.cwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			signal: options.signal,
		});
		return {
			stdout: child.stdout,
			stderr: child.stderr,
			exited: child.exited,
		};
	}
}

/**
 * Runs a command and buffers its output.
 *
 * @param runner - Command runner.
 * @param argv - Executable and arguments.
 * @param options - Working directory and abort signal.
 * @returns Exit code and decoded output.
 * @throws When the executable cannot be started.
 */
export async function runToCompletion(
	runner: CommandRunner,
	argv: readonly string[],
	options?: SpawnOptions,
): Promise<CommandOutput> {
	const child = runner.spawn(argv, options);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, stdout, stderr };
}

/**
 * Splits a byte stream into UTF-8 lines (without terminators). A trailing
 * partial line is emitted at end of stream; `\r\n` and lone `\r` both end a line.
 *
 * @param stream - Byte stream.
 * @returns Async iterable of lines.
 */
export async function* readLines(
	stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of stream) {
		buffer += decoder.decode(chunk, { stream: true });
		const parts = buffer.split(/\r\n|\r|\n/);
		buffer = parts.pop() ?? "";
		yield* parts;
	}
	buffer += decoder.decode();
	if (buffer !== "") yield buffer;
}

/**
 * Interleaves several async iterables, yielding values in arrival order.
 *
 * @param sources - Iterables to merge.
 * @returns One iterable that ends when every source has ended.
 */
export async function* mergeAsync<T>(
	...sources: readonly AsyncIterable<T>[]
): AsyncGenerator<T> {
	const iterators = sources.map((s) => s[Symbol.asyncIterator]());
	const pending = new Map<
		number,
		Promise<{ index: number; result: IteratorResult<T> }>
	>();
	const pull = (index: number): void => {
		const iterator = iterators[index];
		if (iterator === undefined) return;
		pending.set(
			index,
			iterator.next().then((result) => ({ index, result })),
		);
	};
	iterators.forEach((_, index) => {
		pull(index);
	});
	try {
		while (pending.size > 0) {
			const { index, result } = await Promise.race(pending.values());
			if (result.done) {
				pending.delete(index);
			} else {
				pull(index);
				yield result.value;
			}
		}
	} finally {
		// Fire-and-forget: awaiting would block on sources still waiting for data.
		for (const [index] of pending) {
			void iterators[index]?.return?.().catch(() => undefined);
		}
	}
}
