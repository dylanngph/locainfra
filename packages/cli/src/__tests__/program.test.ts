import { describe, expect, test } from "bun:test";
import type { DoctorReport, Progress } from "@locastack/core";
import { version } from "../../package.json";
import { ExitCode } from "../cli.types";
import { runCli } from "../program";
import { createFakeDeps, createFakeIo, sampleReport } from "./support/fakes";

const failingReport: DoctorReport = {
	ok: false,
	generatedAt: "2026-09-23T10:00:00.000Z",
	checks: [
		{
			id: "docker.reachable",
			label: "Docker reachable",
			status: "fail",
			detail: "connect ENOENT",
			fix: "Start Docker Desktop",
		},
	],
};

describe("global flags", () => {
	test("--version prints the package version without loading deps", async () => {
		const io = createFakeIo();
		let loaded = false;
		const code = await runCli(
			["--version"],
			async () => {
				loaded = true;
				throw new Error("should not load");
			},
			io,
		);
		expect(code).toBe(ExitCode.Ok);
		expect(io.out.text.trim()).toBe(version);
		expect(loaded).toBe(false);
	});

	test("--help lists every command and exits 0", async () => {
		const io = createFakeIo();
		const { loadDeps } = createFakeDeps();
		const code = await runCli(["--help"], loadDeps, io);
		expect(code).toBe(ExitCode.Ok);
		for (const name of ["up", "down", "env", "doctor", "--json"]) {
			expect(io.out.text).toContain(name);
		}
	});

	test("unknown command is a usage error (exit 2)", async () => {
		const io = createFakeIo();
		const { loadDeps, calls } = createFakeDeps();
		expect(await runCli(["frobnicate"], loadDeps, io)).toBe(ExitCode.Usage);
		expect(io.errOut.text).toContain("frobnicate");
		expect(calls.doctor).toBe(0);
	});

	test("unknown option is a usage error (exit 2)", async () => {
		const io = createFakeIo();
		const { loadDeps } = createFakeDeps();
		expect(await runCli(["up", "--nope"], loadDeps, io)).toBe(ExitCode.Usage);
	});

	test("the final exit code is reported through io.setExitCode", async () => {
		const io = createFakeIo();
		const { loadDeps } = createFakeDeps({ report: failingReport });
		await runCli(["doctor"], loadDeps, io);
		expect(io.exitCodes.at(-1)).toBe(ExitCode.OpError);
	});

	test("a failing composition root exits 1 with a message", async () => {
		const io = createFakeIo();
		const code = await runCli(
			["doctor"],
			async () => {
				throw new Error("engines unavailable");
			},
			io,
		);
		expect(code).toBe(ExitCode.OpError);
		expect(io.errOut.text).toContain("engines unavailable");
	});
});

describe("doctor", () => {
	test("--json prints the report verbatim", async () => {
		const io = createFakeIo();
		const { loadDeps, calls } = createFakeDeps();
		const code = await runCli(["doctor", "--json"], loadDeps, io);
		expect(code).toBe(ExitCode.Ok);
		expect(JSON.parse(io.out.text)).toEqual(sampleReport);
		expect(calls.doctor).toBe(1);
	});

	test("--json before the command works too", async () => {
		const io = createFakeIo();
		const { loadDeps } = createFakeDeps();
		await runCli(["--json", "doctor"], loadDeps, io);
		expect(JSON.parse(io.out.text)).toEqual(sampleReport);
	});

	test("human output lists checks, fixes and a summary", async () => {
		const io = createFakeIo();
		const { loadDeps } = createFakeDeps();
		expect(await runCli(["doctor"], loadDeps, io)).toBe(ExitCode.Ok);
		expect(io.out.text).toContain("Docker reachable");
		expect(io.out.text).toContain("Update Docker Desktop");
		expect(io.out.text).toContain("1 ok · 1 warn · 0 fail");
	});

	test("a failing check exits 1", async () => {
		const io = createFakeIo();
		const { loadDeps } = createFakeDeps({ report: failingReport });
		expect(await runCli(["doctor", "--json"], loadDeps, io)).toBe(
			ExitCode.OpError,
		);
	});
});

