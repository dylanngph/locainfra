import { type Static, Type } from "@sinclair/typebox";
import { ServiceCategory, ServiceDefinition } from "../catalog/catalog.model";
import { ContainerHealth } from "../ports/docker.port";
import {
	SNAPSHOT_ID_PATTERN,
	SNAPSHOT_NAME_PATTERN,
} from "../ports/snapshot.port";
import { NAME_PATTERN, PersistMode, SeedPath } from "../stack/stack.model";

/*
 * TypeBox models of the values operations return. The server reuses them as
 * API models (like `DoctorReport`), so an op result and its HTTP response
 * share one definition.
 */

/** Placeholder shown instead of a secret value when `reveal` is false. */
export const MASKED_SECRET = "••••••••";

/** A project or service instance name (`^[a-z][a-z0-9-]*$`). */
export const ResourceName = Type.String({ pattern: NAME_PATTERN });
/** A project or service instance name. */
export type ResourceName = Static<typeof ResourceName>;

/** Output format of env previews: `.env`, `export K=V` lines, or a JSON object. */
export const EnvFormatModel = Type.Union([
	Type.Literal("dotenv"),
	Type.Literal("shell"),
	Type.Literal("json"),
]);
/** Env preview output format (same values as core's `EnvFormat`). */
export type EnvFormatModel = Static<typeof EnvFormatModel>;

/**
 * Dashboard state of one service instance:
 * - `running`: container running (and healthy, when it has a healthcheck);
 * - `starting`: created/restarting, or running with health `starting`;
 * - `stopped`: no container yet, or exited cleanly / stopped;
 * - `port-conflict`: the host port is taken (probe failed or compose reported it allocated);
 * - `error`: exited non-zero, dead, or unhealthy.
 */
export const ServiceState = Type.Union([
	Type.Literal("running"),
	Type.Literal("starting"),
	Type.Literal("stopped"),
	Type.Literal("port-conflict"),
	Type.Literal("error"),
]);
/** Dashboard state of one service instance. */
export type ServiceState = Static<typeof ServiceState>;

/** Why a service is in the `port-conflict` or `error` state, with a fix when one exists. */
export const ServiceProblem = Type.Object({
	code: Type.String({ description: "An OpErrorCode, e.g. PORT_CONFLICT" }),
	message: Type.String({
		description:
			"e.g. Port 5432 is already in use by another process on this machine, so the container could not bind.",
	}),
	suggestedPort: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 65535,
			description:
				'Free port for the "Use port N" fix (PATCH the service with { port })',
		}),
	),
});
/** Why a service is in trouble. */
export type ServiceProblem = Static<typeof ServiceProblem>;

/** Live status of one service instance (a row of the project overview table). */
export const ServiceStatus = Type.Object({
	name: ResourceName,
	type: Type.String({ description: "Catalog id" }),
	version: Type.String(),
	image: Type.String({
		description: "Concrete image, e.g. postgres:17-alpine",
	}),
	hostPort: Type.Integer({ description: "Pinned host port on 127.0.0.1" }),
	containerPort: Type.Integer(),
	containerName: Type.String({ description: "li-<project>-<name>" }),
	containerId: Type.Optional(
		Type.String({ description: "Absent when no container exists yet" }),
	),
	persist: PersistMode,
	state: ServiceState,
	health: ContainerHealth,
	startedAt: Type.Optional(
		Type.String({ description: "ISO-8601; set while running" }),
	),
	problem: Type.Optional(ServiceProblem),
	cpuPercent: Type.Optional(
		Type.Number({
			description:
				"Latest CPU sample; filled by the server observer, never by core",
		}),
	),
	memBytes: Type.Optional(
		Type.Integer({
			description:
				"Latest memory sample; filled by the server observer, never by core",
		}),
	),
});
/** Live status of one service instance. */
export type ServiceStatus = Static<typeof ServiceStatus>;

