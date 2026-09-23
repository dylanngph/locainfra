import type { ResolvedStack } from "../resolve/resolved.model";
import { instanceSecretKey } from "../resolve/secrets/generator";

/** Prefix of the compose interpolation variables that carry secrets. */
export const SECRET_VAR_PREFIX = "LI_SECRET_";

/** Shortest secret value that is replaced by a variable reference. */
export const MIN_REFERENCED_SECRET_LENGTH = 8;

/**
 * @param name - Secret key, e.g. `MAIN_DB__POSTGRES_PASSWORD`.
 * @returns The compose interpolation variable, e.g. `LI_SECRET_MAIN_DB__POSTGRES_PASSWORD`.
 */
export function secretVarName(name: string): string {
	return `${SECRET_VAR_PREFIX}${name}`;
}

/**
 * Collects every secret of every service, keyed by `instanceSecretKey`.
 *
 * @param stack - The resolved stack.
 * @returns Secret key → value.
 */
export function collectStackSecrets(
	stack: ResolvedStack,
): Record<string, string> {
	const secrets: Record<string, string> = {};
	for (const service of stack.services) {
		for (const [name, value] of Object.entries(service.secrets)) {
			secrets[instanceSecretKey(service.name, name)] = value;
		}
	}
	return secrets;
}

/** Turns resolved strings into compose-safe strings that reference secrets by variable. */
export interface ComposeEscaper {
	/**
	 * Replaces every known secret value with `${LI_SECRET_<NAME>}` and escapes
	 * every other `$` as `$$` so compose interpolates nothing else.
	 *
	 * @param value - A resolved string (may contain secret values).
	 * @returns The compose-safe string.
	 */
	escape(value: string): string;
}

/**
 * Builds a {@link ComposeEscaper} for a stack's secrets. Values shorter than
 * {@link MIN_REFERENCED_SECRET_LENGTH} are too likely to collide with other
 * text and stay inline.
 *
 * @param secrets - Secret name → value.
 * @returns The escaper.
 */
export function createComposeEscaper(
	secrets: Readonly<Record<string, string>>,
): ComposeEscaper {
	const entries = Object.entries(secrets)
		.filter(([, value]) => value.length >= MIN_REFERENCED_SECRET_LENGTH)
		.sort(([, a], [, b]) => b.length - a.length);
	return {
		escape(value: string): string {
			let out = value;
			entries.forEach(([, secret], index) => {
				out = out.split(secret).join(`\uE000${index}\uE000`);
			});
			out = out.replaceAll("$", "$$$$");
			return out.replace(/\uE000(\d+)\uE000/g, (_whole, index: string) => {
				const entry = entries[Number(index)];
				return entry ? `\${${secretVarName(entry[0])}}` : "";
			});
		},
	};
}
