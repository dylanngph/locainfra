import { describe, expect, test } from "bun:test";
import type { SetupPlan } from "@locastack/core";
import {
	createFakeDeps,
	createFakeIo,
	linuxInstallPlan,
	linuxStartPlan,
	macColimaInstallPlan,
	macDesktopInstallPlan,
	noDockerReport,
	sampleReport,
	stoppedDockerReport,
} from "../../../__tests__/support/fakes";
import { ExitCode } from "../../../cli.types";
import { runCli } from "../../../program";

const nonePlan: SetupPlan = {
	kind: "none",
	alternatives: [],
	reason: "Docker is ready.",
	steps: [],
	postNotes: [],
	needsTerminal: false,
};

function text(io: ReturnType<typeof createFakeIo>): string {
	return Bun.stripANSI(io.out.text + io.errOut.text);
}

describe("locastack setup --dry-run", () => {
	test("prints the macOS Colima install plan with every exact command and runs nothing", async () => {
		const io = createFakeIo({ isTTY: true, confirm: true });
		const { loadDeps, calls, runner } = createFakeDeps({
			report: noDockerReport,
			plan: macColimaInstallPlan,
		});
		const code = await runCli(["setup", "--dry-run"], loadDeps, io);
		expect(code).toBe(ExitCode.OpError);
		expect(io.questions).toEqual([]);
		expect(runner.calls).toEqual([]);
		expect(calls.setupRuns).toEqual([]);
		const out = text(io);
		expect(out).toContain("Docker setup: install · Colima");
		expect(out).toContain(
			"1. Installing Colima, the Docker CLI and Compose\n     $ /opt/homebrew/bin/brew install colima docker docker-compose",
		);
		expect(out).toContain("$ mkdir -p /Users/test/.docker/cli-plugins");
		expect(out).toContain(
			"$ ln -sfn /opt/homebrew/opt/docker-compose/bin/docker-compose /Users/test/.docker/cli-plugins/docker-compose",
		);
		expect(out).toContain(
			"4. Starting Colima\n     $ /opt/homebrew/bin/colima start",
		);
		expect(out).toContain(
			"Other runtimes: Docker Desktop (--runtime docker-desktop), OrbStack (--runtime orbstack)",
		);
		expect(out).toContain("Dry run: nothing was run.");
	});

	test("prints the Linux start plan with its sudo marker", async () => {
		const io = createFakeIo();
		const { loadDeps, runner } = createFakeDeps({
			report: stoppedDockerReport,
			plan: linuxStartPlan,
		});
		const code = await runCli(["setup", "--dry-run"], loadDeps, io);
		expect(code).toBe(ExitCode.OpError);
		expect(runner.calls).toEqual([]);
		const out = text(io);
		expect(out).toContain("Docker setup: start · Docker Engine");
		expect(out).toContain(
			"$ sudo systemctl start docker [sudo: asks for your password]",
		);
	});

	test("names the remote installer URL and how to inspect it", async () => {
		const io = createFakeIo();
		const { loadDeps } = createFakeDeps({
			report: noDockerReport,
			plan: linuxInstallPlan,
		});
		await runCli(["setup", "--dry-run"], loadDeps, io);
		const out = text(io);
		expect(out).toContain(
			"$ curl -fsSL https://get.docker.com -o /tmp/locastack-setup-test/get-docker.sh",
		);
		expect(out).toContain("downloads https://get.docker.com to a file first");
		expect(out).toContain(
			"inspect with: less /tmp/locastack-setup-test/get-docker.sh",
		);
		expect(out).toContain("Log out and back in");
	});

	test("exits 0 when Docker already works", async () => {
		const io = createFakeIo();
		const { loadDeps } = createFakeDeps({
			report: sampleReport,
			plan: nonePlan,
		});
		expect(await runCli(["setup", "--dry-run"], loadDeps, io)).toBe(
			ExitCode.Ok,
		);
		expect(text(io)).toContain("Docker is ready.");
	});
});

