/** Resolved filesystem locations used by LocaStack. All paths are absolute. */
export interface Paths {
	/** User home directory. */
	readonly home: string;
	/** State root, `~/.locastack`. */
	readonly stateDir: string;
	/** Rendered compose projects, `~/.locastack/stacks`. */
	readonly stacksDir: string;
	/** Secrets files (0600), `~/.locastack/secrets`. */
	readonly secretsDir: string;
	/** Registry cache, `~/.locastack/registry`. */
	readonly registryDir: string;
	/** User catalog overrides, `~/.locastack/catalog`. */
	readonly catalogOverridesDir: string;
}
