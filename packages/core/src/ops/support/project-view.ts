import type { ServiceDefinition } from "../../catalog/catalog.model";
import type { StateFile } from "../../ports/state.port";
import type { ResolvedStack } from "../../resolve/resolved.model";
import { resolveStack } from "../../resolve/resolver";
import { ioErrorFrom } from "../../shared/op-error";
import { err, ok, type Result } from "../../shared/result";
import type { Stack } from "../../stack/stack.model";
import type { ProjectViewDeps } from "../ops.contract";
import { loadDefinitions } from "./catalog";

/** A project evaluated without mutating anything. */
export interface ProjectView {
	/** The resolved stack (contains secrets; never log). */
	readonly resolved: ResolvedStack;
	/** Persisted state it was resolved against. */
	readonly state: StateFile;
	/** The merged catalog. */
	readonly definitions: readonly ServiceDefinition[];
}

/**
 * Resolves a project read-only (pinned ports, stored secrets).
 *
 * @param deps - View ports.
 * @param stack - The project stack.
 * @param unprovisioned - `placeholder` shows never-started services with port
 *   0 and masked secrets; `error` refuses them (`INVALID_STACK`).
 * @returns The view, or `INVALID_CATALOG` / `IO` / `INVALID_STACK`.
 */
export async function readProjectView(
	deps: ProjectViewDeps,
	stack: Stack,
	unprovisioned: "error" | "placeholder",
): Promise<Result<ProjectView>> {
	const definitions = await loadDefinitions(deps.catalog);
	if (!definitions.ok) return definitions;
	let state: StateFile;
	let secrets: Record<string, string>;
	try {
		state = await deps.state.read();
		secrets = await deps.secrets.read(stack.name);
	} catch (cause) {
		return err(
			ioErrorFrom(`Could not read state or secrets of "${stack.name}"`, cause, {
				stack: stack.name,
			}),
		);
	}
	const resolved = resolveStack({
		stack,
		definitions: definitions.value,
		state,
		secrets,
		unprovisioned,
	});
	if (!resolved.ok) return resolved;
	return ok({
		resolved: resolved.value,
		state,
		definitions: definitions.value,
	});
}
