import { describe, expect, test } from "bun:test";
import { classifyComposeFailure, extractConflictPort } from "../compose-errors";

describe("classifyComposeFailure", () => {
	test("port is already allocated → PORT_CONFLICT with port", () => {
		const error = classifyComposeFailure(
			[
				" Container ls-demo-postgres-1  Starting",
				"Error response from daemon: driver failed programming external connectivity on endpoint ls-demo-postgres-1 (abc): Bind for 127.0.0.1:5432 failed: port is already allocated",
			],
			1,
			"up",
		);
		expect(error.code).toBe("PORT_CONFLICT");
		expect(error.details).toEqual({ port: 5432, exitCode: 1 });
	});

	test("address already in use → PORT_CONFLICT", () => {
		const error = classifyComposeFailure(
			[
				"Error response from daemon: Ports are not available: exposing port TCP 127.0.0.1:6379 -> 0.0.0.0:0: listen tcp4 127.0.0.1:6379: bind: address already in use",
			],
			1,
			"up",
		);
		expect(error.code).toBe("PORT_CONFLICT");
		expect(error.details.port).toBe(6379);
	});

	test("daemon down → DOCKER_UNREACHABLE", () => {
		const error = classifyComposeFailure(
			[
				"Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
			],
			1,
			"up",
		);
		expect(error.code).toBe("DOCKER_UNREACHABLE");
	});

	test("missing plugin → COMPOSE_MISSING", () => {
		const error = classifyComposeFailure(
			["docker: 'compose' is not a docker command."],
			1,
			"up",
		);
		expect(error.code).toBe("COMPOSE_MISSING");
	});

	test("anything else → UNKNOWN with the last line", () => {
		const error = classifyComposeFailure(
			["first", "no such service: web", ""],
			1,
			"up",
		);
		expect(error.code).toBe("UNKNOWN");
		expect(error.message).toContain("no such service: web");
	});
});

describe("extractConflictPort", () => {
	test("returns undefined when no port is present", () => {
		expect(extractConflictPort("port is already allocated")).toBeUndefined();
	});
});
