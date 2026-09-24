import { describe, expect, test } from "bun:test";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { Value } from "@sinclair/typebox/value";
import { CatalogError, ServiceDefinition } from "../catalog.model";

/** The postgres example from plan §2, as the YAML loader would produce it. */
const postgresExample = {
	id: "postgres",
	name: "PostgreSQL",
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
		POSTGRES_USER: { default: "postgres" },
		POSTGRES_DB: { default: "{{stack.name}}" },
	},
	env: {
		POSTGRES_USER: "{{config.POSTGRES_USER}}",
		POSTGRES_PASSWORD: "{{secrets.POSTGRES_PASSWORD}}",
		POSTGRES_DB: "{{config.POSTGRES_DB}}",
	},
	volumes: [{ name: "data", path: "/var/lib/postgresql/data" }],
	healthcheck: {
		test: [
			"CMD-SHELL",
			"pg_isready -U {{config.POSTGRES_USER}} -d {{config.POSTGRES_DB}}",
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
	connect: [
		"psql",
		"-U",
		"{{config.POSTGRES_USER}}",
		"-d",
		"{{config.POSTGRES_DB}}",
	],
	studio: { panel: "sql" },
};

describe("ServiceDefinition schema", () => {
	test("compiles", () => {
		expect(() => TypeCompiler.Compile(ServiceDefinition)).not.toThrow();
	});

	test("accepts the plan's postgres example", () => {
		const checker = TypeCompiler.Compile(ServiceDefinition);
		expect([...checker.Errors(postgresExample)]).toEqual([]);
		expect(checker.Check(postgresExample)).toBe(true);
	});

	test("Value.Parse applies defaults and converts YAML scalars", () => {
		const { tags, secrets, config, env, volumes, exports, ...minimal } =
			postgresExample;
		const parsed = Value.Parse(ServiceDefinition, {
			...minimal,
			versions: [17, 16],
			defaultVersion: 17,
		});
		expect(parsed.versions).toEqual(["17", "16"]);
		expect(parsed.defaultVersion).toBe("17");
		expect(parsed.tags).toEqual([]);
		expect(parsed.secrets).toEqual([]);
		expect(parsed.config).toEqual({});
		expect(parsed.env).toEqual({});
		expect(parsed.volumes).toEqual([]);
		expect(parsed.exports).toEqual({});
	});

	test("rejects an unknown category", () => {
		expect(
			Value.Check(ServiceDefinition, { ...postgresExample, category: "nope" }),
		).toBe(false);
	});

	test("rejects invalid env names, ids and relative volume paths", () => {
		expect(
			Value.Check(ServiceDefinition, {
				...postgresExample,
				env: { "BAD-NAME": "x" },
			}),
		).toBe(false);
		expect(
			Value.Check(ServiceDefinition, { ...postgresExample, id: "Postgres" }),
		).toBe(false);
		expect(
			Value.Check(ServiceDefinition, {
				...postgresExample,
				volumes: [{ name: "data", path: "relative" }],
			}),
		).toBe(false);
	});

	test("rejects a port outside 1..65535", () => {
		expect(
			Value.Check(ServiceDefinition, {
				...postgresExample,
				port: { container: 70000, default: 5432, range: [5432, 5499] },
			}),
		).toBe(false);
	});

	test("serialises to JSON Schema", () => {
		const json = JSON.parse(JSON.stringify(ServiceDefinition)) as {
			$id: string;
			type: string;
		};
		expect(json.$id).toBe("https://locastack.dev/schema/service.v1.json");
		expect(json.type).toBe("object");
	});
});

describe("CatalogError", () => {
	test("carries id, source and issues", () => {
		const error = new CatalogError("invalid", {
			catalogId: "postgres",
			source: "catalog/postgres.yaml",
			issues: ["/port: expected object"],
		});
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("CatalogError");
		expect(error.catalogId).toBe("postgres");
		expect(error.source).toBe("catalog/postgres.yaml");
		expect(error.issues).toEqual(["/port: expected object"]);
	});
});
