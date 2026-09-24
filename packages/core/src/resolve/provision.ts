import type { ServiceDefinition } from "../catalog/catalog.model";
import type { Clock, PortProbe, SecretGenerator } from "../ports/files.port";
import type { SecretStore } from "../ports/secrets.port";
import type { StateReader, StateWriter } from "../ports/state.port";
import { OpError } from "../shared/op-error";
import { err, type Result } from "../shared/result";
import type { Stack } from "../stack/stack.model";
import { planStack } from "./plan";
import { allocatePorts } from "./ports/allocator";
import type { ResolvedStack } from "./resolved.model";
import { resolveStack } from "./resolver";
import { ensureSecrets, instanceSecretKey } from "./secrets/generator";

/** Ports needed by {@link provisionStack}. */
export interface ProvisionDeps {
	/** Persisted state (ports pinned here). */
	readonly state: StateReader & StateWriter;
	/** Secret persistence. */
	readonly secrets: SecretStore;
	/** Host port probe. */
	readonly probe: PortProbe;
	/** Secret generator. */
	readonly gen: SecretGenerator;
	/** Time source. */
	readonly clock: Clock;
}

/**
 * Plans, allocates and pins ports, generates missing secrets, then resolves
 * the stack. The write path used before rendering (`up`, add service).
 *
 * @param deps - State, secrets, probe, generator and clock.
 * @param stack - The stack.
 * @param definitions - The merged catalog.
 * @returns The resolved stack, or the first error.
 */
export async function provisionStack(
	deps: ProvisionDeps,
	stack: Stack,
	definitions: readonly ServiceDefinition[],
): Promise<Result<ResolvedStack>> {
	const plan = planStack(stack, definitions);
	if (!plan.ok) return plan;

	const ports = await allocatePorts(deps, { stack, services: plan.value });
	if (!ports.ok) return ports;

	const secrets = await ensureSecrets(
		{ store: deps.secrets, gen: deps.gen },
		{
			stack: stack.name,
			names: plan.value.flatMap((s) =>
				s.definition.secrets.map((name) => instanceSecretKey(s.name, name)),
			),
		},
	);
	if (!secrets.ok) return secrets;

	try {
		const state = await deps.state.read();
		return resolveStack({ stack, definitions, state, secrets: secrets.value });
	} catch (cause) {
		return err(
			new OpError("IO", "Could not read LocaStack state", {
				cause,
				details: { stack: stack.name },
			}),
		);
	}
}
