import { describe, expect, test } from "bun:test";
import type { DoctorReport, Progress } from "@locainfra/core";
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

describe("default action", () => {
	test("prints the M2 placeholder and the doctor summary, exit 0", async () => {
		const io = createFakeIo();
		const { loadDeps } = createFakeDeps({ report: failingReport });
		expect(await runCli([], loadDeps, io)).toBe(ExitCode.Ok);
		expect(io.out.text).toContain("Dashboard coming in M2");
		expect(io.out.text).toContain("0 ok · 0 warn · 1 fail");
		expect(io.out.text).toContain("Start Docker Desktop");
	});

	test("--json prints a machine-readable placeholder", async () => {
		const io = createFakeIo();
		const { loadDeps } = createFakeDeps();
		expect(await runCli(["--json"], loadDeps, io)).toBe(ExitCode.Ok);
		const parsed = JSON.parse(io.out.text);
		expect(parsed.dashboard.available).toBe(false);
		expect(parsed.doctor).toEqual(sampleReport);
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
		expect(calls.discover).toEqual([{ cwd: "/work/acme", global: false }]);
		expect(calls.up[0]?.services).toBeUndefined();
		expect(io.out.text).toContain("Starting stack acme");
		expect(io.out.text).toContain("Stack acme is up");
	});

	test("--global and --service are forwarded", async () => {
		const io = createFakeIo();
		const { loadDeps, calls } = createFakeDeps();
		await runCli(
			["up", "--global", "--service", "postgres", "redis"],
			loadDeps,
			io,
		);
		expect(calls.discover[0]?.global).toBe(true);
		expect(calls.up[0]?.services).toEqual(["postgres", "redis"]);
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
				message: "No locainfra.yaml found",
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
