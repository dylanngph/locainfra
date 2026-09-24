import type {
	CommandStep,
	DoctorReport,
	RuntimeProvider,
	SetupPlan,
	SetupStepDecision,
} from "@locastack/core";
import type { CliDeps, CliIo, SelectChoice } from "../../cli.types";
import { writeLine } from "../../ui/output";
import { renderProgress } from "../../ui/progress";
import { theme } from "../../ui/theme";
import { formatDoctorSummary } from "../doctor/doctor.view";
import {
	formatSetupPlan,
	RUNTIME_HINTS,
	RUNTIME_LABELS,
	SetupProgressRenderer,
	setupChoiceQuestion,
	setupQuestion,
} from "./setup.view";

/** How the user's choices are made for a setup run. */
export interface SetupConsentOptions {
	/** `--yes`: no prompt at all; the plan's defaults are used. */
	readonly yes: boolean;
	/** `--runtime`: the runtime is fixed, so no other runtime is offered. */
	readonly runtime?: RuntimeProvider;
	/** `--start-at-login`: fixed, so the Colima "start at login" variant is not offered. */
	readonly startAtLogin?: boolean;
}

/**
 * How a consent-and-run flow ended:
 * - `ready`: the plan ran and a fresh doctor report passes (`report`);
 * - `relogin`: the plan ran and added the user to the `docker` group, which
 *   only applies after a new login (or `newgrp docker`), so Docker is not
 *   usable from this process yet;
 * - `nothing`: Docker already worked (`kind: "none"`);
 * - `unsupported`: no automated remedy (the plan's reason and notes were printed);
 * - `declined`: the user said no or cancelled a prompt (nothing ran, or the run stopped before a step);
 * - `failed`: a step failed or Docker still is not usable (`report` when doctor ran).
 */
export type SetupFlowStatus =
	| "ready"
	| "relogin"
	| "nothing"
	| "unsupported"
	| "declined"
	| "failed";

/** Result of {@link consentAndRunSetup}. */
export interface SetupFlowOutcome {
	/** How the flow ended. */
	readonly status: SetupFlowStatus;
	/** The plan finally consented to (after the runtime choice), or the one declined. */
	readonly plan: SetupPlan;
	/** Doctor report after the run, when one was taken. */
	readonly report?: DoctorReport;
}

type ScriptChoice = "run" | "inspect" | "cancel";

/**
 * Before the step that executes a downloaded script, offer to read it first
 * (opens it in `less`, then asks again). `--yes` runs it without asking.
 */
function inspectBeforeRunning(
	io: CliIo,
	deps: CliDeps,
	yes: boolean,
): (
	step: CommandStep,
	index: number,
	plan: SetupPlan,
) => Promise<SetupStepDecision> {
	return async (_step, index, plan) => {
		const script = plan.steps[index - 1]?.remoteScript;
		if (yes || script === undefined) return "run";
		writeLine(
			io.stdout,
			theme.muted(
				`Downloaded ${script.url} to ${script.path}. You can read it before it runs: ${script.inspectHint}`,
			),
		);
		const choices: SelectChoice<ScriptChoice>[] = [
			{ value: "run", label: "Run it" },
			{ value: "inspect", label: "Show it first", hint: `less ${script.path}` },
			{ value: "cancel", label: "Cancel setup" },
		];
		for (;;) {
			const choice = await io.prompter.select(
				`Run the downloaded installer ${script.path}?`,
				choices,
				"run",
			);
			if (choice === "run") return "run";
			if (choice !== "inspect") return "abort";
			await deps.setup.runner.run(
				{
					id: "setup.inspect-script",
					title: "Showing the installer script",
					argv: ["less", script.path],
				},
				{ attached: true },
			);
		}
	};
}

/** A value of the plan select: a runtime, Colima with start at login, or "Not now". */
type PlanChoice = RuntimeProvider | "colima-at-login" | "decline";

/**
 * Options of the one select that follows the printed plan: the shown plan's
 * runtime first (picking it is the consent to the commands just shown),
 * then the other runtimes, Colima's start-at-login variant, and "Not now".
 * Empty when there is nothing to choose (a plain confirm is asked instead).
 */
function planChoices(
	plan: SetupPlan,
	options: SetupConsentOptions,
): SelectChoice<PlanChoice>[] {
	const provider = plan.provider;
	if (provider === undefined) return [];
	const verb = plan.kind === "start" ? "Start" : "Install with";
	const runtimes =
		options.runtime === undefined
			? [provider, ...plan.alternatives]
			: [provider];
	const choices: SelectChoice<PlanChoice>[] = [];
	for (const runtime of runtimes) {
		const hint =
			plan.kind === "start"
				? runtime === provider
					? "runs the commands above"
					: "installed; shows its commands first"
				: runtime === provider
					? `${RUNTIME_HINTS[runtime]}; runs the commands above`
					: `${RUNTIME_HINTS[runtime]}; shows its commands first`;
		choices.push({
			value: runtime,
			label: `${verb} ${RUNTIME_LABELS[runtime]}`,
			hint,
		});
		if (
			runtime === "colima" &&
			plan.kind === "install" &&
			options.startAtLogin === undefined
		) {
			choices.push({
				value: "colima-at-login",
				label: `${verb} Colima, start it at login`,
				hint: "brew services start colima; shows its commands first",
			});
		}
	}
	if (choices.length < 2) return [];
	return [...choices, { value: "decline", label: "Not now" }];
}

