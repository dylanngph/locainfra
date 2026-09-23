// biome-ignore-all lint/suspicious/noTemplateCurlyInString: compose ${VAR} interpolation is the test data
import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { builtinTestDefinitions } from "../../testing/catalog-fixtures";
import { collect } from "../../testing/collect";
import { FakePortProbe } from "../../testing/fakes";
import { importProject } from "../import-project.op";
import { mapComposeToCatalog } from "../map-compose-to-catalog.op";
import {
	IMPORT_MAX_SERVICES,
	IMPORT_YAML_MAX_BYTES,
	type ImportItem,
} from "../ops.model";
import {
	NO_SERVICES_MESSAGE,
	parseComposeForImport,
} from "../parse-compose-for-import.op";
import { previewImport } from "../preview-import.op";
import { createWorld, SHOP_PORTS } from "./world";

/** The prototype's SAMPLE_COMPOSE, extended with long ports, list env and anchors. */
const COMPOSE = `# docker-compose.yml of a typical app
x-restart: &restart
  restart: unless-stopped

services:
  web:
    build: .
    ports:
      - "3000:3000"
    depends_on: [db, cache]
  db:
    <<: *restart
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: shop
      POSTGRES_USER: app
      POSTGRES_PASSWORD: \${DB_PASSWORD:-secret}
    ports:
      - "127.0.0.1:5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
  cache:
    image: docker.io/library/redis:7.4
    command: redis-server --requirepass devpass
    environment:
      - REDIS_PASSWORD=devpass
      - UNUSED
    ports:
      - target: 6379
        published: 6379
        protocol: tcp
  Cache_2:
    image: valkey/valkey:8
    ports: ["6379"]
  storage:
    image: minio/minio:latest
    environment:
      MINIO_ROOT_USER: minio
      MINIO_ROOT_PASSWORD: minio123
    ports:
      - "9000:9000"
      - "9001:9001"
  mailhog:
    image: mailhog/mailhog
    ports:
      - "8025:8025"
      - "1025:1025"
  vector-db:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_PASSWORD: "p@ss word"
      POSTGRES_DB: "bad db"
    ports:
      - "5432:5432"

volumes:
  pgdata:
`;

