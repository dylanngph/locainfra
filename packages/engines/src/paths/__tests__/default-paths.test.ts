import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { resolveDefaultPaths } from "../default-paths";

describe("resolveDefaultPaths", () => {
	test("defaults to ~/.locainfra", () => {
		expect(resolveDefaultPaths({ env: {}, home: "/Users/me" })).toEqual({
			home: "/Users/me",
			stateDir: "/Users/me/.locainfra",
			stacksDir: "/Users/me/.locainfra/stacks",
			secretsDir: "/Users/me/.locainfra/secrets",
			registryDir: "/Users/me/.locainfra/registry",
			catalogOverridesDir: "/Users/me/.locainfra/catalog",
		});
	});

	test("LOCAINFRA_HOME overrides the state root and is made absolute", () => {
		const paths = resolveDefaultPaths({
			env: { LOCAINFRA_HOME: "rel/li" },
			home: "/Users/me",
		});
		expect(paths.stateDir).toBe(resolve("rel/li"));
		expect(paths.secretsDir).toBe(resolve("rel/li/secrets"));
		expect(paths.home).toBe("/Users/me");
	});

	test("blank LOCAINFRA_HOME is ignored", () => {
		expect(
			resolveDefaultPaths({ env: { LOCAINFRA_HOME: "  " }, home: "/h" })
				.stateDir,
		).toBe("/h/.locainfra");
	});
});
