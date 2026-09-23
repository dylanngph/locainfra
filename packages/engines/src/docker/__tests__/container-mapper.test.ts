import { describe, expect, test } from "bun:test";
import {
	buildContainerListQuery,
	mapPorts,
	parseHealthFromStatus,
	toContainerSummary,
	toDockerInfo,
} from "../container-mapper";

describe("parseHealthFromStatus", () => {
	test.each([
		["Up 2 hours (healthy)", "healthy"],
		["Up 5 seconds (unhealthy)", "unhealthy"],
		["Up 1 second (health: starting)", "starting"],
		["Up 2 hours", "none"],
		["Exited (0) 3 minutes ago", "none"],
	] as const)("%s → %s", (status, expected) => {
		expect(parseHealthFromStatus(status)).toBe(expected);
	});
});

describe("toContainerSummary", () => {
	const raw = {
		Id: "046b64973295b1214ea7e04726f2c80b",
		Names: ["/local-infra-postgres-1"],
		Image: "postgres:17-alpine",
		State: "running",
		Status: "Up 2 hours (healthy)",
		Labels: { "com.docker.compose.project": "local-infra", bad: 3 },
		Ports: [
			{ IP: "127.0.0.1", PrivatePort: 5432, PublicPort: 5432, Type: "tcp" },
			{ IP: "::1", PrivatePort: 5432, PublicPort: 5432, Type: "tcp" },
			{ PrivatePort: 9000, Type: "tcp" },
		],
	};

	test("maps names, labels, health and published ports", () => {
		expect(toContainerSummary(raw)).toEqual({
			id: raw.Id,
			name: "local-infra-postgres-1",
			image: "postgres:17-alpine",
			state: "running",
			health: "healthy",
			labels: { "com.docker.compose.project": "local-infra" },
			ports: [{ host: 5432, container: 5432 }],
		});
	});

	test("returns null when required fields are missing", () => {
		expect(toContainerSummary({ Names: ["/x"] })).toBeNull();
		expect(toContainerSummary("nope")).toBeNull();
	});

	test("mapPorts tolerates garbage", () => {
		expect(mapPorts(undefined)).toEqual([]);
		expect(mapPorts([null, { PublicPort: "1" }])).toEqual([]);
	});
});

describe("toDockerInfo", () => {
	test("maps /version", () => {
		expect(
			toDockerInfo({
				Platform: { Name: "Docker Desktop 4.82.0 (233772)" },
				Version: "29.6.1",
				ApiVersion: "1.55",
				Os: "linux",
				Arch: "arm64",
			}),
		).toEqual({
			serverVersion: "29.6.1",
			apiVersion: "1.55",
			platformName: "Docker Desktop 4.82.0 (233772)",
			os: "linux",
			arch: "arm64",
		});
	});

	test("rejects bodies without versions", () => {
		expect(toDockerInfo({ Os: "linux" })).toBeNull();
	});
});

describe("buildContainerListQuery", () => {
	test("encodes label filters as JSON", () => {
		const params = new URLSearchParams(
			buildContainerListQuery({
				labels: { "com.docker.compose.project": "local-infra" },
			}),
		);
		expect(params.get("all")).toBe("1");
		expect(JSON.parse(params.get("filters") ?? "")).toEqual({
			label: ["com.docker.compose.project=local-infra"],
		});
	});

	test("omits filters when no labels are given", () => {
		expect(buildContainerListQuery({})).toBe("all=1");
	});
});
