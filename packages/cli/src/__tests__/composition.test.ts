import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CatalogError } from "@locainfra/core";
import {
	createEngines,
	DockerClient,
	resolveDefaultPaths,
} from "@locainfra/engines";
import {
	composeDeps,
	DASHBOARD_DIR_ENV,
	embeddedRoot,
	repoDashboardDir,
	resolveCatalogDir,
	resolveDashboardAssets,
	serverOps,
	serverPorts,
} from "../composition";

const stateDir = await mkdtemp(join(tmpdir(), "locainfra-cli-home-"));
afterAll(() => rm(stateDir, { recursive: true, force: true }));

const BUNFS_CATALOG = join(embeddedRoot(), "catalog");
/** Where Bun 1.4.2 puts `--asset packages/dashboard/dist` (its basename). */
const BUNFS_DASHBOARD = join(embeddedRoot(), "dist");
/** The full relative path, in case a Bun release preserves it. */
const BUNFS_DASHBOARD_FULL = join(
	embeddedRoot(),
	"packages",
	"dashboard",
	"dist",
);

/** A filesystem probe that only knows `present` (simulates `/$bunfs`). */
const only =
	(...present: string[]) =>
	(path: string) =>
		present.includes(path);

describe("embeddedRoot", () => {
	test("is Bun's compiled-binary root per platform", () => {
		expect(embeddedRoot("darwin")).toBe("/$bunfs/root");
		expect(embeddedRoot("linux")).toBe("/$bunfs/root");
		expect(embeddedRoot("win32")).toBe("B:\\~BUN\\root");
	});
});

describe("resolveCatalogDir", () => {
	test("defaults to the repo-root catalog/", () => {
		const dir = resolveCatalogDir({});
		expect(dir).toBe(resolve(import.meta.dir, "../../../../catalog"));
		expect(existsSync(join(dir, "postgres.yaml"))).toBe(true);
	});

	test("uses the embedded /$bunfs catalog when it exists", () => {
		expect(resolveCatalogDir({}, only(BUNFS_CATALOG))).toBe(
			resolve(BUNFS_CATALOG),
		);
		expect(resolveCatalogDir({}, only())).toBe(
			resolve(import.meta.dir, "../../../../catalog"),
		);
	});

	test("LOCAINFRA_CATALOG_DIR wins, even over an embedded catalog", () => {
		expect(
			resolveCatalogDir(
				{ LOCAINFRA_CATALOG_DIR: "/tmp/cat" },
				only(BUNFS_CATALOG),
			),
		).toBe(resolve("/tmp/cat"));
		expect(resolveCatalogDir({ LOCAINFRA_CATALOG_DIR: "  " })).toBe(
			resolve(import.meta.dir, "../../../../catalog"),
		);
	});
});

describe("resolveDashboardAssets", () => {
	const repoIndex = join(repoDashboardDir(), "index.html");

	test("LOCAINFRA_DASHBOARD_DIR wins", () => {
		expect(
			resolveDashboardAssets(
				{ [DASHBOARD_DIR_ENV]: " /srv/spa " },
				only(join(BUNFS_DASHBOARD, "index.html"), repoIndex),
			),
		).toBe("/srv/spa");
	});

	test("then the embedded /$bunfs dashboard when it has an index.html", () => {
		expect(
			resolveDashboardAssets(
				{},
				only(join(BUNFS_DASHBOARD, "index.html"), repoIndex),
			),
		).toBe(BUNFS_DASHBOARD);
		expect(
			resolveDashboardAssets(
				{},
				only(join(BUNFS_DASHBOARD_FULL, "index.html")),
			),
		).toBe(BUNFS_DASHBOARD_FULL);
		expect(resolveDashboardAssets({}, only(BUNFS_DASHBOARD))).toBeUndefined();
	});

	test("then the repo build, else none (Vite dev server)", () => {
		expect(resolveDashboardAssets({}, only(repoIndex))).toBe(
			repoDashboardDir(),
		);
		expect(resolveDashboardAssets({}, only())).toBeUndefined();
		expect(resolveDashboardAssets({})).toBe(
			existsSync(repoIndex) ? repoDashboardDir() : undefined,
		);
	});
});

describe("composeDeps", () => {
	const env = { LOCAINFRA_HOME: stateDir };

	test("wires paths from LOCAINFRA_HOME into every op", () => {
		const deps = composeDeps({ env, home: "/home/test" });
		expect(deps.up.paths.stateDir).toBe(stateDir);
		expect(deps.down.paths).toBe(deps.up.paths);
		expect(deps.discover.files).toBe(deps.up.files);
		expect(deps.projects.state).toBe(deps.up.state);
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
		expect(typeof deps.dashboard.start).toBe("function");
		expect(deps.dashboard.createToken()).toMatch(/^[\w-]{32}$/);
		expect(deps.dashboard.createToken()).not.toBe(deps.dashboard.createToken());
	});

	test("LOCAINFRA_SESSION_TOKEN fixes the token when long enough", () => {
		const fixed = "e2e-token-0123456789";
		expect(
			composeDeps({
				env: { ...env, LOCAINFRA_SESSION_TOKEN: fixed },
			}).dashboard.createToken(),
		).toBe(fixed);
		expect(
			composeDeps({
				env: { ...env, LOCAINFRA_SESSION_TOKEN: "short" },
			}).dashboard.createToken(),
		).not.toBe("short");
	});

	test("serverOps covers every op the server needs", () => {
		const ops = serverOps();
		for (const fn of Object.values(ops)) expect(typeof fn).toBe("function");
		expect(Object.keys(ops)).toHaveLength(31);
	});

	test("serverPorts hands the server every M3 adapter, sharing one database", () => {
		const deps = composeDeps({ env });
		const engines = createEngines(
			resolveDefaultPaths({ env: { LOCAINFRA_HOME: stateDir } }),
		);
		const ports = serverPorts(engines, deps.up.catalog);
		expect(ports.exec).toBe(engines.exec);
		expect(ports.archiver).toBe(engines.archiver);
		expect(ports.snapshots).toBe(engines.snapshots);
		expect(ports.journal).toBe(engines.journal);
		expect(ports.state).toBe(engines.state);
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
