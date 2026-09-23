import type { FileStore } from "../../ports/files.port";
import { OpError } from "../../shared/op-error";
import { err, ok, type Result } from "../../shared/result";
import { writeMarkerBlock } from "./marker-writer";

/** Permission bits of a linked env file: it holds revealed secrets (owner read/write only). */
export const LINKED_ENV_FILE_MODE = 0o600;

/**
 * Rewrites the `# locainfra:start` / `# locainfra:end` block of an env file
 * (creating the file, or appending the block, when needed) and leaves every
 * other line untouched. The file is written with mode
 * {@link LINKED_ENV_FILE_MODE}.
 *
 * @param files - File access.
 * @param path - Absolute path of the env file.
 * @param body - New block contents (e.g. dotenv lines), without markers.
 * @returns `ok`, or `IO` (unreadable/unwritable file, malformed markers).
 */
export async function writeLinkedEnvFile(
	files: FileStore,
	path: string,
	body: string,
): Promise<Result<void>> {
	let existing: string | null;
	try {
		existing = await files.readText(path);
	} catch (cause) {
		return err(
			new OpError("IO", `${path}: could not be read`, {
				cause,
				details: { path },
			}),
		);
	}
	const next = writeMarkerBlock(existing, body);
	if (!next.ok) {
		return err(
			new OpError(next.error.code, `${path}: ${next.error.message}`, {
				details: { ...next.error.details, path },
			}),
		);
	}
	try {
		await files.writeText(path, next.value, { mode: LINKED_ENV_FILE_MODE });
	} catch (cause) {
		return err(
			new OpError("IO", `${path}: could not be written`, {
				cause,
				details: { path },
			}),
		);
	}
	return ok(undefined);
}