describe("locastack setup --json", () => {
	test("prints { ok, plan, doctor } and exits 1 without prompting or running", async () => {
		const io = createFakeIo({ isTTY: true, confirm: true });
		const { loadDeps, runner } = createFakeDeps({
			report: noDockerReport,
			plan: macColimaInstallPlan,
		});
		const code = await runCli(["setup", "--json", "--yes"], loadDeps, io);
		expect(code).toBe(ExitCode.OpError);
		expect(io.questions).toEqual([]);
		expect(runner.calls).toEqual([]);
		const parsed = JSON.parse(io.out.text) as {
			ok: boolean;
			plan: SetupPlan;
			doctor: { ok: boolean };
		};
		expect(parsed).toEqual({
			ok: false,
			plan: macColimaInstallPlan,
			doctor: noDockerReport,
		});
	});

	test("ok:true and exit 0 for a none plan", async () => {
		const io = createFakeIo();
		const { loadDeps } = createFakeDeps({
			report: sampleReport,
			plan: nonePlan,
		});
		expect(await runCli(["--json", "setup"], loadDeps, io)).toBe(ExitCode.Ok);
		expect((JSON.parse(io.out.text) as { ok: boolean }).ok).toBe(true);
	});

	test("passes --runtime and --start-at-login to the planner", async () => {
		const io = createFakeIo();
		const { loadDeps, calls } = createFakeDeps({ report: noDockerReport });
		await runCli(
			["setup", "--json", "--runtime", "orbstack", "--start-at-login"],
			loadDeps,
			io,
		);
		expect(calls.planSetup).toEqual([
			{ report: noDockerReport, runtime: "orbstack", startAtLogin: true },
		]);
	});

	test("rejects an unknown --runtime as a usage error", async () => {
		const io = createFakeIo();
		const { loadDeps, calls } = createFakeDeps();
		expect(await runCli(["setup", "--runtime", "podman"], loadDeps, io)).toBe(
			ExitCode.Usage,
		);
		expect(calls.doctor).toBe(0);
	});
});

describe("locastack setup without a terminal", () => {
	test("prints the plan and exits 1 without prompting or running", async () => {
		const io = createFakeIo({ isTTY: false, confirm: true });
		const { loadDeps, runner } = createFakeDeps({
			report: noDockerReport,
			plan: macColimaInstallPlan,
		});
		expect(await runCli(["setup"], loadDeps, io)).toBe(ExitCode.OpError);
		expect(io.questions).toEqual([]);
		expect(runner.calls).toEqual([]);
		const out = text(io);
		expect(out).toContain("$ /opt/homebrew/bin/brew install colima");
		expect(out).toContain("pass --yes to run these commands");
	});
});

describe("locastack setup --yes", () => {
	test("runs every step in order with the terminal attached, then re-checks", async () => {
		const io = createFakeIo();
		const { loadDeps, calls, runner } = createFakeDeps({
			reports: [noDockerReport, sampleReport],
			plan: macColimaInstallPlan,
		});
		const code = await runCli(["setup", "--yes"], loadDeps, io);
		expect(code).toBe(ExitCode.Ok);
		expect(io.questions).toEqual([]);
		expect(runner.ranIds()).toEqual([
			"brew.install-colima",
			"compose.plugin-dir",
			"compose.plugin-link",
			"colima.start",
		]);
		expect(runner.calls.every((c) => c.options.attached)).toBe(true);
		expect(calls.setupRuns[0]?.attached).toBe(true);
		expect(calls.doctor).toBe(2);
		const out = text(io);
		expect(out).toContain(
			"› Starting Colima\n  $ /opt/homebrew/bin/colima start",
		);
		expect(out).toContain("Docker is ready: Engine 29.6.1");
		expect(out).toContain("Doctor: 1 ok · 1 warn · 0 fail");
		expect(out).toContain("Run `locastack` to open the dashboard.");
	});

	test("stops at the first failing step and exits 1", async () => {
		const io = createFakeIo();
		const { loadDeps, runner } = createFakeDeps({
			report: noDockerReport,
			plan: macColimaInstallPlan,
		});
		runner.on("compose.plugin-dir", { exitCode: 1 });
		const code = await runCli(["setup", "--yes"], loadDeps, io);
		expect(code).toBe(ExitCode.OpError);
		expect(runner.ranIds()).toEqual([
			"brew.install-colima",
			"compose.plugin-dir",
		]);
		expect(text(io)).toContain("SETUP_STEP_FAILED");
		expect(text(io)).not.toContain("open the dashboard");
	});

	test("runs a downloaded script without the inspect question", async () => {
		const io = createFakeIo({ isTTY: true });
		const { loadDeps, runner } = createFakeDeps({
			reports: [noDockerReport, sampleReport],
			plan: linuxInstallPlan,
		});
		expect(await runCli(["setup", "--yes"], loadDeps, io)).toBe(ExitCode.Ok);
		expect(io.questions).toEqual([]);
		expect(runner.ranIds()).toEqual([
			"get-docker.download",
			"get-docker.run",
			"docker.group",
		]);
	});
});

