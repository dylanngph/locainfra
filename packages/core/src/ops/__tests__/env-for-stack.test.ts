import { describe, expect, test } from "bun:test";
import {
	builtinTestDefinitions,
	createGlobalStack,
	createProjectStack,
} from "../../testing/catalog-fixtures";
import {
	createTestPaths,
	InMemoryFileStore,
	InMemorySecretStore,
	InMemoryStateStore,
	StaticCatalogSource,
} from "../../testing/fakes";
import { envForStack } from "../env-for-stack.op";

function deps(provisioned = true) {
	return {
		files: new InMemoryFileStore(),
		state: new InMemoryStateStore(
			provisioned
				? {
						projects: [],
						stacks: {
							sovr: {
								ports: { postgres: 5433, redis: 6380 },
								createdAt: "2026-01-01T00:00:00Z",
							},
						},
					}
				: undefined,
		),
		secrets: new InMemorySecretStore(
			provisioned
				? { sovr: { POSTGRES_PASSWORD: "pgpw", REDIS_PASSWORD: "rpw" } }
				: {},
		),
		paths: createTestPaths(),
		catalog: new StaticCatalogSource([...builtinTestDefinitions]),
	};
}

const stack = createProjectStack(
	"sovr",
	{ postgres: {}, redis: {} },
	{ link: { file: ".env.local", names: { redis: "CACHE_URL" } } },
);

describe("envForStack", () => {
	test("dotenv with link.names applied", async () => {
		const result = await envForStack(deps(), { stack, format: "dotenv" });
		expect(result).toEqual({
			ok: true,
			value:
				"DATABASE_URL=postgres://postgres:pgpw@127.0.0.1:5433/sovr\nPGHOST=127.0.0.1\nPGPORT=5433\nCACHE_URL=redis://:rpw@127.0.0.1:6380\n",
		});
	});

	test("shell and json formats", async () => {
		const shell = await envForStack(deps(), { stack, format: "shell" });
		if (!shell.ok) throw shell.error;
		expect(shell.value).toContain(
			"export CACHE_URL='redis://:rpw@127.0.0.1:6380'\n",
		);
		const json = await envForStack(deps(), { stack, format: "json" });
		if (!json.ok) throw json.error;
		expect(JSON.parse(json.value).PGPORT).toBe("5433");
	});

	test("read-only: an unprovisioned stack is INVALID_STACK and nothing is written", async () => {
		const d = deps(false);
		const result = await envForStack(d, { stack, format: "dotenv" });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("INVALID_STACK");
			expect(String(result.error.details.fix)).toContain("locainfra up");
		}
		expect(d.state.updates).toBe(0);
		expect(d.secrets.writes).toBe(0);
	});

	test("global stack uses canonical ports", async () => {
		const d = deps(false);
		d.secrets.stacks.set("global", { POSTGRES_PASSWORD: "g" });
		const result = await envForStack(d, {
			stack: createGlobalStack({ postgres: {} }),
			format: "dotenv",
		});
		if (!result.ok) throw result.error;
		expect(result.value).toContain("PGPORT=5432\n");
	});

	test("catalog failure is INVALID_CATALOG", async () => {
		const d = deps();
		d.catalog.definitions = async () => {
			throw new Error("bad yaml");
		};
		const result = await envForStack(d, { stack, format: "json" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INVALID_CATALOG");
	});

	test("refuses a stack whose name belongs to another project folder", async () => {
		const d = deps();
		d.state.state.projects = [{ name: "sovr", root: "/work/elsewhere" }];
		d.files.files.set(
			"/work/elsewhere/locainfra.yaml",
			"version: 1\nname: sovr\n",
		);
		const result = await envForStack(d, { stack, format: "dotenv" });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("INVALID_STACK");
			expect(result.error.details.registeredRoot).toBe("/work/elsewhere");
			expect(result.error.message).not.toContain("pgpw");
		}
	});

	test("prints for the registered folder", async () => {
		const d = deps();
		d.state.state.projects = [{ name: "sovr", root: "/work/sovr" }];
		const result = await envForStack(d, { stack, format: "dotenv" });
		expect(result.ok).toBe(true);
	});
});
