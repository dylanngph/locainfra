import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { JSON_SCHEMA_DRAFT } from "../../shared/json-schema";
import { stackJsonSchema } from "../../stack/stack.schema";
import { serviceJsonSchema } from "../catalog.schema";

const SCHEMA_DIR = join(
	import.meta.dir,
	"..",
	"..",
	"..",
	"..",
	"..",
	"schema",
);

describe("published JSON Schemas", () => {
	test("committed files are up to date (bun packages/core/scripts/emit-schemas.ts)", async () => {
		// Compared as JSON: the committed files are Biome-formatted.
		expect(await Bun.file(join(SCHEMA_DIR, "service.v1.json")).json()).toEqual(
			JSON.parse(serviceJsonSchema),
		);
		expect(await Bun.file(join(SCHEMA_DIR, "stack.v1.json")).json()).toEqual(
			JSON.parse(stackJsonSchema),
		);
	});

	test("carry $schema and $id", () => {
		const service = JSON.parse(serviceJsonSchema) as {
			$schema: string;
			$id: string;
		};
		expect(service.$schema).toBe(JSON_SCHEMA_DRAFT);
		expect(service.$id).toBe("https://locainfra.dev/schema/service.v1.json");
		expect((JSON.parse(stackJsonSchema) as { $id: string }).$id).toBe(
			"https://locainfra.dev/schema/v1.json",
		);
	});

	test("defaulted properties are not required, so editors accept terse YAML", () => {
		const service = JSON.parse(serviceJsonSchema) as {
			required: string[];
			properties: Record<string, unknown>;
		};
		expect(service.required).toEqual([
			"id",
			"name",
			"category",
			"image",
			"versions",
			"defaultVersion",
			"port",
			"healthcheck",
			"primaryExport",
		]);
		expect(service.properties.command).toBeDefined();
		expect(
			(JSON.parse(stackJsonSchema) as { required: string[] }).required,
		).toEqual(["version", "name"]);
	});
});
