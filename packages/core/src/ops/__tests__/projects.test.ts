import { describe, expect, test } from "bun:test";
import { OpError } from "../../shared/op-error";
import { createProject } from "../create-project.op";
import { listProjects } from "../list-projects.op";
import { loadProject } from "../load-project.op";
import { registerProject } from "../register-project.op";
import { unregisterProject } from "../unregister-project.op";
import { addContainer, createWorld, SHOP_FILE, SHOP_ROOT } from "./world";

describe("loadProject", () => {
	test("loads a registered project's stack", async () => {
		const world = createWorld();
		const result = await loadProject(world, { project: "shop" });
		if (!result.ok) throw result.error;
		expect(result.value.root).toBe(SHOP_ROOT);
		expect(Object.keys(result.value.file.services)).toEqual([
			"main-db",
			"events",
			"cache",
			"rest",
		]);
	});

	test("PROJECT_NOT_FOUND, STACK_NOT_FOUND, renamed file, IO", async () => {
		const world = createWorld();
		const missing = await loadProject(world, { project: "nope" });
		expect(!missing.ok && missing.error.code).toBe("PROJECT_NOT_FOUND");

		const gone = await loadProject(createWorld({ yaml: null }), {
			project: "shop",
		});
		expect(!gone.ok && gone.error.code).toBe("STACK_NOT_FOUND");

		const renamed = await loadProject(
			createWorld({ yaml: "version: 1\nname: other\n" }),
			{ project: "shop" },
		);
		expect(!renamed.ok && renamed.error.code).toBe("INVALID_STACK");
		expect(!renamed.ok && renamed.error.message).toContain('"other"');

		world.state.read = async () => {
			throw new Error("EACCES");
		};
		const io = await loadProject(world, { project: "shop" });
		expect(!io.ok && io.error.code).toBe("IO");

		// A user-facing store error (e.g. a database from a newer release) is shown as-is.
		world.state.read = async () => {
			throw new OpError(
				"IO",
				"/h/locainfra.db was created by a newer LocaInfra; update LocaInfra",
				{
					details: {
						path: "/h/locainfra.db",
						fix: "Install the newer LocaInfra",
					},
				},
			);
		};
		const newer = await loadProject(world, { project: "shop" });
		expect(!newer.ok && newer.error.message).toContain(
			"created by a newer LocaInfra",
		);
		expect(!newer.ok && newer.error.details.fix).toBe(
			"Install the newer LocaInfra",
		);
	});
});

describe("registerProject", () => {
	const APP = "version: 1\nname: app\nservices:\n  db: { type: postgres }\n";

	test("registers an existing folder; re-registering is a no-op", async () => {
		const world = createWorld();
		world.files.files.set("/work/app/locainfra.yaml", APP);
		const result = await registerProject(world, {
			name: "app",
			root: "/work/app/",
		});
		expect(result).toEqual({
			ok: true,
			value: { name: "app", root: "/work/app" },
		});
		expect(world.state.state.projects).toEqual([
			{ name: "shop", root: SHOP_ROOT },
			{ name: "app", root: "/work/app" },
		]);
		const again = await registerProject(world, {
			name: "app",
			root: "/work/app",
		});
		expect(again.ok).toBe(true);
		expect(world.state.state.projects).toHaveLength(2);
	});

	test("validates name, root and the file's name", async () => {
		const world = createWorld();
		world.files.files.set("/work/app/locainfra.yaml", APP);
		const badName = await registerProject(world, {
			name: "App",
			root: "/work/app",
		});
		expect(!badName.ok && badName.error.code).toBe("INVALID_INPUT");
		const relative = await registerProject(world, {
			name: "app",
			root: "work/app",
		});
		expect(!relative.ok && relative.error.code).toBe("INVALID_INPUT");
		const mismatch = await registerProject(world, {
			name: "other",
			root: "/work/app",
		});
		expect(!mismatch.ok && mismatch.error.code).toBe("INVALID_INPUT");
		const missing = await registerProject(world, {
			name: "app",
			root: "/work/none",
		});
		expect(!missing.ok && missing.error.code).toBe("STACK_NOT_FOUND");
	});

	test("PROJECT_EXISTS when another folder holds the name or containers would clash", async () => {
		const world = createWorld();
		world.files.files.set(
			"/work/shop-copy/locainfra.yaml",
			"version: 1\nname: shop\n",
		);
		const taken = await registerProject(world, {
			name: "shop",
			root: "/work/shop-copy",
		});
		expect(!taken.ok && taken.error.code).toBe("PROJECT_EXISTS");
		expect(!taken.ok && taken.error.details.reason).toBe("name-taken");

		// li-shop + main-db  ==  li-shop-main + db
		world.files.files.set(
			"/work/shop-main/locainfra.yaml",
			"version: 1\nname: shop-main\nservices:\n  db: { type: postgres }\n",
		);
		const clash = await registerProject(world, {
			name: "shop-main",
			root: "/work/shop-main",
		});
		expect(!clash.ok && clash.error.code).toBe("PROJECT_EXISTS");
		expect(!clash.ok && clash.error.details.containerName).toBe(
			"li-shop-main-db",
		);
		expect(world.state.state.projects).toHaveLength(1);
	});
});