/** Live status of a project (payload of `status:<project>` snapshots). */
export const ProjectStatus = Type.Object({
	project: ResourceName,
	network: Type.String({ description: "li-<project>" }),
	services: Type.Array(ServiceStatus, {
		description: "In locainfra.yaml order",
	}),
});
/** Live status of a project. */
export type ProjectStatus = Static<typeof ProjectStatus>;

/** One card of the Projects screen. */
export const ProjectSummary = Type.Object({
	name: ResourceName,
	root: Type.String(),
	envFile: Type.Optional(Type.String()),
	serviceCount: Type.Integer({ minimum: 0 }),
	running: Type.Integer({
		minimum: 0,
		description: "Services in state running",
	}),
	errors: Type.Integer({
		minimum: 0,
		description: "Services in state port-conflict or error",
	}),
	types: Type.Array(Type.String(), {
		description: "Catalog id of each service, in file order (type chips)",
	}),
	cpuPercent: Type.Optional(
		Type.Number({
			description:
				"Sum over running services from fresh observer stats; absent when there is no sample (core never sets it, the server overlays it while the project is watched)",
		}),
	),
	memBytes: Type.Optional(
		Type.Integer({
			description:
				"Sum over running services from fresh observer stats; absent when there is no sample (core never sets it, the server overlays it while the project is watched)",
		}),
	),
	issue: Type.Optional(
		Type.String({
			description:
				"Set when the project cannot be loaded (folder or locainfra.yaml missing, invalid file); counts are then 0",
		}),
	),
});
/** One card of the Projects screen. */
export type ProjectSummary = Static<typeof ProjectSummary>;

/** A mounted named volume of a service. */
export const ServiceVolumeInfo = Type.Object({
	name: Type.String({
		description: "Docker volume, li-<project>-<service>-<vol>",
	}),
	source: Type.String({ description: "Catalog volume name, e.g. data" }),
	path: Type.String({ description: "Mount path in the container" }),
});
/** A mounted named volume. */
export type ServiceVolumeInfo = Static<typeof ServiceVolumeInfo>;

/** Everything the service detail page shows except secrets and connection strings. */
export const ServiceDetail = Type.Composite([
	ServiceStatus,
	Type.Object({
		network: Type.String({ description: "li-<project>" }),
		config: Type.Record(Type.String(), Type.String(), {
			description: "Effective non-secret config values (defaults applied)",
		}),
		secretNames: Type.Array(Type.String(), {
			description: "Names of the service's secrets (values via /connection)",
		}),
		volumes: Type.Array(ServiceVolumeInfo, {
			description: "Empty when persist is ephemeral",
		}),
	}),
]);
/** Everything the service detail page shows except secrets. */
export type ServiceDetail = Static<typeof ServiceDetail>;

/** Fields `updateService` may change. `config` replaces the entry's whole config map. */
export const ServicePatch = Type.Object(
	{
		version: Type.Optional(Type.String()),
		port: Type.Optional(
			Type.Union([
				Type.Integer({ minimum: 1, maximum: 65535 }),
				Type.Literal("auto"),
			]),
		),
		persist: Type.Optional(PersistMode),
		config: Type.Optional(Type.Record(Type.String(), Type.String())),
		seed: Type.Optional(
			Type.Union([SeedPath, Type.Literal("")], {
				description:
					"Seed file relative to the project root; empty string removes it. Only for definitions with a `seed` block",
			}),
		),
	},
	{ minProperties: 1 },
);
/** Fields `updateService` may change. */
export type ServicePatch = Static<typeof ServicePatch>;

/** A variable name/value pair (value masked unless revealed). */
export const EnvPair = Type.Object({
	key: Type.String(),
	value: Type.String(),
});
/** A variable name/value pair. */
export type EnvPair = Static<typeof EnvPair>;

