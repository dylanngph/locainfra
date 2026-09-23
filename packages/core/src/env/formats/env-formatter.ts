/** Output format id of the `env` formatters (`--format` value). */
export type EnvFormat = "dotenv" | "shell" | "json";

/** Ordered map of environment variable name → value. */
export type EnvVars = Readonly<Record<string, string>>;

/**
 * Serializes environment variables in one output format.
 *
 * New formats implement this interface and register in `ENV_FORMATTERS`
 * (open/closed: callers never switch on the format).
 */
export interface EnvFormatter {
	/** Format identifier (`--format` value). */
	readonly id: EnvFormat;
	/**
	 * @param vars - Variables in output order.
	 * @returns The serialized text, ending with a newline when non-empty.
	 */
	format(vars: EnvVars): string;
}
