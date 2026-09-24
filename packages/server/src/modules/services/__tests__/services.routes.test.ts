import { describe, expect, it } from "bun:test";
import { ok, type StackFile, WIPE_NEEDS_FORCE_FIX } from "@locastack/core";
import {
	createProjectStack,
	postgresDefinition,
	redisDefinition,
	StaticCatalogSource,
	upstashRedisDefinition,
} from "@locastack/core/testing";
import { setupApp, specPaths } from "../../../__tests__/support/client";
import {
	createStubOps,
	createTestPorts,
	detail,
	PROJECT,
} from "../../../__tests__/support/fixtures";
import { BAKED_SECRET_FIX, dataCapability } from "../services.service";

const BASE = `/api/projects/${PROJECT}/services`;
const SERVICE = `${BASE}/main-db`;
const ROTATE = `${SERVICE}/secrets/POSTGRES_PASSWORD/rotate`;
const PASSWORD = "Abcdefghijklmnop_1234";

/** Stub ops (and their call log) whose project holds the given services. */
function withServices(services: StackFile["services"]) {
	return createStubOps({
		loadProject: async () => ok(createProjectStack(PROJECT, services)),
	});
}

/** Ports whose catalog holds every built-in test definition. */
function allTypesPorts() {
	return {
		...createTestPorts(),
		catalog: new StaticCatalogSource([
			postgresDefinition,
			redisDefinition,
			upstashRedisDefinition,
		]),
	};
}

describe("Data tab capability on service detail", () => {
	it("GET …/services/:name adds data { kind, label } from the catalog", async () => {
		const { call } = setupApp();
		const response = await call("GET", SERVICE);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			...detail,
			data: { kind: "sql", label: "Tables" },
		});
	});

	it("GET …/services adds it to every row", async () => {
		const { call } = setupApp();
		const rows = (await (await call("GET", BASE)).json()) as Array<{
			data: unknown;
		}>;
		expect(rows.map((r) => r.data)).toEqual([{ kind: "sql", label: "Tables" }]);
	});

	it("is none for a type without a data block or missing from the catalog", async () => {
		const { call } = setupApp({
			ports: { ...createTestPorts(), catalog: new StaticCatalogSource([]) },
		});
		const body = (await (await call("GET", SERVICE)).json()) as {
			data: unknown;
		};
		expect(body.data).toEqual({ kind: "none" });
		expect(dataCapability(upstashRedisDefinition)).toEqual({ kind: "none" });
		expect(dataCapability(redisDefinition)).toEqual({
			kind: "redis",
			label: "Key patterns",
		});
		expect(dataCapability(undefined)).toEqual({ kind: "none" });
	});
});

