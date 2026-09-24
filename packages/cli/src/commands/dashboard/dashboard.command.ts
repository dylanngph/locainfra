import { resolve } from "node:path";
import { log } from "@clack/prompts";
import type { DoctorReport } from "@locastack/core";
import type { CommandContext, ExitCode } from "../../cli.types";
import { ExitCode as Exit } from "../../cli.types";
import { renderOpError, writeJson, writeLine } from "../../ui/output";
import { theme } from "../../ui/theme";
import { formatDoctorSummary } from "../doctor/doctor.view";
import { offerSetup, type SetupFlowOutcome } from "../setup/setup.flow";
import { registerProjectDir } from "./project-dir";

/** First port tried for the dashboard when `--port` is not given. */
export const DEFAULT_DASHBOARD_PORT = 4488;

/** Parsed flags of the default (no subcommand) action. */
export interface DashboardCommandOptions {
	/** Machine-readable output (one JSON line, then the server keeps running). */
	readonly json: boolean;
	/** Explicit port (default: first free one ≥ {@link DEFAULT_DASHBOARD_PORT}). */
	readonly port?: number;
	/** Open the browser (`--no-open` sets false). */
	readonly open: boolean;
	/** Folder to register and preselect (`--project <dir>`), relative to cwd. */
	readonly project?: string;
}

/**
 * Adds `?project=<name>` so the dashboard opens that project.
 *
 * @param url - Dashboard URL (with its token).
 * @param project - Project name, if any.
 * @returns The URL to open.
 */
export function withProject(url: string, project: string | undefined): string {
	if (project === undefined) return url;
	const target = new URL(url);
	target.searchParams.set("project", project);
	return target.toString();
}

/**
 * Bare `locastack`: run doctor (in a terminal, failing checks lead to the
 * setup offer; on success it carries on), register `--project` if given, then reuse a
 * live dashboard (`~/.locastack/dashboard.json` + health probe) or start one
 * on 127.0.0.1 (first free port ≥ 4488, random session token), print its URL,
 * open the browser unless `--no-open`, and stay in the foreground. Ctrl+C
 * stops only the server; containers keep running.
 *
 * @param ctx - IO and deps loader.
 * @param options - Parsed flags.
 * @returns Ok after a clean shutdown (or when an instance was reused),
 *   OpError when registration or startup failed.
 */
