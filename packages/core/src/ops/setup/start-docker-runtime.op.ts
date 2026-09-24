import { OpError } from "../../shared/op-error";
import { errorProgress, withTimestamp } from "../../shared/progress";
import type { StartDockerRuntime } from "../ops.contract";
import { planSetup } from "./plan-setup.op";
import { runSetupPlan } from "./run-setup-plan.op";

/**
 * The `start` subset of setup (dashboard Start Docker): plans, then runs
 * only a `start` plan. `none` → `done`; `install` → `DOCKER_NOT_INSTALLED`
 * (fix: `locastack setup`); `unsupported` → `SETUP_UNSUPPORTED`; a sudo
 * start without a terminal → `SETUP_NEEDS_TERMINAL` naming the command.
 * Never installs anything.
 */
export const startDockerRuntime: StartDockerRuntime = async function* (
	deps,
	input,
) {
	const clock = deps.doctor.clock;
	const plan = await planSetup(
		deps,
		input.provider === undefined ? {} : { runtime: input.provider },
	);
	if (plan.kind === "none") {
		yield withTimestamp(
			{ kind: "done", message: "Docker is already running." },
			clock,
		);
		return;
	}
	if (plan.kind === "install") {
		yield errorProgress(
			new OpError("DOCKER_NOT_INSTALLED", plan.reason, {
				details: {
					...(plan.provider ? { provider: plan.provider } : {}),
					fix: "Run `locastack setup` in a terminal: it shows every command, asks, then installs and starts Docker.",
				},
			}),
			clock,
		);
		return;
	}
	yield* runSetupPlan(deps, {
		plan,
		attached: input.attached,
		...(input.signal === undefined ? {} : { signal: input.signal }),
	});
};
