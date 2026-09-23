import { type Static, Type } from "@sinclair/typebox";

const ID_PATTERN = "^[a-z0-9][a-z0-9-]*$";
const ENV_NAME_PATTERN = "^[A-Za-z_][A-Za-z0-9_]*$";
const DURATION_PATTERN = "^([0-9]+(ns|us|ms|s|m|h))+$";

const Port = Type.Integer({ minimum: 1, maximum: 65535 });
const EnvName = Type.String({ pattern: ENV_NAME_PATTERN });
const Duration = Type.String({
	pattern: DURATION_PATTERN,
	description: "Compose duration, e.g. 5s or 1m30s",
});

/** Catalog category shown in the Services Explorer. */
export const ServiceCategory = Type.Union([
	Type.Literal("database"),
	Type.Literal("cache"),
	Type.Literal("queue"),
	Type.Literal("storage"),
	Type.Literal("mail"),
	Type.Literal("search"),
	Type.Literal("auth"),
	Type.Literal("observability"),
	Type.Literal("other"),
]);
/** Catalog category. */
export type ServiceCategory = Static<typeof ServiceCategory>;

/** Built-in dashboard panel a service opts into; remote UI code is never loaded. */
export const StudioPanel = Type.Union([
	Type.Literal("sql"),
	Type.Literal("redis"),
	Type.Literal("iframe"),
	Type.Literal("link"),
	Type.Literal("none"),
]);
/** Built-in dashboard panel kind. */
export type StudioPanel = Static<typeof StudioPanel>;

/** Container and host port policy of a service. */
export const ServicePort = Type.Object({
	container: Port,
	default: Type.Integer({
		minimum: 1,
		maximum: 65535,
		description: "Canonical host port (used by the global stack)",
	}),
	range: Type.Tuple([Port, Port], {
		description: "Inclusive host port range for auto allocation",
	}),
});
/** Container and host port policy. */
export type ServicePort = Static<typeof ServicePort>;

/** A user-tunable config value with its default (may be a template). */
export const ConfigValue = Type.Object({
	default: Type.String(),
	description: Type.Optional(Type.String()),
	pattern: Type.Optional(
		Type.String({
			minLength: 1,
			description:
				"Regular expression the effective value must match (anchor it with ^…$). Use it for values interpolated into commands or URLs.",
		}),
	),
});
/** A user-tunable config value. */
export type ConfigValue = Static<typeof ConfigValue>;

/** A named volume mounted into the service container. */
export const ServiceVolume = Type.Object({
	name: Type.String({ pattern: "^[a-z0-9][a-z0-9_-]*$" }),
	path: Type.String({
		pattern: "^/",
		description: "Absolute path inside the container",
	}),
});
/** A named volume mount. */
export type ServiceVolume = Static<typeof ServiceVolume>;

/** Container healthcheck (compose semantics). */
export const ServiceHealthcheck = Type.Object({
	test: Type.Array(Type.String(), {
		minItems: 1,
		description: 'e.g. ["CMD-SHELL", "pg_isready"]; items may be templates',
	}),
	interval: Type.Optional(Duration),
	retries: Type.Optional(Type.Integer({ minimum: 0 })),
	timeout: Type.Optional(Duration),
	startPeriod: Type.Optional(Duration),
});
/** Container healthcheck. */
export type ServiceHealthcheck = Static<typeof ServiceHealthcheck>;

/**
 * "Use in code" snippets shown on the service Connect tab. The literal
 * placeholder `KEY` is replaced by the (possibly prefixed or renamed) name of
 * the service's primary export, e.g. `process.env.KEY` → `process.env.DATABASE_URL`.
 */
export const ServiceSnippets = Type.Object({
	node: Type.Optional(Type.String()),
	python: Type.Optional(Type.String()),
	go: Type.Optional(Type.String()),
});
/** Per-language connection snippets with a `KEY` placeholder. */
export type ServiceSnippets = Static<typeof ServiceSnippets>;

/** Optional dashboard data panel for the service. */
export const ServiceStudio = Type.Object({
	panel: StudioPanel,
	url: Type.Optional(
		Type.String({ description: "Template URL for iframe/link panels" }),
	),
});
/** Optional dashboard data panel. */
export type ServiceStudio = Static<typeof ServiceStudio>;

/**
 * Kind of the service's Data tab (query runner):
 * - `sql`: the query is passed as ONE argv item (e.g. `psql --csv -c`);
 * - `redis`: the query is split into argv words (redis-cli style: whitespace
 *   separates words, single or double quotes group them);
 * - `none`: no Data tab.
 */
export const ServiceDataKind = Type.Union([
	Type.Literal("sql"),
	Type.Literal("redis"),
	Type.Literal("none"),
]);
/** Kind of the service's Data tab. */
export type ServiceDataKind = Static<typeof ServiceDataKind>;

