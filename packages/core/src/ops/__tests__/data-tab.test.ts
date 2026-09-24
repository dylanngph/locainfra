import { describe, expect, test } from "bun:test";
import { FakeContainerExec } from "../../testing/data-fakes";
import { listDataObjects } from "../list-data-objects.op";
import {
	DATA_MAX_OBJECTS,
	DATA_QUERY_MAX_BYTES,
	DATA_QUERY_MAX_LENGTH,
	DATA_QUERY_TIMEOUT_MS,
	MASKED_SECRET,
} from "../ops.model";
import { runQuery } from "../run-query.op";
import { addContainer, createWorld, SHOP_SECRETS } from "./world";

function dataWorld(running: readonly string[] = ["main-db", "cache", "rest"]) {
	const world = {
		...createWorld({ provisioned: true, rendered: true }),
		exec: new FakeContainerExec(),
	};
	for (const service of running) addContainer(world, service);
	return world;
}

const MAIN_DB = { project: "shop", name: "main-db" };
const CACHE = { project: "shop", name: "cache" };

describe("listDataObjects", () => {
	test("postgres: runs listObjects in the container and fills defaultQuery", async () => {
		const world = dataWorld();
		world.exec.scripts.set("psql", { stdout: "orders\nusers\n\n" });
		const result = await listDataObjects(world, MAIN_DB);
		expect(result).toEqual({
			ok: true,
			value: {
				kind: "sql",
				label: "Tables",
				objects: [
					{
						name: "orders",
						defaultQuery: 'SELECT *\nFROM "orders"\nLIMIT 100;',
					},
					{ name: "users", defaultQuery: 'SELECT *\nFROM "users"\nLIMIT 100;' },
				],
				truncated: false,
			},
		});
		const [call] = world.exec.calls;
		expect(call?.containerId).toBe("ls-shop-main-db");
		expect(call?.argv).toEqual([
			"psql",
			"-X",
			"-U",
			"postgres",
			"-d",
			"shop",
			"-A",
			"-t",
			"-c",
			"SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
		]);
		expect(call?.options).toEqual({
			timeoutMs: DATA_QUERY_TIMEOUT_MS,
			maxBytes: DATA_QUERY_MAX_BYTES,
		});
	});

	test("redis: static key patterns, no exec", async () => {
		const world = dataWorld();
		const result = await listDataObjects(world, CACHE);
		expect(result).toEqual({
			ok: true,
			value: {
				kind: "redis",
				label: "Key patterns",
				objects: [{ name: "*", defaultQuery: "SCAN 0 MATCH * COUNT 100" }],
				truncated: false,
			},
		});
		expect(world.exec.calls).toEqual([]);
	});

	test("caps the list and drops a line cut by the byte cap", async () => {
		const world = dataWorld();
		const names = Array.from(
			{ length: DATA_MAX_OBJECTS + 5 },
			(_, i) => `t${i}`,
		);
		world.exec.scripts.set("psql", { stdout: `${names.join("\n")}\n` });
		const capped = await listDataObjects(world, MAIN_DB);
		expect(capped.ok && capped.value.objects.length).toBe(DATA_MAX_OBJECTS);
		expect(capped.ok && capped.value.truncated).toBe(true);

		world.exec.scripts.set("psql", { stdout: "a\r\nb\npart", truncated: true });
		const cut = await listDataObjects(world, MAIN_DB);
		expect(cut.ok && cut.value.objects.map((o) => o.name)).toEqual(["a", "b"]);
		expect(cut.ok && cut.value.truncated).toBe(true);

		// The adapter may kill the tool at the byte cap (exit code -1).
		world.exec.scripts.set("psql", {
			stdout: "a\nb\npart",
			truncated: true,
			exitCode: -1,
		});
		const killed = await listDataObjects(world, MAIN_DB);
		expect(killed.ok && killed.value.objects.map((o) => o.name)).toEqual([
			"a",
			"b",
		]);
	});

	test("errors: no Data tab, not running, unknown service, Docker down, command failure", async () => {
		const world = dataWorld(["cache"]);
		const noTab = await listDataObjects(world, {
			project: "shop",
			name: "rest",
		});
		expect(!noTab.ok && noTab.error.code).toBe("INVALID_INPUT");

		const stopped = await listDataObjects(world, MAIN_DB);
		expect(!stopped.ok && stopped.error).toMatchObject({
			code: "SERVICE_NOT_RUNNING",
			message: "main-db is not running. Start it to run queries.",
		});

		const missing = await listDataObjects(world, {
			project: "shop",
			name: "nope",
		});
		expect(!missing.ok && missing.error.code).toBe("SERVICE_NOT_FOUND");
		const noProject = await listDataObjects(world, {
			project: "nope",
			name: "x",
		});
		expect(!noProject.ok && noProject.error.code).toBe("PROJECT_NOT_FOUND");

		addContainer(world, "main-db", { state: "exited" });
		const exited = await listDataObjects(world, MAIN_DB);
		expect(!exited.ok && exited.error.details.state).toBe("exited");

		const down = dataWorld();
		down.inspector.inspect = async () => {
			throw new Error("connect ENOENT /var/run/docker.sock");
		};
		const unreachable = await listDataObjects(down, MAIN_DB);
		expect(!unreachable.ok && unreachable.error.code).toBe(
			"DOCKER_UNREACHABLE",
		);

		const failing = dataWorld();
		failing.exec.scripts.set("psql", {
			exitCode: 2,
			stderr: `psql: FATAL: password ${SHOP_SECRETS.MAIN_DB__POSTGRES_PASSWORD} rejected\n`,
		});
		const failed = await listDataObjects(failing, MAIN_DB);
		expect(!failed.ok && failed.error.code).toBe("INVALID_INPUT");
		expect(!failed.ok && failed.error.message).toBe(
			`psql: FATAL: password ${MASKED_SECRET} rejected`,
		);

		failing.exec.scripts.set("psql", new Error("container gone"));
		const gone = await listDataObjects(failing, MAIN_DB);
		expect(!gone.ok && gone.error.code).toBe("DOCKER_UNREACHABLE");
	});
});