describe("PATCH …/secrets/:key/rotate", () => {
	it("refuses a bakedIntoVolume secret of a volume-backed service without force + wipeVolume", async () => {
		const { call, deps, runtime } = setupApp();
		for (const body of [{}, { force: true }, { wipeVolume: true }]) {
			const response = await call("PATCH", ROTATE, body);
			expect(response.status).toBe(422);
			expect(await response.json()).toEqual({
				code: "INVALID_INPUT",
				message:
					"POSTGRES_PASSWORD of main-db is stored in its data volume and cannot be rotated in place.",
				details: {
					field: "key",
					bakedIntoVolume: true,
					fix: BAKED_SECRET_FIX,
				},
			});
		}
		expect(deps.calls.some((c) => c.op === "rotateSecret")).toBe(false);
		expect(runtime.ops.list()).toEqual([]);
	});

	it("refuses wipeVolume without force for any secret (no volume is deleted)", async () => {
		const { ops, calls } = withServices({ cache: { type: "redis" } });
		const { call, runtime } = setupApp({ ops, ports: allTypesPorts() });
		const response = await call(
			"PATCH",
			`${BASE}/cache/secrets/REDIS_PASSWORD/rotate`,
			{ wipeVolume: true },
		);
		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({
			code: "INVALID_INPUT",
			details: { field: "force", fix: WIPE_NEEDS_FORCE_FIX },
		});
		expect(calls.some((c) => c.op === "rotateSecret")).toBe(false);
		expect(runtime.ops.list()).toEqual([]);
	});

	it("rotates with force + wipeVolume (202) and passes both flags", async () => {
		const { call, deps, runtime } = setupApp();
		const response = await call("PATCH", ROTATE, {
			force: true,
			wipeVolume: true,
		});
		expect(response.status).toBe(202);
		const { opId } = (await response.json()) as { opId: string };
		await runtime.ops.settled(opId);
		expect(deps.calls).toContainEqual({
			op: "rotateSecret",
			input: {
				project: PROJECT,
				name: "main-db",
				key: "POSTGRES_PASSWORD",
				force: true,
				wipeVolume: true,
			},
		});
		expect(runtime.ops.get(opId)).toMatchObject({
			kind: "service.rotate-secret",
			service: "main-db",
			state: "done",
		});
	});

	it("rotates an ephemeral Postgres or a redis secret freely", async () => {
		const { ops, calls } = withServices({
			"main-db": { type: "postgres", persist: "ephemeral" },
			cache: { type: "redis" },
		});
		const { call, runtime } = setupApp({ ops, ports: allTypesPorts() });
		for (const path of [
			ROTATE,
			`${BASE}/cache/secrets/REDIS_PASSWORD/rotate`,
		]) {
			const response = await call("PATCH", path, {});
			expect(response.status).toBe(202);
			const { opId } = (await response.json()) as { opId: string };
			await runtime.ops.settled(opId);
		}
		expect(
			calls.filter((c) => c.op === "rotateSecret").map((c) => c.input),
		).toEqual([
			{ project: PROJECT, name: "main-db", key: "POSTGRES_PASSWORD" },
			{ project: PROJECT, name: "cache", key: "REDIS_PASSWORD" },
		]);
	});

	it("422s an unknown key, 404s an unknown service, validates the key pattern", async () => {
		const { call } = setupApp();
		const unknown = await call("PATCH", `${SERVICE}/secrets/NOPE/rotate`, {});
		expect(unknown.status).toBe(422);
		expect(await unknown.json()).toMatchObject({
			code: "INVALID_INPUT",
			details: { field: "key", secrets: ["POSTGRES_PASSWORD"] },
		});
		expect(
			(await call("PATCH", `${BASE}/nope/secrets/POSTGRES_PASSWORD/rotate`, {}))
				.status,
		).toBe(404);
		expect(
			(await call("PATCH", `${SERVICE}/secrets/bad-key/rotate`, {})).status,
		).toBe(422);
		expect((await call("PATCH", ROTATE, { force: "yes" })).status).toBe(422);
		expect((await call("PATCH", ROTATE, {}, "")).status).toBe(401);
	});
});

