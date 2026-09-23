import { describe, expect, test } from "bun:test";
import { dotenvFormatter, quoteDotenvValue } from "../formats/dotenv";
import { jsonFormatter } from "../formats/json";
import { ENV_FORMATTERS, getEnvFormatter } from "../formats/registry";
import { quoteShellValue, shellFormatter } from "../formats/shell";

const vars = {
	DATABASE_URL: "postgres://u:p@127.0.0.1:5433/db",
	QUOTE: "it's $HOME",
};

describe("env formatters", () => {
	test("dotenv keeps safe values bare and quotes the rest", () => {
		expect(dotenvFormatter.format(vars)).toBe(
			'DATABASE_URL=postgres://u:p@127.0.0.1:5433/db\nQUOTE="it\'s \\$HOME"\n',
		);
		expect(quoteDotenvValue("a b")).toBe("'a b'");
		// Newline forces double quotes with \\, \" and \n escapes.
		expect(quoteDotenvValue('x"\\\ny')).toBe(String.raw`"x\"\\\ny"`);
		expect(quoteDotenvValue("")).toBe("");
	});

	test("shell exports single-quoted values", () => {
		expect(shellFormatter.format(vars)).toBe(
			"export DATABASE_URL='postgres://u:p@127.0.0.1:5433/db'\nexport QUOTE='it'\\''s $HOME'\n",
		);
		expect(quoteShellValue("")).toBe("''");
	});

	test("json is a pretty object", () => {
		expect(JSON.parse(jsonFormatter.format(vars))).toEqual(vars);
		expect(jsonFormatter.format({})).toBe("{}\n");
	});

	test("registry covers every format", () => {
		expect(Object.keys(ENV_FORMATTERS).sort()).toEqual([
			"dotenv",
			"json",
			"shell",
		]);
		expect(getEnvFormatter("shell")).toBe(shellFormatter);
		for (const [id, formatter] of Object.entries(ENV_FORMATTERS)) {
			expect(formatter.id).toBe(id as typeof formatter.id);
		}
	});

	test("shell output round-trips through a real shell", async () => {
		const script = `${shellFormatter.format(vars)}printf '%s\\n%s' "$DATABASE_URL" "$QUOTE"`;
		const proc = Bun.spawn(["sh", "-c", script], { stdout: "pipe" });
		const out = await new Response(proc.stdout).text();
		expect(out).toBe(`${vars.DATABASE_URL}\n${vars.QUOTE}`);
	});
});
