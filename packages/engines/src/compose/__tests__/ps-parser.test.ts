import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ComposeServiceStatus } from "@locainfra/core";
import {
	parseComposeHealth,
	parseComposePs,
	parseComposePsWithLabels,
	splitComposeLabels,
} from "../ps-parser";

const fixture = await Bun.file(
	join(import.meta.dir, "fixtures/local-infra-ps.ndjson"),
).text();

const expected: ComposeServiceStatus[] = [
	{
		service: "postgres",
		name: "local-infra-postgres-1",
		state: "running",
		health: "healthy",
		image: "postgres:17-alpine",
		publishers: [{ publishedPort: 5432, targetPort: 5432 }],
	},
	{
		service: "redis",
		name: "local-infra-redis-1",
		state: "running",
		health: "healthy",
		image: "redis:7-alpine",
		publishers: [{ publishedPort: 6379, targetPort: 6379 }],
	},
	{
		service: "serverless-redis-http",
		name: "local-infra-serverless-redis-http-1",
		state: "running",
		health: "none",
		image: "hiett/serverless-redis-http:latest",
		publishers: [{ publishedPort: 8079, targetPort: 80 }],
	},
];

describe("parseComposePs (recorded local-infra fixture)", () => {
	test("parses NDJSON output", () => {
		expect(parseComposePs(fixture)).toEqual(expected);
	});

	test("parses the same rows as a JSON array (older compose)", () => {
		const rows = fixture
			.trim()
			.split("\n")
			.map((line): unknown => JSON.parse(line));
		expect(parseComposePs(JSON.stringify(rows))).toEqual(expected);
	});

	test("empty output means no containers", () => {
		expect(parseComposePs("")).toEqual([]);
		expect(parseComposePs("[]\n")).toEqual([]);
	});

	test("throws on non-JSON output", () => {
		expect(() => parseComposePs("no such service")).toThrow();
	});

	test("exposes split labels, keeping commas inside values", () => {
		const rows = parseComposePsWithLabels(fixture);
		const http = rows.find((r) => r.service === "serverless-redis-http");
		expect(http?.labels["com.docker.compose.project"]).toBe("local-infra");
		expect(http?.labels["com.docker.compose.depends_on"]).toBe(
			"redis:service_healthy:false",
		);
		expect(http?.labels["desktop.docker.io/ports/80/tcp"]).toBe(
			"127.0.0.1:8079",
		);
	});
});

describe("splitComposeLabels", () => {
	test("splits key=value pairs", () => {
		expect(splitComposeLabels("a=1,b=2")).toEqual({ a: "1", b: "2" });
	});
	test("keeps empty values and '=' inside values", () => {
		expect(splitComposeLabels("a=,b=x=y")).toEqual({ a: "", b: "x=y" });
	});
	test("re-joins value fragments that contain commas", () => {
		expect(
			splitComposeLabels(
				"com.docker.compose.depends_on=db:service_healthy:false,cache:service_started:true,x=1",
			),
		).toEqual({
			"com.docker.compose.depends_on":
				"db:service_healthy:false,cache:service_started:true",
			x: "1",
		});
	});
	test("empty string yields no labels", () => {
		expect(splitComposeLabels("")).toEqual({});
	});
});

describe("parseComposeHealth", () => {
	test("maps empty to none and rejects unknown values", () => {
		expect(parseComposeHealth("")).toBe("none");
		expect(parseComposeHealth("starting")).toBe("starting");
		expect(parseComposeHealth("weird")).toBeUndefined();
	});
});
