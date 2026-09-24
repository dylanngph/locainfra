/**
 * Pattern of a stack entry's `seed` path, mirrored from core's
 * `SEED_PATH_PATTERN`: relative to the project root, no leading `/`, `\` or
 * `~`, no drive letter, no `..` segment, no NUL.
 */
export const SEED_PATH_PATTERN =
	"^(?![/\\\\~])(?![A-Za-z]:)(?!(?:.*[/\\\\])?\\.\\.(?:[/\\\\]|$))[^\\u0000]+$";

const SEED_PATH = new RegExp(SEED_PATH_PATTERN);

/**
 * Normalises a typed seed path: trims it and drops leading `./`.
 *
 * @param input - What the user typed, e.g. `./db/seed.sql`.
 * @returns The path stored in `locastack.yaml`, e.g. `db/seed.sql` (`""` when empty).
 */
export function normalizeSeedPath(input: string): string {
	return input.trim().replace(/^(?:\.\/)+/, "");
}

/**
 * Validates an optional seed path (empty is fine: no seed).
 *
 * @param input - What the user typed.
 * @returns An error message, or `undefined` when valid.
 */
export function validateSeedPath(input: string): string | undefined {
	const path = normalizeSeedPath(input);
	if (!path) return undefined;
	return SEED_PATH.test(path)
		? undefined
		: "Use a path inside the project folder, e.g. db/seed.sql.";
}

/**
 * How the dashboard shows a seed path: `./<path>`.
 *
 * @param path - Stored seed path.
 * @returns e.g. `./db/seed.sql`.
 */
export const seedLabel = (path: string): string =>
	`./${normalizeSeedPath(path)}`;
