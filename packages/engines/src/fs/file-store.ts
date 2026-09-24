import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import type {
	DirectoryLister,
	FileInfo,
	FileStore,
	WriteTextOptions,
} from "@locastack/core";
import { writeFileAtomic } from "../state/atomic-write";
import { readTextIfExists } from "./read-text";

/** Mode of a new file written without an explicit mode. */
const DEFAULT_FILE_MODE = 0o644;

/**
 * {@link FileStore} and {@link DirectoryLister} over atomic temp-file +
 * rename writes, a single-read `fs.readFile` (reads, safe against concurrent
 * atomic replacement) and `fs.readdir` (listing).
 */
export class BunFileStore implements FileStore, DirectoryLister {
	/**
	 * @param path - File path.
	 * @returns The file's UTF-8 contents, or `null` when it does not exist.
	 */
	readText(path: string): Promise<string | null> {
		return readTextIfExists(path);
	}

	/**
	 * Writes `content` atomically ({@link writeFileAtomic}: a temp file in the
	 * same folder created with the final mode, fsynced, then renamed over the
	 * target), creating parent directories as needed. A concurrent reader
	 * (e.g. `docker compose` reading the stack `.env`) or a crash never sees
	 * a partial or empty file, and a file with a `mode` is never readable by
	 * others, even briefly. Without a `mode` an existing file keeps its
	 * permission bits (new files get 0644). A symlink is written through:
	 * its target is replaced, the link stays.
	 *
	 * @param path - File path.
	 * @param content - UTF-8 text.
	 * @param options - Optional permission bits.
	 */
	async writeText(
		path: string,
		content: string,
		options: WriteTextOptions = {},
	): Promise<void> {
		let target = path;
		let existingMode: number | undefined;
		try {
			target = await realpath(path);
			existingMode = (await stat(target)).mode & 0o777;
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
		await writeFileAtomic(target, content, {
			mode: options.mode ?? existingMode ?? DEFAULT_FILE_MODE,
		});
	}

	/**
	 * @param path - File or directory path.
	 * @returns Whether anything exists at `path`.
	 */
	async exists(path: string): Promise<boolean> {
		try {
			await stat(path);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * @param path - Any path.
	 * @returns Whether `path` exists and is a directory (symlinks followed).
	 */
	async isDirectory(path: string): Promise<boolean> {
		try {
			return (await stat(path)).isDirectory();
		} catch {
			return false;
		}
	}

	/**
	 * Creates `path` and any missing parents (no-op when it exists).
	 *
	 * @param path - Directory path.
	 */
	async mkdirp(path: string): Promise<void> {
		await mkdir(path, { recursive: true });
	}

	/**
	 * @param path - Any path.
	 * @returns Canonical path (symlinks resolved), kind and size, or `null`
	 *   when nothing exists there or a symlink dangles.
	 * @throws For errors other than a missing path (e.g. `EACCES`, a loop).
	 */
	async fileInfo(path: string): Promise<FileInfo | null> {
		try {
			const realPath = await realpath(path);
			const info = await stat(realPath);
			return {
				realPath,
				kind: info.isFile()
					? "file"
					: info.isDirectory()
						? "directory"
						: "other",
				sizeBytes: info.size,
			};
		} catch (error) {
			if (isMissing(error)) return null;
			throw error;
		}
	}

	/**
	 * @param dir - Absolute directory path.
	 * @returns Names of the regular files in `dir`; `[]` when it is missing or not a directory.
	 */
	async list(dir: string): Promise<string[]> {
		try {
			const entries = await readdir(dir, { withFileTypes: true });
			return entries.filter((e) => e.isFile()).map((e) => e.name);
		} catch (error) {
			if (isMissing(error)) return [];
			throw error;
		}
	}
}

function isMissing(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const code = (error as { code?: unknown }).code;
	return code === "ENOENT" || code === "ENOTDIR";
}
