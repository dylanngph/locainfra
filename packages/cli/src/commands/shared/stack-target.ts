import type { Stack } from "@locastack/core";
import type { CliDeps, CliIo } from "../../cli.types";
import { renderOpError } from "../../ui/output";

/** How a command reports a missing stack. */
export interface StackTargetOptions {
	/** Whether `--json` is active (affects error rendering). */
	readonly json: boolean;
}

/**
 * Runs `discoverStack` for the current directory (walk-up to the nearest
 * `locastack.yaml`) and renders the failure when there is none.
 *
 * @param deps - Composition root.
 * @param io - Process boundary.
 * @param options - Output mode.
 * @returns The stack, or `null` after an error was rendered.
 */
export async function resolveStackTarget(
	deps: CliDeps,
	io: CliIo,
	options: StackTargetOptions,
): Promise<Stack | null> {
	const result = await deps.ops.discoverStack(deps.discover, {
		cwd: io.cwd(),
	});
	if (!result.ok) {
		renderOpError(io, result.error, options.json);
		return null;
	}
	return result.value;
}
