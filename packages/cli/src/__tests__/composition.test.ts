import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CatalogError } from "@locainfra/core";
import { DockerClient } from "@locainfra/engines";
import {
	CATALOG_DIR_ENV,
	composeDeps,
	resolveCatalogDir,
} from "../composition";

const stateDir = await mkdtemp(join(tmpdir(), "locainfra-cli-home-"));
afterAll(() => rm(stateDir, { recursive: true, force: true }));

describe("resolveCatalogDir", () => {
	test("defaults to the repo-root catalog/", () => {
		const dir = resolveCatalogDir({});
		expect(dir).toBe(resolve(import.meta.dir, "../../../../catalog"));
		expect(existsSync(join(dir, "postgres.yaml"))).toBe(true);
	});

	test(`honours ${CATALOG_DIR_ENV}`, () => {
		expect(resolveCatalogDir({ [CATALOG_DIR_ENV]: "/tmp/cat" })).toBe(
			"/tmp/cat",
		);
	});
});

describe("composeDeps", () => {
	const env = { LOCAINFRA_HOME: stateDir };

	test("wires paths from LOCAINFRA_HOME into every op", () => {
		const deps = composeDeps({ env, home: "/home/test" });
		expect(deps.up.paths.stateDir).toBe(stateDir);
		expect(deps.down.paths).toBe(deps.up.paths);
		expect(deps.discover.paths).toBe(deps.up.paths);
		expect(deps.env.paths).toBe(deps.up.paths);
		expect(deps.up.paths.home).toBe("/home/test");
	});

	test("shares one adapter per port across ops", () => {
		const deps = composeDeps({ env });
		expect(deps.doctor.docker).toBeInstanceOf(DockerClient);
		expect(deps.up.lifecycle).toBe(deps.down.lifecycle);
		expect(deps.up.catalog).toBe(deps.env.catalog);
		expect(deps.env.state).toBe(deps.up.state);
		expect(deps.down.state).toBe(deps.up.state);
		expect(deps.down.files).toBe(deps.up.files);
		expect(deps.up.compose).toBe(deps.doctor.compose);
		expect(typeof deps.ops.runDoctor).toBe("function");
		expect(typeof deps.ops.upStack).toBe("function");
	});

	test("loads the built-in catalog and skips invalid overrides", async () => {
		const overrides = join(stateDir, "catalog");
		await mkdir(overrides, { recursive: true });
		await writeFile(join(overrides, "broken.yaml"), "id: [unclosed\n");
		const invalid: CatalogError[] = [];
		const deps = composeDeps({
			env,
			onInvalidCatalog: (e) => invalid.push(e),
		});
		const ids = (await deps.up.catalog.definitions()).map((d) => d.id);
		expect(ids).toEqual(
			expect.arrayContaining(["postgres", "redis", "upstash-redis"]),
		);
		expect(invalid).toHaveLength(1);
	});
});
