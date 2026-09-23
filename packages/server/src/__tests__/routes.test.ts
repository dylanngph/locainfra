import { describe, expect, it } from "bun:test";
import { treaty } from "@elysiajs/eden";
import {
	err,
	OpError,
	ok,
	type Progress,
	type ProjectSummary,
} from "@locainfra/core";
import { type App, createApp, createRuntime } from "../app";
import {
	CONTAINER,
	createStubOps,
	createTestDeps,
	detail,
	HOST,
	listing,
	PROJECT,
	type status,
	summary,
	TOKEN,
} from "./support/fixtures";

function setup(overrides: Parameters<typeof createTestDeps>[0] = {}) {
	const deps = createTestDeps(overrides);
	const runtime = createRuntime(deps);
	const app: App = createApp(deps, runtime);
	const call = (
		method: string,
		path: string,
		body?: unknown,
		token: string | undefined = TOKEN,
	) =>
		app.handle(
			new Request(`http://${HOST}${path}`, {
				method,
				headers: {
					host: HOST,
					...(token ? { "x-locainfra-token": token } : {}),
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
	return { deps, runtime, app, call };
}

const ROUTES: ReadonlyArray<readonly [string, string, unknown?]> = [
	["GET", "/api/system"],
	["GET", "/api/catalog"],
	["GET", "/api/projects"],
	["POST", "/api/projects", { name: "blog", root: "~/Developer/blog" }],
	["POST", "/api/projects/pick-folder", { name: "blog" }],
	["GET", `/api/projects/${PROJECT}`],
	["DELETE", `/api/projects/${PROJECT}`],
	["POST", `/api/projects/${PROJECT}/up`],
	["POST", `/api/projects/${PROJECT}/down?volumes=true`],
	["GET", `/api/projects/${PROJECT}/services`],
	[
		"POST",
		`/api/projects/${PROJECT}/services`,
		{ name: "events", type: "postgres", port: "auto" },
	],
	["GET", `/api/projects/${PROJECT}/services/main-db`],
	["PATCH", `/api/projects/${PROJECT}/services/main-db`, { port: 5434 }],
	["DELETE", `/api/projects/${PROJECT}/services/main-db?volumes=false`],
	["POST", `/api/projects/${PROJECT}/services/main-db/start`],
	["POST", `/api/projects/${PROJECT}/services/main-db/stop`],
	["POST", `/api/projects/${PROJECT}/services/main-db/restart`],
	["GET", `/api/projects/${PROJECT}/services/main-db/connection?reveal=true`],
	["GET", `/api/projects/${PROJECT}/services/main-db/logs?tail=10`],
	["GET", `/api/projects/${PROJECT}/services/main-db/stats`],
	["GET", `/api/projects/${PROJECT}/env?format=shell&reveal=false`],
	["POST", `/api/projects/${PROJECT}/env/write`, { file: ".env.local" }],
];

const EXPECTED_STATUS: Record<string, number> = {
	"POST /api/projects": 201,
};

describe("routes", () => {
	const { call } = setup();
	for (const [method, path, body] of ROUTES) {
		const route = `${method} ${path.split("?")[0]}`;
		const expected =
			EXPECTED_STATUS[route] ??
			(/(\/up|\/down|\/start|\/stop|\/restart)$/.test(
				path.split("?")[0] ?? "",
			) ||
			(method !== "GET" && path.includes("/services"))
				? 202
				: 200);
		it(`${method} ${path} → ${expected}, 401 without a token`, async () => {
			expect((await call(method, path, body, "")).status).toBe(401);
			const res = await call(method, path, body);
			expect(res.status).toBe(expected);
			if (expected === 202) {
				const accepted = (await res.json()) as { opId: string };
				expect(accepted.opId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
			}
		});
	}
});

describe("route behaviour", () => {
	it("GET /api/system adds the dashboard version", async () => {
		const { call } = setup();
		expect(await (await call("GET", "/api/system")).json()).toEqual({
			docker: { version: "29.6.1", apiVersion: "1.55" },
			compose: "5.3.0",
			dashboardVersion: "0.1.0",
		});
	});

	it("GET /api/catalog returns the listing", async () => {
		const { call } = setup();
		const body = (await (await call("GET", "/api/catalog")).json()) as {
			categories: unknown;
		};
		expect(body.categories).toEqual(listing.categories);
	});

	it("maps op errors to their HTTP status and ApiError body", async () => {
		const { call } = setup();
		const res = await call("GET", "/api/projects/nope");
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({
			code: "PROJECT_NOT_FOUND",
			message: "No project named nope",
		});
		expect((await call("POST", "/api/projects/nope/up")).status).toBe(404);
		expect(
			(await call("GET", `/api/projects/${PROJECT}/services/ghost`)).status,
		).toBe(404);
		expect(
			(await call("POST", `/api/projects/${PROJECT}/services/ghost/stop`))
				.status,
		).toBe(404);
	});

	it("hides unexpected errors behind a generic 500", async () => {
		const { ops } = createStubOps({
			listProjects: async () => {
				throw new Error("/Users/someone/secret path");
			},
		});
		const { call } = setup({ ops });
		const res = await call("GET", "/api/projects");
		expect(res.status).toBe(500);
		expect(await res.text()).not.toContain("secret path");
	});

	it("still validates params and bodies (422)", async () => {
		const { call } = setup();
		expect((await call("GET", "/api/projects/Bad_Name")).status).toBe(422);
		expect(
			(await call("PATCH", `/api/projects/${PROJECT}/services/main-db`, {}))
				.status,
		).toBe(422);
		expect(
			(await call("GET", `/api/projects/${PROJECT}/env?format=yaml`)).status,
		).toBe(422);
	});

	it("POST /api/projects creates a new folder, or registers an existing file", async () => {
		const { call, deps } = setup();
		const created = await call("POST", "/api/projects", {
			name: "blog",
			root: "~/Developer/blog",
		});
		expect(created.status).toBe(201);
		expect(deps.calls).toContainEqual({
			op: "createProject",
			input: { name: "blog", root: "/home/test/Developer/blog" },
		});
		await deps.ports.files.writeText("/work/docs/locainfra.yaml", "x");
		const registered = await call("POST", "/api/projects", {
			name: "docs",
			root: "/work/docs",
		});
		expect(registered.status).toBe(201);
		expect(deps.calls).toContainEqual({
			op: "registerProject",
			input: { name: "docs", root: "/work/docs" },
		});
		const relative = await call("POST", "/api/projects", {
			name: "rel",
			root: "work/rel",
		});
		expect(relative.status).toBe(422);
		const taken = await call("POST", "/api/projects", {
			name: PROJECT,
			root: "/work/other",
		});
		expect(taken.status).toBe(409);
	});

	it("POST /api/projects refuses home, hidden, missing-parent and file roots", async () => {
		const { call, deps } = setup();
		await deps.ports.files.mkdirp("/home/test/.ssh");
		await deps.ports.files.writeText("/home/test/Developer/notes.txt", "x");
		const refused = async (root: string, message: RegExp) => {
			const res = await call("POST", "/api/projects", { name: "x", root });
			expect(res.status).toBe(422);
			const body = (await res.json()) as { code: string; message: string };
			expect(body.code).toBe("INVALID_INPUT");
			expect(body.message).toMatch(message);
		};
		await refused("~", /not the home folder itself/);
		await refused("/home/test/", /not the home folder itself/);
		await refused("/home", /not the home folder itself/);
		await refused("/", /not the home folder itself/);
		await refused("~/.ssh", /Hidden folders/);
		await refused("~/Developer/../.config/x", /Hidden folders/);
		await refused("~/Develper/shop", /does not exist/);
		await refused("~/Developer/notes.txt", /is a file/);
		expect(
			deps.calls.filter(
				(c) => c.op === "createProject" || c.op === "registerProject",
			),
		).toEqual([]);
		expect(await deps.ports.files.exists("/home/test/Develper")).toBe(false);
	});

	it("POST /api/projects/pick-folder opens the picker at ~/Developer", async () => {
		const { call, deps } = setup();
		const res = await call("POST", "/api/projects/pick-folder", {
			name: "blog",
		});
		expect(await res.json()).toEqual({ root: "/home/test/Developer/shop-api" });
		expect(deps.ports.folderPicker.calls).toEqual([
			{
				title: "Choose a folder for blog",
				defaultPath: "/home/test/Developer",
			},
		]);
	});

	it("GET /api/projects/:project returns stack and status", async () => {
		const { call } = setup();
		const body = (await (
			await call("GET", `/api/projects/${PROJECT}`)
		).json()) as {
			stack: { name: string };
			status: typeof status;
		};
		expect(body.stack.name).toBe(PROJECT);
		expect(body.status.services[0]?.containerId).toBe(CONTAINER);
	});

	it("GET /api/projects leaves CPU/MEM out while nobody watches the project", async () => {
		const { call } = setup();
		const body = (await (
			await call("GET", "/api/projects")
		).json()) as ProjectSummary[];
		expect(body).toEqual([summary]);
		expect(body[0]).not.toHaveProperty("cpuPercent");
		expect(body[0]).not.toHaveProperty("memBytes");
	});

	it("long actions run in the background and stream on the op registry", async () => {
		const { call, runtime, deps } = setup();
		const res = await call(
			"POST",
			`/api/projects/${PROJECT}/down?volumes=true`,
		);
		const { opId } = (await res.json()) as { opId: string };
		await runtime.ops.settled(opId);
		expect(deps.calls).toContainEqual({
			op: "downProject",
			input: { project: PROJECT, volumes: true },
		});
		const events: Progress[] = [];
		runtime.ops.subscribe(opId, (e) => events.push(e));
		expect(events.map((e) => e.kind)).toEqual(["step", "done"]);
		expect(events.every((e) => e.opId === opId)).toBe(true);
		expect(runtime.ops.get(opId)).toMatchObject({
			kind: "project.down",
			project: PROJECT,
			state: "done",
		});
	});

	it("POST services pre-checks name, type, version, config and port", async () => {
		const deps = createTestDeps();
		deps.ports.probe.busy.add(6000);
		const { call } = setup({ ports: deps.ports });
		const base = `/api/projects/${PROJECT}/services`;
		const add = (body: Record<string, unknown>) =>
			call("POST", base, { name: "events", type: "postgres", ...body });
		expect((await add({ name: "main-db" })).status).toBe(409);
		expect((await add({ type: "mysql" })).status).toBe(422);
		expect((await add({ version: "9" })).status).toBe(422);
		expect((await add({ config: { NOPE: "1" } })).status).toBe(422);
		const conflict = await add({ port: 6000 });
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toEqual({
			code: "PORT_CONFLICT",
			message: "Port 6000 is already in use on this machine",
			details: { port: 6000, suggestedPort: 5433, fix: "Use port 5433" },
		});
		expect(
			(await add({ port: 6002, config: { POSTGRES_DB: "events" } })).status,
		).toBe(202);
	});

	it("rejects an explicit port another project has pinned", async () => {
		const deps = createTestDeps();
		await deps.ports.state.update((state) => ({
			...state,
			stacks: {
				...state.stacks,
				blog: { ports: { db: 5440 }, createdAt: "2026-01-01T00:00:00.000Z" },
			},
		}));
		const { call } = setup({ ports: deps.ports });
		const res = await call("POST", `/api/projects/${PROJECT}/services`, {
			name: "events",
			type: "postgres",
			port: 5440,
		});
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			code: "PORT_CONFLICT",
			message: "Port 5440 is reserved by project blog",
			details: { port: 5440, suggestedPort: 5433 },
		});
	});

	it("GET /api/catalog/:type/free-port skips the default and pinned ports", async () => {
		const deps = createTestDeps();
		deps.ports.probe.busy.add(5433);
		await deps.ports.state.update((state) => ({
			...state,
			stacks: {
				...state.stacks,
				blog: { ports: { db: 5434 }, createdAt: "2026-01-01T00:00:00.000Z" },
			},
		}));
		const { call } = setup({ ports: deps.ports });
		const res = await call("GET", "/api/catalog/postgres/free-port");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ port: 5435 });
		expect((await call("GET", "/api/catalog/nope/free-port")).status).toBe(422);
	});

	it("passes service inputs through to the ops", async () => {
		const { call, deps, runtime } = setup();
		const base = `/api/projects/${PROJECT}/services/main-db`;
		const opIds: string[] = [];
		for (const [method, path, body] of [
			["PATCH", base, { port: 5434 }],
			["DELETE", `${base}?volumes=true`],
			["POST", `${base}/restart`],
		] as const) {
			const res = await call(method, path, body);
			opIds.push(((await res.json()) as { opId: string }).opId);
		}
		await Promise.all(opIds.map((id) => runtime.ops.settled(id)));
		expect(deps.calls).toContainEqual({
			op: "updateService",
			input: { project: PROJECT, name: "main-db", patch: { port: 5434 } },
		});
		expect(deps.calls).toContainEqual({
			op: "removeService",
			input: { project: PROJECT, name: "main-db", volumes: true },
		});
		expect(deps.calls).toContainEqual({
			op: "restartService",
			input: { project: PROJECT, name: "main-db" },
		});
	});

	it("connection and env default to masked values", async () => {
		const { call, deps } = setup();
		await call("GET", `/api/projects/${PROJECT}/services/main-db/connection`);
		await call("GET", `/api/projects/${PROJECT}/env`);
		expect(deps.calls).toContainEqual({
			op: "getConnection",
			input: { project: PROJECT, name: "main-db", reveal: false },
		});
		expect(deps.calls).toContainEqual({
			op: "envPreview",
			input: { project: PROJECT, format: "dotenv", reveal: false },
		});
	});

	it("an op that throws still ends with one error event", async () => {
		const { ops } = createStubOps({
			// biome-ignore lint/correctness/useYield: throws before yielding on purpose
			upProject: async function* () {
				throw new OpError("PORT_CONFLICT", "Port 5433 is taken", {
					details: { port: 5434 },
				});
			},
		});
		const { call, runtime } = setup({ ops });
		const { opId } = (await (
			await call("POST", `/api/projects/${PROJECT}/up`)
		).json()) as { opId: string };
		await runtime.ops.settled(opId);
		const events: Progress[] = [];
		runtime.ops.subscribe(opId, (e) => events.push(e));
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			kind: "error",
			error: { code: "PORT_CONFLICT", details: { port: 5434 } },
		});
	});

	it("serves the OpenAPI spec with every module's reference models", async () => {
		const { app } = setup();
		const res = await app.handle(
			new Request(`http://${HOST}/docs/json`, { headers: { host: HOST } }),
		);
		expect(res.status).toBe(200);
		const spec = (await res.json()) as {
			paths: Record<string, unknown>;
			components: { schemas: Record<string, unknown> };
		};
		expect(Object.keys(spec.paths)).toContain(
			"/api/projects/{project}/services/{name}/connection",
		);
		for (const model of [
			"Projects.List",
			"Services.Connection",
			"Catalog.Listing",
			"Env.Preview",
			"System.Status",
			"Common.OpAccepted",
		])
			expect(Object.keys(spec.components.schemas)).toContain(model);
	});

	it("types the Eden client from App", async () => {
		const { app } = setup();
		const client = treaty(app, {
			headers: { host: HOST, "x-locainfra-token": TOKEN },
		});
		const { data, error } = await client.api
			.projects({ project: PROJECT })
			.services({ name: "main-db" })
			.connection.get({ query: { reveal: true } });
		expect(error).toBeNull();
		const primary: string | undefined = data?.primary.value;
		expect(primary).toContain(":pw@");
		const missing = await client.api.projects({ project: "nope" }).get();
		expect(missing.error?.status).toBe(404);
	});

	it("a failed Result becomes the matching status (INVALID_CATALOG → 422)", async () => {
		const { ops } = createStubOps({
			catalogList: async () =>
				err(new OpError("INVALID_CATALOG", "postgres.yaml is invalid")),
		});
		const { call } = setup({ ops });
		expect((await call("GET", "/api/catalog")).status).toBe(422);
	});

	it("GET …/logs reads the tail once (follow=false) and never opens a stream", async () => {
		const { call, deps } = setup();
		deps.ports.streams.logLines.set(CONTAINER, [
			{ stream: "stdout", text: "one" },
			{ stream: "stderr", text: "two" },
			{ stream: "stdout", text: "three" },
		]);
		const res = await call(
			"GET",
			`/api/projects/${PROJECT}/services/main-db/logs?tail=2`,
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			lines: [
				{ stream: "stderr", text: "two" },
				{ stream: "stdout", text: "three" },
			],
		});
		expect(deps.ports.streams.logsCalls).toHaveLength(1);
		expect(deps.ports.streams.logsCalls[0]?.options).toMatchObject({
			follow: false,
			tail: 2,
		});
		expect(deps.ports.streams.open).toBe(0);
	});

	it("GET …/logs defaults to 200 lines, validates tail and 404s unknown services", async () => {
		const { call, deps } = setup();
		const res = await call(
			"GET",
			`/api/projects/${PROJECT}/services/main-db/logs`,
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ lines: [] });
		expect(deps.ports.streams.logsCalls[0]?.options.tail).toBe(200);
		expect(
			(
				await call(
					"GET",
					`/api/projects/${PROJECT}/services/main-db/logs?tail=5001`,
				)
			).status,
		).toBe(422);
		expect(
			(await call("GET", `/api/projects/${PROJECT}/services/ghost/logs`))
				.status,
		).toBe(404);
	});

	it("GET …/logs is empty for a service without a container", async () => {
		const { containerId: _dropped, ...withoutContainer } = detail;
		const { ops } = createStubOps({
			getService: async () => ok({ ...withoutContainer, state: "stopped" }),
		});
		const { call, deps } = setup({ ops });
		const res = await call(
			"GET",
			`/api/projects/${PROJECT}/services/main-db/logs`,
		);
		expect(await res.json()).toEqual({ lines: [] });
		expect(deps.ports.streams.logsCalls).toHaveLength(0);
	});

	it("GET …/stats returns the second sample and closes the stream", async () => {
		const { call, deps } = setup();
		const sample = (cpuPercent: number, at: string) => ({
			cpuPercent,
			memBytes: 1024,
			memLimitBytes: 4096,
			netRx: 0,
			netTx: 0,
			at,
		});
		deps.ports.streams.samples.set(CONTAINER, [
			sample(0, "2026-09-23T08:00:00.000Z"),
			sample(3.5, "2026-09-23T08:00:01.000Z"),
			sample(9, "2026-09-23T08:00:02.000Z"),
		]);
		const res = await call(
			"GET",
			`/api/projects/${PROJECT}/services/main-db/stats`,
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			samples: [sample(3.5, "2026-09-23T08:00:01.000Z")],
		});
		expect(deps.ports.streams.statsCalls).toEqual([CONTAINER]);
		expect(deps.ports.streams.open).toBe(0);
	});

	it("GET …/stats is empty when the service is not running", async () => {
		const { ops } = createStubOps({
			getService: async () => ok({ ...detail, state: "stopped" }),
		});
		const { call, deps } = setup({ ops });
		const res = await call(
			"GET",
			`/api/projects/${PROJECT}/services/main-db/stats`,
		);
		expect(await res.json()).toEqual({ samples: [] });
		expect(deps.ports.streams.statsCalls).toHaveLength(0);
	});
});
