import { describe, expect, test } from "bun:test";
import { ContainerDetails, isOpError } from "@locastack/core";
import { Value } from "@sinclair/typebox/value";
import { mapInspectPorts, toContainerDetails } from "../container-mapper";
import { DockerClient } from "../docker-client";
import { FakeTransport } from "./fake-transport";

/** Trimmed from a recorded `GET /containers/local-infra-redis-1/json`. */
const inspected = {
	Id: "42c9520b9437",
	Name: "/ls-shop-cache",
	State: {
		Status: "running",
		Running: true,
		ExitCode: 0,
		Error: "",
		StartedAt: "2026-09-23T02:39:57.828200097Z",
		FinishedAt: "0001-01-01T00:00:00Z",
		Health: { Status: "healthy", FailingStreak: 0 },
	},
	Config: {
		Image: "redis:7-alpine",
		Labels: { "locastack.stack": "shop", "locastack.service": "cache" },
	},
	NetworkSettings: {
		Ports: {
			"6379/tcp": [
				{ HostIp: "127.0.0.1", HostPort: "6380" },
				{ HostIp: "::1", HostPort: "6380" },
			],
			"16379/tcp": null,
		},
	},
};

describe("toContainerDetails", () => {
	test("maps a running container", () => {
		const details = toContainerDetails(inspected);
		expect(details).toEqual({
			id: "42c9520b9437",
			name: "ls-shop-cache",
			image: "redis:7-alpine",
			state: "running",
			health: "healthy",
			startedAt: "2026-09-23T02:39:57.828Z",
			exitCode: 0,
			labels: { "locastack.stack": "shop", "locastack.service": "cache" },
			ports: [{ host: 6380, container: 6379 }],
		});
		expect(Value.Check(ContainerDetails, details)).toBe(true);
	});

	test("created container with a port bind error", () => {
		const details = toContainerDetails({
			Id: "abc",
			Name: "/ls-shop-db",
			State: {
				Status: "created",
				ExitCode: 128,
				Error:
					"driver failed programming external connectivity: Bind for 127.0.0.1:5432 failed: port is already allocated",
				StartedAt: "0001-01-01T00:00:00Z",
			},
			Config: { Image: "postgres:17" },
			NetworkSettings: { Ports: {} },
		});
		expect(details?.startedAt).toBeUndefined();
		expect(details?.health).toBe("none");
		expect(details?.exitCode).toBe(128);
		expect(details?.error).toContain("port is already allocated");
		expect(toContainerDetails({ Id: "x" })).toBeNull();
	});

	test("mapInspectPorts ignores junk", () => {
		expect(mapInspectPorts(null)).toEqual([]);
		expect(
			mapInspectPorts({
				"80/tcp": [{ HostPort: "" }],
				"x/tcp": [{ HostPort: "1" }],
			}),
		).toEqual([]);
	});
});

describe("DockerClient.inspect", () => {
	test("GETs the encoded id; 404 is null", async () => {
		const transport = new FakeTransport([
			["/containers/ls-shop-cache/json", () => Response.json(inspected)],
		]);
		const client = new DockerClient(transport);
		expect((await client.inspect("ls-shop-cache"))?.state).toBe("running");
		expect(await client.inspect("gho st")).toBeNull();
		expect(transport.calls).toEqual([
			"/containers/ls-shop-cache/json",
			"/containers/gho%20st/json",
		]);
	});

	test("other failures throw typed errors", async () => {
		const client = new DockerClient(
			new FakeTransport([
				[
					"/containers/",
					() => Response.json({ message: "boom" }, { status: 500 }),
				],
			]),
		);
		const error = await client.inspect("x").catch((e: unknown) => e);
		expect(isOpError(error) && error.code).toBe("UNKNOWN");
	});
});
