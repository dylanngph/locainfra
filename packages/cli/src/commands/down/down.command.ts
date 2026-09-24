import type { CommandContext, ExitCode } from "../../cli.types";
import { ExitCode as Exit } from "../../cli.types";
import type { RootCommand } from "../../root";
import { renderUsageError, writeLine } from "../../ui/output";
import { createProgressRenderer, renderProgress } from "../../ui/progress";
import { theme } from "../../ui/theme";
import { resolveStackTarget } from "../shared/stack-target";

/** Parsed flags of `locastack down`. */
export interface DownCommandOptions {
	/** Also delete named volumes (data loss). */
	readonly volumes: boolean;
	/** Skip the confirmation for `--volumes`. */
	readonly yes: boolean;
	/** Machine-readable output. */
	readonly json: boolean;
}

/**
 * `locastack down`: stop the stack. `--volumes` is destructive: it needs an
 * interactive confirmation, or `--yes` when running with `--json` or without a TTY.
 *
 * @param ctx - IO and deps loader.
 * @param options - Parsed flags.
 * @returns Ok, OpError (failure or declined confirmation), or Usage (`--volumes` without `--yes` non-interactively).
 */
export async function runDown(
	ctx: CommandContext,
	options: DownCommandOptions,
): Promise<ExitCode> {
	const { io } = ctx;
	const mustConfirm = options.volumes && !options.yes;
	if (mustConfirm && (options.json || !io.isTTY)) {
		renderUsageError(
			io,
			"--volumes deletes data; pass --yes to confirm when not running interactively",
			options.json,
		);
		return Exit.Usage;
	}
	const deps = await ctx.loadDeps();
	const stack = await resolveStackTarget(deps, io, options);
	if (!stack) return Exit.OpError;
	if (mustConfirm) {
		const confirmed = await io.prompter.confirm(
			`Stop ${stack.name} and DELETE its volumes? All data in them is lost.`,
		);
		if (!confirmed) {
			writeLine(io.stderr, theme.warn("Aborted; nothing was changed."));
			return Exit.OpError;
		}
	}
	const outcome = await renderProgress(
		deps.ops.downStack(deps.down, { stack, volumes: options.volumes }),
		createProgressRenderer(io, options.json),
		`Stopping stack ${stack.name}`,
	);
	return outcome.ok ? Exit.Ok : Exit.OpError;
}

/**
 * Registers `down [--volumes] [--yes]` on the root program.
 *
 * @param program - Root program.
 * @param ctx - IO and deps loader.
 */
export function registerDownCommand(
	program: RootCommand,
	ctx: CommandContext,
): void {
	program
		.command("down")
		.description(
			"stop the services of the project in this folder (nearest locastack.yaml)",
		)
		.option("--volumes", "also delete the project's volumes (data loss)")
		.option("-y, --yes", "confirm destructive actions without prompting")
		.action(async (opts, cmd) => {
			const { json } = cmd.optsWithGlobals();
			ctx.io.setExitCode(
				await runDown(ctx, {
					volumes: opts.volumes === true,
					yes: opts.yes === true,
					json: json === true,
				}),
			);
		});
}
