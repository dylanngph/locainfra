import { describe, expect, it } from "bun:test";
import {
	DATA_MAX_OBJECTS,
	DATA_QUERY_MAX_LENGTH,
	DATA_QUERY_MAX_ROWS,
	err,
	OpError,
	ok,
} from "@locainfra/core";
import { setupApp, specPaths } from "../../../__tests__/support/client";
import {
	createStubOps,
	dataObjects,
	PROJECT,
	queryResult,
} from "../../../__tests__/support/fixtures";

const SERVICE = `/api/projects/${PROJECT}/services/main-db`;

describe("Data tab routes", () => {
	it("GET …/data returns the object list from listDataObjects", async () => {
		const { call, deps, runtime } = setupApp();
		const response = await call("GET", `${SERVICE}/data`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(dataObjects);
		expect(deps.calls).toContainEqual({
			op: "listDataObjects",
			input: { project: PROJECT, name: "main-db" },
		});
		expect(runtime.ops.list()).toEqual([]);
	});

	it("POST …/data/query runs the query with the default limit and answers directly", async () => {
		const { call, deps, runtime } = setupApp();
		const response = await call("POST", `${SERVICE}/data/query`, {
			query: "SELECT * FROM users",
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(queryResult);
		expect(deps.calls).toContainEqual({
			op: "runQuery",
			input: {
				project: PROJECT,
				name: "main-db",
				query: "SELECT * FROM users",
				limit: DATA_QUERY_MAX_ROWS,
			},
		});
		expect(runtime.ops.list()).toEqual([]);
	});

	it("passes an explicit limit through", async () => {
		const { call, deps } = setupApp();
		await call("POST", `${SERVICE}/data/query`, {
			query: "SELECT 1",
			limit: 5,
		});
		expect(deps.calls.find((c) => c.op === "runQuery")?.input).toMatchObject({
			limit: 5,
		});
	});

	it.each([
		[{ query: "" }],
		[{ query: "SELECT 1", limit: 0 }],
		[{ query: "SELECT 1", limit: DATA_QUERY_MAX_ROWS + 1 }],
		[{ query: "x".repeat(DATA_QUERY_MAX_LENGTH + 1) }],
		[{}],
	])("rejects body %j with 422 before running anything", async (body) => {
		const { call, deps } = setupApp();
		const response = await call("POST", `${SERVICE}/data/query`, body);
		expect(response.status).toBe(422);
		expect(deps.calls.some((c) => c.op === "runQuery")).toBe(false);
	});

	it("rejects invalid names with 422", async () => {
		const { call } = setupApp();
		expect(
			(await call("GET", "/api/projects/Bad/services/main-db/data")).status,
		).toBe(422);
	});

	it("404s an unknown project or service", async () => {
		const { call } = setupApp();
		expect(
			(await call("GET", `/api/projects/${PROJECT}/services/nope/data`)).status,
		).toBe(404);
		const response = await call(
			"POST",
			"/api/projects/other/services/main-db/data/query",
			{
				query: "SELECT 1",
			},
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ code: "PROJECT_NOT_FOUND" });
	});

	it("maps SERVICE_NOT_RUNNING to 409", async () => {
		const message = "main-db is not running. Start it to run queries.";
		const { ops } = createStubOps({
			listDataObjects: async () =>
				err(new OpError("SERVICE_NOT_RUNNING", message)),
			runQuery: async () => err(new OpError("SERVICE_NOT_RUNNING", message)),
		});
		const { call } = setupApp({ ops });
		for (const response of [
			await call("GET", `${SERVICE}/data`),
			await call("POST", `${SERVICE}/data/query`, { query: "SELECT 1" }),
		]) {
			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({
				code: "SERVICE_NOT_RUNNING",
				message,
			});
		}
	});

	it("returns a rejected query as 422 with the engine's message", async () => {
		const { ops } = createStubOps({
			runQuery: async () =>
				err(
					new OpError(
						"INVALID_INPUT",
						'ERROR:  relation "nope" does not exist',
						{
							details: { exitCode: 1 },
						},
					),
				),
		});
		const { call } = setupApp({ ops });
		const response = await call("POST", `${SERVICE}/data/query`, {
			query: "SELECT * FROM nope",
		});
		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({
			code: "INVALID_INPUT",
			message: 'ERROR:  relation "nope" does not exist',
			details: { exitCode: 1 },
		});
	});

	it("maps a timed-out query or listing to 504 TIMEOUT", async () => {
		const timeout = () =>
			err(
				new OpError("INVALID_INPUT", "The query did not finish within 15 s.", {
					details: { timedOut: true },
				}),
			);
		const { ops } = createStubOps({
			runQuery: async () => timeout(),
			listDataObjects: async () => timeout(),
		});
		const { call } = setupApp({ ops });
		for (const response of [
			await call("POST", `${SERVICE}/data/query`, {
				query: "SELECT pg_sleep(60)",
			}),
			await call("GET", `${SERVICE}/data`),
		]) {
			expect(response.status).toBe(504);
			expect(await response.json()).toEqual({
				code: "TIMEOUT",
				message: "The query did not finish within 15 s.",
				details: { timedOut: true, opCode: "INVALID_INPUT" },
			});
		}
	});

	it("never returns more rows than the limit", async () => {
		const rows = Array.from({ length: 12 }, (_, i) => [String(i)]);
		const { ops } = createStubOps({
			runQuery: async () =>
				ok({
					columns: ["n"],
					rows,
					rowCount: rows.length,
					truncated: false,
					durationMs: 1,
				}),
		});
		const { call } = setupApp({ ops });
		const response = await call("POST", `${SERVICE}/data/query`, {
			query: "SELECT n",
			limit: 10,
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			rows: string[][];
			rowCount: number;
			truncated: boolean;
		};
		expect(body.rows).toHaveLength(10);
		expect(body.rowCount).toBe(10);
		expect(body.truncated).toBe(true);
	});

	it("never returns more than DATA_MAX_OBJECTS objects", async () => {
		const objects = Array.from({ length: DATA_MAX_OBJECTS + 5 }, (_, i) => ({
			name: `t${i}`,
			defaultQuery: `SELECT * FROM t${i}`,
		}));
		const { ops } = createStubOps({
			listDataObjects: async () =>
				ok({ kind: "sql", label: "Tables", objects, truncated: false }),
		});
		const { call } = setupApp({ ops });
		const body = (await (await call("GET", `${SERVICE}/data`)).json()) as {
			objects: unknown[];
			truncated: boolean;
		};
		expect(body.objects).toHaveLength(DATA_MAX_OBJECTS);
		expect(body.truncated).toBe(true);
	});

	it("requires the session token", async () => {
		const { call } = setupApp();
		expect((await call("GET", `${SERVICE}/data`, undefined, "")).status).toBe(
			401,
		);
		expect(
			(await call("POST", `${SERVICE}/data/query`, { query: "SELECT 1" }, ""))
				.status,
		).toBe(401);
	});

	it("lists the routes in the OpenAPI spec without 501 and with 504", async () => {
		const { call } = setupApp();
		const paths = await specPaths(call);
		const list = paths["/api/projects/{project}/services/{name}/data/"]?.get;
		const query =
			paths["/api/projects/{project}/services/{name}/data/query"]?.post;
		for (const op of [list, query]) {
			expect(op).toBeDefined();
			expect(Object.keys(op?.responses ?? {})).not.toContain("501");
			expect(Object.keys(op?.responses ?? {})).toContain("504");
		}
	});
});