/** One exported variable of an env preview. */
export const EnvPreviewLine = Type.Object({
	key: Type.String({
		description:
			"Final name: link.names rename, else <INSTANCE>_ prefix only when the plain key collides",
	}),
	value: Type.String({
		description: `Secret parts replaced by ${MASKED_SECRET} unless reveal`,
	}),
	service: ResourceName,
	type: Type.String({ description: "Catalog id of the service" }),
});
/** One exported variable of an env preview. */
export type EnvPreviewLine = Static<typeof EnvPreviewLine>;

/** Result of `envPreview`: the variables and their serialized text. */
export const EnvPreview = Type.Object({
	format: EnvFormatModel,
	lines: Type.Array(EnvPreviewLine),
	text: Type.String({
		description:
			"Serialized in `format`; dotenv/shell group lines under `# <service> (<type>)` comments",
	}),
	serviceCount: Type.Integer({ minimum: 0 }),
	file: Type.String({
		description:
			"Target of Write to …: link.file, else .env (relative to the project root)",
	}),
});
/** Result of `envPreview`. */
export type EnvPreview = Static<typeof EnvPreview>;

/** Result of `linkEnv`. */
export const LinkEnvResult = Type.Object({
	path: Type.String({ description: "Absolute path of the written env file" }),
	count: Type.Integer({ minimum: 0, description: "Variables written" }),
});
/** Result of `linkEnv`. */
export type LinkEnvResult = Static<typeof LinkEnvResult>;

/** One row of the Connect tab details grid (Host, Port, User, Database, Secret, Container…). */
export const ConnectionDetail = Type.Object({
	k: Type.String(),
	v: Type.String(),
});
/** One row of the Connect tab details grid. */
export type ConnectionDetail = Static<typeof ConnectionDetail>;

/** "Use in code" snippets with `KEY` already replaced by the primary export's final name. */
export const ConnectionSnippets = Type.Object({
	env: Type.String({ description: "KEY=value lines of the service's exports" }),
	node: Type.Optional(Type.String()),
	python: Type.Optional(Type.String()),
	go: Type.Optional(Type.String()),
});
/** Resolved connection snippets. */
export type ConnectionSnippets = Static<typeof ConnectionSnippets>;

/** Everything the Connect tab shows for one service. */
export const ConnectionInfo = Type.Object({
	primary: EnvPair,
	exports: Type.Array(EnvPair),
	details: Type.Array(ConnectionDetail),
	snippets: ConnectionSnippets,
});
/** Everything the Connect tab shows. */
export type ConnectionInfo = Static<typeof ConnectionInfo>;

/** A catalog filter chip: `categoryLabel` (or the category) with its definition count. */
export const CatalogCategory = Type.Object({
	id: Type.String({
		description:
			"Slug of the label, e.g. database, redis (the `cat` search param)",
	}),
	label: Type.String({ description: "e.g. Database, Redis" }),
	category: ServiceCategory,
	count: Type.Integer({ minimum: 0 }),
});
/** A catalog filter chip. */
export type CatalogCategory = Static<typeof CatalogCategory>;

/** Result of `catalogList`. */
export const CatalogListing = Type.Object({
	definitions: Type.Array(ServiceDefinition),
	categories: Type.Array(CatalogCategory),
});
/** Result of `catalogList`. */
export type CatalogListing = Static<typeof CatalogListing>;

/** Docker and compose versions (header status dot). */
export const SystemInfo = Type.Object({
	docker: Type.Union(
		[
			Type.Object({
				version: Type.String(),
				apiVersion: Type.String(),
				platformName: Type.Optional(Type.String()),
			}),
			Type.Null(),
		],
		{ description: "null when the daemon is unreachable" },
	),
	compose: Type.Union([Type.String(), Type.Null()], {
		description: "Compose plugin version, null when missing",
	}),
});
/** Docker and compose versions. */
export type SystemInfo = Static<typeof SystemInfo>;

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/**
 * Pattern of a client-supplied secret value (Config page "Regenerate"):
 * 16–256 URL-unreserved ASCII characters. Stricter than "printable ASCII" on
 * purpose: values are interpolated unencoded into connection URLs
 * (`postgres://user:<pw>@…`), compose `.env` files and argv.
 */
