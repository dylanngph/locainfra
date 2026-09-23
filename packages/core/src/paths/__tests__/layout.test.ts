import { describe, expect, test } from "bun:test";
import type { Paths } from "../../ports/paths.port";
import {
	composeFilePath,
	composeProjectName,
	dashboardFilePath,
	secretsFilePath,
	serviceContainerName,
	serviceVolumeName,
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
		expect(composeProjectName("shop")).toBe("li-shop");
		expect(stateFilePath(paths)).toBe("/h/.locainfra/state.json");
		expect(dashboardFilePath(paths)).toBe("/h/.locainfra/dashboard.json");
		expect(stackDir(paths, "shop")).toBe("/h/.locainfra/stacks/shop");
		expect(composeFilePath(paths, "shop")).toBe(
			"/h/.locainfra/stacks/shop/docker-compose.yml",
		);
		expect(secretsFilePath(paths, "shop")).toBe(
			"/h/.locainfra/secrets/shop.env",
		);
	});

	test("names containers and volumes per instance", () => {
		expect(serviceContainerName("shop", "main-db")).toBe("li-shop-main-db");
		expect(serviceVolumeName("shop", "main-db", "data")).toBe(
			"li-shop-main-db-data",
		);
		// The documented collision: registration has to refuse one of these.
		expect(serviceContainerName("shop", "api-db")).toBe(
			serviceContainerName("shop-api", "db"),
		);
	});
});
