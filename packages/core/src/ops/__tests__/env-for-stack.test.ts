import { describe, expect, test } from "bun:test";
import {
	builtinTestDefinitions,
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
							shop: {
								ports: { postgres: 5433, redis: 6380, events: 5434 },
								createdAt: "2026-01-01T00:00:00Z",
							},
						},
					}
				: undefined,
		),
		secrets: new InMemorySecretStore(
			provisioned
				? {
						shop: {
							POSTGRES__POSTGRES_PASSWORD: "pgpw",
							REDIS__REDIS_PASSWORD: "rpw",
							EVENTS__POSTGRES_PASSWORD: "evpw",
						},
					}
				: {},
		),
		paths: createTestPaths(),
		catalog: new StaticCatalogSource([...builtinTestDefinitions]),
	};
}

const stack = createProjectStack(
	"shop",
	{ postgres: { type: "postgres" }, redis: { type: "redis" } },
	{ link: { file: ".env.local", names: { redis: "CACHE_URL" } } },
);

describe("envForStack", () => {
	test("dotenv with link.names applied", async () => {
		const result = await envForStack(deps(), { stack, format: "dotenv" });
		expect(result).toEqual({
			ok: true,
			value:
				"DATABASE_URL=postgres://postgres:pgpw@127.0.0.1:5433/shop\nPGHOST=127.0.0.1\nPGPORT=5433\nCACHE_URL=redis://:rpw@127.0.0.1:6380\n",
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

	test("a second instance of a type gets its keys prefixed", async () => {
		const twoDbs = createProjectStack("shop", {
			postgres: { type: "postgres" },
			events: { type: "postgres" },
		});
		const result = await envForStack(deps(), {
			stack: twoDbs,
			format: "dotenv",
		});
		if (!result.ok) throw result.error;
		expect(result.value).toContain(
			"EVENTS_DATABASE_URL=postgres://postgres:evpw@127.0.0.1:5434/shop\nEVENTS_PGHOST=127.0.0.1\nEVENTS_PGPORT=5434\n",
		);
		expect(result.value).toContain("\nPGPORT=5433\n");
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
		d.state.state.projects = [{ name: "shop", root: "/work/elsewhere" }];
		d.files.files.set(
			"/work/elsewhere/locainfra.yaml",
			"version: 1\nname: shop\n",
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
		d.state.state.projects = [{ name: "shop", root: "/work/shop" }];
		const result = await envForStack(d, { stack, format: "dotenv" });
		expect(result.ok).toBe(true);
	});
});
