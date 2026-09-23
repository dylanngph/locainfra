/** Values another service exposes to templates of services that depend on it. */
export interface TemplateServiceContext {
	/**
	 * Hostname of the dependency on the stack network: its instance name (the
	 * compose service key), e.g. `cache` in `redis://…@{{services.redis.host}}:6379`.
	 */
	readonly host: string;
	/** Resolved host port of the dependency. */
	readonly port: number;
	/** Secrets of the dependency, by name. */
	readonly secrets: Readonly<Record<string, string>>;
	/** Resolved config values of the dependency, by name. */
	readonly config: Readonly<Record<string, string>>;
}

/**
 * Everything a catalog `{{path}}` template may reference.
 *
 * Paths are dot-separated lookups into this object, e.g. `{{port}}`,
 * `{{name}}`, `{{stack.name}}`, `{{config.POSTGRES_DB}}` or
 * `{{services.redis.secrets.REDIS_PASSWORD}}`.
 */
export interface TemplateContext {
	/** Instance name of the service (the `services` key in `locainfra.yaml`). */
	readonly name: string;
	/** Selected image version of the service. */
	readonly version: string;
	/** Resolved host port of the service. */
	readonly port: number;
	/** The stack the service belongs to. */
	readonly stack: { readonly name: string };
	/** Resolved config values of the service. */
	readonly config: Readonly<Record<string, string>>;
	/** Secrets of the service. */
	readonly secrets: Readonly<Record<string, string>>;
	/**
	 * Dependencies (from the definition's `dependsOn`), keyed by catalog id
	 * (what catalog templates use, e.g. `{{services.redis.host}}`) and also by
	 * the bound instance name (e.g. `{{services.cache.port}}`); the catalog-id
	 * key wins when both spell the same. Each dependency resolves to the
	 * instance named in the entry's `uses`, else to the first instance of that
	 * type in the stack file.
	 */
	readonly services: Readonly<Record<string, TemplateServiceContext>>;
	/**
	 * Dependencies keyed by catalog id only (`{{byType.redis.port}}`): the
	 * same instance as `services.<catalogId>`. Unambiguous even when an
	 * instance name equals another catalog id.
	 */
	readonly byType: Readonly<Record<string, TemplateServiceContext>>;
}

/** Why a template path could not be substituted. */
export type TemplateIssueReason = "unknown" | "not-scalar" | "empty";

/** One unresolvable `{{path}}` reference. */
export interface TemplateIssue {
	/** The path as written between the braces (trimmed). */
	readonly path: string;
	/** Why it failed. */
	readonly reason: TemplateIssueReason;
}

/**
 * A template referenced paths that do not resolve to a string or number.
 *
 * The message lists the paths but never the template's resolved content, so it
 * is safe to log (templates may interpolate secrets).
 */
export class TemplateError extends Error {
	/** Every failing path, in order of first appearance. */
	readonly paths: readonly string[];
	/** Every failing path with its reason. */
	readonly issues: readonly TemplateIssue[];

	/**
	 * @param issues - The unresolvable references (at least one).
	 */
	constructor(issues: readonly TemplateIssue[]) {
		const paths = issues.map((issue) => issue.path);
		super(
			`Unresolved template path${paths.length === 1 ? "" : "s"}: ${issues
				.map((issue) => `{{${issue.path}}} (${issue.reason})`)
				.join(", ")}`,
		);
		this.name = "TemplateError";
		this.paths = paths;
		this.issues = issues;
	}
}
