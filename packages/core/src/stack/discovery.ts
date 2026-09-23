import { dirname, join, resolve } from "node:path";
import type { FileStore } from "../ports/files.port";
import {
	GLOBAL_STACK_NAME,
	PROJECT_STACK_FILE_NAME,
	type StackFile,
} from "./stack.model";

/**
 * Walks up from `cwd` to the filesystem root looking for `locainfra.yaml`.
 *
 * @param files - File access.
 * @param cwd - Start directory (resolved to an absolute path).
 * @returns Absolute path of the nearest stack file, or `null`.
 */
export async function findProjectStackFile(
	files: FileStore,
	cwd: string,
): Promise<string | null> {
	let dir = resolve(cwd);
	for (;;) {
		const candidate = join(dir, PROJECT_STACK_FILE_NAME);
		if (await files.exists(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * The stack file an absent `global.yaml` is equivalent to.
 *
 * @param name - Stack name (default `global`).
 * @returns `{ version: 1, name, services: {} }`.
 */
export function emptyStackFile(name: string = GLOBAL_STACK_NAME): StackFile {
	return { version: 1, name, services: {} };
}
