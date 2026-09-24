import {
	Command,
	InvalidArgumentError,
	Option,
} from "@commander-js/extra-typings";
import { version } from "../package.json";
import type { CliIo } from "./cli.types";
import { theme } from "./ui/theme";

/**
 * Builds the bare `locastack` program: name, version, global `--json`, the
 * dashboard flags (`--port`, `--no-open`, `--project`) and output/exit
 * wiring. Subcommands are attached by `createProgram`.
 *
 * Commander never calls `process.exit`: every exit is surfaced as a thrown
 * `CommanderError` that `runCli` maps to an exit code.
 *
 * @param io - Where help, version and usage errors are written.
 * @returns The root command.
 */
export function createRootCommand(io: CliIo) {
	return new Command("locastack")
		.description(
			"Dashboard-first local Docker dev services. Run without a command to open the dashboard.",
		)
		.version(version, "-v, --version", "print the version")
		.option("--json", "print machine-readable JSON (no spinners, no colors)")
		.addOption(
			new Option(
				"-p, --port <port>",
				"dashboard port (default: first free port from 4488)",
			).argParser(parsePort),
		)
		.option("--no-open", "do not open the browser")
		.option(
			"--project <dir>",
			"register this folder as a project and open it in the dashboard",
		)
		.helpOption("-h, --help", "show help")
		.addHelpText(
			"after",
			"\nNo Docker yet, or it is stopped? `locastack setup` shows the exact commands and asks before running any.",
		)
		.showHelpAfterError("(run `locastack --help` for usage)")
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

/**
 * Parses `--port`: an integer from 1024 to 65535.
 *
 * @param value - Raw flag value.
 * @returns The port.
 * @throws InvalidArgumentError when out of range.
 */
export function parsePort(value: string): number {
	const port = Number(value);
	if (!/^\d+$/.test(value) || port < 1024 || port > 65535)
		throw new InvalidArgumentError("expected a port from 1024 to 65535");
	return port;
}

/** The root program type (carries the typed global `--json` option). */
export type RootCommand = ReturnType<typeof createRootCommand>;
