import {
	type DerivedEnvLine,
	deriveEnvLines,
	maskSecrets,
} from "../../env/deriver";
import type { ProjectEntry, StateFile } from "../../ports/state.port";
import type { ResolvedStack } from "../../resolve/resolved.model";
import type { Result } from "../../shared/result";
import { ok } from "../../shared/result";
import type { Stack } from "../../stack/stack.model";
import { MASKED_SECRET } from "../ops.model";

/** Env file written by `linkEnv` when neither the input, `link.file` nor the registry names one. */
export const DEFAULT_ENV_FILE = ".env";

/**
 * Derives a project's variables (stack file order), masking secret values
 * unless `reveal`.
 *
 * @param resolved - The resolved stack.
 * @param stack - The project stack (`link`, service order).
 * @param reveal - Keep secret values.
 * @returns The variables, or the deriver's error.
 */
export function projectEnvLines(
	resolved: ResolvedStack,
	stack: Stack,
	reveal: boolean,
): Result<DerivedEnvLine[]> {
	const lines = deriveEnvLines(
		resolved,
		stack.file.link,
		Object.keys(stack.file.services),
	);
	if (!lines.ok || reveal) return lines;
	const secretsOf = new Map(
		resolved.services.map((s) => [s.name, Object.values(s.secrets)]),
	);
	return ok(
		lines.value.map((line) => ({
			...line,
			value: maskSecrets(
				line.value,
				secretsOf.get(line.service) ?? [],
				MASKED_SECRET,
			),
		})),
	);
}

/**
 * @param stack - The project stack.
 * @param state - Persisted state (registry `envFile`).
 * @returns The env file to link, relative to the root: `link.file`, else the
 *   registry entry's `envFile`, else {@link DEFAULT_ENV_FILE}.
 */
export function envFileOf(stack: Stack, state: StateFile): string {
	const entry: ProjectEntry | undefined = state.projects.find(
		(p) => p.name === stack.name,
	);
	return stack.file.link?.file ?? entry?.envFile ?? DEFAULT_ENV_FILE;
}
