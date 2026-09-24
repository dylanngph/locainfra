import { describe, expect, test } from "bun:test";
import { buildEventsQuery, toDockerEvent } from "../event-mapper";

function filters(query: string): unknown {
	return JSON.parse(new URLSearchParams(query).get("filters") ?? "null");
}

describe("buildEventsQuery", () => {
	test("defaults to container events of LocaStack containers", () => {
		expect(filters(buildEventsQuery({}))).toEqual({
			type: ["container"],
			label: ["locastack.stack"],
		});
	});

	test("exact values and presence-only labels", () => {
		expect(
			filters(
				buildEventsQuery({
					labels: { "locastack.stack": "shop", "locastack.service": "" },
				}),
			),
		).toEqual({
			type: ["container"],
			label: ["locastack.stack=shop", "locastack.service"],
		});
	});
});

describe("toDockerEvent", () => {
	const now = new Date("2026-09-23T00:00:00.000Z");

	test("maps a recorded health_status event", () => {
		expect(
			toDockerEvent(
				{
					status: "health_status: healthy",
					id: "42c9",
					from: "redis:7-alpine",
					Type: "container",
					Action: "health_status: healthy",
					Actor: {
						ID: "42c9",
						Attributes: {
							image: "redis:7-alpine",
							name: "ls-shop-cache",
							"locastack.stack": "shop",
							exitCode: 0,
						},
					},
					scope: "local",
					time: 1790143200,
					timeNano: 1790143200123000000,
				},
				now,
			),
		).toEqual({
			action: "health_status: healthy",
			id: "42c9",
			at: "2026-09-23T06:00:00.123Z",
			attributes: {
				image: "redis:7-alpine",
				name: "ls-shop-cache",
				"locastack.stack": "shop",
			},
		});
	});

	test("falls back to legacy fields and `time`; rejects other types", () => {
		expect(
			toDockerEvent({ status: "die", id: "abc", time: 1790143200 }, now),
		).toEqual({
			action: "die",
			id: "abc",
			at: "2026-09-23T06:00:00.000Z",
			attributes: {},
		});
		expect(
			toDockerEvent({ Type: "network", Action: "connect", Actor: { ID: "n" } }),
		).toBeNull();
		expect(toDockerEvent({ Type: "container" })).toBeNull();
		expect(toDockerEvent([])).toBeNull();
		expect(
			toDockerEvent({ Action: "start", Actor: { ID: "x" } }, now)?.at,
		).toBe(now.toISOString());
	});
});
