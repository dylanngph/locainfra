import type { EnvFormatter, EnvVars } from "./env-formatter";

/**
 * Single-quotes a value for POSIX shells (`'` becomes `'\''`).
 *
 * @param value - Raw value.
 * @returns The quoted value.
 */
export function quoteShellValue(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** `export KEY='value'` lines, for `eval "$(locainfra env --format shell)"`. */
export const shellFormatter: EnvFormatter = {
	id: "shell",
	format(vars: EnvVars): string {
		return Object.entries(vars)
			.map(([key, value]) => `export ${key}=${quoteShellValue(value)}\n`)
			.join("");
	},
};
