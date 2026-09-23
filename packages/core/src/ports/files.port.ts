/** Options of {@link FileStore.writeText}. */
export interface WriteTextOptions {
	/**
	 * POSIX permission bits for the file (e.g. `0o600` for files holding
	 * secrets). Applied on every write, including to an existing file.
	 */
	readonly mode?: number;
}

/** Minimal text-file access used by ops (stack files, rendered compose, env links). */
export interface FileStore {
	/** @returns File contents, or `null` when the file does not exist. */
	readText(path: string): Promise<string | null>;
	/** Writes `content`, creating parent directories as needed. */
	writeText(
		path: string,
		content: string,
		options?: WriteTextOptions,
	): Promise<void>;
	/** @returns Whether a file or directory exists at `path`. */
	exists(path: string): Promise<boolean>;
	/** Creates a directory and any missing parents. */
	mkdirp(path: string): Promise<void>;
}

/** Lists the files in a directory (catalog overrides, registry cache). */
export interface DirectoryLister {
	/**
	 * @param dir - Absolute directory path.
	 * @returns Entry names (not paths) of regular files in `dir`; `[]` when it does not exist.
	 */
	list(dir: string): Promise<string[]>;
}

/** Checks whether a host port can be bound on 127.0.0.1. */
export interface PortProbe {
	/** @returns `true` when `port` is free on 127.0.0.1. */
	isFree(port: number): Promise<boolean>;
}

/** Time source (injectable for deterministic tests). */
export interface Clock {
	/** @returns The current time. */
	now(): Date;
}

/** Cryptographically secure secret generator. */
export interface SecretGenerator {
	/**
	 * @param bytes - Number of random bytes.
	 * @returns A URL- and shell-safe encoding of `bytes` random bytes.
	 */
	generate(bytes: number): string;
}
