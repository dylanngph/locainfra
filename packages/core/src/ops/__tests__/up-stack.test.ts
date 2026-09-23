import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { OpError } from "../../shared/op-error";
import { toProgressError } from "../../shared/progress.model";
import { MIN_COMPOSE_VERSION } from "../../shared/version";
import {
	builtinTestDefinitions,
	createGlobalStack,
	createProjectStack,
} from "../../testing/catalog-fixtures";
import { collect } from "../../testing/collect";
import {
	createTestPaths,
	FakeComposeInfo,
	FakeLifecycleRunner,
	FakePortProbe,
	FixedClock,
	InMemoryFileStore,
	InMemorySecretStore,
	InMemoryStateStore,
	SequentialSecretGenerator,
	StaticCatalogSource,
} from "../../testing/fakes";
import type { UpStackDeps } from "../ops.contract";
import { SECRET_FILE_MODE, UP_WAIT_TIMEOUT_SEC, upStack } from "../up-stack.op";

function setup() {
	const deps = {
		files: new InMemoryFileStore(),
		state: new InMemoryStateStore(),
		secrets: new InMemorySecretStore(),
		probe: new FakePortProbe([5433]),
		gen: new SequentialSecretGenerator(),
		lifecycle: new FakeLifecycleRunner(),
		compose: new FakeComposeInfo("2.29.1"),
		paths: createTestPaths(),
		clock: new FixedClock("2026-09-23T08:00:00.000Z"),
		catalog: new StaticCatalogSource([...builtinTestDefinitions]),
	} satisfies UpStackDeps;
	return deps;
}

const stack = createProjectStack("sovr", { postgres: {}, redis: {} });
const composePath = "/home/test/.locainfra/stacks/sovr/docker-compose.yml";
const envPath = "/home/test/.locainfra/stacks/sovr/.env";

