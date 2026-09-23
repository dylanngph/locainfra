import type { EnvFormatter, EnvVars } from "./env-formatter";

const SAFE_UNQUOTED = /^[A-Za-z0-9_\-.,:/@+=%~]*$/;

/**
 * Quotes a value for a dotenv file readable by both `docker compose` and
 * common dotenv loaders.
 *
 * Safe values stay bare; values without single quotes or newlines are
 * single-quoted (no interpolation); anything else is double-quoted with
 * `\`, `"`, `$` and newlines escaped.
 *
 * @param value - Raw value.
 * @returns The value as it should appear after `KEY=`.
 */
export function quoteDotenvValue(value: string): string {
	if (SAFE_UNQUOTED.test(value)) return value;
	if (!value.includes("'") && !/[\r\n]/.test(value)) return `'${value}'`;
	const escaped = value
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replaceAll("$", "\\$")
		.replaceAll("\r", "\\r")
		.replaceAll("\n", "\\n");
	return `"${escaped}"`;
}

/** `KEY=value` lines (the format of `.env` / `.env.local`). */
export const dotenvFormatter: EnvFormatter = {
	id: "dotenv",
	format(vars: EnvVars): string {
		return Object.entries(vars)
			.map(([key, value]) => `${key}=${quoteDotenvValue(value)}\n`)
			.join("");
	},
};