/**
 * Asks for consent to the plan already printed. With a choice to make (other
 * runtimes, Colima at login) it is one select whose first option runs the
 * shown commands; any other pick is re-planned, printed and confirmed on its
 * own. Otherwise a plain confirm. `--yes` asks nothing.
 *
 * @returns The consented plan, or `undefined` when the user said no or cancelled.
 */
async function consentTo(
	io: CliIo,
	deps: CliDeps,
	plan: SetupPlan,
	report: DoctorReport,
	options: SetupConsentOptions,
): Promise<SetupPlan | undefined> {
	if (options.yes) return plan;
	const choices = planChoices(plan, options);
	if (choices.length === 0)
		return (await io.prompter.confirm(setupQuestion(plan))) ? plan : undefined;
	const picked = await io.prompter.select(
		setupChoiceQuestion(plan),
		choices,
		choices[0]?.value ?? "decline",
	);
	if (picked === undefined || picked === "decline") return undefined;
	if (picked === plan.provider) return plan;
	const atLogin = picked === "colima-at-login";
	const runtime: RuntimeProvider = atLogin ? "colima" : picked;
	const startAtLogin = atLogin ? true : options.startAtLogin;
	const other = await deps.ops.planSetup(deps.setup, {
		report,
		runtime,
		...(startAtLogin === undefined ? {} : { startAtLogin }),
	});
	writeLine(io.stdout);
	writeLine(io.stdout, formatSetupPlan(other));
	writeLine(io.stdout);
	if (other.kind !== "start" && other.kind !== "install") return other;
	return (await io.prompter.confirm(setupQuestion(other))) ? other : undefined;
}

/**
 * The shared interactive setup flow of `locastack setup`, `locastack doctor`
 * and bare `locastack`: print the plan (reason, every exact command, the
 * other runtimes), then ask (see {@link consentTo}; nothing with `--yes`),
 * run it with the terminal attached (sudo password prompts stay visible),
 * then re-run doctor. The run's `done` event carries the plan's `postNotes`.
 * A cancelled prompt counts as "no".
 *
 * @param io - Process boundary.
 * @param deps - Composition root.
 * @param plan - Plan from `planSetup`.
 * @param report - The doctor report the plan was built from.
 * @param options - `--yes`, `--runtime`, `--start-at-login`.
 * @returns How it ended.
 */
export async function consentAndRunSetup(
	io: CliIo,
	deps: CliDeps,
	plan: SetupPlan,
	report: DoctorReport,
	options: SetupConsentOptions,
): Promise<SetupFlowOutcome> {
	if (plan.kind === "none") return { status: "nothing", plan };
	if (plan.kind === "unsupported") {
		writeLine(io.stderr, formatSetupPlan(plan));
		return { status: "unsupported", plan };
	}
	writeLine(io.stdout, formatSetupPlan(plan));
	writeLine(io.stdout);
	const chosen = await consentTo(io, deps, plan, report, options);
	if (chosen === undefined) return declined(io, plan);
	if (chosen.kind === "none") return { status: "nothing", plan: chosen };
	if (chosen.kind === "unsupported")
		return { status: "unsupported", plan: chosen };

	const outcome = await renderProgress(
		deps.ops.runSetupPlan(deps.setup, {
			plan: chosen,
			attached: true,
			beforeStep: inspectBeforeRunning(io, deps, options.yes),
		}),
		new SetupProgressRenderer(io, chosen),
		chosen.kind === "start" ? "Starting Docker" : "Setting up Docker",
	);
	if (outcome.last?.error?.code === "SETUP_CANCELLED")
		return declined(io, chosen);
	const after = await deps.ops.runDoctor(deps.doctor);
	writeLine(io.stdout, formatDoctorSummary(after));
	if (outcome.ok && after.ok)
		return { status: "ready", plan: chosen, report: after };
	// The done event already told the user to log in again.
	if (outcome.ok && chosen.requiresRelogin === true)
		return { status: "relogin", plan: chosen, report: after };
	return { status: "failed", plan: chosen, report: after };
}

function declined(io: CliIo, plan: SetupPlan): SetupFlowOutcome {
	writeLine(
		io.stderr,
		theme.muted(
			"Nothing else was run. Run `locastack setup` when you are ready.",
		),
	);
	return { status: "declined", plan };
}

/**
 * The offer made by `locastack doctor` and bare `locastack` when checks
 * fail: only in a terminal and never with `--json`. Plans from the report
 * already taken, then runs {@link consentAndRunSetup} (which asks before
 * anything runs).
 *
 * @param io - Process boundary.
 * @param deps - Composition root.
 * @param report - The failing doctor report.
 * @returns How it ended (`unsupported`/`nothing` when there was nothing to offer).
 */
export async function offerSetup(
	io: CliIo,
	deps: CliDeps,
	report: DoctorReport,
): Promise<SetupFlowOutcome> {
	const plan = await deps.ops.planSetup(deps.setup, { report });
	if (plan.kind === "unsupported" || plan.kind === "none")
		return { status: plan.kind === "none" ? "nothing" : "unsupported", plan };
	writeLine(io.stdout);
	return consentAndRunSetup(io, deps, plan, report, { yes: false });
}
