import { describe, expect, test } from "bun:test";
import type { Progress } from "@locainfra/core";
import { OpError } from "@locainfra/core";
import { createFakeIo } from "../../__tests__/support/fakes";
import {
	createProgressRenderer,
	JsonProgressRenderer,
	LineProgressRenderer,
	renderProgress,
	SpinnerProgressRenderer,
} from "../progress";

async function* from(events: Progress[]): AsyncIterable<Progress> {
	for (const e of events) yield e;
}

describe("createProgressRenderer", () => {
	test("json beats tty", () => {
		expect(
			createProgressRenderer(createFakeIo({ isTTY: true }), true),
		).toBeInstanceOf(JsonProgressRenderer);
	});
	test("tty gets a spinner, pipes get lines", () => {
		expect(
			createProgressRenderer(createFakeIo({ isTTY: true }), false),
		).toBeInstanceOf(SpinnerProgressRenderer);
		expect(
			createProgressRenderer(createFakeIo({ isTTY: false }), false),
		).toBeInstanceOf(LineProgressRenderer);
	});
});

describe("renderProgress", () => {
	test("reports success and the done event", async () => {
		const io = createFakeIo();
		const outcome = await renderProgress(
			from([
				{ kind: "step", message: "Pulling", service: "postgres" },
				{ kind: "done", message: "Up" },
			]),
			new LineProgressRenderer(io),
			"Starting",
		);
		expect(outcome).toEqual({
			ok: true,
			last: { kind: "done", message: "Up" },
		});
		const plain = Bun.stripANSI(io.out.text);
		expect(plain).toContain("Starting");
		expect(plain).toContain("› postgres: Pulling");
		expect(plain).toContain("✓ Up");
	});

	test("an error event fails and goes to stderr", async () => {
		const io = createFakeIo();
		const outcome = await renderProgress(
			from([{ kind: "error", message: "boom" }]),
			new LineProgressRenderer(io),
			"Starting",
		);
		expect(outcome.ok).toBe(false);
		expect(Bun.stripANSI(io.errOut.text)).toContain("✗ boom");
	});

	test("an error event shows its code and fix hint", async () => {
		const io = createFakeIo();
		await renderProgress(
			from([
				{
					kind: "error",
					message: "Port 5432 is in use",
					error: {
						code: "PORT_CONFLICT",
						message: "Port 5432 is in use",
						details: { port: 5432, fix: "Stop the other stack." },
					},
				},
			]),
			new LineProgressRenderer(io),
			"Starting",
		);
		const err = Bun.stripANSI(io.errOut.text);
		expect(err).toContain("✗ Port 5432 is in use (PORT_CONFLICT)");
		expect(err).toContain("fix: Stop the other stack.");
	});

	test("a throwing stream becomes a synthetic error event", async () => {
		const io = createFakeIo();
		async function* broken(): AsyncIterable<Progress> {
			yield { kind: "step", message: "Starting" };
			throw new OpError("DOCKER_UNREACHABLE", "Docker is not running");
		}
		const outcome = await renderProgress(
			broken(),
			new JsonProgressRenderer(io),
			"x",
		);
		const last: Progress = {
			kind: "error",
			message: "Docker is not running",
			error: { code: "DOCKER_UNREACHABLE", message: "Docker is not running" },
		};
		expect(outcome).toEqual({ ok: false, last });
		const lines = io.out.text.trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[1] ?? "")).toEqual(last);
	});

	test("json mode writes nothing but NDJSON", async () => {
		const io = createFakeIo();
		await renderProgress(
			from([
				{ kind: "log", message: "line" },
				{ kind: "done", message: "ok" },
			]),
			new JsonProgressRenderer(io),
			"Starting",
		);
		expect(io.out.text).toBe(
			'{"kind":"log","message":"line"}\n{"kind":"done","message":"ok"}\n',
		);
		expect(io.errOut.text).toBe("");
	});

	test("the spinner renderer draws steps and the final message", async () => {
		const io = createFakeIo({ isTTY: true });
		const outcome = await renderProgress(
			from([
				{ kind: "step", message: "Rendering" },
				{ kind: "log", message: "pulling layer" },
				{ kind: "done", message: "All healthy" },
			]),
			new SpinnerProgressRenderer(io),
			"Starting stack acme",
		);
		expect(outcome.ok).toBe(true);
		const plain = Bun.stripANSI(io.out.text);
		expect(plain).toContain("Starting stack acme");
		expect(plain).toContain("All healthy");
	});
});