export const SECRET_VALUE_PATTERN = "^[A-Za-z0-9._~-]{16,256}$";

/** A client-supplied secret value (see {@link SECRET_VALUE_PATTERN}). */
export const SecretValue = Type.String({
	pattern: SECRET_VALUE_PATTERN,
	description:
		"16-256 characters from A-Z a-z 0-9 . _ ~ - (safe in URLs, .env files and argv)",
});
/** A client-supplied secret value. */
export type SecretValue = Static<typeof SecretValue>;

/** Initial secret values by catalog secret name (e.g. `{ POSTGRES_PASSWORD: "…" }`). */
export const SecretValues = Type.Record(
	Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }),
	SecretValue,
	{
		description:
			"Catalog secret name → value; names must be entries of the definition's `secrets`. Omitted secrets are generated",
	},
);
/** Initial secret values by catalog secret name. */
export type SecretValues = Static<typeof SecretValues>;

/** Options of `rotateSecret` (`PATCH …/secrets/:key/rotate` body). */
export const RotateSecretOptions = Type.Object({
	force: Type.Optional(
		Type.Boolean({
			description:
				"Confirms a destructive rotation: required whenever wipeVolume is set, and (with wipeVolume) for a secret the catalog marks bakedIntoVolume while the service has a data volume",
		}),
	),
	wipeVolume: Type.Optional(
		Type.Boolean({
			description:
				"Delete the service's data volumes before recreating it (destructive; needs force; typed confirmation in the UI)",
		}),
	),
});
/** Options of `rotateSecret`. */
export type RotateSecretOptions = Static<typeof RotateSecretOptions>;

// ---------------------------------------------------------------------------
// Data tab (query runner)
// ---------------------------------------------------------------------------

/** Hard deadline of one query (`runQuery`) or object listing, in milliseconds. */
export const DATA_QUERY_TIMEOUT_MS = 15_000;

/** Most stdout bytes read from one query; the rest is dropped (`truncated`). */
export const DATA_QUERY_MAX_BYTES = 2 * 1024 * 1024;

/** Most rows returned by one query (also the upper bound of `limit`). */
export const DATA_QUERY_MAX_ROWS = 1000;

/** Longest accepted query text, in characters. */
export const DATA_QUERY_MAX_LENGTH = 100_000;

/** Most objects returned by `listDataObjects`. */
export const DATA_MAX_OBJECTS = 1000;

/** Hard deadline of `seedService`'s exec, in milliseconds. */
export const SEED_TIMEOUT_MS = 120_000;

/** Largest seed file piped to a container by `seedService`, in bytes (64 MB). */
export const SEED_MAX_BYTES = 64 * 1024 * 1024;

/** One entry of the Data tab's object list (a table, a key pattern…). */
export const DataObject = Type.Object({
	name: Type.String(),
	defaultQuery: Type.String({
		description:
			"The catalog's data.defaultQuery with {{object}} replaced; prefilled when the object is selected",
	}),
});
/** One entry of the Data tab's object list. */
export type DataObject = Static<typeof DataObject>;

/** Result of `listDataObjects`: the Data tab's side list. */
export const DataObjects = Type.Object({
	kind: Type.Union([Type.Literal("sql"), Type.Literal("redis")]),
	label: Type.String({ description: "e.g. Tables or Key patterns" }),
	objects: Type.Array(DataObject, {
		maxItems: DATA_MAX_OBJECTS,
		description:
			"In the order the service lists them (catalog listObjects) or the static catalog list",
	}),
	truncated: Type.Boolean({
		description: `More than ${DATA_MAX_OBJECTS} objects existed`,
	}),
});
/** Result of `listDataObjects`. */
export type DataObjects = Static<typeof DataObjects>;

