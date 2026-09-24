import { describe, expect, test } from "bun:test";
import { createProjectStack } from "../../testing/catalog-fixtures";
import { InMemoryFileStore, InMemoryStateStore } from "../../testing/fakes";
import {
	checkProjectOwner,
	claimProjectName,
	containerNameClashError,
	findContainerNameClash,
	findProjectEntry,
	registeredProjectRoot,
} from "../project-registry";

const app = createProjectStack("app", {});
const twin = {
	...app,
	root: "/work/twin",
	filePath: "/work/twin/locastack.yaml",
};

describe("claimProjectName", () => {
	test("concurrent claims of one name from two folders: exactly one wins", async () => {
		const state = new InMemoryStateStore();
		const files = new InMemoryFileStore({
			"/work/app/locastack.yaml": "version: 1\nname: app\n",
			"/work/twin/locastack.yaml": "version: 1\nname: app\n",
		});
		const [a, b] = await Promise.all([
			claimProjectName({ state, files }, app),
			claimProjectName({ state, files }, twin),
		]);
		expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
		expect(state.state.projects).toHaveLength(1);
		const loser = a.ok ? b : a;
		if (!loser.ok) expect(loser.error.code).toBe("INVALID_STACK");
	});

	test("renaming a folder's stack replaces its old registration", async () => {
		const state = new InMemoryStateStore({
			projects: [{ name: "old", root: "/work/app" }],
			stacks: {},
		});
		const result = await claimProjectName(
			{ state, files: new InMemoryFileStore() },
			app,
		);
		expect(result.ok).toBe(true);
		expect(state.state.projects).toEqual([{ name: "app", root: "/work/app" }]);
	});

	test("an invalid stack file at the registered root keeps the claim", async () => {
		const state = new InMemoryStateStore({
			projects: [{ name: "app", root: "/work/twin" }],
			stacks: {},
		});
		const files = new InMemoryFileStore({
			"/work/twin/locastack.yaml": "version: [",
		});
		const result = await claimProjectName({ state, files }, app);
		expect(result.ok).toBe(false);
	});

	test("state read failure is IO", async () => {
		const state = new InMemoryStateStore();
		state.read = async () => {
			throw new Error("EACCES");
		};
		const result = await claimProjectName(
			{ state, files: new InMemoryFileStore() },
			app,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("IO");
	});
});

describe("checkProjectOwner", () => {
	test("never writes state", async () => {
		const state = new InMemoryStateStore();
		const result = await checkProjectOwner(
			{ state, files: new InMemoryFileStore() },
			app,
		);
		expect(result.ok).toBe(true);
		expect(state.updates).toBe(0);
		expect(registeredProjectRoot(state.state, "app")).toBeUndefined();
	});
});

describe("container name clashes", () => {
	const shopFile =
		"version: 1\nname: shop\nservices:\n  api-db: { type: postgres }\n";
	const shopApi = createProjectStack("shop-api", {
		db: { type: "postgres" },
		cache: { type: "redis" },
	});

	test("findContainerNameClash reports ls-shop-api-db from both sides", async () => {
		const state = new InMemoryStateStore({
			projects: [{ name: "shop", root: "/work/shop" }],
			stacks: {},
		});
		const files = new InMemoryFileStore({
			"/work/shop/locastack.yaml": shopFile,
		});
		const clash = await findContainerNameClash(
			{ state, files },
			{ name: "shop-api", root: "/work/shop-api", services: ["db", "cache"] },
		);
		expect(clash).toEqual({
			containerName: "ls-shop-api-db",
			service: "db",
			otherProject: "shop",
			otherRoot: "/work/shop",
			otherService: "api-db",
		});
		expect(
			await findContainerNameClash(
				{ state, files },
				{ name: "shop-api", root: "/work/shop-api", services: ["cache"] },
			),
		).toBeUndefined();
		expect(
			await findContainerNameClash(
				{ state, files },
				{ name: "shop", root: "/work/shop", services: ["api-db"] },
			),
		).toBeUndefined();
		expect(
			await findContainerNameClash(
				{ state, files },
				{ name: "x", root: "/work/x", services: [] },
			),
		).toBeUndefined();
	});

	test("projects with a missing or invalid file are skipped", async () => {
		const state = new InMemoryStateStore({
			projects: [
				{ name: "shop", root: "/work/shop" },
				{ name: "gone", root: "/work/gone" },
			],
			stacks: {},
		});
		const files = new InMemoryFileStore({
			"/work/shop/locastack.yaml": "version: [",
		});
		expect(
			await findContainerNameClash(
				{ state, files },
				{ name: "shop-api", root: "/work/shop-api", services: ["db"] },
			),
		).toBeUndefined();
	});

	test("claimProjectName refuses a new claim that would clash", async () => {
		const state = new InMemoryStateStore({
			projects: [{ name: "shop", root: "/work/shop" }],
			stacks: {},
		});
		const files = new InMemoryFileStore({
			"/work/shop/locastack.yaml": shopFile,
		});
		const result = await claimProjectName({ state, files }, shopApi);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("INVALID_STACK");
			expect(result.error.details.reason).toBe("container-name");
			expect(result.error.message).toContain("ls-shop-api-db");
		}
		expect(state.state.projects).toHaveLength(1);
	});

	test("containerNameClashError uses the requested code", () => {
		const error = containerNameClashError(
			{
				containerName: "ls-a-b-c",
				service: "b-c",
				otherProject: "a-b",
				otherRoot: "/w/a-b",
				otherService: "c",
			},
			"SERVICE_EXISTS",
		);
		expect(error.code).toBe("SERVICE_EXISTS");
		expect(error.details.fix).toContain("Rename");
	});

	test("findProjectEntry and registeredProjectRoot", () => {
		const state = {
			projects: [{ name: "a", root: "/w/a", envFile: ".env.local" }],
			stacks: {},
		};
		expect(findProjectEntry(state, "a")?.envFile).toBe(".env.local");
		expect(registeredProjectRoot(state, "a")).toBe("/w/a");
		expect(findProjectEntry(state, "b")).toBeUndefined();
	});
});