describe("parseComposeForImport", () => {
	test("reads a realistic compose file: build, anchors, short/long ports, env forms", () => {
		const parsed = parseComposeForImport(COMPOSE);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.services).toEqual([
			{
				name: "web",
				build: true,
				ports: [{ host: 3000, container: 3000 }],
				environment: {},
			},
			{
				name: "db",
				image: "postgres:16-alpine",
				build: false,
				ports: [{ host: 5432, container: 5432 }],
				environment: {
					POSTGRES_DB: "shop",
					POSTGRES_USER: "app",
					POSTGRES_PASSWORD: "secret",
				},
			},
			{
				name: "cache",
				image: "docker.io/library/redis:7.4",
				build: false,
				ports: [{ host: 6379, container: 6379 }],
				environment: { REDIS_PASSWORD: "devpass" },
			},
			{
				name: "Cache_2",
				image: "valkey/valkey:8",
				build: false,
				ports: [{ container: 6379 }],
				environment: {},
			},
			{
				name: "storage",
				image: "minio/minio:latest",
				build: false,
				ports: [
					{ host: 9000, container: 9000 },
					{ host: 9001, container: 9001 },
				],
				environment: {
					MINIO_ROOT_USER: "minio",
					MINIO_ROOT_PASSWORD: "minio123",
				},
			},
			{
				name: "mailhog",
				image: "mailhog/mailhog",
				build: false,
				ports: [
					{ host: 8025, container: 8025 },
					{ host: 1025, container: 1025 },
				],
				environment: {},
			},
			{
				name: "vector-db",
				image: "pgvector/pgvector:pg16",
				build: false,
				ports: [{ host: 5432, container: 5432 }],
				environment: { POSTGRES_PASSWORD: "p@ss word", POSTGRES_DB: "bad db" },
			},
		]);
	});

	test("rejects oversized, invalid and service-less files", () => {
		const cases: Array<[string, string]> = [
			[
				"x".repeat(IMPORT_YAML_MAX_BYTES + 1),
				"The file is larger than 512 KB.",
			],
			[
				"services:\n  db:\n    image: a\n   bad: 1\n",
				"Invalid YAML at line 4, column 1",
			],
			["services:\n  a: {}\n  a: {}\n", "Map keys must be unique"],
			["version: '3'\n", NO_SERVICES_MESSAGE],
			["services: {}\n", NO_SERVICES_MESSAGE],
			["services: [a, b]\n", NO_SERVICES_MESSAGE],
			["- just a list\n", NO_SERVICES_MESSAGE],
			["", NO_SERVICES_MESSAGE],
		];
		for (const [text, message] of cases) {
			const result = parseComposeForImport(text);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.code).toBe("INVALID_INPUT");
				expect(result.error.message).toContain(message);
			}
		}
		const many = `services:\n${Array.from({ length: IMPORT_MAX_SERVICES + 1 }, (_, i) => `  s${i}: { image: redis }`).join("\n")}\n`;
		const tooMany = parseComposeForImport(many);
		expect(!tooMany.ok && tooMany.error.message).toBe(
			`The file has ${IMPORT_MAX_SERVICES + 1} services; Import takes at most ${IMPORT_MAX_SERVICES}.`,
		);
	});

	test("a service that is not a map has no image; an alias bomb is refused", () => {
		const parsed = parseComposeForImport("services:\n  odd: redis\n  empty:\n");
		expect(parsed.ok && parsed.value.services).toEqual([
			{ name: "odd", build: false, ports: [], environment: {} },
			{ name: "empty", build: false, ports: [], environment: {} },
		]);
		const bomb = [
			"a: &a [x, x, x, x, x, x, x, x, x, x]",
			"b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]",
			"c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]",
			"d: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]",
			"services: { x: { image: redis, labels: *d } }",
		].join("\n");
		const refused = parseComposeForImport(bomb);
		expect(!refused.ok && refused.error.code).toBe("INVALID_INPUT");
	});
});

function parsed() {
	const result = parseComposeForImport(COMPOSE);
	if (!result.ok) throw result.error;
	return result.value;
}

