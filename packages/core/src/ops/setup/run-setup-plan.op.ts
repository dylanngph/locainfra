import type { CommandStep, ProcessRunResult } from "../../ports/process.port";
import { formatCommandStep } from "../../shared/command-format";
import { OpError, type OpErrorCode } from "../../shared/op-error";
import { errorProgress, withTimestamp } from "../../shared/progress";
import type { Progress } from "../../shared/progress.model";
import { DOCTOR_CHECK, type DoctorReport } from "../doctor/doctor.model";
import { runDoctor } from "../doctor/run-doctor.op";
import type {
	RunSetupPlan,
	RunSetupPlanDeps,
	RunSetupPlanInput,
} from "../ops.contract";
import {
	DOCKER_START_TIMEOUT_MS,
	SETUP_STEP_TIMEOUT_MS,
	type SetupPlan,
} from "../ops.model";
import { MANUAL_INSTALL_URLS, RUNTIME_LABELS, SETUP_STEP } from "./setup-steps";

/** Captured output lines forwarded as `log` events per step (the tail). */
const MAX_LOG_LINES = 200;
// ANSI escape sequences (colours, cursor moves) in captured output.
const ANSI = new RegExp(
	`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`,
	"g",
);

function describe(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Splits captured output into display lines: ANSI stripped, carriage-return
 * progress bars collapsed to their last state, blank lines dropped, the last
 * {@link MAX_LOG_LINES} kept.
 *
 * @param output - Captured stdout+stderr.
 * @returns Lines to stream as `log` events.
 */
export function outputLines(output: string): string[] {
	const lines = output
		.replace(ANSI, "")
		.split(/\n/)
		.map((line) => (line.split("\r").pop() ?? "").trimEnd())
		.filter((line) => line.trim().length > 0);
	return lines.slice(-MAX_LOG_LINES);
}

/** Fix of a `colima start` that failed because Colima/Lima are x86_64 builds under Rosetta. */
export const ROSETTA_COLIMA_FIX =
	"Colima was installed with the Intel Homebrew at /usr/local and cannot run under Rosetta. Run `locastack setup` again: it will install the native Homebrew at /opt/homebrew and reinstall Colima from it (or use `locastack setup --runtime docker-desktop`).";

/**
 * Whether a failed Colima start printed Lima's Rosetta refusal
 * ("limactl is running under rosetta, please reinstall lima with native arch").
 * The start step sets `tee`, so its output is captured even in a terminal.
 */
function colimaUnderRosetta(
	step: CommandStep,
	result: ProcessRunResult | undefined,
): boolean {
	return (
		(step.id === SETUP_STEP.colimaStart ||
			step.id === SETUP_STEP.colimaStartAtLogin) &&
		/running under rosetta/i.test(result?.output ?? "")
	);
}

/** Manual remedy shown when a step fails. */
export function stepFailureFix(
	step: CommandStep,
	result?: ProcessRunResult,
): string {
	const command = formatCommandStep(step);
	const retry = "then run `locastack setup` again.";
	if (result?.exitCode === 127) {
		return `\`${step.argv[0]}\` was not found. Install it (or fix PATH), ${retry}`;
	}
	if (colimaUnderRosetta(step, result)) return ROSETTA_COLIMA_FIX;
	switch (step.id) {
		case SETUP_STEP.brewDownload:
		case SETUP_STEP.engineDownload:
			return `Could not download ${step.remoteScript?.url ?? "the installer"}. Check your network connection, ${retry}`;
		case SETUP_STEP.brewInstall:
			return `Homebrew installation was cancelled or failed. Install Homebrew from ${MANUAL_INSTALL_URLS.homebrew}, ${retry}`;
		case SETUP_STEP.engineInstall:
			return `Docker's install script failed; read its output above, fix the cause (or install Docker Engine by hand: ${MANUAL_INSTALL_URLS.engine}), ${retry}`;
		case SETUP_STEP.groupAdd:
			return `Run \`${command}\` yourself, then log out and back in (or run \`newgrp docker\`).`;
	}
	const sudo =
		step.sudo === true
			? " (a wrong sudo password or Ctrl-C also stops setup)"
			: "";
	return `Run \`${command}\` yourself to see why it failed${sudo}, ${retry}`;
}

/** Remedy when the daemon did not answer in time after the steps. */
function waitFix(plan: SetupPlan): string {
	switch (plan.provider) {
		case "docker-desktop":
			return "Docker Desktop may still be finishing its setup in its own window (accept its terms). Once it shows that the engine is running, run `locastack doctor`.";
		case "colima":
			return "Check `colima status` (and the output of `colima start`), then run `locastack doctor`.";
		case "orbstack":
			return "Open OrbStack and finish its setup, then run `locastack doctor`.";
		case "docker-engine":
			return "Check `sudo systemctl status docker` (or `sudo service docker status`), then run `locastack doctor`.";
		default:
			return "Start Docker, then run `locastack doctor`.";
	}
}

/** Error code of the first failing doctor check. */
function codeOfCheck(id: string): OpErrorCode {
	if (id === DOCTOR_CHECK.composePlugin) return "COMPOSE_MISSING";
	if (id === DOCTOR_CHECK.composeVersion) return "COMPOSE_TOO_OLD";
	return "DOCKER_UNREACHABLE";
}

function engineOf(report: DoctorReport): string {
	const daemon = report.checks.find((c) => c.id === DOCTOR_CHECK.daemon);
	return daemon?.detail ?? "the daemon answers";
}

function withNotes(message: string, notes: readonly string[]): string {
	return [message, ...notes].join("\n");
}

/** A failure's fix followed by the plan's notes (e.g. put Homebrew on PATH). */
function fixWithNotes(fix: string, plan: SetupPlan): string {
	return [fix, ...plan.postNotes].join(" ");
}

async function* execute(
	deps: RunSetupPlanDeps,
	input: RunSetupPlanInput,
): AsyncIterable<Progress> {
	const { plan, signal, attached } = input;
	const clock = deps.doctor.clock;
	const event = (e: Progress): Progress => withTimestamp(e, clock);
	const fail = (
		code: OpErrorCode,
		message: string,
		details?: Record<string, unknown>,
	): Progress =>
		errorProgress(
			new OpError(code, message, details === undefined ? {} : { details }),
			clock,
		);
	const cancelled = (step?: CommandStep): Progress =>
		fail(
			"SETUP_CANCELLED",
			step ? `Setup cancelled before: ${step.title}` : "Setup cancelled",
			{
				...(step ? { stepId: step.id } : {}),
				fix: "Run `locastack setup` again when you are ready.",
			},
		);

	if (plan.kind === "none") {
		yield event({ kind: "done", message: "Docker is already running." });
		return;
	}
	if (plan.kind === "unsupported") {
		yield fail("SETUP_UNSUPPORTED", plan.reason, {
			notes: plan.postNotes,
			...(plan.postNotes.length > 0 ? { fix: plan.postNotes.join(" ") } : {}),
		});
		return;
	}
	if (!attached && plan.needsTerminal) {
		const commands = plan.steps
			.filter((s) => s.sudo === true || s.attached === true)
			.map(formatCommandStep);
		const names = commands.map((c) => `\`${c}\``).join(", ");
		yield fail(
			"SETUP_NEEDS_TERMINAL",
			`${plan.reason} This needs a terminal (sudo or an interactive installer).`,
			{
				commands,
				fix: `Run \`locastack setup\` in a terminal (it runs ${names}), or run ${commands.length > 1 ? "them" : "it"} yourself.`,
			},
		);
		return;
	}

	const total = plan.steps.length;
	for (const [index, step] of plan.steps.entries()) {
		if (signal?.aborted) {
			yield cancelled(step);
			return;
		}
		if (input.beforeStep) {
			const decision = await input.beforeStep(step, index, plan);
			if (decision === "abort") {
				yield cancelled(step);
				return;
			}
		}
		yield event({
			kind: "step",
			message: step.title,
			percent: Math.round((index / total) * 100),
		});
		const timeoutMs =
			step.timeoutMs ?? (attached ? undefined : SETUP_STEP_TIMEOUT_MS);
		let result: ProcessRunResult;
		try {
			result = await deps.runner.run(step, {
				attached,
				...(signal === undefined ? {} : { signal }),
				...(timeoutMs === undefined ? {} : { timeoutMs }),
			});
		} catch (cause) {
			yield fail(
				"SETUP_STEP_FAILED",
				`${step.title} failed: ${describe(cause)}`,
				{
					stepId: step.id,
					command: formatCommandStep(step),
					exitCode: -1,
					stepTimedOut: false,
					fix: stepFailureFix(step),
				},
			);
			return;
		}
		if (!attached && result.output !== undefined) {
			for (const line of outputLines(result.output)) {
				yield event({ kind: "log", message: line });
			}
		}
		if (signal?.aborted) {
			yield cancelled();
			return;
		}
		if (result.exitCode !== 0 || result.timedOut) {
			const why = result.timedOut
				? "timed out"
				: result.exitCode === 127
					? `\`${step.argv[0]}\` was not found`
					: `exit code ${result.exitCode}`;
			yield fail("SETUP_STEP_FAILED", `${step.title} failed (${why})`, {
				stepId: step.id,
				command: formatCommandStep(step),
				exitCode: result.exitCode,
				stepTimedOut: result.timedOut,
				fix: stepFailureFix(step, result),
			});
			return;
		}
		yield event({ kind: "log", message: `Done: ${step.title}` });
	}

	// A Homebrew prefix that is not on this process's PATH (installed by this
	// plan, or its shellenv never added): without it the daemon wait's
	// `docker context inspect` and doctor's `which docker` miss the new CLI.
	if (plan.pathAdditions !== undefined && plan.pathAdditions.length > 0) {
		deps.runner.prependPath(plan.pathAdditions);
	}

	// With a fresh docker group membership this process cannot reach the
	// socket until a new login, so waiting would only time out.
	if (plan.requiresRelogin !== true) {
		const timeoutMs = input.waitTimeoutMs ?? DOCKER_START_TIMEOUT_MS;
		const name = plan.provider ? RUNTIME_LABELS[plan.provider] : "Docker";
		yield event({
			kind: "step",
			message: `Waiting for ${name} to answer (up to ${Math.round(timeoutMs / 1000)} s)`,
		});
		const ready = await deps.waiter.waitForDocker(timeoutMs, signal);
		if (signal?.aborted) {
			yield cancelled();
			return;
		}
		if (!ready) {
			yield fail(
				"DOCKER_START_TIMEOUT",
				`${name} did not answer within ${Math.round(timeoutMs / 1000)} s.`,
				{
					...(plan.provider ? { provider: plan.provider } : {}),
					notes: plan.postNotes,
					fix: fixWithNotes(waitFix(plan), plan),
				},
			);
			return;
		}
	}

	yield event({ kind: "step", message: "Checking Docker" });
	const report = await runDoctor(deps.doctor);
	if (report.ok) {
		yield event({
			kind: "done",
			message: withNotes(
				`Docker is ready: ${engineOf(report)}`,
				plan.postNotes,
			),
		});
		return;
	}
	if (plan.requiresRelogin === true) {
		yield event({
			kind: "done",
			message: withNotes(
				"Setup finished. Docker works for your user after you log out and back in (or run `newgrp docker`).",
				plan.postNotes,
			),
		});
		return;
	}
	const first = report.checks.find((c) => c.status === "fail");
	const id = first?.id ?? DOCTOR_CHECK.daemon;
	yield fail(
		codeOfCheck(id),
		`Setup finished but ${first?.label ?? "Docker"} still fails: ${first?.detail ?? "see locastack doctor"}`,
		{
			checkId: id,
			notes: plan.postNotes,
			fix: fixWithNotes(
				first?.fix ?? "Run `locastack doctor` for details.",
				plan,
			),
		},
	);
}

/**
 * Executes a consented plan: a `step` event per command (captured output as
 * `log` events when not attached), stop at the first failure with
 * `SETUP_STEP_FAILED` and a manual fix, then wait for the daemon (skipped
 * when the plan needs a re-login for the docker group), re-run doctor and
 * end with `done` or `error`. Exactly one terminal event; never throws.
 */
export const runSetupPlan: RunSetupPlan = async function* (deps, input) {
	try {
		yield* execute(deps, input);
	} catch (cause) {
		yield errorProgress(
			new OpError("UNKNOWN", `Setup failed: ${describe(cause)}`, { cause }),
			deps.doctor.clock,
		);
	}
};
