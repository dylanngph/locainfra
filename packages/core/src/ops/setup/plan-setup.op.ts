import type { PlatformFacts } from "../../ports/platform.port";
import { runDoctor } from "../doctor/run-doctor.op";
import type { PlanSetup } from "../ops.contract";
import type { SetupOptions, SetupPlan } from "../ops.model";
import { buildSetupPlan } from "./build-setup-plan.op";
import { MANUAL_INSTALL_URLS } from "./setup-steps";

/**
 * Inspects the platform, runs doctor (unless `input.report` is given) and
 * returns {@link buildSetupPlan}'s plan. Executes nothing. Never throws: an
 * inspection failure yields `kind: "unsupported"` with the reason.
 */
export const planSetup: PlanSetup = async (deps, input) => {
	let facts: PlatformFacts;
	try {
		facts = await deps.platform.inspect();
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		const plan: SetupPlan = {
			kind: "unsupported",
			alternatives: [],
			reason: `Could not inspect this machine: ${message}`,
			steps: [],
			postNotes: [
				`Run \`locastack doctor\` for details, or install Docker by hand: ${MANUAL_INSTALL_URLS.engine}`,
			],
			needsTerminal: false,
		};
		return plan;
	}
	const report = input.report ?? (await runDoctor(deps.doctor));
	const options: SetupOptions = {
		...(input.runtime === undefined ? {} : { runtime: input.runtime }),
		...(input.startAtLogin === undefined
			? {}
			: { startAtLogin: input.startAtLogin }),
	};
	return buildSetupPlan(facts, report, options);
};