describe("mapComposeToCatalog", () => {
	test("matches images, versions, config and secrets; remaps taken ports", async () => {
		const probe = new FakePortProbe([6379]);
		const plan = await mapComposeToCatalog({
			parsed: parsed(),
			definitions: builtinTestDefinitions,
			reserved: new Map([[5432, "shop-api/main-db"]]),
			probe,
		});
		const byName = new Map(plan.items.map((item) => [item.name, item]));
		expect(plan.items.map((i) => i.name)).toEqual([
			"web",
			"db",
			"cache",
			"cache-2",
			"storage",
			"mailhog",
			"vector-db",
		]);
		expect(byName.get("web")).toEqual({
			composeName: "web",
			name: "web",
			config: {},
			secrets: {},
			supported: false,
			skipReason: "build",
			include: false,
		});
		expect(byName.get("db")).toEqual({
			composeName: "db",
			name: "db",
			image: "postgres:16-alpine",
			type: "postgres",
			version: "16",
			supported: true,
			include: true,
			hostPort: 5433,
			wantedPort: 5432,
			remapNote: "5432 is used by shop-api/main-db",
			config: { POSTGRES_DB: "shop", POSTGRES_USER: "app" },
			secrets: { POSTGRES_PASSWORD: "secret" },
		});
		expect(byName.get("cache")).toMatchObject({
			type: "redis",
			version: "7",
			hostPort: 6380,
			wantedPort: 6379,
			remapNote: "6379 is in use on this machine",
			config: {},
			secrets: { REDIS_PASSWORD: "devpass" },
		});
		// Container port only: the definition's default port, busy on the host.
		expect(byName.get("cache-2")).toMatchObject({
			composeName: "Cache_2",
			type: "redis",
			version: "8",
			wantedPort: 6379,
			hostPort: 6381,
			remapNote: "6379 is in use on this machine",
		});
		expect(byName.get("storage")).toMatchObject({
			supported: false,
			skipReason: "no-match",
			include: false,
		});
		expect(byName.get("mailhog")).toMatchObject({
			supported: false,
			skipReason: "no-match",
		});
		// Values that break URLs or patterns are dropped (generated / defaulted later).
		expect(byName.get("vector-db")).toMatchObject({
			type: "postgres",
			hostPort: 5434,
			remapNote: "5432 is used by shop-api/main-db",
			config: {},
			secrets: {},
		});
		expect(byName.get("vector-db")?.version).toBeUndefined();
	});

	test("keeps a free wanted port; import.env renames; no free port leaves auto", async () => {
		const [postgres, redis, upstash] = builtinTestDefinitions;
		if (postgres === undefined || redis === undefined || upstash === undefined)
			throw new Error("fixtures");
		const renamed = {
			...postgres,
			import: {
				images: ["postgres"],
				env: {
					DB_NAME: "config.POSTGRES_DB",
					DB_PASS: "secrets.POSTGRES_PASSWORD",
					DB_BAD: "config.NOPE",
				},
			},
		};
		const plan = await mapComposeToCatalog({
			parsed: {
				services: [
					{
						name: "db",
						image: "postgres:${PG:-15}",
						build: false,
						ports: [{ host: 15432, container: 5432 }],
						environment: { DB_NAME: "app", DB_PASS: "pw", DB_BAD: "x" },
					},
					{
						name: "kv",
						image: "redis",
						build: false,
						ports: [],
						environment: {},
					},
					{
						name: "rest",
						image: "hiett/serverless-redis-http:latest",
						build: false,
						ports: [{ host: 8079, container: 80 }],
						environment: {},
					},
					{ name: "nothing", build: false, ports: [], environment: {} },
				],
			},
			definitions: [renamed, redis, upstash],
			reserved: new Map(),
			probe: new FakePortProbe(Array.from({ length: 200 }, (_, i) => 8000 + i)),
		});
		expect(plan.items[0]).toMatchObject({
			type: "postgres",
			version: "15",
			hostPort: 15432,
			wantedPort: 15432,
			config: { POSTGRES_DB: "app" },
			secrets: { POSTGRES_PASSWORD: "pw" },
		});
		expect(plan.items[0]?.remapNote).toBeUndefined();
		expect(plan.items[1]).toMatchObject({
			type: "redis",
			hostPort: 6379,
			wantedPort: 6379,
		});
		expect(plan.items[1]?.version).toBeUndefined();
		expect(plan.items[2]).toMatchObject({
			type: "upstash-redis",
			version: "latest",
			wantedPort: 8079,
			remapNote: "8079 is in use on this machine",
		});
		expect(plan.items[2]?.hostPort).toBeUndefined();
		expect(plan.items[3]).toMatchObject({
			supported: false,
			skipReason: "no-match",
		});
	});

	test("a throwing probe counts as busy", async () => {
		const plan = await mapComposeToCatalog({
			parsed: {
				services: [
					{
						name: "db",
						image: "postgres",
						build: false,
						ports: [],
						environment: {},
					},
				],
			},
			definitions: builtinTestDefinitions,
			reserved: new Map(),
			probe: {
				isFree: async (port) => {
					if (port === 5432) throw new Error("EPERM");
					return true;
				},
			},
		});
		expect(plan.items[0]).toMatchObject({
			hostPort: 5433,
			remapNote: "5432 is in use on this machine",
		});
	});
});

