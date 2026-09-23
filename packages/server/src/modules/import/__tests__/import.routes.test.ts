import { describe, expect, it } from "bun:test";
import {
	err,
	IMPORT_MAX_SERVICES,
	IMPORT_YAML_MAX_BYTES,
	OpError,
	ok,
	type PreviewImportDeps,
} from "@locainfra/core";
import { setupApp, specPaths } from "../../../__tests__/support/client";
import {
	createStubOps,
	createTestPorts,
	importItem,
	importPreview,
	PROJECT,
} from "../../../__tests__/support/fixtures";

const ROOT = "/home/test/Developer/blog";
const COMPOSE = "services:\n  db:\n    image: postgres:16-alpine\n";

const importBody = (overrides: Record<string, unknown> = {}) => ({
	name: "blog",
	root: ROOT,
	start: false,
	items: importPreview.items,
	...overrides,
});

describe("POST /api/import/preview", () => {
	it("returns the op's preview and passes the text and name through", async () => {
		const { call, deps, runtime } = setupApp();
		const response = await call("POST", "/api/import/preview", {
			yaml: COMPOSE,
			projectName: "blog",
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(importPreview);
		expect(deps.calls).toContainEqual({
			op: "previewImport",
			input: { yaml: COMPOSE, projectName: "blog" },
		});
		expect(runtime.ops.list()).toEqual([]);
	});

	it("never writes: the op only gets a read-only state, the catalog and the probe", async () => {
		const ports = createTestPorts();
		let received: PreviewImportDeps | undefined;
		const { ops } = createStubOps({
			previewImport: async (deps) => {
				received = deps;
				return ok(importPreview);
			},
		});
		const filesBefore = [...ports.files.files.entries()];
		const stateBefore = await ports.state.read();
		const { call } = setupApp({ ops, ports });
		expect(
			(await call("POST", "/api/import/preview", { yaml: COMPOSE })).status,
		).toBe(200);
		expect(Object.keys(received ?? {}).sort()).toEqual([
			"catalog",
			"probe",
			"state",
		]);
		expect("update" in (received?.state ?? {})).toBe(false);
		expect(await received?.state.read()).toEqual(stateBefore);
		expect([...ports.files.files.entries()]).toEqual(filesBefore);
		expect(await ports.state.read()).toEqual(stateBefore);
	});

	it("maps invalid compose text to 422", async () => {
		const { ops } = createStubOps({
			previewImport: async () =>
				err(
					new OpError(
						"INVALID_INPUT",
						"No services found. Make sure the file has a top-level “services:” key.",
					),
				),
		});
		const { call } = setupApp({ ops });
		const response = await call("POST", "/api/import/preview", {
			yaml: "version: 3\n",
		});
		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({ code: "INVALID_INPUT" });
	});

	it.each([
		[{ yaml: "" }],
		[{ yaml: "x".repeat(IMPORT_YAML_MAX_BYTES + 1) }],
		[{ yaml: COMPOSE, projectName: "x".repeat(65) }],
		[{}],
	])("rejects body %# with 422 before the op", async (body) => {
		const { call, deps } = setupApp();
		expect((await call("POST", "/api/import/preview", body)).status).toBe(422);
		expect(deps.calls.some((c) => c.op === "previewImport")).toBe(false);
	});

	it("422s text within the character bound but over the UTF-8 byte bound", async () => {
		const { call, deps } = setupApp();
		const yaml = "é".repeat(IMPORT_YAML_MAX_BYTES / 2 + 1);
		const response = await call("POST", "/api/import/preview", { yaml });
		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({
			code: "INVALID_INPUT",
			details: { field: "yaml", maxBytes: IMPORT_YAML_MAX_BYTES },
		});
		expect(deps.calls.some((c) => c.op === "previewImport")).toBe(false);
	});
});

describe("POST /api/import", () => {
	it("starts importProject with the normalized folder and answers 202", async () => {
		const { call, deps, runtime } = setupApp();
		const response = await call(
			"POST",
			"/api/import",
			importBody({ root: "~/Developer/blog/", start: true }),
		);
		expect(response.status).toBe(202);
		const { opId } = (await response.json()) as { opId: string };
		await runtime.ops.settled(opId);
		expect(deps.calls).toContainEqual({
			op: "importProject",
			input: {
				name: "blog",
				root: ROOT,
				items: importPreview.items,
				start: true,
			},
		});
		expect(runtime.ops.get(opId)).toMatchObject({
			kind: "project.import",
			project: "blog",
			state: "done",
		});
	});

	it("409s a registered name or a folder that already holds locainfra.yaml", async () => {
		const ports = createTestPorts();
		await ports.state.update((s) => ({
			...s,
			projects: [{ name: PROJECT, root: "/home/test/Developer/shop-api" }],
		}));
		await ports.files.writeText(`${ROOT}/locainfra.yaml`, "version: 1\n");
		const { call, deps } = setupApp({ ports });
		const taken = await call(
			"POST",
			"/api/import",
			importBody({ name: PROJECT, root: "/home/test/Developer/new" }),
		);
		expect(taken.status).toBe(409);
		expect(await taken.json()).toMatchObject({
			code: "PROJECT_EXISTS",
			details: { field: "name" },
		});
		const occupied = await call("POST", "/api/import", importBody());
		expect(occupied.status).toBe(409);
		expect(await occupied.json()).toMatchObject({
			code: "PROJECT_EXISTS",
			details: { field: "root" },
		});
		expect(deps.calls.some((c) => c.op === "importProject")).toBe(false);
	});

	it.each([
		["a relative folder", { root: "Developer/blog" }],
		["the home folder", { root: "/home/test" }],
		["a hidden folder", { root: "/home/test/.config/blog" }],
		["a missing parent", { root: "/home/test/Nope/blog" }],
		["no importable item", { items: [{ ...importItem, include: false }] }],
		["only unsupported items", { items: [importPreview.items[1]] }],
		[
			"duplicate instance names",
			{ items: [importItem, { ...importItem, composeName: "db2" }] },
		],
	])("422s %s before starting the op", async (_label, overrides) => {
		const { call, deps, runtime } = setupApp();
		const response = await call("POST", "/api/import", importBody(overrides));
		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({ code: "INVALID_INPUT" });
		expect(deps.calls.some((c) => c.op === "importProject")).toBe(false);
		expect(runtime.ops.list()).toEqual([]);
	});

	it.each([
		[{ name: "Bad Name" }],
		[{ items: [] }],
		[
			{
				items: Array.from(
					{ length: IMPORT_MAX_SERVICES + 1 },
					() => importItem,
				),
			},
		],
		[
			{
				items: [{ ...importItem, secrets: { POSTGRES_PASSWORD: "has space" } }],
			},
		],
		[{ start: undefined }],
	])("rejects body %# with 422 (schema)", async (overrides) => {
		const { call } = setupApp();
		expect(
			(await call("POST", "/api/import", importBody(overrides))).status,
		).toBe(422);
	});
});

describe("Import controller", () => {
	it("requires the session token", async () => {
		const { call } = setupApp();
		expect(
			(await call("POST", "/api/import/preview", { yaml: COMPOSE }, "")).status,
		).toBe(401);
		expect((await call("POST", "/api/import", importBody(), "")).status).toBe(
			401,
		);
	});

	it("lists the routes in the OpenAPI spec without 501", async () => {
		const { call } = setupApp();
		const paths = await specPaths(call);
		for (const path of ["/api/import/preview", "/api/import/"]) {
			const op = paths[path]?.post;
			expect(op).toBeDefined();
			expect(Object.keys(op?.responses ?? {})).not.toContain("501");
		}
	});
});
