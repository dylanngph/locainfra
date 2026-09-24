import type { CommandStep } from "../ports/process.port";

const SAFE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Quotes one argument for display in a POSIX shell (single quotes when it
 * holds anything but plain word characters).
 *
 * @param arg - Raw argument.
 * @returns The argument as a user would type it (`''` for an empty string).
 */
export function quoteShellArg(arg: string): string {
	if (arg === "") return "''";
	if (SAFE_ARG.test(arg)) return arg;
	return `'${arg.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Joins an argv into the one-line command shown to the user before consent.
 *
 * @param argv - Command and arguments.
 * @returns e.g. `sudo sh /tmp/locastack-setup-x/get-docker.sh`.
 */
export function formatCommand(argv: readonly string[]): string {
	return argv.map(quoteShellArg).join(" ");
}

/**
 * Formats a {@link CommandStep} exactly as it runs: extra environment
 * variables first (`KEY=value`), then the quoted argv. The CLI and the
 * dashboard both use it so commands read the same everywhere.
 *
 * @param step - Planned step.
 * @returns The command line.
 */
export function formatCommandStep(
	step: Pick<CommandStep, "argv" | "env">,
): string {
	const env = Object.entries(step.env ?? {}).map(
		([key, value]) => `${key}=${quoteShellArg(value)}`,
	);
	return [...env, formatCommand(step.argv)].join(" ");
}
