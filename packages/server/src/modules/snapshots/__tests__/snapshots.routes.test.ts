import { describe, expect, it } from "bun:test";
import { OpError, ok, type StackFile } from "@locainfra/core";
import {
	createProjectStack,
	postgresDefinition,
	redisDefinition,
	StaticCatalogSource,
} from "@locainfra/core/testing";
import { setupApp, specPaths } from "../../../__tests__/support/client";
import {
	createStubOps,
	createTestPorts,
	detail,
	PROJECT,
	SNAPSHOT_ID,
	snapshot,
	snapshotRecord,
} from "../../../__tests__/support/fixtures";

const SERVICE = `/api/projects/${PROJECT}/services/main-db`;

/** Stub ops (and their call log) whose project holds `main-db` with the given entry fields. */
function withEntry(entry: Partial<StackFile["services"][string]>) {
	return createStubOps({
		loadProject: async (_deps, input) =>
			input.project === PROJECT
				? ok(
						createProjectStack(PROJECT, {
							"main-db": {
								type: "postgres",
								version: "17",
								port: 5433,
								...entry,
							},
						}),
					)
				: await createStubOps().ops.loadProject(_deps, input),
	});
}

describe("Snapshots routes", () => {
	it("GET …/snapshots lists the service's snapshots", async () => {
		const { call, deps } = setupApp();
		const response = await call("GET", `${SERVICE}/snapshots`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual([snapshot]);
		expect(deps.calls).toContainEqual({
			op: "listSnapshots",
			input: { project: PROJECT, name: "main-db" },
		});
	});

	it("GET …/snapshots 404s an unknown service", async () => {
		const { call } = setupApp();
		const response = await call(
			"GET",
			`/api/projects/${PROJECT}/services/nope/snapshots`,
		);
		expect(response.status).toBe(404);
	});

	it("POST …/snapshots starts createSnapshot and answers 202", async () => {
		const { call, deps, runtime } = setupApp();
		const response = await call("POST", `${SERVICE}/snapshots`, {
			name: "before migration",
		});
		expect(response.status).toBe(202);
		const { opId } = (await response.json()) as { opId: string };
		await runtime.ops.settled(opId);
		expect(deps.calls).toContainEqual({
			op: "createSnapshot",
			input: {
				project: PROJECT,
				name: "main-db",
				snapshotName: "before migration",
			},
		});
		expect(runtime.ops.get(opId)).toMatchObject({
			kind: "snapshot.create",
			project: PROJECT,
			service: "main-db",
			state: "done",
		});
	});

	it("POST …/snapshots without a name lets the op choose one", async () => {
		const { call, deps, runtime } = setupApp();
		const response = await call("POST", `${SERVICE}/snapshots`, {});
		const { opId } = (await response.json()) as { opId: string };
		await runtime.ops.settled(opId);
		expect(deps.calls.find((c) => c.op === "createSnapshot")?.input).toEqual({
			project: PROJECT,
			name: "main-db",
		});
	});

	it("POST …/snapshots refuses an ephemeral service with 422 before any op", async () => {
		const { ops, calls } = withEntry({ persist: "ephemeral" });
		const { call, runtime } = setupApp({ ops });
		const response = await call("POST", `${SERVICE}/snapshots`, {});
		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({
			code: "INVALID_INPUT",
			details: { field: "persist" },
		});
		expect(calls.some((c) => c.op === "createSnapshot")).toBe(false);
		expect(runtime.ops.list()).toEqual([]);
	});

	it("POST …/snapshots validates the name and 404s unknown services", async () => {
		const { call } = setupApp();
		expect(
			(await call("POST", `${SERVICE}/snapshots`, { name: "../escape" }))
				.status,
		).toBe(422);
		expect(
			(await call("POST", `${SERVICE}/snapshots`, { name: "" })).status,
		).toBe(422);
		expect(
			(
				await call(
					"POST",
					`/api/projects/${PROJECT}/services/nope/snapshots`,
					{},
				)
			).status,
		).toBe(404);
		expect(
			(await call("POST", `/api/projects/other/services/main-db/snapshots`, {}))
				.status,
		).toBe(404);
	});

	it("POST …/snapshots/:id/restore starts restoreSnapshot and answers 202", async () => {
		const { call, deps, runtime } = setupApp();
		const response = await call(
			"POST",
			`${SERVICE}/snapshots/${SNAPSHOT_ID}/restore`,
		);
		expect(response.status).toBe(202);
		const { opId } = (await response.json()) as { opId: string };
		await runtime.ops.settled(opId);
		expect(deps.calls).toContainEqual({
			op: "restoreSnapshot",
			input: { project: PROJECT, name: "main-db", snapshotId: SNAPSHOT_ID },
		});
		expect(runtime.ops.get(opId)).toMatchObject({ kind: "snapshot.restore" });
	});

	it("restore 404s an unknown id or another service's snapshot before any op", async () => {
		const ports = createTestPorts();
		await ports.snapshots.insert({
			...snapshotRecord,
			id: "other-1",
			service: "cache",
		});
		const { call, deps, runtime } = setupApp({ ports });
		for (const id of ["unknown", "other-1"]) {
			const response = await call("POST", `${SERVICE}/snapshots/${id}/restore`);
			expect(response.status).toBe(404);
			expect(await response.json()).toMatchObject({
				code: "SNAPSHOT_NOT_FOUND",
			});
		}
		expect(deps.calls.some((c) => c.op === "restoreSnapshot")).toBe(false);
		expect(runtime.ops.list()).toEqual([]);
		expect(
			(await call("POST", `${SERVICE}/snapshots/bad.id/restore`)).status,
		).toBe(422);
	});

	it("restore 422s a snapshot of another type or major version before any op", async () => {
		const ports = createTestPorts();
		await ports.snapshots.insert({
			...snapshotRecord,
			id: "redis-data",
			type: "redis",
			version: "7",
		});
		await ports.snapshots.insert({
			...snapshotRecord,
			id: "pg-16",
			type: "postgres",
			version: "16",
		});
		const { call, deps, runtime } = setupApp({ ports });
		for (const [id, reason] of [
			["redis-data", "type-mismatch"],
			["pg-16", "version-mismatch"],
		]) {
			const response = await call("POST", `${SERVICE}/snapshots/${id}/restore`);
			expect(response.status).toBe(422);
			expect(await response.json()).toMatchObject({
				code: "INVALID_INPUT",
				details: { reason },
			});
		}
		expect(deps.calls.some((c) => c.op === "restoreSnapshot")).toBe(false);
		expect(runtime.ops.list()).toEqual([]);
	});

	it("DELETE waits for a restore of the project in flight (op lane)", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const order: string[] = [];
		const stub = createStubOps();
		const { ops } = createStubOps({
			restoreSnapshot: async function* (deps, input) {
				order.push("restore:start");
				await gate;
				order.push("restore:released");
				yield* stub.ops.restoreSnapshot(deps, input);
			},
			deleteSnapshot: async (deps, input) => {
				order.push("delete");
				return stub.ops.deleteSnapshot(deps, input);
			},
		});
		const { call, runtime } = setupApp({ ops });
		const restore = await call(
			"POST",
			`${SERVICE}/snapshots/${SNAPSHOT_ID}/restore`,
		);
		const { opId } = (await restore.json()) as { opId: string };
		const deleting = call("DELETE", `${SERVICE}/snapshots/${SNAPSHOT_ID}`);
		await Bun.sleep(20);
		expect(order).toEqual(["restore:start"]);
		release();
		expect((await deleting).status).toBe(200);
		await runtime.ops.settled(opId);
		expect(order).toEqual(["restore:start", "restore:released", "delete"]);
	});

	it("DELETE …/snapshots/:id answers 200 with the deleted snapshot, without an op", async () => {
		const { call, deps, runtime } = setupApp();
		const response = await call(
			"DELETE",
			`${SERVICE}/snapshots/${SNAPSHOT_ID}`,
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(snapshot);
		expect(deps.calls).toContainEqual({
			op: "deleteSnapshot",
			input: { project: PROJECT, name: "main-db", snapshotId: SNAPSHOT_ID },
		});
		expect(runtime.ops.list()).toEqual([]);
		const missing = await call("DELETE", `${SERVICE}/snapshots/unknown`);
		expect(missing.status).toBe(404);
		expect(await missing.json()).toMatchObject({ code: "SNAPSHOT_NOT_FOUND" });
	});
});

describe("Seed route", () => {
	it("POST …/seed starts seedService for a running service with a seed file", async () => {
		const { ops, calls } = withEntry({ seed: "db/seed.sql" });
		const { call, runtime } = setupApp({ ops });
		const response = await call("POST", `${SERVICE}/seed`);
		expect(response.status).toBe(202);
		const { opId } = (await response.json()) as { opId: string };
		await runtime.ops.settled(opId);
		expect(calls).toContainEqual({
			op: "seedService",
			input: { project: PROJECT, name: "main-db" },
		});
		expect(runtime.ops.get(opId)).toMatchObject({
			kind: "service.seed",
			state: "done",
		});
	});

	it("POST …/seed without a seed file is 422 with a fix", async () => {
		const { call, deps } = setupApp();
		const response = await call("POST", `${SERVICE}/seed`);
		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({
			code: "INVALID_INPUT",
			message: "main-db has no seed file.",
			details: { field: "seed", fix: "Set a seed file on the Config page" },
		});
		expect(deps.calls.some((c) => c.op === "seedService")).toBe(false);
	});

	it("POST …/seed on a stopped service is 409 SERVICE_NOT_RUNNING", async () => {
		const { ops, calls } = withEntry({ seed: "db/seed.sql" });
		const { call } = setupApp({
			ops: {
				...ops,
				getService: async () => ok({ ...detail, state: "stopped" }),
			},
		});
		const response = await call("POST", `${SERVICE}/seed`);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			code: "SERVICE_NOT_RUNNING",
		});
		expect(calls.some((c) => c.op === "seedService")).toBe(false);
	});

	it("POST …/seed on a type without seed support is 422", async () => {
		const ports = createTestPorts();
		const { call } = setupApp({
			ports: {
				...ports,
				catalog: new StaticCatalogSource([postgresDefinition, redisDefinition]),
			},
			ops: createStubOps({
				loadProject: async () =>
					ok(
						createProjectStack(PROJECT, {
							cache: { type: "redis", seed: "x.txt" },
						}),
					),
			}).ops,
		});
		const response = await call(
			"POST",
			`/api/projects/${PROJECT}/services/cache/seed`,
		);
		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({
			code: "INVALID_INPUT",
			message: "Redis does not support seed files.",
		});
	});

	it("an op failure after the 202 arrives as the error event", async () => {
		const { call, runtime } = setupApp({
			ops: {
				...withEntry({ seed: "db/seed.sql" }).ops,
				seedService: async function* () {
					yield { kind: "step", message: "Seeding main-db from ./db/seed.sql" };
					throw new OpError("IO", "Seed file ./db/seed.sql is missing");
				},
			},
		});
		const { opId } = (await (await call("POST", `${SERVICE}/seed`)).json()) as {
			opId: string;
		};
		expect(await runtime.ops.settled(opId)).toMatchObject({ state: "error" });
	});
});

describe("Snapshots controller", () => {
	it("requires the session token", async () => {
		const { call } = setupApp();
		expect(
			(await call("GET", `${SERVICE}/snapshots`, undefined, "")).status,
		).toBe(401);
		expect((await call("POST", `${SERVICE}/seed`, undefined, "")).status).toBe(
			401,
		);
	});

	it("lists the routes in the OpenAPI spec without 501", async () => {
		const { call } = setupApp();
		const paths = await specPaths(call);
		const routes: Array<[string, string]> = [
			["/api/projects/{project}/services/{name}/snapshots", "get"],
			["/api/projects/{project}/services/{name}/snapshots", "post"],
			[
				"/api/projects/{project}/services/{name}/snapshots/{id}/restore",
				"post",
			],
			["/api/projects/{project}/services/{name}/snapshots/{id}", "delete"],
			["/api/projects/{project}/services/{name}/seed", "post"],
		];
		for (const [path, method] of routes) {
			const op = paths[path]?.[method];
			expect(op).toBeDefined();
			expect(Object.keys(op?.responses ?? {})).not.toContain("501");
		}
	});
});
