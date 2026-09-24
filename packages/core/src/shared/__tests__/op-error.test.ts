import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { DoctorReport } from "../../ops/doctor/doctor.model";
import { ioErrorFrom, isOpError, OpError } from "../op-error";
import { Progress } from "../progress.model";
import { err, ok } from "../result";

describe("Result helpers", () => {
	test("ok and err build discriminated results", () => {
		expect(ok(1)).toEqual({ ok: true, value: 1 });
		const failure = err(new OpError("IO", "boom"));
		expect(failure.ok).toBe(false);
		if (!failure.ok) expect(failure.error.code).toBe("IO");
	});
});

describe("OpError", () => {
	test("keeps code, details and cause", () => {
		const cause = new Error("root");
		const error = new OpError("PORT_CONFLICT", "port busy", {
			details: { port: 5432 },
			cause,
		});
		expect(error.name).toBe("OpError");
		expect(error.code).toBe("PORT_CONFLICT");
		expect(error.details).toEqual({ port: 5432 });
		expect(error.cause).toBe(cause);
		expect(isOpError(error)).toBe(true);
		expect(isOpError(new Error("x"))).toBe(false);
	});

	test("defaults details to an empty object", () => {
		expect(new OpError("UNKNOWN", "x").details).toEqual({});
	});
});

describe("Progress and Doctor schemas", () => {
	test("validate their shapes", () => {
		expect(
			Value.Check(Progress, {
				kind: "step",
				message: "Pulling",
				service: "postgres",
			}),
		).toBe(true);
		expect(Value.Check(Progress, { kind: "other", message: "x" })).toBe(false);
		expect(
			Value.Check(DoctorReport, {
				ok: true,
				checks: [{ id: "docker.reachable", label: "Docker", status: "ok" }],
				generatedAt: "2026-09-23T00:00:00.000Z",
			}),
		).toBe(true);
	});
});

describe("ioErrorFrom", () => {
	test("keeps a user-facing OpError from a port and adds context", () => {
		const cause = new OpError(
			"IO",
			"/h/locastack.db was created by a newer LocaStack; update LocaStack",
			{
				details: {
					path: "/h/locastack.db",
					fix: "Install the newer LocaStack",
				},
			},
		);
		const error = ioErrorFrom("Could not read the registry", cause, {
			stack: "shop",
		});
		expect(error.code).toBe("IO");
		expect(error.message).toBe(cause.message);
		expect(error.details).toEqual({
			stack: "shop",
			path: "/h/locastack.db",
			fix: "Install the newer LocaStack",
		});
		expect(error.cause).toBe(cause);
	});

	test("wraps anything else as IO with the given message", () => {
		const cause = new Error("EACCES");
		const error = ioErrorFrom("Could not read the registry", cause);
		expect(error.code).toBe("IO");
		expect(error.message).toBe("Could not read the registry");
		expect(error.details).toEqual({});
		expect(error.cause).toBe(cause);
	});
});
