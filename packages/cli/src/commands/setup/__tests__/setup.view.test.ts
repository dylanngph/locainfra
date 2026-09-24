import { describe, expect, test } from "bun:test";
import {
	linuxInstallPlan,
	linuxStartPlan,
	macColimaInstallPlan,
} from "../../../__tests__/support/fakes";
import { formatSetupPlan, setupQuestion } from "../setup.view";

describe("command lines", () => {
	test("quote arguments and show extra environment variables first", () => {
		const text = Bun.stripANSI(
			formatSetupPlan({
				...linuxStartPlan,
				steps: [
					{
						id: "x",
						title: "Example",
						argv: ["sudo", "usermod", "-aG", "docker", "a b"],
						env: { HOMEBREW_NO_ANALYTICS: "1" },
						sudo: true,
					},
				],
			}),
		);
		expect(text).toContain(
			"$ HOMEBREW_NO_ANALYTICS=1 sudo usermod -aG docker 'a b' [sudo: asks for your password]",
		);
	});
});

describe("setupQuestion", () => {
	test("names the runtime and the number of commands", () => {
		expect(setupQuestion(linuxStartPlan)).toBe(
			"Docker is not running. Start Docker Engine now? (runs the 1 command above)",
		);
		expect(setupQuestion(macColimaInstallPlan)).toBe(
			"Install Docker with Colima? (runs the 4 commands above)",
		);
		expect(
			setupQuestion({
				kind: "install",
				alternatives: [],
				reason: "Not in the docker group.",
				steps: linuxStartPlan.steps,
				postNotes: [],
				needsTerminal: true,
			}),
		).toBe("Apply these fixes now? (runs the 1 command above)");
	});
});

describe("formatSetupPlan", () => {
	test("numbers every step with its exact command", () => {
		const text = Bun.stripANSI(formatSetupPlan(macColimaInstallPlan));
		const lines = text.split("\n");
		expect(lines[0]).toBe("Docker setup: install · Colima");
		expect(lines[1]).toBe(macColimaInstallPlan.reason);
		expect(lines).toContain("     $ /opt/homebrew/bin/colima start");
		expect(lines).toContain("Afterwards:");
	});

	test("names a download's URL and inspect command once, without repeating its note", () => {
		const download = linuxInstallPlan.steps[0];
		if (download === undefined) throw new Error("fixture has no steps");
		const plan = {
			...linuxInstallPlan,
			steps: [
				{ ...download, note: "Downloads it; you can read it before it runs." },
				...linuxInstallPlan.steps.slice(1),
			],
		};
		const text = Bun.stripANSI(formatSetupPlan(plan));
		expect(text).toContain(
			"downloads https://get.docker.com to a file first; it only runs in the next step (inspect with: less /tmp/locastack-setup-test/get-docker.sh)",
		);
		expect(text).not.toContain("you can read it before it runs");
	});
});
