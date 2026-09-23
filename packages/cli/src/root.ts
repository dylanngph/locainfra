import { Command } from "@commander-js/extra-typings";
import { version } from "../package.json";
import type { CliIo } from "./cli.types";
import { theme } from "./ui/theme";

/**
 * Builds the bare `locainfra` program: name, version, global `--json`, and
 * output/exit wiring. Subcommands are attached by `createProgram`.
 *
 * Commander never calls `process.exit`: every exit is surfaced as a thrown
 * `CommanderError` that `runCli` maps to an exit code.
 *
 * @param io - Where help, version and usage errors are written.
 * @returns The root command.
 */
export function createRootCommand(io: CliIo) {
	return new Command("locainfra")
		.description(
			"Dashboard-first local Docker dev services. Run without a command to open the dashboard.",
		)
		.version(version, "-v, --version", "print the version")
		.option("--json", "print machine-readable JSON (no spinners, no colors)")
		.helpOption("-h, --help", "show help")
		.showHelpAfterError("(run `locainfra --help` for usage)")
		.configureOutput({
			writeOut: (text) => {
				io.stdout.write(text);
			},
			writeErr: (text) => {
				io.stderr.write(text);
			},
			outputError: (text, write) => write(theme.fail(text)),
		})
		.exitOverride();
}

/** The root program type (carries the typed global `--json` option). */
export type RootCommand = ReturnType<typeof createRootCommand>;
