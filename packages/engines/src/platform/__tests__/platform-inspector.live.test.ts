import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { PlatformFacts } from "@locastack/core";
import { Value } from "@sinclair/typebox/value";
import { DockerSocketLocator } from "../../docker/socket-locator";
import { HostPlatformInspector } from "../platform-inspector";

// READ ONLY: inspect() only runs `brew --prefix`, `docker context inspect`
// and a `/_ping`; it never starts, stops or configures anything.
const isMacWithDesktop =
	process.platform === "darwin" && existsSync("/Applications/Docker.app");
const socket = isMacWithDesktop
	? await new DockerSocketLocator().locate()
	: null;
const desktopAnswers =
	socket !== null &&
	(await fetch("http://localhost/_ping", { unix: socket })
		.then((r) => r.ok)
		.catch(() => false));

describe.skipIf(!isMacWithDesktop)(
	"HostPlatformInspector (live, read-only, macOS with Docker Desktop)",
	() => {
		test("reports this Mac", async () => {
			const facts = await new HostPlatformInspector().inspect();
			expect(Value.Check(PlatformFacts, facts)).toBe(true);
			expect(facts.os).toBe("darwin");
			expect(facts.hasSystemd).toBe(false);
			expect(facts.installedRuntimes).toContain("docker-desktop");
			expect(facts.inDockerGroup).toBeUndefined();
			if (Bun.which("brew") !== null || existsSync("/opt/homebrew/bin/brew")) {
				expect(facts.hasBrew).toBe(true);
				expect(facts.brewPrefix).toMatch(/^\//);
			}
			if (desktopAnswers) {
				expect(facts.runningRuntime).toBe("docker-desktop");
				expect(facts.dockerCliPath).toMatch(/\/docker$/);
			}
		});
	},
);