/** Template placeholder replaced by the user's query in {@link ServiceData}`.runQuery`. */
export const DATA_QUERY_PLACEHOLDER = "{{query}}";

/** Template placeholder replaced by an object name in {@link ServiceData}`.defaultQuery`. */
export const DATA_OBJECT_PLACEHOLDER = "{{object}}";

/**
 * Data tab (query runner) of a service. Commands run inside the service's
 * running container with `docker exec` (never through a shell), so their argv
 * items are catalog templates over the usual context (`config.*`,
 * `secrets.*`, …) plus two extra roots:
 *
 * - `{{query}}` (only in `runQuery`): an argv item that is exactly
 *   `{{query}}` becomes the query (kind `sql`: one item; kind `redis`: its
 *   words, see {@link ServiceDataKind}). It may appear once.
 * - `{{object}}` (only in `defaultQuery`): the selected object's name.
 *
 * Consistency (checked by the catalog validator): kind `none` has no other
 * field; otherwise `label`, `runQuery` and `defaultQuery` are required and
 * exactly one of `listObjects` / `objects` is set.
 */
export const ServiceData = Type.Object({
	kind: ServiceDataKind,
	label: Type.Optional(
		Type.String({
			minLength: 1,
			description: "Heading of the object list, e.g. Tables or Key patterns",
		}),
	),
	listObjects: Type.Optional(
		Type.Array(Type.String(), {
			minItems: 1,
			description:
				"docker exec argv printing one object name per line on stdout (e.g. the public tables); items may be templates",
		}),
	),
	objects: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			minItems: 1,
			description:
				"Static object list for services whose objects cannot be listed (e.g. redis key patterns ['*'])",
		}),
	),
	runQuery: Type.Optional(
		Type.Array(Type.String(), {
			minItems: 1,
			description:
				"docker exec argv printing the result as CSV (header row first) on stdout; one item is exactly {{query}}",
		}),
	),
	defaultQuery: Type.Optional(
		Type.String({
			minLength: 1,
			description:
				"Query prefilled when an object is selected; {{object}} is its name",
		}),
	),
});
/** Data tab (query runner) of a service. */
export type ServiceData = Static<typeof ServiceData>;

/**
 * Seed file support: when a stack entry sets `seed` (a path relative to the
 * project root), the renderer bind-mounts `<root>/<seed>` read-only at
 * `<mountPath>/<fileName>` (for Postgres the entrypoint runs it on first init).
 * `run` re-applies the seed to a running container (`seedService`): a
 * docker exec argv that reads the seed file's contents from stdin.
 */
export const ServiceSeed = Type.Object({
	mountPath: Type.String({
		pattern: "^/",
		description:
			"Absolute directory in the container, e.g. /docker-entrypoint-initdb.d",
	}),
	fileName: Type.String({
		pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
		description: "File name inside mountPath, e.g. seed.sql",
	}),
	run: Type.Array(Type.String(), {
		minItems: 1,
		description:
			"docker exec argv applying the seed read from stdin, e.g. psql … -v ON_ERROR_STOP=1 -f -; items may be templates",
	}),
});
/** Seed file support of a service. */
export type ServiceSeed = Static<typeof ServiceSeed>;

/** Per-secret behaviour flags (keys must be entries of `secrets`). */
export const ServiceSecretOptions = Type.Object({
	bakedIntoVolume: Type.Optional(
		Type.Boolean({
			description:
				"The value is written into the data volume on first init (e.g. POSTGRES_PASSWORD): rotating it without wiping the volume would lock clients out, so rotateSecret refuses unless forced with wipeVolume",
		}),
	),
});
/** Per-secret behaviour flags. */
export type ServiceSecretOptions = Static<typeof ServiceSecretOptions>;

/** Pattern of an import env mapping target: `config.<KEY>` or `secrets.<NAME>`. */
export const IMPORT_ENV_TARGET_PATTERN =
	"^(config|secrets)\\.[A-Za-z_][A-Za-z0-9_]*$";

/**
 * How a `docker-compose.yml` service maps onto this definition (Import).
 * A compose service matches when its image repository (tag, digest and a
 * `docker.io/` or `docker.io/library/` prefix removed) equals one of `images`.
 * Compose environment variables named like a `config` key or a `secrets`
 * entry map to it by name; `env` adds explicit renames.
 */
export const ServiceImport = Type.Object({
	images: Type.Array(Type.String({ minLength: 1 }), {
		minItems: 1,
		description:
			"Image repositories without tag, e.g. postgres, postgis/postgis, pgvector/pgvector",
	}),
	env: Type.Optional(
		Type.Record(
			Type.String({ pattern: ENV_NAME_PATTERN }),
			Type.String({ pattern: IMPORT_ENV_TARGET_PATTERN }),
			{
				description:
					"Compose env var → config.<KEY> or secrets.<NAME> (in addition to same-name matches)",
			},
		),
	),
});
/** How a compose service maps onto this definition. */
export type ServiceImport = Static<typeof ServiceImport>;

