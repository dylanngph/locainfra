import { Option } from "@commander-js/extra-typings";
import type { EnvFormat } from "@locainfra/core";
import type { CommandContext, ExitCode } from "../../cli.types";
import { ExitCode as Exit } from "../../cli.types";
import type { RootCommand } from "../../root";
import { renderOpError } from "../../ui/output";
import { resolveStackTarget } from "../shared/stack-target";

/** Formats accepted by `--format`. */
export const ENV_FORMATS = [
	"dotenv",
	"shell",
	"json",
] as const satisfies readonly EnvFormat[];

/** Parsed flags of `locainfra env`. */
export interface EnvCommandOptions {
	/** Explicit `--format`; when omitted, `json` under `--json`, else `dotenv`. */
	readonly format?: EnvFormat;
	/** Machine-readable output. */
	readonly json: boolean;
}

/**
 * Picks the effective output format: an explicit `--format` wins, otherwise
 * `--json` means `json`, otherwise `dotenv`.
 *
 * @param options - Parsed flags.
 * @returns The format to request from `envForStack`.
 */
export function effectiveEnvFormat(options: EnvCommandOptions): EnvFormat {
	return options.format ?? (options.json ? "json" : "dotenv");
}

/**
 * `locainfra env`: print the cwd project's connection variables on stdout, e.g.
 * `eval "$(locainfra env --format shell)"`. The output intentionally contains
 * credentials; nothing is logged elsewhere.
 *
 * @param ctx - IO and deps loader.
 * @param options - Parsed flags.
 * @returns Ok, or OpError when discovery or rendering fails.
 */
export async function runEnv(
	ctx: CommandContext,
	options: EnvCommandOptions,
): Promise<ExitCode> {
	const deps = await ctx.loadDeps();
	const stack = await resolveStackTarget(deps, ctx.io, options);
	if (!stack) return Exit.OpError;
	const result = await deps.ops.envForStack(deps.env, {
		stack,
		format: effectiveEnvFormat(options),
	});
	if (!result.ok) {
		renderOpError(ctx.io, result.error, options.json);
		return Exit.OpError;
	}
	const text = result.value;
	ctx.io.stdout.write(text.endsWith("\n") || text === "" ? text : `${text}\n`);
	return Exit.Ok;
}

/**
 * Registers `env [--format dotenv|shell|json]` on the root program.
 *
 * @param program - Root program.
 * @param ctx - IO and deps loader.
 */
export function registerEnvCommand(
	program: RootCommand,
	ctx: CommandContext,
): void {
	program
		.command("env")
		.description(
			"print connection variables of the project in this folder (nearest locainfra.yaml)",
		)
		.addOption(
			new Option("-f, --format <format>", "output format").choices(ENV_FORMATS),
		)
		.action(async (opts, cmd) => {
			const { json } = cmd.optsWithGlobals();
			ctx.io.setExitCode(
				await runEnv(ctx, {
					json: json === true,
					...(opts.format ? { format: opts.format } : {}),
				}),
			);
		});
}