export async function runDashboard(
	ctx: CommandContext,
	options: DashboardCommandOptions,
): Promise<ExitCode> {
	const { io } = ctx;
	const deps = await ctx.loadDeps();
	let report = await deps.ops.runDoctor(deps.doctor);
	if (!options.json) printDoctor(ctx, report);
	let outcome: SetupFlowOutcome | undefined;
	if (!report.ok && !options.json && io.isTTY) {
		// Offer to start or install Docker (every command shown, explicit yes).
		outcome = await offerSetup(io, deps, report);
		if (outcome.status === "ready" && outcome.report !== undefined)
			report = outcome.report;
	}
	if (!report.ok) {
		// Without Docker (or Compose) the dashboard cannot manage anything:
		// stop here with the fix hints instead of opening an empty UI.
		if (options.json)
			writeJson(io.stdout, { ok: false, doctor: report }, false);
		else closingHint(ctx, outcome);
		return Exit.OpError;
	}

	let project: string | undefined;
	if (options.project !== undefined) {
		const registered = await registerProjectDir(
			deps,
			resolve(io.cwd(), options.project),
		);
		if (!registered.ok) {
			renderOpError(io, registered.error, options.json);
			return Exit.OpError;
		}
		project = registered.value;
	}

	const launcher = deps.dashboard;
	const running = await launcher.findRunning();
	if (running !== null) {
		const url = withProject(running.url, project);
		if (options.json)
			writeJson(
				io.stdout,
				{
					ok: true,
					dashboard: { url, port: running.port, reused: true },
					doctor: report,
				},
				false,
			);
		else
			writeLine(
				io.stdout,
				`${theme.ok("●")} Dashboard already running (pid ${running.pid}): ${url}`,
			);
		if (options.open) await openQuietly(ctx, url, options.json);
		return Exit.Ok;
	}

	const port =
		options.port ?? (await launcher.findFreePort(DEFAULT_DASHBOARD_PORT));
	if (port === undefined) {
		renderStartError(
			ctx,
			`No free port found from ${DEFAULT_DASHBOARD_PORT}; pass --port <n>.`,
			options.json,
		);
		return Exit.OpError;
	}
	let server: Awaited<ReturnType<typeof launcher.start>>;
	try {
		server = await launcher.start({ port, token: launcher.createToken() });
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		renderStartError(
			ctx,
			`Could not start the dashboard on 127.0.0.1:${port}: ${reason}`,
			options.json,
		);
		return Exit.OpError;
	}
	const url = withProject(server.url, project);
	if (options.json) {
		writeJson(
			io.stdout,
			{
				ok: true,
				dashboard: { url, port: server.port, reused: false },
				doctor: report,
			},
			false,
		);
	} else {
		writeLine(io.stdout, `${theme.ok("●")} Dashboard: ${theme.strong(url)}`);
		if (!server.servesSpa)
			writeLine(
				io.stdout,
				theme.warn(
					"  The dashboard is not built: run `bun run build` in packages/dashboard, or `bun run dev` there and open http://127.0.0.1:5173/?t=<token>.",
				),
			);
		writeLine(
			io.stdout,
			theme.muted("  Ctrl+C stops the dashboard; your services keep running."),
		);
	}
	if (options.open) await openQuietly(ctx, url, options.json);
	await launcher.waitForShutdown();
	await server.stop();
	if (!options.json) writeLine(io.stdout, theme.muted("Dashboard stopped."));
	return Exit.Ok;
}

function printDoctor(ctx: CommandContext, report: DoctorReport): void {
	const output = ctx.io.stdout;
	log.message(`${theme.strong("LocaStack")}  ${formatDoctorSummary(report)}`, {
		output,
	});
	printFailingChecks(ctx, report);
}

function printFailingChecks(ctx: CommandContext, report: DoctorReport): void {
	const output = ctx.io.stdout;
	for (const check of report.checks.filter((c) => c.status === "fail")) {
		log.warn(check.fix ? `${check.label}: ${check.fix}` : check.label, {
			output,
		});
	}
}

/**
 * The one closing line when bare `locastack` stops because Docker is not
 * usable, matching how the setup offer ended (none made: non-TTY or
 * nothing automatable).
 */
function closingHint(
	ctx: CommandContext,
	outcome: SetupFlowOutcome | undefined,
): void {
	const { stderr } = ctx.io;
	switch (outcome?.status) {
		case "declined":
			// The flow already said "Nothing else was run. Run `locastack setup` …".
			return;
		case "relogin":
			writeLine(
				stderr,
				theme.warn(
					"Log out and back in (or run `newgrp docker`), then run `locastack`.",
				),
			);
			return;
		case "failed":
			if (outcome.report !== undefined) printFailingChecks(ctx, outcome.report);
			writeLine(
				stderr,
				theme.fail(
					"Setup did not make Docker usable: fix the checks above, then run `locastack` again.",
				),
			);
			return;
		default:
			writeLine(
				stderr,
				theme.fail("Fix the failing checks above, then run `locastack` again."),
			);
	}
}

async function openQuietly(
	ctx: CommandContext,
	url: string,
	json: boolean,
): Promise<void> {
	const deps = await ctx.loadDeps();
	try {
		await deps.dashboard.openBrowser(url);
	} catch {
		if (!json)
			writeLine(
				ctx.io.stderr,
				theme.warn("Could not open a browser; open the URL above."),
			);
	}
}

function renderStartError(
	ctx: CommandContext,
	message: string,
	json: boolean,
): void {
	if (json)
		writeJson(ctx.io.stdout, {
			ok: false,
			error: { code: "DASHBOARD_START", message },
		});
	else writeLine(ctx.io.stderr, theme.fail(message));
}
