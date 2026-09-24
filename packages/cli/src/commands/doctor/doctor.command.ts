import type { CommandContext, ExitCode } from "../../cli.types";
import { ExitCode as Exit } from "../../cli.types";
import type { RootCommand } from "../../root";
import { writeJson, writeLine } from "../../ui/output";
import { theme } from "../../ui/theme";
import { formatDoctorReport } from "./doctor.view";

/** Parsed flags of `locastack doctor`. */
export interface DoctorCommandOptions {
	/** Print the raw `DoctorReport` as JSON. */
	readonly json: boolean;
}

/**
 * `locastack doctor`: diagnose Docker, compose and the socket.
 *
 * @param ctx - IO and deps loader.
 * @param options - Parsed flags.
 * @returns Ok when no check failed (warnings allowed), OpError otherwise.
 */
export async function runDoctorCommand(
	ctx: CommandContext,
	options: DoctorCommandOptions,
): Promise<ExitCode> {
	const deps = await ctx.loadDeps();
	const report = await deps.ops.runDoctor(deps.doctor);
	if (options.json) {
		writeJson(ctx.io.stdout, report);
	} else {
		writeLine(ctx.io.stdout, theme.strong("LocaStack doctor"));
		writeLine(ctx.io.stdout, formatDoctorReport(report));
	}
	return report.ok ? Exit.Ok : Exit.OpError;
}

/**
 * Registers `doctor` on the root program.
 *
 * @param program - Root program.
 * @param ctx - IO and deps loader.
 */
export function registerDoctorCommand(
	program: RootCommand,
	ctx: CommandContext,
): void {
	program
		.command("doctor")
		.description("diagnose Docker, the compose plugin and the Docker socket")
		.action(async (_opts, cmd) => {
			const { json } = cmd.optsWithGlobals();
			ctx.io.setExitCode(await runDoctorCommand(ctx, { json: json === true }));
		});
}
