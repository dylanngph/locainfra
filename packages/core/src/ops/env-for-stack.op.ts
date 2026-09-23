import { deriveEnv } from "../env/deriver";
import { getEnvFormatter } from "../env/formats/registry";
import { resolveStack } from "../resolve/resolver";
import { ioErrorFrom, OpError } from "../shared/op-error";
import { err, ok } from "../shared/result";
import { checkProjectOwner } from "../stack/project-registry";
import type { EnvForStack } from "./ops.contract";

/**
 * Renders a stack's exported connection variables (after `link.names`
 * renames and `<INSTANCE>_` collision prefixes, in stack file order) as
 * dotenv, shell `export` lines, or JSON. Read-only: ports and
 * secrets must already be provisioned (`INVALID_STACK` with a fix hint
 * otherwise).
 */
export const envForStack: EnvForStack = async (deps, input) => {
	const { stack } = input;
	const owner = await checkProjectOwner(deps, stack);
	if (!owner.ok) return owner;
	let definitions: Awaited<ReturnType<typeof deps.catalog.definitions>>;
	try {
		definitions = await deps.catalog.definitions();
	} catch (cause) {
		return err(
			new OpError("INVALID_CATALOG", "Could not load the service catalog", {
				cause,
			}),
		);
	}

	let state: Awaited<ReturnType<typeof deps.state.read>>;
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

	const resolved = resolveStack({ stack, definitions, state, secrets });
	if (!resolved.ok) return resolved;
	const vars = deriveEnv(
		resolved.value,
		stack.file.link,
		Object.keys(stack.file.services),
	);
	if (!vars.ok) return vars;
	return ok(getEnvFormatter(input.format).format(vars.value));
};
