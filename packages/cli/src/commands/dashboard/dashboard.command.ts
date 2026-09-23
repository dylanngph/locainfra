import { intro, log, outro } from "@clack/prompts";
import type { CommandContext, ExitCode } from "../../cli.types";
import { ExitCode as Exit } from "../../cli.types";
import { writeJson } from "../../ui/output";
import { theme } from "../../ui/theme";
import { formatDoctorSummary } from "../doctor/doctor.view";

/** Parsed flags of the default (no subcommand) action. */
export interface DashboardCommandOptions {
	/** Machine-readable output. */
	readonly json: boolean;
}

/** Placeholder text shown until the dashboard lands. */
export const DASHBOARD_PLACEHOLDER = "Dashboard coming in M2";

/**
 * Default action of `locainfra` (no subcommand). For now it prints a
 * placeholder plus the doctor summary line and always exits 0.
 *
 * TODO(M2, plan §1 "`locainfra` — the main command"): run doctor silently,
 * reuse a running dashboard (pidfile + health ping) or dynamic-`import()` the
 * server, start it on the first free port ≥ 4488 bound to 127.0.0.1, and open
 * the browser. Add `--port`, `--no-open`, `--project <dir>`.
 *
 * @param ctx - IO and deps loader.
 * @param options - Parsed flags.
 * @returns Always {@link Exit.Ok}.
 */
export async function runDashboard(
	ctx: CommandContext,
	options: DashboardCommandOptions,
): Promise<ExitCode> {
	const deps = await ctx.loadDeps();
	const report = await deps.ops.runDoctor(deps.doctor);
	if (options.json) {
		writeJson(ctx.io.stdout, {
			dashboard: { available: false, message: DASHBOARD_PLACEHOLDER },
			doctor: report,
		});
		return Exit.Ok;
	}
	const output = ctx.io.stdout;
	intro(theme.strong("LocaInfra"), { output });
	log.info(DASHBOARD_PLACEHOLDER, { output });
	log.message(formatDoctorSummary(report), { output });
	const failing = report.checks.filter((c) => c.status === "fail");
	for (const check of failing) {
		log.error(check.fix ? `${check.label}: ${check.fix}` : check.label, {
			output,
		});
	}
	outro(theme.muted("Run `locainfra doctor` for details."), { output });
	return Exit.Ok;
}
