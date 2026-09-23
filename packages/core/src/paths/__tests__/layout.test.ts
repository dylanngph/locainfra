import { describe, expect, test } from "bun:test";
import type { Paths } from "../../ports/paths.port";
import {
	composeFilePath,
	composeProjectName,
	dashboardFilePath,
	globalStackFilePath,
	secretsFilePath,
	stackDir,
	stateFilePath,
} from "../layout";

const paths: Paths = {
	home: "/h",
	stateDir: "/h/.locainfra",
	stacksDir: "/h/.locainfra/stacks",
	secretsDir: "/h/.locainfra/secrets",
	registryDir: "/h/.locainfra/registry",
	catalogOverridesDir: "/h/.locainfra/catalog",
};

describe("layout", () => {
	test("derives well-known paths", () => {
		expect(composeProjectName("sovr")).toBe("li-sovr");
		expect(stateFilePath(paths)).toBe("/h/.locainfra/state.json");
		expect(globalStackFilePath(paths)).toBe("/h/.locainfra/global.yaml");
		expect(dashboardFilePath(paths)).toBe("/h/.locainfra/dashboard.json");
		expect(stackDir(paths, "sovr")).toBe("/h/.locainfra/stacks/sovr");
		expect(composeFilePath(paths, "sovr")).toBe(
			"/h/.locainfra/stacks/sovr/docker-compose.yml",
		);
		expect(secretsFilePath(paths, "sovr")).toBe(
			"/h/.locainfra/secrets/sovr.env",
		);
	});
});
