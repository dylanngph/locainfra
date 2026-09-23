import { describe, expect, test } from "bun:test";
import {
	LINK_END_MARKER,
	LINK_START_MARKER,
	readMarkerBlock,
	writeMarkerBlock,
} from "../link/marker-writer";

const body = "DATABASE_URL=postgres://x\nREDIS_URL=redis://y\n";
const block = `${LINK_START_MARKER}\n${body}${LINK_END_MARKER}\n`;

function unwrap<T>(
	result: { ok: true; value: T } | { ok: false; error: Error },
): T {
	if (!result.ok) throw result.error;
	return result.value;
}

describe("writeMarkerBlock", () => {
	test("creates the file content when absent", () => {
		expect(unwrap(writeMarkerBlock(null, body))).toBe(block);
		expect(unwrap(writeMarkerBlock("", body))).toBe(block);
	});

	test("appends after existing content with a blank line", () => {
		expect(unwrap(writeMarkerBlock("FOO=1\n", body))).toBe(`FOO=1\n\n${block}`);
		expect(unwrap(writeMarkerBlock("FOO=1", body))).toBe(`FOO=1\n\n${block}`);
		expect(unwrap(writeMarkerBlock("FOO=1\n\n", body))).toBe(
			`FOO=1\n\n${block}`,
		);
	});

	test("rewrites only the block and preserves everything else", () => {
		const existing = `# top comment\nFOO=1\n\n${LINK_START_MARKER}\nOLD=1\n${LINK_END_MARKER}\nBAR=2 # keep\n`;
		expect(unwrap(writeMarkerBlock(existing, "NEW=2\n"))).toBe(
			`# top comment\nFOO=1\n\n${LINK_START_MARKER}\nNEW=2\n${LINK_END_MARKER}\nBAR=2 # keep\n`,
		);
	});

	test("is idempotent", () => {
		const once = unwrap(writeMarkerBlock("A=1\n", body));
		expect(unwrap(writeMarkerBlock(once, body))).toBe(once);
	});

	test("keeps CRLF line endings", () => {
		const existing = `A=1\r\n${LINK_START_MARKER}\r\nOLD=1\r\n${LINK_END_MARKER}\r\nB=2\r\n`;
		expect(unwrap(writeMarkerBlock(existing, "NEW=1\n"))).toBe(
			`A=1\r\n${LINK_START_MARKER}\r\nNEW=1\r\n${LINK_END_MARKER}\r\nB=2\r\n`,
		);
	});

	test("an empty body leaves an empty block", () => {
		expect(unwrap(writeMarkerBlock(null, ""))).toBe(
			`${LINK_START_MARKER}\n${LINK_END_MARKER}\n`,
		);
	});

	test("malformed markers are an IO error and nothing is rewritten", () => {
		for (const bad of [
			`${LINK_START_MARKER}\nA=1\n`,
			`${LINK_END_MARKER}\n${LINK_START_MARKER}\n`,
			`${block}${block}`,
		]) {
			const result = writeMarkerBlock(bad, body);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.code).toBe("IO");
		}
	});
});

describe("readMarkerBlock", () => {
	test("returns the body, null without a block", () => {
		expect(unwrap(readMarkerBlock(`X=1\n${block}`))).toBe(body);
		expect(unwrap(readMarkerBlock("X=1\n"))).toBeNull();
		expect(
			unwrap(readMarkerBlock(`${LINK_START_MARKER}\n${LINK_END_MARKER}\n`)),
		).toBe("");
	});
});