describe("previewImport", () => {
	test("maps against every project's pins and suggests a free name", async () => {
		const world = createWorld({ provisioned: true });
		const preview = await previewImport(world, {
			yaml: COMPOSE,
			projectName: "My Shop.yml",
		});
		expect(preview.ok).toBe(true);
		if (!preview.ok) return;
		expect(preview.value.suggestedName).toBe("my-shop");
		const db = preview.value.items.find((i) => i.name === "db");
		// 5432 is free and not pinned (shop pins 5433/5434): kept.
		expect(db).toMatchObject({ hostPort: 5432, wantedPort: 5432 });
		const cache = preview.value.items.find((i) => i.name === "cache");
		expect(cache).toMatchObject({ hostPort: 6379 });
		// 6379 went to "cache"; 6380 is pinned by shop/cache.
		expect(preview.value.items.find((i) => i.name === "cache-2")).toMatchObject(
			{
				hostPort: 6381,
				remapNote: "6379 is used by another service in this file",
			},
		);
		expect(
			preview.value.items.find((i) => i.name === "vector-db"),
		).toMatchObject({
			hostPort: 5435,
			remapNote: "5432 is used by another service in this file",
		});
		expect(world.state.updates).toBe(0);
		expect(world.files.files.size).toBe(1);

		const pinned = createWorld({ provisioned: true });
		pinned.state.state.stacks.shop = {
			ports: { ...SHOP_PORTS, legacy: 5432 },
			createdAt: "2026-01-01T00:00:00Z",
		};
		const remapped = await previewImport(pinned, { yaml: COMPOSE });
		const pinnedDb = remapped.ok
			? remapped.value.items.find((i) => i.name === "db")
			: undefined;
		expect(pinnedDb).toMatchObject({
			hostPort: 5435,
			remapNote: "5432 is used by shop/legacy",
		});
	});

	test("suggested name falls back to compose-app, compose-app-2…", async () => {
		const world = createWorld({ provisioned: true });
		world.state.state.projects.push({ name: "compose-app", root: "/x" });
		const taken = await previewImport(world, {
			yaml: COMPOSE,
			projectName: "shop",
		});
		expect(taken.ok && taken.value.suggestedName).toBe("compose-app-2");
		const none = await previewImport(createWorld(), {
			yaml: COMPOSE,
			projectName: "  ",
		});
		expect(none.ok && none.value.suggestedName).toBe("compose-app");
	});

	test("errors: parse, catalog, state", async () => {
		const world = createWorld();
		const bad = await previewImport(world, { yaml: "nope: 1\n" });
		expect(!bad.ok && bad.error.message).toBe(NO_SERVICES_MESSAGE);
		world.catalog.definitions = async () => {
			throw new Error("broken");
		};
		const catalog = await previewImport(world, { yaml: COMPOSE });
		expect(!catalog.ok && catalog.error.code).toBe("INVALID_CATALOG");
		const stateFails = createWorld();
		stateFails.state.read = async () => {
			throw new Error("SQLITE_CORRUPT");
		};
		const io = await previewImport(stateFails, { yaml: COMPOSE });
		expect(!io.ok && io.error.code).toBe("IO");
	});
});

const ROOT = "/work/imported";

async function previewItems(): Promise<ImportItem[]> {
	const world = createWorld({ provisioned: true });
	const preview = await previewImport(world, { yaml: COMPOSE });
	if (!preview.ok) throw preview.error;
	return preview.value.items;
}

