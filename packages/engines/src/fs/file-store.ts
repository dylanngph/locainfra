import { chmod, mkdir, readdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type {
	DirectoryLister,
	FileStore,
	WriteTextOptions,
} from "@locainfra/core";
import { readTextIfExists } from "./read-text";

/**
 * {@link FileStore} and {@link DirectoryLister} over `Bun.write` (writes),
 * a single-read `fs.readFile` (reads, safe against concurrent atomic
 * replacement) and `fs.readdir` (listing).
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
	 * Writes `content`, creating parent directories as needed. With a `mode`,
	 * the file is created empty with that mode before the content is written,
	 * so secrets are never readable by others, even briefly.
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
		await mkdir(dirname(path), { recursive: true });
		if (options.mode !== undefined) {
			await Bun.write(path, "", { mode: options.mode });
			await chmod(path, options.mode);
		}
		await Bun.write(path, content);
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
	 * Creates `path` and any missing parents (no-op when it exists).
	 *
	 * @param path - Directory path.
	 */
	async mkdirp(path: string): Promise<void> {
		await mkdir(path, { recursive: true });
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
