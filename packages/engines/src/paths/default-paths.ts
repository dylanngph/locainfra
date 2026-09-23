import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Paths } from "@locainfra/core";

/** Environment variable that overrides the state root (`~/.locainfra`). */
export const LOCAINFRA_HOME_ENV = "LOCAINFRA_HOME";

/** Inputs for {@link resolveDefaultPaths}; all optional, defaulting to the real process. */
export interface DefaultPathsOptions {
	/** Environment to read {@link LOCAINFRA_HOME_ENV} from (default `process.env`). */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** Home directory (default `os.homedir()`). */
	readonly home?: string;
}

/**
 * Resolves the LocaInfra filesystem layout.
 *
 * The state root is `$LOCAINFRA_HOME` when set (resolved to an absolute path),
 * otherwise `~/.locainfra`. Every other directory lives under the state root.
 *
 * @param options - Environment and home overrides (for tests).
 * @returns Absolute {@link Paths}.
 */
export function resolveDefaultPaths(options: DefaultPathsOptions = {}): Paths {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const override = env[LOCAINFRA_HOME_ENV]?.trim();
	const stateDir =
		override !== undefined && override !== ""
			? resolve(override)
			: join(home, ".locainfra");
	return {
		home,
		stateDir,
		stacksDir: join(stateDir, "stacks"),
		secretsDir: join(stateDir, "secrets"),
		registryDir: join(stateDir, "registry"),
		catalogOverridesDir: join(stateDir, "catalog"),
	};
}
