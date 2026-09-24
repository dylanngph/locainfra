import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { resolveDefaultPaths } from "../default-paths";

describe("resolveDefaultPaths", () => {
	test("defaults to ~/.locastack", () => {
		expect(resolveDefaultPaths({ env: {}, home: "/Users/me" })).toEqual({
			home: "/Users/me",
			stateDir: "/Users/me/.locastack",
			stacksDir: "/Users/me/.locastack/stacks",
			secretsDir: "/Users/me/.locastack/secrets",
			registryDir: "/Users/me/.locastack/registry",
			catalogOverridesDir: "/Users/me/.locastack/catalog",
		});
	});

	test("LOCASTACK_HOME overrides the state root and is made absolute", () => {
		const paths = resolveDefaultPaths({
			env: { LOCASTACK_HOME: "rel/li" },
			home: "/Users/me",
		});
		expect(paths.stateDir).toBe(resolve("rel/li"));
		expect(paths.secretsDir).toBe(resolve("rel/li/secrets"));
		expect(paths.home).toBe("/Users/me");
	});

	test("blank LOCASTACK_HOME is ignored", () => {
		expect(
			resolveDefaultPaths({ env: { LOCASTACK_HOME: "  " }, home: "/h" })
				.stateDir,
		).toBe("/h/.locastack");
	});
});
