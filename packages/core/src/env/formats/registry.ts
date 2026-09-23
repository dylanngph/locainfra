import { dotenvFormatter } from "./dotenv";
import type { EnvFormat, EnvFormatter } from "./env-formatter";
import { jsonFormatter } from "./json";
import { shellFormatter } from "./shell";

/** Every built-in {@link EnvFormatter}, keyed by format id. */
export const ENV_FORMATTERS: Readonly<Record<EnvFormat, EnvFormatter>> = {
	dotenv: dotenvFormatter,
	shell: shellFormatter,
	json: jsonFormatter,
};

/**
 * @param format - Format id.
 * @returns The formatter for `format`.
 */
export function getEnvFormatter(format: EnvFormat): EnvFormatter {
	return ENV_FORMATTERS[format];
}
