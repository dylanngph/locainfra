#!/usr/bin/env bun
/**
 * `locainfra` binary entry and public surface of `@locainfra/cli`.
 *
 * The composition root is imported dynamically, so `--version` and `--help`
 * never load engines (plan §6, "plain commands skip the server").
 *
 * @packageDocumentation
 */
import type { ExitCode } from "./cli.types";
import { runCli } from "./program";

export type {
	CliDeps,
	CliDepsLoader,
	CliIo,
	CliOps,
	CliPrompter,
	CommandContext,
	DashboardLauncher,
	GlobalOptions,
	RunningDashboardInfo,
	StartedDashboard,
} from "./cli.types";
export { ExitCode } from "./cli.types";
export { createProcessIo } from "./io";
export { createProgram, runCli } from "./program";
export type { RootCommand } from "./root";

/**
 * Runs the real CLI (composition root loaded lazily). Called when this file
 * is executed directly: from source and as the compiled binary's entry.
 *
 * @param args - User arguments (without the executable and script path).
 * @returns The exit code.
 */
export function main(args: readonly string[]): Promise<ExitCode> {
	return runCli(args, async () => {
		const { composeDeps } = await import("./composition");
		return composeDeps();
	});
}

if (import.meta.main) {
	await main(process.argv.slice(2));
}