describe("default action (dashboard)", () => {
	test("starts on the first free port from 4488, prints the URL, opens it and waits", async () => {
		const io = createFakeIo();
		const { loadDeps, calls } = createFakeDeps({ report: failingReport });
		expect(await runCli([], loadDeps, io)).toBe(ExitCode.Ok);
		expect(calls.dashboard).toEqual([
			"find",
			"port:4488",
			"start:4489",
			"open:http://127.0.0.1:4489/?t=tok",
			"wait",
			"stop",
		]);
		expect(io.out.text).toContain("http://127.0.0.1:4489/?t=tok");
		expect(io.out.text).toContain("0 ok · 0 warn · 1 fail");
		expect(io.out.text).toContain("Start Docker Desktop");
		expect(io.out.text).toContain("Dashboard stopped");
	});

	test("--port and --no-open are honoured", async () => {
		const io = createFakeIo();
		const { loadDeps, calls } = createFakeDeps();
		await runCli(["--port", "4599", "--no-open"], loadDeps, io);
		expect(calls.dashboard).toEqual(["find", "start:4599", "wait", "stop"]);
	});

	test("an invalid --port is a usage error", async () => {
		const io = createFakeIo();
		const { loadDeps, calls } = createFakeDeps();
		expect(await runCli(["--port", "80"], loadDeps, io)).toBe(ExitCode.Usage);
		expect(await runCli(["--port", "abc"], loadDeps, io)).toBe(ExitCode.Usage);
		expect(calls.dashboard).toEqual([]);
	});

	test("reuses a live dashboard and only opens the browser", async () => {
		const io = createFakeIo();
		const { loadDeps, calls } = createFakeDeps({
			running: { pid: 42, port: 4488, url: "http://127.0.0.1:4488/?t=old" },
		});
		expect(await runCli([], loadDeps, io)).toBe(ExitCode.Ok);
		expect(calls.dashboard).toEqual([
			"find",
			"open:http://127.0.0.1:4488/?t=old",
		]);
		expect(io.out.text).toContain("already running (pid 42)");
	});

	test("--project registers an existing folder and preselects it", async () => {
		const io = createFakeIo({ cwd: "/work" });
		const { loadDeps, calls } = createFakeDeps({
			stackFiles: {
				"/work/acme": "version: 1\nname: acme\nservices: {}\n",
			},
		});
		await runCli(["--project", "acme", "--no-open"], loadDeps, io);
		expect(calls.projects).toEqual([
			{ op: "register", name: "acme", root: "/work/acme" },
		]);
		expect(io.out.text).toContain("/?t=tok&project=acme");
	});

	test("--project creates locastack.yaml in a folder without one", async () => {
		const io = createFakeIo({ cwd: "/work" });
		const { loadDeps, calls } = createFakeDeps({
			running: { pid: 42, port: 4488, url: "http://127.0.0.1:4488/?t=old" },
		});
		await runCli(["--project", "/tmp/My App", "--json"], loadDeps, io);
		expect(calls.projects).toEqual([
			{ op: "create", name: "my-app", root: "/tmp/My App" },
		]);
		const line = JSON.parse(io.out.text);
		expect(line.dashboard).toEqual({
			url: "http://127.0.0.1:4488/?t=old&project=my-app",
			port: 4488,
			reused: true,
		});
		expect(calls.dashboard).toContain(
			"open:http://127.0.0.1:4488/?t=old&project=my-app",
		);
	});

	test("--json prints one machine-readable line with the URL", async () => {
		const io = createFakeIo();
		const { loadDeps } = createFakeDeps();
		expect(await runCli(["--json", "--no-open"], loadDeps, io)).toBe(
			ExitCode.Ok,
		);
		const parsed = JSON.parse(io.out.text);
		expect(parsed.dashboard).toEqual({
			url: "http://127.0.0.1:4489/?t=tok",
			port: 4489,
			reused: false,
		});
		expect(parsed.doctor).toEqual(sampleReport);
	});

	test("a start failure exits 1 with the reason", async () => {
		const io = createFakeIo();
		const { loadDeps } = createFakeDeps({ startFails: true });
		expect(await runCli(["--no-open"], loadDeps, io)).toBe(ExitCode.OpError);
		expect(io.errOut.text).toContain("EADDRINUSE");
	});

	test("extra positional arguments are a usage error", async () => {
		const io = createFakeIo();
		const { loadDeps } = createFakeDeps();
		expect(await runCli(["a", "b"], loadDeps, io)).toBe(ExitCode.Usage);
	});
});

describe("up", () => {
	test("discovers from cwd and streams progress", async () => {
		const io = createFakeIo();
		const { loadDeps, calls } = createFakeDeps();
		expect(await runCli(["up"], loadDeps, io)).toBe(ExitCode.Ok);
		expect(calls.discover).toEqual([{ cwd: "/work/acme" }]);
		expect(calls.up[0]?.services).toBeUndefined();
		expect(io.out.text).toContain("Starting stack acme");
		expect(io.out.text).toContain("Stack acme is up");
	});

	test("--service is forwarded and --global no longer exists", async () => {
		const io = createFakeIo();
		const { loadDeps, calls } = createFakeDeps();
		await runCli(["up", "--service", "main-db", "cache"], loadDeps, io);
		expect(calls.up[0]?.services).toEqual(["main-db", "cache"]);
		expect(await runCli(["up", "--global"], loadDeps, io)).toBe(ExitCode.Usage);
	});

	test("--json emits NDJSON progress events", async () => {
		const io = createFakeIo();
		const { loadDeps } = createFakeDeps();
		await runCli(["up", "--json"], loadDeps, io);
		const lines = io.out.text
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(lines.map((l: Progress) => l.kind)).toEqual(["step", "log", "done"]);
	});

	test("an error event exits 1", async () => {
		const io = createFakeIo();
		const { loadDeps } = createFakeDeps({
			events: [
				{ kind: "step", message: "Starting" },
				{ kind: "error", message: "port 5432 is taken" },
			],
		});
		expect(await runCli(["up"], loadDeps, io)).toBe(ExitCode.OpError);
		expect(io.errOut.text).toContain("port 5432 is taken");
	});

	test("a missing stack exits 1 with a JSON error under --json", async () => {
		const io = createFakeIo();
		const { loadDeps, calls } = createFakeDeps({ noStack: true });
		expect(await runCli(["up", "--json"], loadDeps, io)).toBe(ExitCode.OpError);
		expect(JSON.parse(io.out.text)).toEqual({
			ok: false,
			error: {
				code: "STACK_NOT_FOUND",
				message: "No locastack.yaml found",
				details: { cwd: "/work/acme" },
			},
		});
		expect(calls.up).toHaveLength(0);
	});
});

