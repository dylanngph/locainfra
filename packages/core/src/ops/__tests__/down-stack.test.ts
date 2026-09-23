import { describe, expect, test } from "bun:test";
import { createProjectStack } from "../../testing/catalog-fixtures";
import { collect } from "../../testing/collect";
import {
	createTestPaths,
	FakeLifecycleRunner,
	InMemoryFileStore,
	InMemoryStateStore,
} from "../../testing/fakes";
import { downStack } from "../down-stack.op";

const stack = createProjectStack("shop", { postgres: { type: "postgres" } });

function deps(
	lifecycle: FakeLifecycleRunner,
	state = new InMemoryStateStore(),
	files = new InMemoryFileStore(),
) {
	return { lifecycle, paths: createTestPaths(), state, files };
}

describe("downStack", () => {
	test("runs compose down for li-<stack> and forwards progress", async () => {
		const lifecycle = new FakeLifecycleRunner();
		lifecycle.downScript = [
			{ kind: "log", message: "Container li-shop-postgres Removed" },
			{ kind: "done", message: "Stopped" },
		];
		const events = await collect(
			downStack(deps(lifecycle), { stack, volumes: true }),
		);
		expect(lifecycle.downCalls).toEqual([
			{
				projectName: "li-shop",
				composeFile: "/home/test/.locainfra/stacks/shop/docker-compose.yml",
				volumes: true,
			},
		]);
		expect(events.map((e) => e.kind)).toEqual(["step", "log", "done"]);
		expect(events[0]?.message).toContain("removing its volumes");
	});

	test("a failing runner yields one error event", async () => {
		const lifecycle = new FakeLifecycleRunner();
		lifecycle.downScript = new Error("daemon down");
		const events = await collect(downStack(deps(lifecycle), { stack }));
		expect(events.map((e) => e.kind)).toEqual(["step", "error"]);
		expect(lifecycle.downCalls[0]?.volumes).toBeUndefined();
	});

	test("refuses a stack whose name belongs to another project folder", async () => {
		const lifecycle = new FakeLifecycleRunner();
		const state = new InMemoryStateStore({
			projects: [{ name: "shop", root: "/work/other" }],
			stacks: {},
		});
		const files = new InMemoryFileStore({
			"/work/other/locainfra.yaml": "version: 1\nname: shop\n",
		});
		const events = await collect(
			downStack(deps(lifecycle, state, files), { stack, volumes: true }),
		);
		expect(events.map((e) => e.kind)).toEqual(["step", "error"]);
		expect(events[1]?.error).toMatchObject({
			code: "INVALID_STACK",
			details: { registeredRoot: "/work/other" },
		});
		expect(lifecycle.downCalls).toHaveLength(0);
	});

	test("runs for the registered folder, an unregistered name, or a stale claim", async () => {
		for (const root of ["/work/shop", undefined, "/gone"]) {
			const lifecycle = new FakeLifecycleRunner();
			const state = new InMemoryStateStore({
				projects: root === undefined ? [] : [{ name: "shop", root }],
				stacks: {},
			});
			const events = await collect(
				downStack(deps(lifecycle, state), { stack }),
			);
			expect(events.at(-1)?.kind).toBe("done");
			expect(lifecycle.downCalls).toHaveLength(1);
		}
	});
});
