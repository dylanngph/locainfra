import type { Progress } from "@locastack/server";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { useObserverStore } from "@/shared/lib/observer/observer-store";
import { mockDb } from "@/test/msw/mock-db";
import { server } from "@/test/msw/node";
import { waitForService } from "../api/services.api";

const PROJECT = "shop-api";
const NAME = "queue-cache";
const OP = "op-add-1";

const emit = (payload: Progress) =>
	useObserverStore
		.getState()
		.apply({ channel: `op:${OP}`, type: "progress", payload });

/** Serves GET …/services/queue-cache as `exists()` says and counts the calls. */
const serveService = (exists: () => boolean) => {
	const calls = { count: 0 };
	server.use(
		http.get(`*/api/projects/${PROJECT}/services/${NAME}`, () => {
			calls.count += 1;
			const project = mockDb.project(PROJECT);
			const main = project?.services.find((s) => s.name === "main-db");
			if (!exists() || !project || !main)
				return HttpResponse.json(
					{ code: "NOT_FOUND", message: "no such service" },
					{ status: 404 },
				);
			return HttpResponse.json(mockDb.detail(project, main));
		}),
	);
	return calls;
};

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("waitForService", () => {
	it("waits for the op's Added event without polling, then GETs once", async () => {
		let written = false;
		const calls = serveService(() => written);
		const until = new Promise<never>(() => {});
		const result = waitForService(PROJECT, NAME, OP, until);

		emit({ kind: "step", message: `Adding ${NAME}`, service: NAME });
		// Queued behind other ops of the project: no request while waiting.
		await tick(400);
		expect(calls.count).toBe(0);

		written = true;
		emit({
			kind: "step",
			message: `Added ${NAME} to /p/shop-api/locastack.yaml`,
			service: NAME,
		});
		await expect(result).resolves.toBe(true);
		expect(calls.count).toBe(1);
	});

	it("resolves false with one GET when the op fails before writing the entry", async () => {
		const calls = serveService(() => false);
		const result = waitForService(PROJECT, NAME, OP, new Promise(() => {}));
		emit({ kind: "error", message: "Port 6380 is busy", service: NAME });
		await expect(result).resolves.toBe(false);
		expect(calls.count).toBe(1);
	});

	it("stops waiting when `until` settles (timeout) and checks once", async () => {
		const calls = serveService(() => false);
		await expect(
			waitForService(PROJECT, NAME, OP, Promise.reject(new Error("timeout"))),
		).resolves.toBe(false);
		expect(calls.count).toBe(1);
	});
});