describe("down", () => {
	test("stops without touching volumes by default", async () => {
		const io = createFakeIo();
		const { loadDeps, calls } = createFakeDeps();
		expect(await runCli(["down"], loadDeps, io)).toBe(ExitCode.Ok);
		expect(calls.down).toEqual([
			{ stack: expect.objectContaining({ name: "acme" }), volumes: false },
		]);
	});

	test("--volumes without --yes in a non-TTY is a usage error", async () => {
		const io = createFakeIo({ isTTY: false });
		const { loadDeps, calls } = createFakeDeps();
		expect(await runCli(["down", "--volumes"], loadDeps, io)).toBe(
			ExitCode.Usage,
		);
		expect(io.errOut.text).toContain("--yes");
		expect(calls.down).toHaveLength(0);
		expect(io.questions).toHaveLength(0);
	});

	test("--volumes without --yes under --json is a usage error even in a TTY", async () => {
		const io = createFakeIo({ isTTY: true, confirm: true });
		const { loadDeps, calls } = createFakeDeps();
		expect(await runCli(["down", "--volumes", "--json"], loadDeps, io)).toBe(
			ExitCode.Usage,
		);
		expect(JSON.parse(io.out.text).error.code).toBe("USAGE");
		expect(calls.down).toHaveLength(0);
	});

	test("--volumes --yes skips the prompt", async () => {
		const io = createFakeIo({ isTTY: false });
		const { loadDeps, calls } = createFakeDeps();
		expect(await runCli(["down", "--volumes", "--yes"], loadDeps, io)).toBe(
			ExitCode.Ok,
		);
		expect(calls.down[0]?.volumes).toBe(true);
		expect(io.questions).toHaveLength(0);
	});

	test("--volumes in a TTY asks and aborts on no", async () => {
		const io = createFakeIo({ isTTY: true, confirm: false });
		const { loadDeps, calls } = createFakeDeps();
		expect(await runCli(["down", "--volumes"], loadDeps, io)).toBe(
			ExitCode.OpError,
		);
		expect(io.questions[0]).toContain("acme");
		expect(calls.down).toHaveLength(0);
	});

	test("--volumes in a TTY proceeds on yes", async () => {
		const io = createFakeIo({ isTTY: true, confirm: true });
		const { loadDeps, calls } = createFakeDeps();
		expect(await runCli(["down", "--volumes"], loadDeps, io)).toBe(ExitCode.Ok);
		expect(calls.down[0]?.volumes).toBe(true);
	});
});

describe("env", () => {
	test("defaults to dotenv", async () => {
		const io = createFakeIo();
		const { loadDeps, calls } = createFakeDeps();
		expect(await runCli(["env"], loadDeps, io)).toBe(ExitCode.Ok);
		expect(calls.env).toEqual(["dotenv"]);
		expect(io.out.text).toBe("DATABASE_URL=postgres://x\n");
	});

	test("--json implies the json format", async () => {
		const io = createFakeIo();
		const { loadDeps, calls } = createFakeDeps();
		await runCli(["env", "--json"], loadDeps, io);
		expect(calls.env).toEqual(["json"]);
		expect(JSON.parse(io.out.text)).toEqual({ DATABASE_URL: "postgres://x" });
	});

	test("an explicit --format wins over --json", async () => {
		const io = createFakeIo();
		const { loadDeps, calls } = createFakeDeps();
		await runCli(["env", "--format", "shell", "--json"], loadDeps, io);
		expect(calls.env).toEqual(["shell"]);
	});

	test("an invalid --format is a usage error", async () => {
		const io = createFakeIo();
		const { loadDeps, calls } = createFakeDeps();
		expect(await runCli(["env", "--format", "yaml"], loadDeps, io)).toBe(
			ExitCode.Usage,
		);
		expect(calls.env).toHaveLength(0);
	});

	test("an op error exits 1", async () => {
		const io = createFakeIo();
		const { loadDeps } = createFakeDeps({ envFails: true });
		expect(await runCli(["env"], loadDeps, io)).toBe(ExitCode.OpError);
		expect(io.errOut.text).toContain("cannot read secrets");
	});
});
