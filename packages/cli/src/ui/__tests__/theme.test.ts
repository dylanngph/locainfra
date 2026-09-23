import { describe, expect, test } from "bun:test";
import { colorLevel } from "../theme";

describe("colorLevel", () => {
	test("keeps the detected level on a TTY", () => {
		expect(colorLevel({}, true, 3)).toBe(3);
	});
	test("turns color off when stdout is piped", () => {
		expect(colorLevel({ COLORTERM: "truecolor" }, false, 3)).toBe(0);
	});
	test("FORCE_COLOR keeps color when piped", () => {
		expect(colorLevel({ FORCE_COLOR: "1" }, false, 1)).toBe(1);
	});
	test("NO_COLOR always wins", () => {
		expect(colorLevel({ NO_COLOR: "1", FORCE_COLOR: "1" }, true, 3)).toBe(0);
	});
});
