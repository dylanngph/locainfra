import { describe, expect, test } from "bun:test";
import { ComposeRunner } from "../compose-runner";

// READ ONLY: only `docker compose version` is executed here; never up/down.
const compose = new ComposeRunner();
const version = await compose.version();

describe.skipIf(version === null)("ComposeRunner (live, read-only)", () => {
	test("version() returns a dotted version", () => {
		expect(version).toMatch(/^\d+\.\d+/);
	});
});
