import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	CATALOG_DIR_ENV,
	repoCatalogDir,
	resolveBuiltinCatalogDir,
} from "../catalog-dir";

describe("resolveBuiltinCatalogDir", () => {
	test("LOCAINFRA_CATALOG_DIR wins over everything", () => {
		expect(
			resolveBuiltinCatalogDir({
				env: { [CATALOG_DIR_ENV]: "  /opt/catalog " },
				embeddedDir: "/embedded",
			}),
		).toEqual({ dir: "/opt/catalog", source: "env" });
	});

	test("then the embedded assets folder passed by the CLI", () => {
		expect(
			resolveBuiltinCatalogDir({
				env: { [CATALOG_DIR_ENV]: " " },
				embeddedDir: "/home/me/.locainfra/catalog-builtin/0.1.0",
			}),
		).toEqual({
			dir: "/home/me/.locainfra/catalog-builtin/0.1.0",
			source: "embedded",
		});
	});

	test("else the repo catalog/ folder, which holds the built-in definitions", () => {
		const found = resolveBuiltinCatalogDir({ env: {} });
		expect(found.source).toBe("repo");
		expect(found.dir).toBe(resolve(import.meta.dir, "../../../../../catalog"));
		expect(found.dir).toBe(repoCatalogDir());
		expect(existsSync(join(found.dir, "postgres.yaml"))).toBe(true);
	});
});
