import { describe, expect, test } from "bun:test";
import { formatGroupedEnv } from "../formats/grouped";

const lines = [
	{
		key: "DATABASE_URL",
		value: "postgres://x",
		service: "main-db",
		type: "postgres",
	},
	{ key: "PGPORT", value: "5433", service: "main-db", type: "postgres" },
	{
		key: "REDIS_URL",
		value: "redis://:p w@h",
		service: "cache",
		type: "redis",
	},
];

describe("formatGroupedEnv", () => {
	test("dotenv groups lines under a comment per service", () => {
		expect(formatGroupedEnv("dotenv", lines)).toBe(
			"# main-db (postgres)\nDATABASE_URL=postgres://x\nPGPORT=5433\n\n# cache (redis)\nREDIS_URL='redis://:p w@h'\n",
		);
	});

	test("shell groups export lines the same way", () => {
		expect(formatGroupedEnv("shell", lines)).toBe(
			"# main-db (postgres)\nexport DATABASE_URL='postgres://x'\nexport PGPORT='5433'\n\n# cache (redis)\nexport REDIS_URL='redis://:p w@h'\n",
		);
	});

	test("json is one flat object", () => {
		expect(JSON.parse(formatGroupedEnv("json", lines))).toEqual({
			DATABASE_URL: "postgres://x",
			PGPORT: "5433",
			REDIS_URL: "redis://:p w@h",
		});
	});

	test("no lines is an empty text (json: {})", () => {
		expect(formatGroupedEnv("dotenv", [])).toBe("");
		expect(formatGroupedEnv("json", [])).toBe("{}\n");
	});
});