describe("Add and PATCH with secrets and seed", () => {
	it("Add passes client-chosen secrets and a seed file through", async () => {
		const ports = createTestPorts();
		await ports.files.writeText("/work/shop-api/db/seed.sql", "SELECT 1;");
		const { call, deps, runtime } = setupApp({ ports });
		const response = await call("POST", BASE, {
			name: "events",
			type: "postgres",
			secrets: { POSTGRES_PASSWORD: PASSWORD },
			seed: "db/seed.sql",
		});
		expect(response.status).toBe(202);
		const { opId } = (await response.json()) as { opId: string };
		await runtime.ops.settled(opId);
		expect(deps.calls.find((c) => c.op === "addService")?.input).toEqual({
			project: PROJECT,
			name: "events",
			type: "postgres",
			secrets: { POSTGRES_PASSWORD: PASSWORD },
			seed: "db/seed.sql",
		});
	});

	it.each([
		["an unknown secret name", { secrets: { NOPE: PASSWORD } }, "secrets"],
		["a missing seed file", { seed: "db/missing.sql" }, "seed"],
	])("Add 422s %s before starting", async (_label, extra, field) => {
		const { call, deps } = setupApp();
		const response = await call("POST", BASE, {
			name: "events",
			type: "postgres",
			...extra,
		});
		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({
			code: "INVALID_INPUT",
			details: { field },
		});
		expect(deps.calls.some((c) => c.op === "addService")).toBe(false);
	});

	it("Add 422s a seed for a type without seed support", async () => {
		const ports = allTypesPorts();
		await ports.files.writeText("/work/shop-api/seed.txt", "x");
		const { call } = setupApp({ ports });
		const response = await call("POST", BASE, {
			name: "cache",
			type: "redis",
			seed: "seed.txt",
		});
		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({
			message: "Redis does not support seed files",
		});
	});

	it.each([
		[{ secrets: { POSTGRES_PASSWORD: "short" } }],
		[{ secrets: { POSTGRES_PASSWORD: "has spaces in it, sixteen+" } }],
		[{ seed: "../outside.sql" }],
		[{ seed: "/etc/passwd" }],
		[{ seed: "~/seed.sql" }],
	])("Add rejects %j with 422 (schema)", async (extra) => {
		const { call } = setupApp();
		const response = await call("POST", BASE, {
			name: "events",
			type: "postgres",
			...extra,
		});
		expect(response.status).toBe(422);
	});

	it("PATCH sets or removes the seed file", async () => {
		const ports = createTestPorts();
		await ports.files.writeText("/work/shop-api/seed.sql", "SELECT 1;");
		const { call, deps, runtime } = setupApp({ ports });
		for (const seed of ["seed.sql", ""]) {
			const response = await call("PATCH", SERVICE, { seed });
			expect(response.status).toBe(202);
			const { opId } = (await response.json()) as { opId: string };
			await runtime.ops.settled(opId);
		}
		expect(
			deps.calls.filter((c) => c.op === "updateService").map((c) => c.input),
		).toEqual([
			{ project: PROJECT, name: "main-db", patch: { seed: "seed.sql" } },
			{ project: PROJECT, name: "main-db", patch: { seed: "" } },
		]);
	});

	it("PATCH 422s a seed that links out of the project or is not a regular file", async () => {
		const ports = createTestPorts();
		ports.files.links.set(
			"/work/shop-api/creds.sql",
			"/Users/dev/.aws/credentials",
		);
		await ports.files.writeText("/Users/dev/.aws/credentials", "[default]");
		ports.files.links.set("/work/shop-api/zero.sql", "/dev/zero");
		ports.files.dirs.add("/work/shop-api/db");
		const { call, deps } = setupApp({ ports });
		for (const [seed, message] of [
			[
				"creds.sql",
				"Seed file ./creds.sql links to a file outside the project folder",
			],
			[
				"zero.sql",
				"Seed file ./zero.sql links to a file outside the project folder",
			],
			["db", "Seed file ./db is not a regular file"],
		] as const) {
			const response = await call("PATCH", SERVICE, { seed });
			expect(response.status).toBe(422);
			expect(await response.json()).toMatchObject({
				code: "INVALID_INPUT",
				message,
				details: { field: "seed" },
			});
		}
		expect(deps.calls.some((c) => c.op === "updateService")).toBe(false);
	});

	it("PATCH 422s a missing seed file and 404s an unknown service", async () => {
		const { call, deps } = setupApp();
		const missing = await call("PATCH", SERVICE, { seed: "nope.sql" });
		expect(missing.status).toBe(422);
		expect(await missing.json()).toMatchObject({
			code: "INVALID_INPUT",
			details: {
				field: "seed",
				fix: "Create ./nope.sql next to locastack.yaml",
			},
		});
		expect((await call("PATCH", `${BASE}/nope`, { seed: "" })).status).toBe(
			404,
		);
		expect((await call("PATCH", SERVICE, { seed: "../x.sql" })).status).toBe(
			422,
		);
		expect(deps.calls.some((c) => c.op === "updateService")).toBe(false);
	});

	it("lists the rotate route in the OpenAPI spec without 501", async () => {
		const { call } = setupApp();
		const paths = await specPaths(call);
		const op =
			paths["/api/projects/{project}/services/{name}/secrets/{key}/rotate"]
				?.patch;
		expect(op).toBeDefined();
		expect(Object.keys(op?.responses ?? {})).not.toContain("501");
	});
});
