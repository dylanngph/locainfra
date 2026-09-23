import { describe, expect, test } from "bun:test";
import { createProjectStack } from "../../testing/catalog-fixtures";
import { InMemoryFileStore, InMemoryStateStore } from "../../testing/fakes";
import {
	checkProjectOwner,
	claimProjectName,
	registeredProjectRoot,
} from "../project-registry";

const app = createProjectStack("app", {});
const twin = {
	...app,
	root: "/work/twin",
	filePath: "/work/twin/locainfra.yaml",
};

describe("claimProjectName", () => {
	test("concurrent claims of one name from two folders: exactly one wins", async () => {
		const state = new InMemoryStateStore();
		const files = new InMemoryFileStore({
			"/work/app/locainfra.yaml": "version: 1\nname: app\n",
			"/work/twin/locainfra.yaml": "version: 1\nname: app\n",
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
			"/work/twin/locainfra.yaml": "version: [",
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
