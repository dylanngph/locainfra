import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Registered project folders (`StateFile.projects`). Row order (`rowid`) is
 * the order of the array; `created_at` is database-only bookkeeping.
 */
export const projects = sqliteTable("projects", {
	/** Stack name of the project. */
	name: text("name").primaryKey(),
	/** Absolute project folder. */
	root: text("root").notNull(),
	/** Env file to link, relative to `root`. */
	envFile: text("env_file"),
	/** ISO-8601 time the project was first registered. */
	createdAt: text("created_at").notNull(),
});

/** Stacks that have state (`StateFile.stacks` keys and their `createdAt`). */
export const stacks = sqliteTable("stacks", {
	/** Stack (compose project) name. */
	name: text("name").primaryKey(),
	/** ISO-8601 creation time, as exposed by `StackState.createdAt`. */
	createdAt: text("created_at").notNull(),
});

/**
 * Pinned host ports (`StackState.ports`). A host port is pinned by at most one
 * stack/service on the machine (`UNIQUE(port)`); a violation surfaces as a
 * `PORT_CONFLICT` from the store.
 */
export const portPins = sqliteTable(
	"port_pins",
	{
		/** Owning stack name. */
		project: text("project")
			.notNull()
			.references(() => stacks.name, { onDelete: "cascade" }),
		/** Service id inside the stack. */
		service: text("service").notNull(),
		/** Pinned host port on 127.0.0.1. */
		port: integer("port").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.project, table.service] }),
		uniqueIndex("port_pins_port_unique").on(table.port),
	],
);

/** Registry cache metadata (`StateFile.registry`); a single row with `id = 1`. */
export const registry = sqliteTable(
	"registry",
	{
		/** Always 1. */
		id: integer("id").primaryKey(),
		/** HTTP ETag of the cached registry index. */
		etag: text("etag"),
		/** ISO-8601 time of the last refresh. */
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [check("registry_single_row", sql`${table.id} = 1`)],
);

/** Snapshot index (archives and secret sidecars live on disk). */
export const snapshots = sqliteTable(
	"snapshots",
	{
		/** Snapshot id. */
		id: text("id").primaryKey(),
		/** Stack name. */
		project: text("project").notNull(),
		/** Service id. */
		service: text("service").notNull(),
		/** Human-readable snapshot name. */
		name: text("name").notNull(),
		/** Absolute path of the snapshot file. */
		path: text("path").notNull(),
		/** Size of the snapshot file in bytes. */
		sizeBytes: integer("size_bytes").notNull(),
		/** ISO-8601 creation time. */
		createdAt: text("created_at").notNull(),
		/**
		 * Catalog type of the service when archived (e.g. `postgres`); `null`
		 * for rows written before migration 0002. Restore refuses another type.
		 */
		type: text("type"),
		/**
		 * Service version when archived (e.g. `17`); `null` for rows written
		 * before migration 0002. Restore refuses another major version.
		 */
		version: text("version"),
		/**
		 * Whether a `<id>.secrets.json` sidecar (mode 0600, next to the archive)
		 * holds the values of the secrets baked into the volume at archive time.
		 */
		hasSecrets: integer("has_secrets", { mode: "boolean" })
			.notNull()
			.default(false),
	},
	(table) => [
		index("snapshots_project_service_idx").on(table.project, table.service),
	],
);

/** Rows kept per project in {@link ops}; older rows are pruned by a trigger. */
export const OPS_RETENTION_PER_PROJECT = 200;

/**
 * Operation history. Bounded: an `AFTER INSERT` trigger keeps the newest
 * {@link OPS_RETENTION_PER_PROJECT} rows per project.
 */
export const ops = sqliteTable(
	"ops",
	{
		/** Operation id. */
		id: text("id").primaryKey(),
		/** Stack name. */
		project: text("project").notNull(),
		/** Service id, when the op targets one service. */
		service: text("service"),
		/** Operation kind (e.g. `up`, `snapshot`). */
		kind: text("kind").notNull(),
		/** `running`, `succeeded`, `failed`, … */
		status: text("status").notNull(),
		/** ISO-8601 start time. */
		startedAt: text("started_at").notNull(),
		/** ISO-8601 end time, once finished. */
		finishedAt: text("finished_at"),
		/** Serialised secret-free `OpError` JSON on failure. */
		errorJson: text("error_json"),
	},
	(table) => [
		index("ops_project_started_idx").on(table.project, table.startedAt),
	],
);

/** Key/value metadata (schema and app versions). */
export const meta = sqliteTable("meta", {
	/** Metadata key. */
	key: text("key").primaryKey(),
	/** Metadata value. */
	value: text("value").notNull(),
});
