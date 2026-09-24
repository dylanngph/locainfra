import { describe, expect, test } from "bun:test";
import { collect } from "../../testing/collect";
import { downProject } from "../down-project.op";
import { upProject } from "../up-project.op";
import { createWorld, SHOP_COMPOSE } from "./world";

describe("upProject", () => {
	test("loads the registered project and runs upStack", async () => {
		const world = createWorld();
		const events = await collect(
			upProject(world, { project: "shop", services: ["main-db"] }),
		);
		expect(events.at(-1)?.kind).toBe("done");
		expect(world.lifecycle.upCalls).toEqual([
			{
				projectName: "ls-shop",
				composeFile: SHOP_COMPOSE,
				services: ["main-db"],
				wait: true,
				waitTimeoutSec: 120,
			},
		]);
		expect(world.state.state.stacks.shop?.ports).toEqual({
			"main-db": 5433,
			events: 5434,
			cache: 6380,
			rest: 8080,
		});
		expect(Object.keys(world.secrets.stacks.get("shop") ?? {}).sort()).toEqual([
			"CACHE__REDIS_PASSWORD",
			"EVENTS__POSTGRES_PASSWORD",
			"MAIN_DB__POSTGRES_PASSWORD",
			"REST__SRH_TOKEN",
		]);
	});

	test("an unknown project ends with one PROJECT_NOT_FOUND error", async () => {
		const world = createWorld();
		const events = await collect(upProject(world, { project: "nope" }));
		expect(events.map((e) => e.kind)).toEqual(["step", "error"]);
		expect(events[1]?.error?.code).toBe("PROJECT_NOT_FOUND");
		expect(world.lifecycle.upCalls).toHaveLength(0);
	});
});

describe("downProject", () => {
	test("loads the registered project and runs downStack", async () => {
		const world = createWorld();
		const events = await collect(
			downProject(world, { project: "shop", volumes: true }),
		);
		expect(events.at(-1)?.kind).toBe("done");
		expect(world.lifecycle.downCalls).toEqual([
			{ projectName: "ls-shop", composeFile: SHOP_COMPOSE, volumes: true },
		]);
		await collect(downProject(world, { project: "shop" }));
		expect(world.lifecycle.downCalls[1]?.volumes).toBeUndefined();
	});

	test("an unknown project ends with one error", async () => {
		const world = createWorld();
		const events = await collect(downProject(world, { project: "nope" }));
		expect(events.map((e) => e.kind)).toEqual(["step", "error"]);
		expect(world.lifecycle.downCalls).toHaveLength(0);
	});
});
