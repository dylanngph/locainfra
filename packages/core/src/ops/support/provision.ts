import type { ServiceDefinition } from "../../catalog/catalog.model";
import { provisionStack } from "../../resolve/provision";
import type { ResolvedStack } from "../../resolve/resolved.model";
import type { OpError } from "../../shared/op-error";
import { err, ok, type Result } from "../../shared/result";
import type { Stack } from "../../stack/stack.model";
import type { ResolveDeps } from "../ops.contract";
import { writeComposeProject } from "./compose";
import { withPortSuggestion } from "./ports";

/** Result of {@link provisionAndRender}. */
export interface RenderedProject {
	/** The resolved stack (contains secrets; never log). */
	readonly resolved: ResolvedStack;
	/** Absolute path of the written `docker-compose.yml`. */
	readonly composeFile: string;
}

/**
 * Pins ports, generates missing secrets, resolves the stack and writes its
 * compose project. A `PORT_CONFLICT` gets a `suggestedPort` for the
 * dashboard's "Use port N" fix.
 *
 * @param deps - Resolve ports.
 * @param stack - The project stack.
 * @param definitions - The merged catalog.
 * @returns The resolved stack and compose file, or the first error.
 */
export async function provisionAndRender(
	deps: ResolveDeps,
	stack: Stack,
	definitions: readonly ServiceDefinition[],
): Promise<Result<RenderedProject>> {
	const resolved = await provisionStack(deps, stack, definitions);
	if (!resolved.ok) {
		return err(await suggestPort(deps, stack, definitions, resolved.error));
	}
	const composeFile = await writeComposeProject(deps, resolved.value);
	if (!composeFile.ok) return composeFile;
	return ok({ resolved: resolved.value, composeFile: composeFile.value });
}

async function suggestPort(
	deps: ResolveDeps,
	stack: Stack,
	definitions: readonly ServiceDefinition[],
	error: OpError,
): Promise<OpError> {
	if (error.code !== "PORT_CONFLICT") return error;
	try {
		const state = await deps.state.read();
		const byId = new Map(definitions.map((d) => [d.id, d]));
		return await withPortSuggestion(error, deps.probe, state, (service) => {
			const type = stack.file.services[service]?.type;
			return type === undefined ? undefined : byId.get(type);
		});
	} catch {
		return error;
	}
}
