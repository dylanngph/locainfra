import type { SecretGenerator } from "../../ports/files.port";
import type { SecretStore } from "../../ports/secrets.port";
import { OpError } from "../../shared/op-error";
import { err, ok, type Result } from "../../shared/result";

/**
 * Key of one instance's secret in the stack's {@link SecretStore} file (and,
 * prefixed with `LI_SECRET_`, in the compose `.env`): the instance name
 * upper-cased with dashes as `_`, then `__`, then the secret name. Two
 * instances of one type thus never share a password.
 *
 * @param instance - Service instance name, e.g. `main-db`.
 * @param name - Secret name from the definition, e.g. `POSTGRES_PASSWORD`.
 * @returns e.g. `MAIN_DB__POSTGRES_PASSWORD`.
 */
export function instanceSecretKey(instance: string, name: string): string {
	return `${instance.toUpperCase().replaceAll("-", "_")}__${name}`;
}

/** Random bytes per generated secret. */
export const SECRET_BYTES = 32;

/** Ports needed by {@link ensureSecrets}. */
export interface SecretEnsurerDeps {
	/** Secret persistence. */
	readonly store: SecretStore;
	/** Secure random source. */
	readonly gen: SecretGenerator;
}

/** Input of {@link ensureSecrets}. */
export interface SecretEnsurerInput {
	/** Stack name (one secrets file per stack). */
	readonly stack: string;
	/** Secret keys to ensure (see {@link instanceSecretKey}). */
	readonly names: readonly string[];
}

/**
 * Generates every missing secret once ({@link SECRET_BYTES} random bytes,
 * URL-safe) and persists the stack's secrets. Existing values, including ones
 * no service declares any more, are never regenerated or dropped; the store is
 * only written when something was generated.
 *
 * The read, generation and write happen in one locked `store.update`, so two
 * concurrent first-time `up` runs agree on one value per secret (postgres
 * only takes its password when the volume is first initialised, so a second,
 * different value would break auth).
 *
 * @param deps - Store and generator.
 * @param input - Stack name and required secret names.
 * @returns The stack's complete secret map, or an `IO` error.
 */
export async function ensureSecrets(
	deps: SecretEnsurerDeps,
	input: SecretEnsurerInput,
): Promise<Result<Record<string, string>>> {
	try {
		const secrets = await deps.store.update(input.stack, (current) => {
			const next = { ...current };
			let generated = false;
			for (const name of input.names) {
				if (next[name] === undefined || next[name] === "") {
					next[name] = deps.gen.generate(SECRET_BYTES);
					generated = true;
				}
			}
			return generated ? next : undefined;
		});
		return ok(secrets);
	} catch (cause) {
		return err(
			new OpError(
				"IO",
				`Could not read or write secrets of stack "${input.stack}"`,
				{
					cause,
					details: { stack: input.stack },
				},
			),
		);
	}
}

/**
 * @param names - Secret names per service, possibly repeated.
 * @returns Unique names in first-seen order.
 */
export function uniqueSecretNames(
	names: Iterable<readonly string[]>,
): string[] {
	const seen = new Set<string>();
	for (const list of names) for (const name of list) seen.add(name);
	return [...seen];
}