describe("runQuery", () => {
	test("sql: passes the query as one argv item and parses the CSV", async () => {
		const world = dataWorld();
		world.exec.scripts.set("psql", {
			stdout: 'id,email,deleted_at\n1,a@x.dev,\n2,"b,c@x.dev",2026-01-01\n',
		});
		const query = "SELECT id, email, deleted_at FROM users; -- $(whoami)";
		const result = await runQuery(world, { ...MAIN_DB, query });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toMatchObject({
			columns: ["id", "email", "deleted_at"],
			rows: [
				["1", "a@x.dev", ""],
				["2", "b,c@x.dev", "2026-01-01"],
			],
			rowCount: 2,
			truncated: false,
		});
		expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
		expect(world.exec.calls[0]?.argv).toEqual([
			"psql",
			"-X",
			"-U",
			"postgres",
			"-d",
			"shop",
			"--csv",
			"-v",
			"ON_ERROR_STOP=1",
			"-c",
			query,
		]);
	});

	test("a never-started service elsewhere in the project does not block queries", async () => {
		const world = dataWorld();
		const text = world.files.files.get("/work/shop/locastack.yaml") ?? "";
		world.files.files.set(
			"/work/shop/locastack.yaml",
			text.replace("link:", "  later: { type: postgres }\nlink:"),
		);
		world.exec.scripts.set("psql", { stdout: "n\n1\n" });
		const result = await runQuery(world, {
			...MAIN_DB,
			query: "SELECT 1 AS n",
		});
		expect(result.ok && result.value.rows).toEqual([["1"]]);
	});

	test("sql: row limit, byte cap and ragged rows", async () => {
		const world = dataWorld();
		world.exec.scripts.set("psql", { stdout: "n\n1\n2\n3\n" });
		const limited = await runQuery(world, {
			...MAIN_DB,
			query: "SELECT n",
			limit: 2,
		});
		expect(limited.ok && limited.value).toMatchObject({
			rows: [["1"], ["2"]],
			rowCount: 2,
			truncated: true,
		});

		world.exec.scripts.set("psql", { stdout: "a,b\n1,2\n3", truncated: true });
		const cut = await runQuery(world, { ...MAIN_DB, query: "SELECT a, b" });
		expect(cut.ok && cut.value).toMatchObject({
			rows: [["1", "2"]],
			truncated: true,
		});

		world.exec.scripts.set("psql", {
			stdout: "a,b\n1,2\n3",
			truncated: true,
			exitCode: -1,
		});
		const killed = await runQuery(world, {
			...MAIN_DB,
			query: "SELECT a, b",
		});
		expect(killed.ok && killed.value).toMatchObject({
			rows: [["1", "2"]],
			truncated: true,
		});

		world.exec.scripts.set("psql", { stdout: "a,b\n1\n1,2,3\n" });
		const ragged = await runQuery(world, { ...MAIN_DB, query: "SELECT a, b" });
		expect(ragged.ok && ragged.value.rows).toEqual([
			["1", ""],
			["1", "2"],
		]);

		world.exec.scripts.set("psql", { stdout: "", truncated: true });
		const empty = await runQuery(world, { ...MAIN_DB, query: "SELECT" });
		expect(empty.ok && empty.value).toMatchObject({
			columns: [],
			rows: [],
			truncated: true,
		});
	});

	test("sql: a statement without result set shows its command tag", async () => {
		const world = dataWorld();
		world.exec.scripts.set("psql", { stdout: "INSERT 0 1\n" });
		const result = await runQuery(world, {
			...MAIN_DB,
			query: "INSERT INTO t VALUES (1)",
		});
		expect(result.ok && result.value).toMatchObject({
			columns: ["status"],
			rows: [["INSERT 0 1"]],
			rowCount: 1,
		});
		world.exec.scripts.set("psql", {
			stdout: "CREATE TABLE\nINSERT 0 2\n",
		});
		const several = await runQuery(world, {
			...MAIN_DB,
			query: "CREATE TABLE t (id int); INSERT INTO t VALUES (1), (2)",
		});
		expect(several.ok && several.value).toMatchObject({
			columns: ["status"],
			rows: [["CREATE TABLE"], ["INSERT 0 2"]],
			rowCount: 2,
		});
		world.exec.scripts.set("psql", { stdout: "total\n" });
		const header = await runQuery(world, {
			...MAIN_DB,
			query: "SELECT 1 AS total WHERE false",
		});
		expect(header.ok && header.value).toMatchObject({
			columns: ["total"],
			rows: [],
		});
	});

	test("sql: a rejected query or timeout is INVALID_INPUT with a masked excerpt", async () => {
		const world = dataWorld();
		const secret = SHOP_SECRETS.MAIN_DB__POSTGRES_PASSWORD;
		world.exec.scripts.set("psql", {
			exitCode: 1,
			stderr: `ERROR:  relation "x" does not exist\nLINE 1: SELECT '${secret}' FROM x\n        ^\nmore\n`,
		});
		const rejected = await runQuery(world, {
			...MAIN_DB,
			query: "SELECT * FROM x",
		});
		expect(!rejected.ok && rejected.error).toMatchObject({
			code: "INVALID_INPUT",
			message: `ERROR:  relation "x" does not exist\nLINE 1: SELECT '${MASKED_SECRET}' FROM x\n        ^`,
			details: { exitCode: 1, timedOut: false },
		});

		world.exec.scripts.set("psql", { exitCode: 3 });
		const silent = await runQuery(world, { ...MAIN_DB, query: "SELECT 1" });
		expect(!silent.ok && silent.error.message).toBe(
			"Query failed with exit code 3.",
		);

		world.exec.scripts.set("psql", { exitCode: -1, timedOut: true });
		const slow = await runQuery(world, {
			...MAIN_DB,
			query: "SELECT pg_sleep(60)",
		});
		expect(!slow.ok && slow.error).toMatchObject({
			code: "INVALID_INPUT",
			message: "Query timed out after 15 s.",
			details: { timedOut: true },
		});

		world.exec.scripts.set("psql", new Error("daemon gone"));
		const down = await runQuery(world, { ...MAIN_DB, query: "SELECT 1" });
		expect(!down.ok && down.error.code).toBe("DOCKER_UNREACHABLE");
	});

	test("redis: words as argv, one column named after the command", async () => {
		const world = dataWorld();
		world.exec.scripts.set("redis-cli", { stdout: '"0","user:1","user:2"\n' });
		const result = await runQuery(world, {
			...CACHE,
			query: "scan 0 MATCH user:* COUNT 100",
		});
		expect(result.ok && result.value).toMatchObject({
			columns: ["SCAN"],
			rows: [["0"], ["user:1"], ["user:2"]],
			rowCount: 3,
			truncated: false,
		});
		expect(world.exec.calls[0]?.argv).toEqual([
			"redis-cli",
			"--csv",
			"scan",
			"0",
			"MATCH",
			"user:*",
			"COUNT",
			"100",
		]);
		expect(world.exec.calls[0]?.containerId).toBe("ls-shop-cache");

		world.exec.scripts.set("redis-cli", { stdout: '"a","b","c"\n' });
		const limited = await runQuery(world, {
			...CACHE,
			query: "KEYS *",
			limit: 2,
		});
		expect(limited.ok && limited.value).toMatchObject({
			rows: [["a"], ["b"]],
			truncated: true,
		});

		world.exec.scripts.set("redis-cli", {
			stdout: '"a","b","c',
			truncated: true,
		});
		const cut = await runQuery(world, { ...CACHE, query: "KEYS *" });
		expect(cut.ok && cut.value).toMatchObject({
			rows: [["a"], ["b"]],
			truncated: true,
		});

		world.exec.scripts.set("redis-cli", {
			stdout: '"a","b","c',
			truncated: true,
			exitCode: -1,
		});
		const killed = await runQuery(world, { ...CACHE, query: "KEYS *" });
		expect(killed.ok && killed.value).toMatchObject({
			rows: [["a"], ["b"]],
			truncated: true,
		});
	});

	test("redis: an error reply is INVALID_INPUT", async () => {
		const world = dataWorld();
		world.exec.scripts.set("redis-cli", {
			exitCode: 1,
			stdout: "ERROR,\"ERR unknown command 'NOPE'\"\n",
		});
		const result = await runQuery(world, { ...CACHE, query: "NOPE" });
		expect(!result.ok && result.error).toMatchObject({
			code: "INVALID_INPUT",
			message: "ERR unknown command 'NOPE'",
		});
		world.exec.scripts.set("redis-cli", {
			exitCode: 1,
			stderr: "Could not connect\n",
		});
		const failed = await runQuery(world, { ...CACHE, query: "PING" });
		expect(!failed.ok && failed.error.message).toBe("Could not connect");
		const option = await runQuery(world, { ...CACHE, query: "-x SET k" });
		expect(!option.ok && option.error.code).toBe("INVALID_INPUT");
	});

	test("validates the query before touching Docker", async () => {
		const world = dataWorld();
		const cases: Array<[Record<string, unknown>, string]> = [
			[{ query: "   \n" }, "Query is empty."],
			[
				{ query: "x".repeat(DATA_QUERY_MAX_LENGTH + 1) },
				"Query is longer than 100000 characters.",
			],
			[{ query: "SELECT 1\u0000" }, "Query contains a NUL character."],
			[
				{ query: "SELECT 1", limit: 0 },
				"limit must be an integer between 1 and 1000.",
			],
			[
				{ query: "SELECT 1", limit: 1.5 },
				"limit must be an integer between 1 and 1000.",
			],
			[
				{ query: "SELECT 1", limit: 1001 },
				"limit must be an integer between 1 and 1000.",
			],
		];
		for (const [fields, message] of cases) {
			const result = await runQuery(world, {
				...MAIN_DB,
				query: "",
				...fields,
			});
			expect(!result.ok && result.error).toMatchObject({
				code: "INVALID_INPUT",
				message,
			});
		}
		expect(world.exec.calls).toEqual([]);
		expect(world.inspector.inspected).toEqual([]);
	});
});
