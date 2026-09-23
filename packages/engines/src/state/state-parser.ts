import { OpError, StateFile } from "@locainfra/core";
import { Value } from "@sinclair/typebox/value";

/** Turns a JSON pointer (`/stacks/a/ports/x`) into a dotted path (`stacks.a.ports.x`). */
function dottedPath(pointer: string): string {
	const path = pointer
		.split("/")
		.slice(1)
		.map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
		.join(".");
	return path === "" ? "$" : path;
}

/**
 * Validates parsed `state.json` content against core's `StateFile` schema.
 * Missing `projects`/`stacks` default to empty; unknown keys are dropped.
 * Validation runs before cleaning, so a wrongly typed value is reported
 * rather than silently removed.
 *
 * @param raw - Parsed JSON.
 * @returns A well-formed {@link StateFile} (a new object; `raw` is not mutated).
 * @throws {OpError} `IO` naming the first invalid path (never its value).
 */
export function parseStateFile(raw: unknown): StateFile {
	const value = Value.Default(StateFile, Value.Clone(raw));
	const first = Value.Errors(StateFile, value).First();
	if (first !== undefined) {
		const path = dottedPath(first.path);
		throw new OpError(
			"IO",
			`state.json is invalid at ${path}: ${first.message.toLowerCase()}`,
			{ details: { path } },
		);
	}
	return Value.Clean(StateFile, value) as StateFile;
}
