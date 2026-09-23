import { describe, expect, test } from "bun:test";
import { compareVersions, isAtLeast, parseVersion } from "../version";

describe("version-compare", () => {
	test("parses dotted versions with v prefix and suffixes", () => {
		expect(parseVersion("v2.24.0")).toEqual([2, 24, 0]);
		expect(parseVersion("2.29.1-desktop.1")).toEqual([2, 29, 1]);
		expect(parseVersion("1.44")).toEqual([1, 44]);
		expect(parseVersion("dev")).toBeNull();
	});

	test("compares numerically, padding missing parts", () => {
		expect(compareVersions("2.10.0", "2.9.9")).toBeGreaterThan(0);
		expect(compareVersions("1.44", "1.44.0")).toBe(0);
		expect(compareVersions("1.43", "1.44")).toBeLessThan(0);
		expect(compareVersions("5.3.0", "2.30")).toBeGreaterThan(0);
		expect(compareVersions("x", "1")).toBeNull();
	});

	test("isAtLeast", () => {
		expect(isAtLeast("2.24.0", "2.24")).toBe(true);
		expect(isAtLeast("2.23.9", "2.24")).toBe(false);
		expect(isAtLeast("?", "2.24")).toBeNull();
	});
});
