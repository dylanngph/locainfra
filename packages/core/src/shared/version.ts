/** Oldest Docker Engine API version LocaStack talks to. */
export const MIN_DOCKER_API_VERSION = "1.44";
/** Oldest supported `docker compose` version (fail below). */
export const MIN_COMPOSE_VERSION = "2.24.0";
/** Recommended `docker compose` version (warn below). */
export const RECOMMENDED_COMPOSE_VERSION = "2.30.0";

/**
 * Parses a dotted version string into numeric parts.
 *
 * Accepts an optional leading `v` and ignores any pre-release or build suffix
 * (`2.24.0-desktop.1` → `[2, 24, 0]`, `v5.3.0` → `[5, 3, 0]`, `1.44` → `[1, 44]`).
 *
 * @param version - Version string.
 * @returns Numeric parts, or `null` when `version` does not start with a number.
 */
export function parseVersion(version: string): number[] | null {
	const match = /^\s*v?(\d+(?:\.\d+)*)/i.exec(version);
	if (!match?.[1]) return null;
	return match[1].split(".").map((part) => Number.parseInt(part, 10));
}

/**
 * Compares two version strings numerically, part by part (missing parts count as 0).
 *
 * @param a - First version.
 * @param b - Second version.
 * @returns Negative when `a < b`, positive when `a > b`, `0` when equal, or
 *   `null` when either side cannot be parsed.
 */
export function compareVersions(a: string, b: string): number | null {
	const left = parseVersion(a);
	const right = parseVersion(b);
	if (!left || !right) return null;
	const length = Math.max(left.length, right.length);
	for (let i = 0; i < length; i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/**
 * @param version - Version to test.
 * @param minimum - Inclusive lower bound.
 * @returns Whether `version >= minimum`, or `null` when either is unparsable.
 */
export function isAtLeast(version: string, minimum: string): boolean | null {
	const diff = compareVersions(version, minimum);
	return diff === null ? null : diff >= 0;
}
