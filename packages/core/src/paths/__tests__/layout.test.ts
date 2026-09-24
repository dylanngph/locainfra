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
	stateDir: "/h/.locastack",
	stacksDir: "/h/.locastack/stacks",
	secretsDir: "/h/.locastack/secrets",
	registryDir: "/h/.locastack/registry",
	catalogOverridesDir: "/h/.locastack/catalog",
};

describe("layout", () => {
	test("derives well-known paths", () => {
		expect(composeProjectName("shop")).toBe("ls-shop");
		expect(stateFilePath(paths)).toBe("/h/.locastack/state.json");
		expect(dashboardFilePath(paths)).toBe("/h/.locastack/dashboard.json");
		expect(stackDir(paths, "shop")).toBe("/h/.locastack/stacks/shop");
		expect(composeFilePath(paths, "shop")).toBe(
			"/h/.locastack/stacks/shop/docker-compose.yml",
		);
		expect(secretsFilePath(paths, "shop")).toBe(
			"/h/.locastack/secrets/shop.env",
		);
	});

	test("names containers and volumes per instance", () => {
		expect(serviceContainerName("shop", "main-db")).toBe("ls-shop-main-db");
		expect(serviceVolumeName("shop", "main-db", "data")).toBe(
			"ls-shop-main-db-data",
		);
		// The documented collision: registration has to refuse one of these.
		expect(serviceContainerName("shop", "api-db")).toBe(
			serviceContainerName("shop-api", "db"),
		);
	});
});
