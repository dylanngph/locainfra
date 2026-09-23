import type { CommandContext, ExitCode } from "../../cli.types";
import { ExitCode as Exit } from "../../cli.types";
import type { RootCommand } from "../../root";
import { createProgressRenderer, renderProgress } from "../../ui/progress";
import { resolveStackTarget } from "../shared/stack-target";

/** Parsed flags of `locainfra up`. */
export interface UpCommandOptions {
	/** Start the global stack. */
	readonly global: boolean;
	/** Only these service ids (all when empty or omitted). */
	readonly services?: readonly string[];
	/** Machine-readable output. */
	readonly json: boolean;
}

/**
 * `locainfra up`: discover the stack, stream `upStack` progress, and map the
 * outcome to an exit code (so CI fails when services never become healthy).
 *
 * @param ctx - IO and deps loader.
 * @param options - Parsed flags.
 * @returns {@link Exit.Ok} when the stack is up, {@link Exit.OpError} otherwise.
 */
export async function runUp(
	ctx: CommandContext,
	options: UpCommandOptions,
): Promise<ExitCode> {
	const deps = await ctx.loadDeps();
	const stack = await resolveStackTarget(deps, ctx.io, options);
	if (!stack) return Exit.OpError;
	const services =
		options.services && options.services.length > 0
			? options.services
			: undefined;
	const outcome = await renderProgress(
		deps.ops.upStack(deps.up, services ? { stack, services } : { stack }),
		createProgressRenderer(ctx.io, options.json),
		`Starting stack ${stack.name}`,
	);
	return outcome.ok ? Exit.Ok : Exit.OpError;
}

/**
 * Registers `up [--global] [--service <name...>]` on the root program.
 *
 * @param program - Root program.
 * @param ctx - IO and deps loader.
 */
export function registerUpCommand(
	program: RootCommand,
	ctx: CommandContext,
): void {
	program
		.command("up")
		.description("start the current project's stack (or the global one)")
		.option("-g, --global", "use the global stack (~/.locainfra/global.yaml)")
		.option("-s, --service <name...>", "only start these services")
		.action(async (opts, cmd) => {
			const { json } = cmd.optsWithGlobals();
			const options: UpCommandOptions = {
				global: opts.global === true,
				json: json === true,
				...(opts.service ? { services: opts.service } : {}),
			};
			ctx.io.setExitCode(await runUp(ctx, options));
		});
}
