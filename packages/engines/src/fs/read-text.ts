import { readFile } from "node:fs/promises";

/**
 * Reads a UTF-8 file with a single open + read-to-EOF.
 *
 * Unlike `Bun.file(path).text()`, which can size the read from a stale `stat`,
 * this never returns a truncated mix when the file is atomically replaced
 * (temp file + rename) concurrently.
 *
 * @param path - File path.
 * @returns The contents, or `null` when the file does not exist.
 * @throws For errors other than `ENOENT` (e.g. `EACCES`, `EISDIR`).
 */
export async function readTextIfExists(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			return null;
		}
		throw error;
	}
}
