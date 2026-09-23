#!/usr/bin/env bun
/**
 * `locainfra` binary entry and public surface of `@locainfra/cli`.
 *
 * The composition root is imported dynamically, so `--version` and `--help`
 * never load engines (plan §6, "plain commands skip the server").
 *
 * @packageDocumentation
 */
import { runCli } from "./program";

export type {
	CliDeps,
	CliDepsLoader,
	CliIo,
	CliOps,
	CliPrompter,
	CommandContext,
	GlobalOptions,
} from "./cli.types";
export { ExitCode } from "./cli.types";
export { createProcessIo } from "./io";
export { createProgram, runCli } from "./program";
export type { RootCommand } from "./root";

if (import.meta.main) {
	await runCli(process.argv.slice(2), async () => {
		const { composeDeps } = await import("./composition");
		return composeDeps();
	});
}
