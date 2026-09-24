import { describe, expect, test } from "bun:test";
import {
	formatCommand,
	formatCommandStep,
	quoteShellArg,
} from "../command-format";

describe("command formatting", () => {
	test("plain words stay bare, others are single-quoted", () => {
		expect(quoteShellArg("/opt/homebrew/bin/brew")).toBe(
			"/opt/homebrew/bin/brew",
		);
		expect(quoteShellArg("--create-dirs")).toBe("--create-dirs");
		expect(quoteShellArg("")).toBe("''");
		expect(quoteShellArg("a b")).toBe("'a b'");
		expect(quoteShellArg("it's")).toBe(`'it'"'"'s'`);
		expect(quoteShellArg("$(rm -rf ~)")).toBe("'$(rm -rf ~)'");
	});

	test("formatCommand joins argv", () => {
		expect(formatCommand(["sudo", "usermod", "-aG", "docker", "jo doe"])).toBe(
			"sudo usermod -aG docker 'jo doe'",
		);
	});

	test("formatCommandStep prefixes env", () => {
		expect(
			formatCommandStep({
				argv: ["colima", "start"],
				env: { PATH: "/opt/homebrew/bin:/usr/bin" },
			}),
		).toBe("PATH=/opt/homebrew/bin:/usr/bin colima start");
		expect(formatCommandStep({ argv: ["open", "-a", "Docker"] })).toBe(
			"open -a Docker",
		);
	});
});