describe("createProject", () => {
	test("creates the folder and a fresh file, then registers it", async () => {
		const world = createWorld();
		const result = await createProject(world, {
			name: "blog",
			root: "/Users/me/Developer/blog",
			services: { db: { type: "postgres" } },
		});
		if (!result.ok) throw result.error;
		expect(result.value).toMatchObject({
			name: "blog",
			root: "/Users/me/Developer/blog",
			filePath: "/Users/me/Developer/blog/locainfra.yaml",
		});
		const text = world.files.files.get(
			"/Users/me/Developer/blog/locainfra.yaml",
		);
		expect(text).toContain("# yaml-language-server");
		expect(text).toContain("name: blog\n");
		expect(text).toContain("  db: { type: postgres }\n");
		expect(world.files.dirs.has("/Users/me/Developer/blog")).toBe(true);
		expect(world.state.state.projects.at(-1)).toEqual({
			name: "blog",
			root: "/Users/me/Developer/blog",
		});
		expect(world.lifecycle.upCalls).toHaveLength(0);
	});

	test("PROJECT_EXISTS for a registered name or an existing file", async () => {
		const world = createWorld();
		const name = await createProject(world, { name: "shop", root: "/work/x" });
		expect(!name.ok && name.error.code).toBe("PROJECT_EXISTS");
		const file = await createProject(world, { name: "fresh", root: SHOP_ROOT });
		expect(!file.ok && file.error.code).toBe("PROJECT_EXISTS");
		expect(!file.ok && file.error.details.reason).toBe("file-exists");
	});

	test("INVALID_INPUT, INVALID_STACK and IO", async () => {
		const world = createWorld();
		const bad = await createProject(world, { name: "Bad", root: "/work/b" });
		expect(!bad.ok && bad.error.code).toBe("INVALID_INPUT");
		const invalid = await createProject(world, {
			name: "b",
			root: "/work/b",
			services: { Bad: { type: "postgres" } },
		});
		expect(!invalid.ok && invalid.error.code).toBe("INVALID_STACK");

		world.files.writeText = async () => {
			throw new Error("EROFS");
		};
		const io = await createProject(world, { name: "c", root: "/work/c" });
		expect(!io.ok && io.error.code).toBe("IO");
		expect(world.state.state.projects.map((p) => p.name)).toEqual(["shop"]);

		world.files.exists = async () => {
			throw new Error("EACCES");
		};
		const check = await createProject(world, { name: "d", root: "/work/d" });
		expect(!check.ok && check.error.code).toBe("IO");
	});
});

describe("unregisterProject", () => {
	test("removes only the registry entry", async () => {
		const world = createWorld({ provisioned: true });
		const result = await unregisterProject(world, { project: "shop" });
		expect(result).toEqual({
			ok: true,
			value: { name: "shop", root: SHOP_ROOT },
		});
		expect(world.state.state.projects).toEqual([]);
		expect(world.state.state.stacks.shop).toBeDefined();
		expect(world.files.files.has(SHOP_FILE)).toBe(true);
		const again = await unregisterProject(world, { project: "shop" });
		expect(!again.ok && again.error.code).toBe("PROJECT_NOT_FOUND");
	});

	test("state failures are IO", async () => {
		const world = createWorld();
		world.state.update = async () => {
			throw new Error("EACCES");
		};
		const result = await unregisterProject(world, { project: "shop" });
		expect(!result.ok && result.error.code).toBe("IO");
	});
});

describe("listProjects", () => {
	test("summarizes every project, with issues for broken ones", async () => {
		const world = createWorld();
		world.state.state.projects.push(
			{ name: "gone", root: "/work/gone", envFile: ".env.local" },
			{ name: "empty", root: "/work/empty" },
		);
		world.files.files.set(
			"/work/empty/locainfra.yaml",
			"version: 1\nname: empty\n",
		);
		addContainer(world, "main-db", { state: "running", health: "healthy" });
		addContainer(world, "events", { state: "dead" });
		addContainer(world, "cache", { state: "running", health: "starting" });
		const result = await listProjects(world);
		if (!result.ok) throw result.error;
		expect(result.value).toEqual([
			{
				name: "shop",
				root: SHOP_ROOT,
				serviceCount: 4,
				running: 1,
				errors: 1,
				types: ["postgres", "postgres", "redis", "upstash-redis"],
			},
			{
				name: "gone",
				root: "/work/gone",
				envFile: ".env.local",
				serviceCount: 0,
				running: 0,
				errors: 0,
				types: [],
				issue: "/work/gone/locainfra.yaml: not found",
			},
			{
				name: "empty",
				root: "/work/empty",
				serviceCount: 0,
				running: 0,
				errors: 0,
				types: [],
			},
		]);
	});

	test("Docker down gives zero counts; state failure is IO", async () => {
		const world = createWorld();
		world.containers.list = async () => {
			throw new Error("ECONNREFUSED");
		};
		const result = await listProjects(world);
		expect(result.ok && result.value[0]?.running).toBe(0);
		world.state.read = async () => {
			throw new Error("EACCES");
		};
		const io = await listProjects(world);
		expect(!io.ok && io.error.code).toBe("IO");
	});
});
