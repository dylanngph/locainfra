import { describe, expect, test } from "bun:test";
import { effectiveEnvFormat } from "../env.command";

describe("effectiveEnvFormat", () => {
	test("dotenv by default", () => {
		expect(effectiveEnvFormat({ global: false, json: false })).toBe("dotenv");
	});
	test("json under --json", () => {
		expect(effectiveEnvFormat({ global: false, json: true })).toBe("json");
	});
	test("explicit format wins", () => {
		expect(
			effectiveEnvFormat({ global: false, json: true, format: "shell" }),
		).toBe("shell");
	});
});
