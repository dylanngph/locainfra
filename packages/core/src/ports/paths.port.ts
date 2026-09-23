/** Resolved filesystem locations used by LocaInfra. All paths are absolute. */
export interface Paths {
	/** User home directory. */
	readonly home: string;
	/** State root, `~/.locainfra`. */
	readonly stateDir: string;
	/** Rendered compose projects, `~/.locainfra/stacks`. */
	readonly stacksDir: string;
	/** Secrets files (0600), `~/.locainfra/secrets`. */
	readonly secretsDir: string;
	/** Registry cache, `~/.locainfra/registry`. */
	readonly registryDir: string;
	/** User catalog overrides, `~/.locainfra/catalog`. */
	readonly catalogOverridesDir: string;
}