/** Input of `runQuery` beyond the service reference (`POST …/data/query` body). */
export const DataQueryRequest = Type.Object({
	query: Type.String({
		minLength: 1,
		maxLength: DATA_QUERY_MAX_LENGTH,
		description:
			"Query text (SQL, or a redis command line). Blank (whitespace only) is INVALID_INPUT",
	}),
	limit: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: DATA_QUERY_MAX_ROWS,
			description: `Most rows to return (default and maximum ${DATA_QUERY_MAX_ROWS})`,
		}),
	),
});
/** Input of `runQuery` beyond the service reference. */
export type DataQueryRequest = Static<typeof DataQueryRequest>;

/** Result of `runQuery`: the command's CSV output parsed into a grid. */
export const DataQueryResult = Type.Object({
	columns: Type.Array(Type.String(), {
		description:
			"CSV header row (sql); for redis, one synthetic column named after the command, e.g. SCAN or value",
	}),
	rows: Type.Array(Type.Array(Type.String()), {
		maxItems: DATA_QUERY_MAX_ROWS,
		description:
			"Cells as text, one array per row, each as long as columns (NULL is the empty string)",
	}),
	rowCount: Type.Integer({
		minimum: 0,
		description: "rows.length (rows returned, not rows matched)",
	}),
	truncated: Type.Boolean({
		description: `Rows were dropped: more than limit (≤ ${DATA_QUERY_MAX_ROWS}) rows, or more than ${DATA_QUERY_MAX_BYTES} bytes of output`,
	}),
	durationMs: Type.Integer({
		minimum: 0,
		description: "Wall time of the docker exec",
	}),
});
/** Result of `runQuery`. */
export type DataQueryResult = Static<typeof DataQueryResult>;

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/** A snapshot as the API shows it (the index row without its file path). */
export const Snapshot = Type.Object({
	id: Type.String({ pattern: SNAPSHOT_ID_PATTERN }),
	service: ResourceName,
	name: Type.String({ pattern: SNAPSHOT_NAME_PATTERN }),
	sizeBytes: Type.Integer({ minimum: 0 }),
	createdAt: Type.String({ description: "ISO-8601 creation time" }),
});
/** A snapshot as the API shows it. */
export type Snapshot = Static<typeof Snapshot>;

/** Optional input of `createSnapshot` (`POST …/snapshots` body). */
export const CreateSnapshotRequest = Type.Object({
	name: Type.Optional(
		Type.String({
			pattern: SNAPSHOT_NAME_PATTERN,
			description:
				"Display name (default: snap-<n>, n = existing snapshots of the service + 1)",
		}),
	),
});
/** Optional input of `createSnapshot`. */
export type CreateSnapshotRequest = Static<typeof CreateSnapshotRequest>;

// ---------------------------------------------------------------------------
// Import docker-compose.yml
// ---------------------------------------------------------------------------

/** Largest accepted compose text, in bytes (UTF-8). */
export const IMPORT_YAML_MAX_BYTES = 512 * 1024;

/** Most services accepted from one compose file. */
export const IMPORT_MAX_SERVICES = 100;

/**
 * Pattern of a secret value carried over from a compose file: any length ≥ 1
 * (existing dev passwords like `postgres` keep working) but the same
 * URL-unreserved alphabet as {@link SECRET_VALUE_PATTERN}.
 */
export const IMPORT_SECRET_VALUE_PATTERN = "^[A-Za-z0-9._~-]{1,256}$";

/** A port mapping of a compose service (`"5433:5432"`, `"5432"`, long syntax). */
export const ComposeImportPort = Type.Object({
	host: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 65535,
			description:
				"Published host port; absent when only the container port is given",
		}),
	),
	container: Type.Integer({ minimum: 1, maximum: 65535 }),
});
/** A port mapping of a compose service. */
export type ComposeImportPort = Static<typeof ComposeImportPort>;