describe("locastack setup in a terminal", () => {
	test("start plan: one confirmation, then runs", async () => {
		const io = createFakeIo({ isTTY: true, confirm: true });
		const { loadDeps, runner } = createFakeDeps({
			reports: [stoppedDockerReport, sampleReport],
			plan: linuxStartPlan,
		});
		expect(await runCli(["setup"], loadDeps, io)).toBe(ExitCode.Ok);
		expect(io.questions).toEqual([
			"Docker is not running. Start Docker Engine now? (runs the 1 command above)",
		]);
		expect(runner.ranIds()).toEqual(["docker.start"]);
	});

	test("install plan: prints the plan first, then one select whose first option runs it", async () => {
		const seenAtQuestion: string[] = [];
		const io = createFakeIo({
			isTTY: true,
			answer: (q) => {
				seenAtQuestion.push(Bun.stripANSI(io.out.text));
				return q.startsWith("Set up Docker") ? "colima" : true;
			},
		});
		const { loadDeps, calls, runner } = createFakeDeps({
			reports: [noDockerReport, sampleReport],
			plan: macColimaInstallPlan,
		});
		expect(await runCli(["setup"], loadDeps, io)).toBe(ExitCode.Ok);
		expect(io.questions).toEqual([
			"Set up Docker with Colima? (the 4 commands above, or pick another runtime)",
		]);
		// The reason and every command were on screen before the question.
		expect(seenAtQuestion[0]).toContain(macColimaInstallPlan.reason);
		expect(seenAtQuestion[0]).toContain(
			"$ /opt/homebrew/bin/brew install colima docker docker-compose",
		);
		expect(calls.planSetup).toHaveLength(1);
		expect(runner.ranIds()).toHaveLength(4);
	});

	test("the select offers every runtime, Colima at login, and Not now", async () => {
		let offered: string[] = [];
		const io = createFakeIo({ isTTY: true, answer: () => "decline" });
		const select = io.prompter.select.bind(io.prompter);
		io.prompter.select = async (message, choices, initial) => {
			offered = choices.map((c) => c.label);
			return select(message, choices, initial);
		};
		const { loadDeps, calls } = createFakeDeps({
			report: noDockerReport,
			plan: macColimaInstallPlan,
		});
		expect(await runCli(["setup"], loadDeps, io)).toBe(ExitCode.OpError);
		expect(offered).toEqual([
			"Install with Colima",
			"Install with Colima, start it at login",
			"Install with Docker Desktop",
			"Install with OrbStack",
			"Not now",
		]);
		expect(calls.setupRuns).toEqual([]);
		expect(text(io)).toContain("Nothing else was run.");
	});

	test("Colima at login re-plans, prints the new commands and asks again", async () => {
		const io = createFakeIo({
			isTTY: true,
			answer: (q) => (q.startsWith("Set up Docker") ? "colima-at-login" : true),
		});
		const { loadDeps, calls, runner } = createFakeDeps({
			reports: [noDockerReport, sampleReport],
			plan: macColimaInstallPlan,
		});
		expect(await runCli(["setup"], loadDeps, io)).toBe(ExitCode.Ok);
		expect(calls.planSetup.at(-1)).toEqual({
			report: noDockerReport,
			runtime: "colima",
			startAtLogin: true,
		});
		expect(io.questions).toEqual([
			"Set up Docker with Colima? (the 4 commands above, or pick another runtime)",
			"Install Docker with Colima? (runs the 4 commands above)",
		]);
		expect(runner.ranIds()).toHaveLength(4);
	});

	test("choosing Docker Desktop re-plans for it, prints its commands, then asks", async () => {
		const io = createFakeIo({
			isTTY: true,
			answer: (q) => (q.startsWith("Set up Docker") ? "docker-desktop" : true),
		});
		const { loadDeps, calls, runner } = createFakeDeps({
			reports: [noDockerReport, sampleReport],
			plan: (input) =>
				input.runtime === "docker-desktop"
					? macDesktopInstallPlan
					: macColimaInstallPlan,
		});
		expect(await runCli(["setup"], loadDeps, io)).toBe(ExitCode.Ok);
		expect(calls.planSetup.map((i) => i.runtime)).toEqual([
			undefined,
			"docker-desktop",
		]);
		expect(io.questions.at(-1)).toBe(
			"Install Docker with Docker Desktop? (runs the 2 commands above)",
		);
		expect(runner.ranIds()).toEqual([
			"brew.install-docker-desktop",
			"docker-desktop.open",
		]);
		expect(text(io)).toContain(
			"note: Docker Desktop finishes setup in its own window.",
		);
	});

	test("cancelling the re-planned runtime's confirm runs nothing", async () => {
		const io = createFakeIo({
			isTTY: true,
			answer: (q) => (q.startsWith("Set up Docker") ? "docker-desktop" : false),
		});
		const { loadDeps, calls } = createFakeDeps({
			report: noDockerReport,
			plan: (input) =>
				input.runtime === "docker-desktop"
					? macDesktopInstallPlan
					: macColimaInstallPlan,
		});
		expect(await runCli(["setup"], loadDeps, io)).toBe(ExitCode.OpError);
		expect(calls.setupRuns).toEqual([]);
	});

	test("start plan with another installed runtime: Start X / Start Y / Not now", async () => {
		const desktopStart: SetupPlan = {
			kind: "start",
			provider: "docker-desktop",
			alternatives: ["colima"],
			reason: "Docker Desktop is installed but not running; start it.",
			steps: [
				{
					id: "docker-desktop.start",
					title: "Starting Docker Desktop",
					argv: ["open", "-a", "Docker"],
				},
			],
			postNotes: [],
			needsTerminal: false,
		};
		let offered: string[] = [];
		const io = createFakeIo({ isTTY: true, answer: () => "docker-desktop" });
		const select = io.prompter.select.bind(io.prompter);
		io.prompter.select = async (message, choices, initial) => {
			offered = choices.map((c) => c.label);
			return select(message, choices, initial);
		};
		const { loadDeps, runner } = createFakeDeps({
			reports: [stoppedDockerReport, sampleReport],
			plan: desktopStart,
		});
		expect(await runCli(["setup"], loadDeps, io)).toBe(ExitCode.Ok);
		expect(offered).toEqual([
			"Start Docker Desktop",
			"Start Colima",
			"Not now",
		]);
		expect(io.questions).toEqual([
			"Docker is not running. Start Docker Desktop? (the 1 command above, or pick another runtime)",
		]);
		expect(runner.ranIds()).toEqual(["docker-desktop.start"]);
	});

	test("--runtime skips the runtime select", async () => {
		const io = createFakeIo({ isTTY: true, confirm: false });
		const { loadDeps } = createFakeDeps({
			report: noDockerReport,
			plan: macDesktopInstallPlan,
		});
		await runCli(["setup", "--runtime", "docker-desktop"], loadDeps, io);
		expect(io.questions).toEqual([
			"Install Docker with Docker Desktop? (runs the 2 commands above)",
		]);
	});

	test("declining runs nothing and exits 1", async () => {
		const io = createFakeIo({ isTTY: true, confirm: false });
		const { loadDeps, calls, runner } = createFakeDeps({
			report: stoppedDockerReport,
			plan: linuxStartPlan,
		});
		expect(await runCli(["setup"], loadDeps, io)).toBe(ExitCode.OpError);
		expect(calls.setupRuns).toEqual([]);
		expect(runner.calls).toEqual([]);
		expect(text(io)).toContain("Nothing else was run.");
	});

	test("cancelling the runtime select runs nothing", async () => {
		const io = createFakeIo({ isTTY: true, answer: () => false });
		const { loadDeps, calls } = createFakeDeps({
			report: noDockerReport,
			plan: macColimaInstallPlan,
		});
		expect(await runCli(["setup"], loadDeps, io)).toBe(ExitCode.OpError);
		expect(io.questions).toHaveLength(1);
		expect(calls.setupRuns).toEqual([]);
	});

	test("offers to show a downloaded script before running it", async () => {
		const scriptAnswers = ["inspect", "run"];
		const io = createFakeIo({
			isTTY: true,
			answer: (q) =>
				q.startsWith("Run the downloaded installer")
					? scriptAnswers.shift()
					: true,
		});
		const { loadDeps, runner } = createFakeDeps({
			reports: [noDockerReport, sampleReport],
			plan: linuxInstallPlan,
		});
		expect(await runCli(["setup"], loadDeps, io)).toBe(ExitCode.Ok);
		expect(runner.ranIds()).toEqual([
			"get-docker.download",
			"setup.inspect-script",
			"get-docker.run",
			"docker.group",
		]);
		expect(runner.calls[1]?.step.argv).toEqual([
			"less",
			"/tmp/locastack-setup-test/get-docker.sh",
		]);
		expect(text(io)).toContain(
			"Downloaded https://get.docker.com to /tmp/locastack-setup-test/get-docker.sh",
		);
	});

	test("cancelling at the downloaded script stops before it runs", async () => {
		const io = createFakeIo({
			isTTY: true,
			answer: (q) =>
				q.startsWith("Run the downloaded installer") ? "cancel" : true,
		});
		const { loadDeps, runner } = createFakeDeps({
			report: noDockerReport,
			plan: linuxInstallPlan,
		});
		expect(await runCli(["setup"], loadDeps, io)).toBe(ExitCode.OpError);
		expect(runner.ranIds()).toEqual(["get-docker.download"]);
		expect(text(io)).toContain("Nothing else was run.");
	});

	test("a docker-group change that is not active yet tells the user to log in again", async () => {
		const io = createFakeIo({ isTTY: true });
		const { loadDeps } = createFakeDeps({
			report: noDockerReport,
			plan: linuxInstallPlan,
		});
		expect(await runCli(["setup", "--yes"], loadDeps, io)).toBe(ExitCode.Ok);
		expect(text(io)).toContain(
			"Setup finished. Docker works for your user after you log out and back in",
		);
		expect(text(io)).toContain("After logging in again, run `locastack`");
	});

	test("an unsupported plan prints what to do and exits 1", async () => {
		const io = createFakeIo({ isTTY: true, confirm: true });
		const { loadDeps, calls } = createFakeDeps({
			report: noDockerReport,
			plan: {
				kind: "unsupported",
				alternatives: [],
				reason: "LocaStack cannot install Docker on Windows.",
				steps: [],
				postNotes: ["Install Docker Desktop from docker.com."],
				needsTerminal: false,
			},
		});
		expect(await runCli(["setup"], loadDeps, io)).toBe(ExitCode.OpError);
		expect(io.questions).toEqual([]);
		expect(calls.setupRuns).toEqual([]);
		expect(text(io)).toContain("What to do:\n  - Install Docker Desktop");
	});
});