describe("upStack", () => {
	test("writes compose + .env, then runs compose up --wait", async () => {
		const deps = setup();
		const events = await collect(upStack(deps, { stack }));

		const compose = deps.files.files.get(composePath);
		expect(compose).toBeDefined();
		const doc = parse(compose ?? "");
		expect(doc.name).toBe("li-sovr");
		expect(doc.services.postgres.ports).toEqual(["127.0.0.1:5434:5432"]);

		const secrets = deps.secrets.stacks.get("sovr") ?? {};
		expect(Object.keys(secrets).sort()).toEqual([
			"POSTGRES_PASSWORD",
			"REDIS_PASSWORD",
		]);
		const env = deps.files.files.get(envPath) ?? "";
		for (const value of Object.values(secrets)) {
			expect(env).toContain(value);
			expect(compose).not.toContain(value);
		}
		expect(deps.files.modes.get(envPath)).toBe(SECRET_FILE_MODE);
		expect(deps.files.modes.has(composePath)).toBe(false);
		expect(deps.files.dirs.has("/home/test/.locainfra/stacks/sovr")).toBe(true);

		expect(deps.lifecycle.upCalls).toEqual([
			{
				projectName: "li-sovr",
				composeFile: composePath,
				wait: true,
				waitTimeoutSec: UP_WAIT_TIMEOUT_SEC,
			},
		]);
		expect(deps.state.state.stacks.sovr?.ports).toEqual({
			postgres: 5434,
			redis: 6380,
		});
		expect(events.map((e) => e.kind)).toEqual(["step", "step", "done"]);
		expect(events.at(-1)?.message).toBe("Started");
		expect(events[0]?.at).toBe("2026-09-23T08:00:00.000Z");
	});

	test("forwards lifecycle progress in order and stops at the terminal event", async () => {
		const deps = setup();
		deps.lifecycle.upScript = [
			{ kind: "log", message: "Pulling postgres" },
			{
				kind: "step",
				message: "Container li-sovr-postgres Healthy",
				service: "postgres",
			},
			{ kind: "done", message: "All healthy" },
			{ kind: "log", message: "ignored after done" },
		];
		const events = await collect(
			upStack(deps, { stack, services: ["postgres"] }),
		);
		expect(events.slice(2)).toEqual([
			{ kind: "log", message: "Pulling postgres" },
			{
				kind: "step",
				message: "Container li-sovr-postgres Healthy",
				service: "postgres",
			},
			{ kind: "done", message: "All healthy" },
		]);
		expect(deps.lifecycle.upCalls[0]?.services).toEqual(["postgres"]);
	});

	test("appends done when the runner ends without a terminal event", async () => {
		const deps = setup();
		deps.lifecycle.upScript = [{ kind: "log", message: "up" }];
		const events = await collect(upStack(deps, { stack }));
		expect(events.map((e) => e.kind)).toEqual(["step", "step", "log", "done"]);
	});

	test("a throwing runner ends with exactly one error event", async () => {
		const deps = setup();
		deps.lifecycle.upScript = new Error("compose exited with 1");
		const events = await collect(upStack(deps, { stack }));
		expect(events.at(-1)).toMatchObject({
			kind: "error",
			message: "compose exited with 1",
		});
		expect(
			events.filter((e) => e.kind === "error" || e.kind === "done"),
		).toHaveLength(1);
	});

	test("a runner's error event is forwarded as is; a thrown OpError becomes a serializable error", async () => {
		const deps = setup();
		const conflict = new OpError("PORT_CONFLICT", "Port 5434 is taken", {
			details: { port: 5434 },
		});
		deps.lifecycle.upScript = [
			{
				kind: "error",
				message: conflict.message,
				error: toProgressError(conflict),
			},
		];
		const attached = await collect(upStack(deps, { stack }));
		expect(attached.at(-1)?.error).toEqual({
			code: "PORT_CONFLICT",
			message: "Port 5434 is taken",
			details: { port: 5434 },
		});

		deps.lifecycle.upScript = conflict;
		const thrown = await collect(upStack(deps, { stack }));
		const last = thrown.at(-1);
		expect(last?.error).toEqual({
			code: "PORT_CONFLICT",
			message: "Port 5434 is taken",
			details: { port: 5434 },
		});
		expect(last?.error).not.toBeInstanceOf(Error);
		expect(JSON.parse(JSON.stringify(last))).toEqual(last);
	});

	test("port conflict: error event, nothing written, compose not run", async () => {
		const deps = setup();
		deps.probe.busy.add(6380);
		const conflicting = createProjectStack("sovr", { redis: { port: 6380 } });
		const events = await collect(upStack(deps, { stack: conflicting }));
		expect(events.map((e) => e.kind)).toEqual(["step", "error"]);
		expect(events[1]?.message).toContain("6380");
		expect(events[1]?.error).toMatchObject({
			code: "PORT_CONFLICT",
			details: { port: 6380 },
		});
		expect(JSON.parse(JSON.stringify(events[1])).error.code).toBe(
			"PORT_CONFLICT",
		);
		expect(deps.files.files.size).toBe(0);
		expect(deps.lifecycle.upCalls).toHaveLength(0);
	});

	test("unknown service filter is an error", async () => {
		const deps = setup();
		const events = await collect(upStack(deps, { stack, services: ["mysql"] }));
		expect(events.at(-1)).toMatchObject({ kind: "error" });
		expect(deps.lifecycle.upCalls).toHaveLength(0);
	});

	test("file write failure is an error event", async () => {
		const deps = setup();
		deps.files.writeText = async () => {
			throw new Error("EROFS");
		};
		const events = await collect(upStack(deps, { stack }));
		expect(events.at(-1)?.kind).toBe("error");
		expect(deps.lifecycle.upCalls).toHaveLength(0);
	});

	test("second run keeps ports and secrets", async () => {
		const deps = setup();
		await collect(upStack(deps, { stack }));
		const before = { ...(deps.secrets.stacks.get("sovr") ?? {}) };
		const compose = deps.files.files.get(composePath);
		deps.probe.busy.add(5434);
		deps.probe.busy.add(6380);
		await collect(upStack(deps, { stack }));
		expect(deps.secrets.stacks.get("sovr")).toEqual(before);
		expect(deps.files.files.get(composePath)).toBe(compose);
		expect(deps.gen.count).toBe(2);
	});

	test("compose missing: COMPOSE_MISSING before anything is written", async () => {
		const deps = setup();
		deps.compose.current = null;
		const events = await collect(upStack(deps, { stack }));
		expect(events.map((e) => e.kind)).toEqual(["step", "error"]);
		expect(events[1]?.error?.code).toBe("COMPOSE_MISSING");
		expect(deps.files.files.size).toBe(0);
		expect(deps.state.updates).toBe(0);
		expect(deps.lifecycle.upCalls).toHaveLength(0);
	});

	test("compose older than MIN_COMPOSE_VERSION: COMPOSE_TOO_OLD with a fix hint", async () => {
		const deps = setup();
		deps.compose.current = "2.20.2";
		const events = await collect(upStack(deps, { stack }));
		const last = events.at(-1);
		expect(last?.kind).toBe("error");
		expect(last?.error).toMatchObject({
			code: "COMPOSE_TOO_OLD",
			details: { version: "2.20.2", minimum: MIN_COMPOSE_VERSION },
		});
		expect(String(last?.error?.details?.fix)).toContain(MIN_COMPOSE_VERSION);
		expect(deps.files.files.size).toBe(0);
		expect(deps.lifecycle.upCalls).toHaveLength(0);
	});

	test("compose exactly at the minimum and unparsable versions are allowed", async () => {
		for (const version of [MIN_COMPOSE_VERSION, "dev-build"]) {
			const deps = setup();
			deps.compose.current = version;
			const events = await collect(upStack(deps, { stack }));
			expect(events.at(-1)?.kind).toBe("done");
		}
	});

	test("first up registers { name, root } in state.projects", async () => {
		const deps = setup();
		await collect(upStack(deps, { stack }));
		expect(deps.state.state.projects).toEqual([
			{ name: "sovr", root: "/work/sovr" },
		]);
		await collect(upStack(deps, { stack }));
		expect(deps.state.state.projects).toHaveLength(1);
	});

	test("same name from another folder is INVALID_STACK; the first project is untouched", async () => {
		const deps = setup();
		deps.files.files.set(
			"/work/sovr/locainfra.yaml",
			"version: 1\nname: sovr\n",
		);
		await collect(upStack(deps, { stack }));
		const compose = deps.files.files.get(composePath);
		const secrets = { ...(deps.secrets.stacks.get("sovr") ?? {}) };
		const upCalls = deps.lifecycle.upCalls.length;

		const clone: typeof stack = {
			...stack,
			root: "/work/sovr-worktree",
			filePath: "/work/sovr-worktree/locainfra.yaml",
		};
		const events = await collect(upStack(deps, { stack: clone }));
		const last = events.at(-1);
		expect(last?.kind).toBe("error");
		expect(last?.error).toMatchObject({
			code: "INVALID_STACK",
			details: { registeredRoot: "/work/sovr", stack: "sovr" },
		});
		expect(String(last?.error?.details?.fix)).toContain("name:");
		expect(deps.files.files.get(composePath)).toBe(compose);
		expect(deps.secrets.stacks.get("sovr")).toEqual(secrets);
		expect(deps.lifecycle.upCalls).toHaveLength(upCalls);
		expect(deps.state.state.projects).toEqual([
			{ name: "sovr", root: "/work/sovr" },
		]);
	});

	test("a claim whose folder no longer declares the name is taken over", async () => {
		const deps = setup();
		deps.state.state.projects = [{ name: "sovr", root: "/old/sovr" }];
		deps.files.files.set(
			"/old/sovr/locainfra.yaml",
			"version: 1\nname: renamed\n",
		);
		const events = await collect(upStack(deps, { stack }));
		expect(events.at(-1)?.kind).toBe("done");
		expect(deps.state.state.projects).toEqual([
			{ name: "sovr", root: "/work/sovr" },
		]);

		const moved = setup();
		moved.state.state.projects = [{ name: "sovr", root: "/gone/sovr" }];
		const again = await collect(upStack(moved, { stack }));
		expect(again.at(-1)?.kind).toBe("done");
		expect(moved.state.state.projects[0]?.root).toBe("/work/sovr");
	});

	test("the global stack never touches the project registry", async () => {
		const deps = setup();
		await collect(
			upStack(deps, { stack: createGlobalStack({ postgres: {} }) }),
		);
		expect(deps.state.state.projects).toEqual([]);
	});
});
