import { describe, expect, test } from "bun:test";
import { isOpError } from "@locastack/core";
import { DockerClient } from "../docker-client";
import { FakeTransport } from "./fake-transport";

describe("DockerClient (fake transport)", () => {
	test("info() maps /version", async () => {
		const client = new DockerClient(
			new FakeTransport([
				[
					"/version",
					() =>
						Response.json({
							Version: "29.6.1",
							ApiVersion: "1.55",
							Os: "linux",
							Arch: "arm64",
						}),
				],
			]),
		);
		expect(await client.info()).toEqual({
			serverVersion: "29.6.1",
			apiVersion: "1.55",
			os: "linux",
			arch: "arm64",
		});
	});

	test("list() sends the label filter and skips malformed rows", async () => {
		const transport = new FakeTransport([
			[
				"/containers/json",
				() =>
					Response.json([
						{
							Id: "abc",
							Names: ["/one"],
							Image: "redis:7",
							State: "exited",
							Status: "Exited (0) 1 hour ago",
							Labels: {},
							Ports: [],
						},
						{ garbage: true },
					]),
			],
		]);
		const list = await new DockerClient(transport).list({
			labels: { "locastack.stack": "demo" },
		});
		expect(list).toEqual([
			{
				id: "abc",
				name: "one",
				image: "redis:7",
				state: "exited",
				health: "none",
				labels: {},
				ports: [],
			},
		]);
		expect(transport.calls[0]).toContain("filters=");
		expect(decodeURIComponent(transport.calls[0] ?? "")).toContain(
			"locastack.stack=demo",
		);
	});

	test("non-2xx responses become OpErrors with the daemon message", async () => {
		const client = new DockerClient(
			new FakeTransport([
				[
					"/containers/json",
					() => Response.json({ message: "boom" }, { status: 500 }),
				],
			]),
		);
		const error = await client.list({}).catch((e: unknown) => e);
		expect(isOpError(error)).toBe(true);
		expect(String((error as Error).message)).toContain("boom");
	});
});
