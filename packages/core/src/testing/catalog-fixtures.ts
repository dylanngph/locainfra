import type { ServiceDefinition } from "../catalog/catalog.model";
import type { Stack, StackFile } from "../stack/stack.model";

/** Test definition of PostgreSQL (the plan's §2 example). */
export const postgresDefinition: ServiceDefinition = {
	id: "postgres",
	name: "PostgreSQL",
	description: "Relational SQL database.",
	category: "database",
	tags: ["sql", "relational"],
	icon: "postgres",
	homepage: "https://www.postgresql.org",
	image: "postgres:{{version}}-alpine",
	versions: ["17", "16", "15"],
	defaultVersion: "17",
	port: { container: 5432, default: 5432, range: [5432, 5499] },
	secrets: ["POSTGRES_PASSWORD"],
	config: {
		POSTGRES_USER: {
			default: "postgres",
			pattern: "^[A-Za-z0-9_][A-Za-z0-9_.-]*$",
		},
		POSTGRES_DB: {
			default: "{{stack.name}}",
			pattern: "^[A-Za-z0-9_][A-Za-z0-9_-]*$",
		},
	},
	env: {
		POSTGRES_USER: "{{config.POSTGRES_USER}}",
		POSTGRES_PASSWORD: "{{secrets.POSTGRES_PASSWORD}}",
		POSTGRES_DB: "{{config.POSTGRES_DB}}",
	},
	volumes: [{ name: "data", path: "/var/lib/postgresql/data" }],
	healthcheck: {
		test: [
			"CMD",
			"pg_isready",
			"-U",
			"{{config.POSTGRES_USER}}",
			"-d",
			"{{config.POSTGRES_DB}}",
		],
		interval: "5s",
		retries: 10,
	},
	exports: {
		DATABASE_URL:
			"postgres://{{config.POSTGRES_USER}}:{{secrets.POSTGRES_PASSWORD}}@127.0.0.1:{{port}}/{{config.POSTGRES_DB}}",
		PGHOST: "127.0.0.1",
		PGPORT: "{{port}}",
	},
	primaryExport: "DATABASE_URL",
	snippets: {
		node: 'import pg from "pg";\nconst pool = new pg.Pool({ connectionString: process.env.KEY });',
		python: 'import os, psycopg\nconn = psycopg.connect(os.environ["KEY"])',
		go: 'conn, err := pgx.Connect(ctx, os.Getenv("KEY"))',
	},
	connect: [
		"psql",
		"-U",
		"{{config.POSTGRES_USER}}",
		"-d",
		"{{config.POSTGRES_DB}}",
	],
	studio: { panel: "sql" },
	data: {
		kind: "sql",
		label: "Tables",
		listObjects: [
			"psql",
			"-X",
			"-U",
			"{{config.POSTGRES_USER}}",
			"-d",
			"{{config.POSTGRES_DB}}",
			"-A",
			"-t",
			"-c",
			"SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
		],
		runQuery: [
			"psql",
			"-X",
			"-U",
			"{{config.POSTGRES_USER}}",
			"-d",
			"{{config.POSTGRES_DB}}",
			"--csv",
			"-v",
			"ON_ERROR_STOP=1",
			"-c",
			"{{query}}",
		],
		defaultQuery: 'SELECT *\nFROM "{{object}}"\nLIMIT 100;',
	},
	seed: {
		mountPath: "/docker-entrypoint-initdb.d",
		fileName: "seed.sql",
		run: [
			"psql",
			"-X",
			"-q",
			"-U",
			"{{config.POSTGRES_USER}}",
			"-d",
			"{{config.POSTGRES_DB}}",
			"-v",
			"ON_ERROR_STOP=1",
			"-f",
			"-",
		],
	},
	secretOptions: { POSTGRES_PASSWORD: { bakedIntoVolume: true } },
	import: { images: ["postgres", "postgis/postgis", "pgvector/pgvector"] },
};