/**
 * A data-only catalog service definition (`catalog/*.yaml`, registry, overrides).
 *
 * String values may contain `{{path}}` templates over
 * `{ version, port, name, stack, config, secrets, services.<catalogId>.* }`.
 * Parse with `Value.Parse(ServiceDefinition, raw)` so collection defaults and
 * scalar conversion (e.g. YAML `17` → `"17"`) apply.
 */
export const ServiceDefinition = Type.Object(
	{
		id: Type.String({ pattern: ID_PATTERN }),
		name: Type.String({ minLength: 1 }),
		description: Type.Optional(Type.String()),
		category: ServiceCategory,
		categoryLabel: Type.Optional(
			Type.String({
				minLength: 1,
				description:
					"Dashboard grouping label overriding the category name, e.g. Redis for redis and upstash-redis",
			}),
		),
		tags: Type.Array(Type.String(), { default: [] }),
		icon: Type.Optional(Type.String()),
		iconUrl: Type.Optional(Type.String()),
		homepage: Type.Optional(Type.String()),
		image: Type.String({
			minLength: 1,
			description: "Image reference template, e.g. postgres:{{version}}-alpine",
		}),
		versions: Type.Array(Type.String(), { minItems: 1 }),
		defaultVersion: Type.String(),
		port: ServicePort,
		secrets: Type.Array(EnvName, { default: [] }),
		config: Type.Record(
			Type.String({ pattern: ENV_NAME_PATTERN }),
			ConfigValue,
			{
				default: {},
				additionalProperties: false,
			},
		),
		env: Type.Record(
			Type.String({ pattern: ENV_NAME_PATTERN }),
			Type.String(),
			{
				default: {},
				additionalProperties: false,
			},
		),
		volumes: Type.Array(ServiceVolume, { default: [] }),
		command: Type.Optional(
			Type.Array(Type.String(), {
				minItems: 1,
				description:
					"Container command override (compose `command`, exec form); items may be templates, e.g. [redis-server, --requirepass, '{{secrets.REDIS_PASSWORD}}']",
			}),
		),
		healthcheck: ServiceHealthcheck,
		exports: Type.Record(
			Type.String({ pattern: ENV_NAME_PATTERN }),
			Type.String(),
			{
				default: {},
				additionalProperties: false,
			},
		),
		primaryExport: Type.String({
			pattern: ENV_NAME_PATTERN,
			description:
				"Key of `exports` that is the service's connection URL (Copy URL, link.names renames, KEY in snippets)",
		}),
		snippets: Type.Optional(ServiceSnippets),
		connect: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
		dependsOn: Type.Optional(Type.Array(Type.String({ pattern: ID_PATTERN }))),
		studio: Type.Optional(ServiceStudio),
		data: Type.Optional(ServiceData),
		seed: Type.Optional(ServiceSeed),
		secretOptions: Type.Optional(
			Type.Record(
				Type.String({ pattern: ENV_NAME_PATTERN }),
				ServiceSecretOptions,
				{
					additionalProperties: false,
					description: "Flags per secret name, e.g. bakedIntoVolume",
				},
			),
		),
		import: Type.Optional(ServiceImport),
	},
	{ $id: "https://locainfra.dev/schema/service.v1.json" },
);
/** A data-only catalog service definition. */
export type ServiceDefinition = Static<typeof ServiceDefinition>;

/** Construction options for {@link CatalogError}. */
export interface CatalogErrorOptions {
	/** Definition id, when known. */
	readonly catalogId?: string;
	/** Origin of the definition (file path or URL). */
	readonly source?: string;
	/** Individual validation messages. */
	readonly issues?: readonly string[];
	/** Underlying error. */
	readonly cause?: unknown;
}

/** A catalog definition failed to load, parse, or validate. */
export class CatalogError extends Error {
	/** Definition id, when known. */
	readonly catalogId: string | undefined;
	/** Origin of the definition (file path or URL). */
	readonly source: string | undefined;
	/** Individual validation messages. */
	readonly issues: readonly string[];

	/**
	 * @param message - Human-readable summary.
	 * @param options - Id, source, issues and cause.
	 */
	constructor(message: string, options: CatalogErrorOptions = {}) {
		super(
			message,
			options.cause === undefined ? undefined : { cause: options.cause },
		);
		this.name = "CatalogError";
		this.catalogId = options.catalogId;
		this.source = options.source;
		this.issues = options.issues ?? [];
	}
}
