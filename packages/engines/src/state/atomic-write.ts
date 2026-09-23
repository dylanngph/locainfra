import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Options for {@link writeFileAtomic}. */
export interface AtomicWriteOptions {
	/** File mode for the new file (default `0o644`); enforced with `chmod` after rename. */
	readonly mode?: number;
	/** Mode for a newly created parent directory (default `0o755`). */
	readonly dirMode?: number;
}

/**
 * Writes `content` to `path` atomically: write a sibling temp file with `mode`
 * (created exclusively, never readable by others when `mode` says so),
 * `fsync` it, then `rename` over the target. Readers, and a crash at any
 * point, never observe a partially written or empty file.
 *
 * @param path - Target file.
 * @param content - UTF-8 text.
 * @param options - File and directory modes.
 */
export async function writeFileAtomic(
	path: string,
	content: string,
	options: AtomicWriteOptions = {},
): Promise<void> {
	const mode = options.mode ?? 0o644;
	const dir = dirname(path);
	await mkdir(dir, { recursive: true, mode: options.dirMode ?? 0o755 });
	const suffix = `${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
	const temp = join(dir, `.${basename(path)}.${suffix}`);
	try {
		const handle = await open(temp, "wx", mode);
		try {
			await handle.writeFile(content, "utf8");
			await handle.chmod(mode);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temp, path);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
	await chmod(path, mode);
}
