/** Options of {@link FileStore.writeText}. */
export interface WriteTextOptions {
	/**
	 * POSIX permission bits for the file (e.g. `0o600` for files holding
	 * secrets). Applied on every write, including to an existing file.
	 */
	readonly mode?: number;
}

/** What {@link FileStore.fileInfo} reports about a path (symlinks followed). */
export interface FileInfo {
	/** Canonical absolute path with every symlink resolved. */
	readonly realPath: string;
	/** `file`, `directory`, or `other` (FIFO, socket, device, …). */
	readonly kind: "file" | "directory" | "other";
	/** Size in bytes (meaningful for files only). */
	readonly sizeBytes: number;
}

/** Minimal text-file access used by ops (stack files, rendered compose, env links). */
export interface FileStore {
	/** @returns File contents, or `null` when the file does not exist. */
	readText(path: string): Promise<string | null>;
	/**
	 * Writes `content` atomically (temp file, then rename: a reader or a crash
	 * never sees a partial or empty file), creating parent directories as
	 * needed.
	 */
	writeText(
		path: string,
		content: string,
		options?: WriteTextOptions,
	): Promise<void>;
	/** @returns Whether a file or directory exists at `path`. */
	exists(path: string): Promise<boolean>;
	/** @returns Whether `path` exists and is a directory (symlinks followed). */
	isDirectory(path: string): Promise<boolean>;
	/** Creates a directory and any missing parents. */
	mkdirp(path: string): Promise<void>;
	/**
	 * @param path - Any path.
	 * @returns Its canonical path, kind and size with symlinks followed, or
	 *   `null` when nothing exists there (or a symlink dangles).
	 */
	fileInfo(path: string): Promise<FileInfo | null>;
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
