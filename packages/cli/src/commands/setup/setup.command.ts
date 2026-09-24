import { Option } from "@commander-js/extra-typings";
import type { RuntimeProvider } from "@locastack/core";
import type { CommandContext, ExitCode } from "../../cli.types";
import { ExitCode as Exit } from "../../cli.types";
import type { RootCommand } from "../../root";
import { writeJson, writeLine } from "../../ui/output";
import { theme } from "../../ui/theme";
import { formatDoctorSummary } from "../doctor/doctor.view";
import { consentAndRunSetup } from "./setup.flow";
import { formatSetupPlan } from "./setup.view";

/** Runtimes `--runtime` accepts (macOS; Linux always uses Docker Engine). */
export const SETUP_RUNTIME_CHOICES = [
	"colima",
	"docker-desktop",
	"orbstack",
] as const satisfies readonly RuntimeProvider[];

/** Parsed flags of `locastack setup`. */
export interface SetupCommandOptions {
	/** Structured plan on stdout; never prompts or runs anything. */
	readonly json: boolean;
	/** Run without prompts (scripted use). */
	readonly yes: boolean;
	/** Print the plan and exit without running anything. */
	readonly dryRun: boolean;
	/** Runtime to install or start (default: the planner's choice). */
	readonly runtime?: RuntimeProvider;
	/** Colima: start at login (`brew services start colima`). */
	readonly startAtLogin?: boolean;
}

/**
 * `locastack setup`: run doctor, plan the commands that make Docker usable
 * (start a stopped runtime before installing anything) and, after an
 * explicit yes, run them with the terminal attached.
 *
 * - `--dry-run`, `--json`, or no terminal without `--yes`: print the plan
 *   (JSON: `{ ok, plan, doctor }`) and exit; nothing runs.
 * - `--yes`: no prompts, the plan's defaults (plus `--runtime`, `--start-at-login`).
 *
 * @param ctx - IO and deps loader.
 * @param options - Parsed flags.
 * @returns Ok when Docker works (already, or after the run, or once the user
 *   logs in again for a new docker group membership), OpError otherwise.
 */
export async function runSetupCommand(
	ctx: CommandContext,
	options: SetupCommandOptions,
): Promise<ExitCode> {
	const { io } = ctx;
	const deps = await ctx.loadDeps();
	const report = await deps.ops.runDoctor(deps.doctor);
	const plan = await deps.ops.planSetup(deps.setup, {
		report,
		...(options.runtime === undefined ? {} : { runtime: options.runtime }),
		...(options.startAtLogin === undefined
			? {}
			: { startAtLogin: options.startAtLogin }),
	});
	const planExit = plan.kind === "none" ? Exit.Ok : Exit.OpError;

	if (options.json) {
		writeJson(io.stdout, { ok: plan.kind === "none", plan, doctor: report });
		return planExit;
	}
	if (plan.kind === "none") {
		writeLine(io.stdout, formatDoctorSummary(report));
		writeLine(
			io.stdout,
			`${theme.ok("Docker is ready.")} Run \`locastack\` to open the dashboard.`,
		);
		return Exit.Ok;
	}
	if (options.dryRun || plan.kind === "unsupported") {
		writeLine(io.stdout, formatSetupPlan(plan));
		if (options.dryRun && plan.kind !== "unsupported")
			writeLine(
				io.stdout,
				theme.muted(
					"\nDry run: nothing was run. Run `locastack setup` to apply.",
				),
			);
		return planExit;
	}
	if (!io.isTTY && !options.yes) {
		writeLine(io.stdout, formatSetupPlan(plan));
		writeLine(
			io.stderr,
			theme.fail(
				"Not running in a terminal: nothing was run. Run `locastack setup` in a terminal, or pass --yes to run these commands.",
			),
		);
		return Exit.OpError;
	}

	const outcome = await consentAndRunSetup(io, deps, plan, report, {
		yes: options.yes,
		...(options.runtime === undefined ? {} : { runtime: options.runtime }),
		...(options.startAtLogin === undefined
			? {}
			: { startAtLogin: options.startAtLogin }),
	});
	if (outcome.status === "ready" || outcome.status === "nothing") {
		writeLine(io.stdout, "Run `locastack` to open the dashboard.");
		return Exit.Ok;
	}
	if (outcome.status === "relogin") {
		writeLine(
			io.stdout,
			"After logging in again, run `locastack` to open the dashboard.",
		);
		return Exit.Ok;
	}
	return Exit.OpError;
}

/**
 * Registers `setup` on the root program.
 *
 * @param program - Root program.
 * @param ctx - IO and deps loader.
 */
export function registerSetupCommand(
	program: RootCommand,
	ctx: CommandContext,
): void {
	program
		.command("setup")
		.description(
			"install or start Docker (asks before running anything; shows every command first)",
		)
		.option("-y, --yes", "run the plan without prompts (scripted use)")
		.option("--dry-run", "print the plan and exit without running anything")
		.addOption(
			new Option(
				"--runtime <runtime>",
				"Docker runtime to install on macOS (default: colima)",
			).choices(SETUP_RUNTIME_CHOICES),
		)
		.option(
			"--start-at-login",
			"Colima: start at login (brew services start colima)",
		)
		.action(async (_opts, cmd) => {
			const opts = cmd.optsWithGlobals();
			ctx.io.setExitCode(
				await runSetupCommand(ctx, {
					json: opts.json === true,
					yes: opts.yes === true,
					dryRun: opts.dryRun === true,
					...(opts.runtime === undefined ? {} : { runtime: opts.runtime }),
					...(opts.startAtLogin === true ? { startAtLogin: true } : {}),
				}),
			);
		});
}