/** One service of a parsed `docker-compose.yml` (only what Import needs). */
export const ComposeImportService = Type.Object({
	name: Type.String({ description: "Compose service key, as written" }),
	image: Type.Optional(
		Type.String({
			description: "Image reference; absent for build-only services",
		}),
	),
	build: Type.Boolean({ description: "Has a build section" }),
	ports: Type.Array(ComposeImportPort, {
		description: "Ranges and env-interpolated ports are skipped",
	}),
	environment: Type.Record(Type.String(), Type.String(), {
		description:
			"List or map form, values as strings; a VAR:-default interpolation keeps its default, other interpolated values are left out",
	}),
});
/** One service of a parsed compose file. */
export type ComposeImportService = Static<typeof ComposeImportService>;

/** Result of `parseComposeForImport`. */
export const ParsedCompose = Type.Object({
	services: Type.Array(ComposeImportService, {
		maxItems: IMPORT_MAX_SERVICES,
		description: "In file order",
	}),
});
/** Result of `parseComposeForImport`. */
export type ParsedCompose = Static<typeof ParsedCompose>;

/** Why a compose service cannot be imported. */
export const ImportSkipReason = Type.Union([
	Type.Literal("build", {
		description: "Built from source: your app, runs outside LocaInfra",
	}),
	Type.Literal("no-match", {
		description: "No catalog definition matches the image",
	}),
]);
/** Why a compose service cannot be imported. */
export type ImportSkipReason = Static<typeof ImportSkipReason>;

/** One row of the Import preview (and of the `POST /api/import` body). */
export const ImportItem = Type.Object({
	composeName: Type.String({ description: "Compose service key, as written" }),
	name: ResourceName,
	image: Type.Optional(Type.String()),
	type: Type.Optional(
		Type.String({ description: "Matched catalog id; absent when unsupported" }),
	),
	version: Type.Optional(
		Type.String({
			description:
				"Catalog version derived from the image tag (e.g. 16-alpine → 16) when it is one of the definition's versions; absent = defaultVersion",
		}),
	),
	supported: Type.Boolean(),
	skipReason: Type.Optional(ImportSkipReason),
	include: Type.Boolean({
		description: "Checked in the preview (false for unsupported items)",
	}),
	hostPort: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 65535,
			description: "Host port the imported service will pin",
		}),
	),
	wantedPort: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 65535,
			description:
				"Host port the compose file asked for (else the definition's default port)",
		}),
	),
	remapNote: Type.Optional(
		Type.String({
			description:
				"Why hostPort differs from wantedPort, e.g. 5432 is used by shop-api/main-db, or 5432 is in use on this machine",
		}),
	),
	config: Type.Record(Type.String(), Type.String(), {
		description: "Definition config keys taken from the compose environment",
	}),
	secrets: Type.Record(
		Type.String(),
		Type.String({ pattern: IMPORT_SECRET_VALUE_PATTERN }),
		{
			description:
				"Definition secret names → values from the compose environment (echoed back from the client's own file; never logged). Values outside the URL-safe alphabet are dropped (a fresh one is generated)",
		},
	),
});
/** One row of the Import preview. */
export type ImportItem = Static<typeof ImportItem>;

/** Result of `mapComposeToCatalog`. */
export const ImportPlan = Type.Object({
	items: Type.Array(ImportItem, { description: "In compose file order" }),
});
/** Result of `mapComposeToCatalog`. */
export type ImportPlan = Static<typeof ImportPlan>;

/** Result of `previewImport` (`POST /api/import/preview`). */
export const ImportPreview = Type.Composite([
	ImportPlan,
	Type.Object({
		suggestedName: ResourceName,
	}),
]);
/** Result of `previewImport`. */
export type ImportPreview = Static<typeof ImportPreview>;
