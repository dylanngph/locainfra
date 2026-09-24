import { log } from "@clack/prompts";
import {
	type CommandStep,
	formatCommandStep,
	type Progress,
	type RuntimeProvider,
	type SetupPlan,
} from "@locastack/core";
import type { CliIo } from "../../cli.types";
import { fixHint, writeLine } from "../../ui/output";
import type { ProgressOutcome, ProgressRenderer } from "../../ui/progress";
import { glyph, theme } from "../../ui/theme";

/** Human names of the runtimes, as shown in prompts and plans. */
export const RUNTIME_LABELS: Readonly<Record<RuntimeProvider, string>> = {
	colima: "Colima",
	"docker-desktop": "Docker Desktop",
	orbstack: "OrbStack",
	"docker-engine": "Docker Engine",
};

/** One-line hints shown next to each runtime in the runtime select. */
export const RUNTIME_HINTS: Readonly<Record<RuntimeProvider, string>> = {
	colima: "open source, command line only (recommended)",
	"docker-desktop":
		"Docker's desktop app; license terms apply to larger companies",
	orbstack: "fast desktop app; free for personal use",
	"docker-engine": "native Linux daemon",
};

/**
 * The line that describes a plan as a question, e.g.
 * `Docker is not running. Start Colima now?`.
 *
 * @param plan - A `start` or `install` plan.
 * @returns The confirmation question.
 */
export function setupQuestion(plan: SetupPlan): string {
	const name =
		plan.provider === undefined ? undefined : RUNTIME_LABELS[plan.provider];
	const count = plan.steps.length;
	const commands = `${count} command${count === 1 ? "" : "s"} above`;
	if (plan.kind === "start")
		return `Docker is not running. Start ${name ?? "it"} now? (runs the ${commands})`;
	return name === undefined
		? `Apply these fixes now? (runs the ${commands})`
		: `Install Docker with ${name}? (runs the ${commands})`;
}

/**
 * The question of the select that follows a printed plan with runtime
 * choices, e.g. `Docker is not installed. Set it up with Colima?`.
 *
 * @param plan - A `start` or `install` plan with a provider.
 * @returns The question.
 */
export function setupChoiceQuestion(plan: SetupPlan): string {
	const name =
		plan.provider === undefined ? "Docker" : RUNTIME_LABELS[plan.provider];
	const count = plan.steps.length;
	const commands = `the ${count} command${count === 1 ? "" : "s"} above`;
	if (plan.kind === "start")
		return `Docker is not running. Start ${name}? (${commands}, or pick another runtime)`;
	return `Set up Docker with ${name}? (${commands}, or pick another runtime)`;
}

function stepLines(step: CommandStep, index: number): string[] {
	const lines = [
		`  ${theme.strong(`${index + 1}.`)} ${step.title}`,
		`     ${theme.muted("$")} ${theme.accent(formatCommandStep(step))}${
			step.sudo ? ` ${theme.warn("[sudo: asks for your password]")}` : ""
		}`,
	];
	if (step.remoteScript !== undefined)
		lines.push(
			`     ${theme.muted(`downloads ${step.remoteScript.url} to a file first; it only runs in the next step (inspect with: ${step.remoteScript.inspectHint})`)}`,
		);
	if (step.attached && !step.sudo)
		lines.push(
			`     ${theme.muted("runs in this terminal (it may ask questions)")}`,
		);
	// A download step's note repeats the remote-script line above.
	if (step.note !== undefined && step.remoteScript === undefined)
		lines.push(`     ${theme.muted(`note: ${step.note}`)}`);
	return lines;
}

/**
 * Human-readable plan: the reason, every command numbered with its exact
 * argv (sudo marked, remote scripts named with their URL), the other
 * runtimes and what to do afterwards.
 *
 * @param plan - The plan to show.
 * @returns Multi-line text without a trailing newline.
 */
export function formatSetupPlan(plan: SetupPlan): string {
	const provider =
		plan.provider === undefined ? "" : ` · ${RUNTIME_LABELS[plan.provider]}`;
	const out = [
		theme.strong(`Docker setup: ${plan.kind}${provider}`),
		plan.reason,
	];
	if (plan.steps.length > 0) {
		out.push("");
		plan.steps.forEach((step, i) => {
			out.push(...stepLines(step, i));
		});
	}
	if (plan.alternatives.length > 0) {
		out.push(
			"",
			theme.muted(
				`Other runtimes: ${plan.alternatives
					.map((r) => `${RUNTIME_LABELS[r]} (--runtime ${r})`)
					.join(", ")}`,
			),
		);
	}
	if (plan.postNotes.length > 0) {
		out.push(
			"",
			plan.kind === "unsupported" ? "What to do:" : "Afterwards:",
			...plan.postNotes.map((note) => `  - ${note}`),
		);
	}
	return out.join("\n");
}

/**
 * Renders a running setup plan. Steps inherit the terminal, so there is no
 * spinner: each step prints its title (a clack step in a TTY) and its exact
 * command, and the child's own output follows below it.
 */
export class SetupProgressRenderer implements ProgressRenderer {
	private readonly shown = new Set<number>();

	/**
	 * @param io - Process streams.
	 * @param plan - The plan being run (to show each step's command).
	 */
	constructor(
		private readonly io: CliIo,
		private readonly plan: SetupPlan,
	) {}

	/** @param title - Printed as a heading. */
	start(title: string): void {
		if (this.io.isTTY)
			log.info(theme.strong(title), { output: this.io.stdout });
		else writeLine(this.io.stdout, theme.strong(title));
	}

	/** @param event - Step titles with their command; logs, done and errors. */
	event(event: Progress): void {
		const output = this.io.stdout;
		switch (event.kind) {
			case "step": {
				const index = this.plan.steps.findIndex(
					(step, i) => !this.shown.has(i) && step.title === event.message,
				);
				const step = index === -1 ? undefined : this.plan.steps[index];
				if (step !== undefined) this.shown.add(index);
				const text =
					step === undefined
						? event.message
						: `${event.message}\n${theme.muted("$")} ${theme.accent(formatCommandStep(step))}`;
				if (this.io.isTTY) log.step(text, { output });
				else writeLine(output, `${glyph.step} ${text.replace("\n", "\n  ")}`);
				break;
			}
			case "log":
				writeLine(output, theme.muted(`  ${event.message}`));
				break;
			case "done":
				if (this.io.isTTY) log.success(theme.ok(event.message), { output });
				else writeLine(output, theme.ok(`${glyph.ok} ${event.message}`));
				break;
			case "error": {
				const code = event.error
					? ` ${theme.muted(`(${event.error.code})`)}`
					: "";
				const fix = fixHint(event.error?.details);
				if (this.io.isTTY) {
					log.error(`${theme.fail(event.message)}${code}`, { output });
					if (fix) log.message(theme.muted(`fix: ${fix}`), { output });
				} else {
					writeLine(
						this.io.stderr,
						`${theme.fail(`${glyph.fail} ${event.message}`)}${code}`,
					);
					if (fix) writeLine(this.io.stderr, theme.muted(`  fix: ${fix}`));
				}
				break;
			}
		}
	}

	/** Nothing to flush. */
	finish(_outcome: ProgressOutcome): void {}
}
