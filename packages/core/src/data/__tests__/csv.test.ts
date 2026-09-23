import { describe, expect, test } from "bun:test";
import { parseCsv, parseRedisCsv } from "../csv";

describe("parseCsv", () => {
	test("parses psql --csv output: header, quoting, NULL, embedded newlines", () => {
		const text =
			'id,name,note\n1,"Ada, Countess",\n2,"say ""hi""","line1\nline2"\r\n3,plain,x\n';
		expect(parseCsv(text, 10)).toEqual({
			records: [
				["id", "name", "note"],
				["1", "Ada, Countess", ""],
				["2", 'say "hi"', "line1\nline2"],
				["3", "plain", "x"],
			],
			more: false,
			partialTail: false,
		});
	});

	test("stops after maxRecords and reports more", () => {
		const parsed = parseCsv("a\n1\n2\n3\n", 2);
		expect(parsed.records).toEqual([["a"], ["1"]]);
		expect(parsed.more).toBe(true);
	});

	test("flags a record cut at the end (no final newline or open quote)", () => {
		expect(parseCsv("a,b\n1,2\n3,", 10)).toEqual({
			records: [
				["a", "b"],
				["1", "2"],
				["3", ""],
			],
			more: false,
			partialTail: true,
		});
		expect(parseCsv('a\n"open', 10).partialTail).toBe(true);
		expect(parseCsv("a\n1\n2", 2)).toEqual({
			records: [["a"], ["1"]],
			more: true,
			partialTail: true,
		});
	});

	test("empty text has no records", () => {
		expect(parseCsv("", 5)).toEqual({
			records: [],
			more: false,
			partialTail: false,
		});
	});
});

describe("parseRedisCsv", () => {
	test("flattens a SCAN reply with C-style escapes", () => {
		const out = '"0","user:1","say \\"hi\\"","tab\\there","caf\\xc3\\xa9"\n';
		expect(parseRedisCsv(out).values).toEqual([
			"0",
			"user:1",
			'say "hi"',
			"tab\there",
			"café",
		]);
	});

	test("bare integers, NULL, booleans and escapes of every kind", () => {
		expect(parseRedisCsv("42,NULL,true,3.14\n").values).toEqual([
			"42",
			"",
			"true",
			"3.14",
		]);
		expect(parseRedisCsv('"a\\nb\\r\\a\\b\\\\\\q"\n').values).toEqual([
			"a\nb\r\x07\b\\q",
		]);
		expect(parseRedisCsv('"é"').values).toEqual(["é"]);
	});

	test("an error reply is returned as error", () => {
		expect(parseRedisCsv("ERROR,\"ERR unknown command 'NOPE'\"\n")).toEqual({
			values: [],
			error: "ERR unknown command 'NOPE'",
		});
		// A string value "ERROR" is data, not an error reply.
		expect(parseRedisCsv('"ERROR","x"\n').values).toEqual(["ERROR", "x"]);
	});
});
