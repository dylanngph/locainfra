import type { Stack } from "@locainfra/core";
import type { CliDeps, CliIo } from "../../cli.types";
import { renderOpError } from "../../ui/output";

/** Which stack a command targets. */
export interface StackTargetOptions {
	/** Target `~/.locainfra/global.yaml` instead of walking up from cwd. */
	readonly global: boolean;
	/** Whether `--json` is active (affects error rendering). */
	readonly json: boolean;
}

/**
 * Runs `discoverStack` for the current directory (or the global stack) and
 * renders the failure when there is none.
 *
 * @param deps - Composition root.
 * @param io - Process boundary.
 * @param options - Global flag and output mode.
 * @returns The stack, or `null` after an error was rendered.
 */
export async function resolveStackTarget(
	deps: CliDeps,
	io: CliIo,
	options: StackTargetOptions,
): Promise<Stack | null> {
	const result = await deps.ops.discoverStack(deps.discover, {
		cwd: io.cwd(),
		global: options.global,
	});
	if (!result.ok) {
		renderOpError(io, result.error, options.json);
		return null;
	}
	return result.value;
}
