import { describe, expect, test } from "bun:test";
import { red } from "ansis";
import { formatTable, padVisible } from "../table";

describe("padVisible", () => {
	test("pads by visible width, ignoring ANSI codes", () => {
		const colored = red("ab");
		const padded = padVisible(colored, 5);
		expect(Bun.stringWidth(padded)).toBe(5);
		expect(padded.startsWith(colored)).toBe(true);
	});

	test("counts wide characters as two columns", () => {
		expect(padVisible("日本", 6)).toBe("日本  ");
	});

	test("never truncates", () => {
		expect(padVisible("abcdef", 3)).toBe("abcdef");
	});
});

describe("formatTable", () => {
	test("aligns columns and leaves no trailing spaces", () => {
		const out = formatTable(
			[
				["postgres", "5432", "healthy"],
				["upstash-redis", "8079", ""],
			],
			{ header: ["SERVICE", "PORT", "STATE"] },
		);
		expect(out.split("\n")).toEqual([
			"SERVICE        PORT  STATE",
			"postgres       5432  healthy",
			"upstash-redis  8079",
		]);
	});

	test("supports indent and gap", () => {
		expect(formatTable([["a", "b"]], { indent: 2, gap: 1 })).toBe("  a b");
	});

	test("returns an empty string for no rows", () => {
		expect(formatTable([])).toBe("");
	});

	test("aligns colored cells", () => {
		const out = formatTable([
			[red("x"), "1"],
			["yyy", "2"],
		]);
		const lines = out.split("\n").map((l) => Bun.stripANSI(l));
		expect(lines).toEqual(["x    1", "yyy  2"]);
	});
});