describe("importProject", () => {
	test("writes locainfra.yaml, stores secrets, registers; skips unchecked items", async () => {
		const items = (await previewItems()).map((item) =>
			item.name === "vector-db" ? { ...item, include: false } : item,
		);
		const world = createWorld({ provisioned: true, busy: [] });
		const events = await collect(
			importProject(world, {
				name: "imported",
				root: ROOT,
				items,
				start: false,
			}),
		);
		expect(events.map((e) => [e.kind, e.message])).toEqual([
			["step", `Creating ${ROOT}`],
			["step", "Registering imported"],
			["step", "Storing secrets"],
			["step", "Writing locainfra.yaml"],
			["done", "Imported 3 services into imported, 1 port remapped"],
		]);
		const file = parse(world.files.files.get(`${ROOT}/locainfra.yaml`) ?? "");
		expect(file).toEqual({
			version: 1,
			name: "imported",
			services: {
				db: {
					type: "postgres",
					version: "16",
					port: 5432,
					persist: "volume",
					config: { POSTGRES_DB: "shop", POSTGRES_USER: "app" },
				},
				cache: { type: "redis", version: "7", port: 6379, persist: "volume" },
				"cache-2": {
					type: "redis",
					version: "8",
					port: 6381,
					persist: "volume",
				},
			},
		});
		expect(world.secrets.stacks.get("imported")).toEqual({
			DB__POSTGRES_PASSWORD: "secret",
			CACHE__REDIS_PASSWORD: "devpass",
		});
		expect(world.state.state.projects).toContainEqual({
			name: "imported",
			root: ROOT,
		});
		expect(world.files.dirs.has(ROOT)).toBe(true);
		expect(JSON.stringify(events)).not.toContain("devpass");
		expect(world.lifecycle.upCalls).toEqual([]);
	});

	test("start: ups the stack and ends with the import summary", async () => {
		const items = (await previewItems()).filter((i) => i.name === "db");
		const world = createWorld();
		const events = await collect(
			importProject(world, {
				name: "imported",
				root: ROOT,
				items,
				start: true,
			}),
		);
		expect(events.map((e) => e.message)).toContain("Starting 1 service");
		expect(events.at(-1)).toMatchObject({
			kind: "done",
			message: "Imported 1 service into imported",
		});
		expect(world.lifecycle.upCalls).toHaveLength(1);
		expect(world.lifecycle.upCalls[0]?.projectName).toBe("li-imported");

		const failing = createWorld();
		failing.lifecycle.upScript = [
			{ kind: "error", message: "pull access denied" },
		];
		const failed = await collect(
			importProject(failing, {
				name: "imported",
				root: ROOT,
				items,
				start: true,
			}),
		);
		expect(failed.at(-1)).toMatchObject({
			kind: "error",
			message: "pull access denied",
		});
		expect(failing.state.state.projects).toContainEqual({
			name: "imported",
			root: ROOT,
		});
	});

	test("PROJECT_EXISTS and PORT_CONFLICT before anything is written", async () => {
		const items = (await previewItems()).filter((i) => i.name === "db");
		const cases: Array<
			[
				(w: ReturnType<typeof createWorld>) => void,
				Record<string, unknown>,
				string,
			]
		> = [
			[() => undefined, { name: "shop" }, "PROJECT_EXISTS"],
			[
				(w) => w.files.files.set(`${ROOT}/locainfra.yaml`, "x"),
				{},
				"PROJECT_EXISTS",
			],
			[(w) => w.probe.busy.add(5432), {}, "PORT_CONFLICT"],
			[
				(w) => {
					w.state.state.stacks.shop = {
						ports: { x: 5432 },
						createdAt: "2026-01-01T00:00:00Z",
					};
				},
				{},
				"PORT_CONFLICT",
			],
			[
				() => undefined,
				{ items: [...items, { ...items[0], name: "db2" }] },
				"PORT_CONFLICT",
			],
			[() => undefined, { name: "Bad Name" }, "INVALID_INPUT"],
			[() => undefined, { root: "relative/path" }, "INVALID_INPUT"],
			[
				() => undefined,
				{ items: items.map((i) => ({ ...i, include: false })) },
				"INVALID_INPUT",
			],
		];
		for (const [arrange, fields, code] of cases) {
			const world = createWorld();
			arrange(world);
			const before = world.files.files.size;
			const events = await collect(
				importProject(world, {
					name: "imported",
					root: ROOT,
					items,
					start: false,
					...fields,
				}),
			);
			expect(events).toHaveLength(1);
			expect(events[0]?.error?.code).toBe(code);
			expect(world.files.files.size).toBe(before);
			expect(world.state.state.projects.map((p) => p.name)).not.toContain(
				"imported",
			);
		}
	});

	test("a container name clash with another project is PROJECT_EXISTS", async () => {
		const world = createWorld();
		// shop + "main-db" → li-shop-main-db; project "shop-main" + "db" → li-shop-main-db.
		const items = (await previewItems()).filter((i) => i.name === "db");
		const events = await collect(
			importProject(world, {
				name: "shop-main",
				root: ROOT,
				items,
				start: false,
			}),
		);
		expect(events[0]?.error).toMatchObject({
			code: "PROJECT_EXISTS",
			details: { reason: "container-name" },
		});
	});

	test("re-validates items against the catalog", async () => {
		const [db] = (await previewItems()).filter((i) => i.name === "db");
		if (db === undefined) throw new Error("fixture");
		const cases: Array<[Partial<ImportItem>[], string]> = [
			[[{ name: "Bad" }], 'Invalid service name "Bad"'],
			[[{}, {}], 'Two services are named "db"'],
			[[{ type: undefined }], '"db" has no service type'],
			[[{ type: "mysql" }], 'Unknown service type "mysql"'],
			[[{ version: "9" }], 'Version "9" is not available for PostgreSQL'],
			[[{ config: { NOPE: "x" } }], 'Unknown config "NOPE" for PostgreSQL'],
			[[{ secrets: { NOPE: "x" } }], 'Unknown secret "NOPE" for PostgreSQL'],
			[
				[{ secrets: { POSTGRES_PASSWORD: "has space" } }],
				'The value of POSTGRES_PASSWORD of "db" is not a valid secret',
			],
			[
				[
					{
						type: "upstash-redis",
						version: undefined,
						hostPort: undefined,
						config: {},
						secrets: {},
					},
				],
				'Service "db" needs a redis service',
			],
		];
		for (const [overrides, message] of cases) {
			const world = createWorld();
			const items = overrides.map((o) => ({ ...db, ...o }));
			const events = await collect(
				importProject(world, {
					name: "imported",
					root: ROOT,
					items,
					start: false,
				}),
			);
			expect(events[0]?.error).toMatchObject({ code: "INVALID_INPUT" });
			expect(events[0]?.message).toStartWith(message);
		}
	});

	test("rolls back the registration when storing secrets or writing fails", async () => {
		const items = (await previewItems()).filter((i) => i.name === "db");
		const secretsFail = createWorld();
		secretsFail.secrets.update = async () => {
			throw new Error("EACCES");
		};
		const a = await collect(
			importProject(secretsFail, {
				name: "imported",
				root: ROOT,
				items,
				start: false,
			}),
		);
		expect(a.at(-1)?.error?.code).toBe("IO");
		expect(secretsFail.state.state.projects.map((p) => p.name)).toEqual([
			"shop",
		]);

		const writeFails = createWorld();
		const write = writeFails.files.writeText.bind(writeFails.files);
		writeFails.files.writeText = async (path, content, options) => {
			if (path.endsWith("locainfra.yaml")) throw new Error("EROFS");
			return write(path, content, options);
		};
		const b = await collect(
			importProject(writeFails, {
				name: "imported",
				root: ROOT,
				items,
				start: false,
			}),
		);
		expect(b.at(-1)?.error?.code).toBe("IO");
		expect(writeFails.state.state.projects.map((p) => p.name)).toEqual([
			"shop",
		]);
		expect(writeFails.files.files.has(`${ROOT}/locainfra.yaml`)).toBe(false);

		const mkdirFails = createWorld();
		mkdirFails.files.mkdirp = async () => {
			throw new Error("EACCES");
		};
		const c = await collect(
			importProject(mkdirFails, {
				name: "imported",
				root: ROOT,
				items,
				start: false,
			}),
		);
		expect(c.map((e) => e.kind)).toEqual(["step", "error"]);

		const stateFails = createWorld();
		stateFails.state.read = async () => {
			throw new Error("SQLITE_BUSY");
		};
		const d = await collect(
			importProject(stateFails, {
				name: "imported",
				root: ROOT,
				items,
				start: false,
			}),
		);
		expect(d[0]?.error?.code).toBe("IO");

		const catalogFails = createWorld();
		catalogFails.catalog.definitions = async () => {
			throw new Error("broken");
		};
		const e = await collect(
			importProject(catalogFails, {
				name: "imported",
				root: ROOT,
				items,
				start: false,
			}),
		);
		expect(e[0]?.error?.code).toBe("INVALID_CATALOG");
	});
});