/** Test definition of Redis (password via `command`). */
export const redisDefinition: ServiceDefinition = {
	id: "redis",
	name: "Redis",
	category: "cache",
	categoryLabel: "Redis",
	tags: ["key-value"],
	icon: "redis",
	image: "redis:{{version}}-alpine",
	versions: ["7", "8"],
	defaultVersion: "7",
	port: { container: 6379, default: 6379, range: [6379, 6449] },
	secrets: ["REDIS_PASSWORD"],
	config: {},
	env: {},
	command: [
		"redis-server",
		"--requirepass",
		"{{secrets.REDIS_PASSWORD}}",
		"--appendonly",
		"yes",
	],
	volumes: [{ name: "data", path: "/data" }],
	healthcheck: {
		test: [
			"CMD",
			"redis-cli",
			"-a",
			"{{secrets.REDIS_PASSWORD}}",
			"--no-auth-warning",
			"ping",
		],
		interval: "5s",
		retries: 10,
	},
	exports: {
		REDIS_URL: "redis://:{{secrets.REDIS_PASSWORD}}@127.0.0.1:{{port}}",
	},
	primaryExport: "REDIS_URL",
	studio: { panel: "redis" },
	data: {
		kind: "redis",
		label: "Key patterns",
		objects: ["*"],
		runQuery: ["redis-cli", "--csv", "{{query}}"],
		defaultQuery: "SCAN 0 MATCH {{object}} COUNT 100",
	},
	import: { images: ["redis", "valkey/valkey"] },
};

/** Test definition of the Upstash-compatible REST proxy (depends on redis). */
export const upstashRedisDefinition: ServiceDefinition = {
	id: "upstash-redis",
	name: "Upstash Redis (REST)",
	category: "cache",
	categoryLabel: "Redis",
	tags: ["serverless", "rest"],
	image: "hiett/serverless-redis-http:{{version}}",
	versions: ["latest"],
	defaultVersion: "latest",
	port: { container: 80, default: 8079, range: [8079, 8149] },
	secrets: ["SRH_TOKEN"],
	config: {},
	env: {
		SRH_MODE: "env",
		SRH_TOKEN: "{{secrets.SRH_TOKEN}}",
		SRH_CONNECTION_STRING:
			"redis://:{{services.redis.secrets.REDIS_PASSWORD}}@{{services.redis.host}}:6379",
	},
	volumes: [],
	healthcheck: {
		test: [
			"CMD-SHELL",
			"wget -qO- http://127.0.0.1:80/ >/dev/null 2>&1 || exit 1",
		],
		interval: "5s",
		retries: 10,
	},
	exports: {
		UPSTASH_REDIS_REST_URL: "http://127.0.0.1:{{port}}",
		UPSTASH_REDIS_REST_TOKEN: "{{secrets.SRH_TOKEN}}",
	},
	primaryExport: "UPSTASH_REDIS_REST_URL",
	dependsOn: ["redis"],
	data: { kind: "none" },
	import: {
		images: ["hiett/serverless-redis-http", "upstash/redis-http"],
	},
};

/** The three built-in v0.1 definitions. */
export const builtinTestDefinitions: readonly ServiceDefinition[] = [
	postgresDefinition,
	redisDefinition,
	upstashRedisDefinition,
];

/**
 * Builds a project {@link Stack} for tests.
 *
 * @param name - Project name.
 * @param services - Stack file `services` (instance name → entry with `type`).
 * @param extra - Extra stack file fields (e.g. `link`).
 * @returns A project stack rooted at `/work/<name>`.
 */
export function createProjectStack(
	name: string,
	services: StackFile["services"],
	extra: Partial<Omit<StackFile, "version" | "name" | "services">> = {},
): Stack {
	return {
		name,
		root: `/work/${name}`,
		filePath: `/work/${name}/locainfra.yaml`,
		file: { version: 1, name, services, ...extra },
	};
}
