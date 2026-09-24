import { describe, expect, it } from "vitest";
import { cliCommandLine, shellQuote, shortPath } from "../shell";

describe("shellQuote", () => {
	it("single-quotes and escapes embedded quotes", () => {
		expect(shellQuote("/Users/me/My Projects/shop")).toBe(
			"'/Users/me/My Projects/shop'",
		);
		expect(shellQuote("/tmp/it's")).toBe(`'/tmp/it'\\''s'`);
		expect(shellQuote("/tmp/$HOME")).toBe("'/tmp/$HOME'");
	});
});

describe("cliCommandLine", () => {
	it("prefixes a quoted cd when a folder is given", () => {
		expect(cliCommandLine("locastack up", "/Users/me/dev/my shop")).toBe(
			"cd '/Users/me/dev/my shop' && locastack up",
		);
	});

	it("returns the bare command without a folder", () => {
		expect(cliCommandLine("locastack doctor")).toBe("locastack doctor");
	});
});

describe("shortPath", () => {
	it("keeps only the last segment", () => {
		expect(shortPath("/Users/me/dev/m2-smoke")).toBe("…/m2-smoke");
		expect(shortPath("/Users/me/dev/m2-smoke/")).toBe("…/m2-smoke");
		expect(shortPath("/srv")).toBe("/srv");
		expect(shortPath("/")).toBe("/");
	});
});
