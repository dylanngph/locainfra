import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
	createEmptyState,
	OpError,
	type StateFile,
	type StateReader,
	type StateWriter,
} from "@locainfra/core";
import { readTextIfExists } from "../fs/read-text";
import { writeFileAtomic } from "./atomic-write";
import { acquireFileLock, type FileLockOptions } from "./file-lock";
import { parseStateFile } from "./state-parser";

/** Options for {@link FileStateStore}. */
export interface FileStateStoreOptions {
	/** Path of `state.json` (see `stateFilePath` in core). */
	readonly filePath: string;
	/** Lock timing. */
	readonly lock?: FileLockOptions;
}

/**
 * {@link StateReader} + {@link StateWriter} over `~/.locainfra/state.json`.
 *
 * Updates take `state.json.lock` (exclusive create, retried), re-read the file,
 * apply the mutation, validate, and write via temp file + rename. Updates within
 * one process are additionally serialised so they never contend on the lock file.
 */
export class FileStateStore implements StateReader, StateWriter {
	readonly #filePath: string;
	readonly #lockPath: string;
	readonly #lockOptions: FileLockOptions;
	#queue: Promise<unknown> = Promise.resolve();

	/** @param options - File path and lock timing. */
	constructor(options: FileStateStoreOptions) {
		this.#filePath = options.filePath;
		this.#lockPath = `${options.filePath}.lock`;
		this.#lockOptions = options.lock ?? {};
	}

	/**
	 * @returns The persisted state, or an empty state when the file does not exist.
	 * @throws {OpError} `IO` when the file is not valid JSON or has the wrong shape.
	 */
	async read(): Promise<StateFile> {
		const text = await readTextIfExists(this.#filePath);
		if (text === null || text.trim() === "") return createEmptyState();
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch (cause) {
			throw new OpError("IO", `${this.#filePath} is not valid JSON`, {
				details: { path: this.#filePath },
				cause,
			});
		}
		return parseStateFile(raw);
	}

	/**
	 * Applies `mutate` under the lock and persists the validated result atomically.
	 *
	 * @param mutate - Function from current state (a private copy) to new state.
	 * @returns The state as written.
	 * @throws {OpError} `IO` on lock timeout or invalid resulting state; rethrows errors from `mutate`.
	 */
	update(mutate: (state: StateFile) => StateFile): Promise<StateFile> {
		const run = this.#queue.then(() => this.#updateLocked(mutate));
		this.#queue = run.catch(() => undefined);
		return run;
	}

	async #updateLocked(
		mutate: (state: StateFile) => StateFile,
	): Promise<StateFile> {
		await mkdir(dirname(this.#filePath), { recursive: true, mode: 0o700 });
		const release = await acquireFileLock(this.#lockPath, this.#lockOptions);
		try {
			const current = await this.read();
			const next = parseStateFile(mutate(structuredClone(current)));
			await writeFileAtomic(
				this.#filePath,
				`${JSON.stringify(next, null, 2)}\n`,
				{ mode: 0o600, dirMode: 0o700 },
			);
			return next;
		} finally {
			await release();
		}
	}
}
