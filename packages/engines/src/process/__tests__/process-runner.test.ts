import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandStep } from "@locastack/core";
import { BunProcessRunner, PROCESS_OUTPUT_MAX_BYTES } from "../process-runner";

function step(argv: string[], extra: Partial<CommandStep> = {}): CommandStep {
	return { id: "test.step", title: "Test step", argv, ...extra };
}

const runner = new BunProcessRunner({ killGraceMs: 200 });

describe("BunProcessRunner", () => {
	test("runs argv verbatim with no shell and captures output", async () => {
		const result = await runner.run(
			step(["/bin/echo", "hello", "$(whoami)", "*"]),
			{ attached: false },
		);
		expect(result).toEqual({
			exitCode: 0,
			timedOut: false,
			output: "hello $(whoami) *\n",
		});
	});

	test("interleaves stderr into the captured output", async () => {
		const result = await runner.run(
			step(["/bin/sh", "-c", "echo out; echo err 1>&2; exit 3"]),
			{ attached: false },
		);
		expect(result.exitCode).toBe(3);
		expect(result.timedOut).toBe(false);
		expect(result.output).toContain("out\n");
		expect(result.output).toContain("err\n");
	});

	test("a failing command resolves with its exit code", async () => {
		const result = await runner.run(step(["/usr/bin/false"]), {
			attached: false,
		});
		expect(result.exitCode).toBe(1);
		expect(result.timedOut).toBe(false);
	});

	test("a missing binary reports 127 instead of rejecting", async () => {
		const result = await runner.run(
			step(["locastack-definitely-missing-binary"]),
			{ attached: false },
		);
		expect(result.exitCode).toBe(127);
		expect(result.output).toContain("locastack-definitely-missing-binary");
	});

	test("the deadline kills the child and reports timedOut", async () => {
		const started = performance.now();
		const result = await runner.run(step(["/bin/sleep", "10"]), {
			attached: false,
			timeoutMs: 100,
		});
		expect(result).toMatchObject({ exitCode: -1, timedOut: true });
		expect(performance.now() - started).toBeLessThan(3_000);
	});

	test("step.timeoutMs applies when the options give none", async () => {
		const result = await runner.run(
			step(["/bin/sleep", "10"], { timeoutMs: 100 }),
			{ attached: false },
		);
		expect(result.timedOut).toBe(true);
	});

	test("SIGKILL follows when SIGTERM is ignored", async () => {
		const started = performance.now();
		const result = await runner.run(
			step(["/bin/sh", "-c", "trap '' TERM; sleep 10 & wait; sleep 10"]),
			{ attached: false, timeoutMs: 100 },
		);
		expect(result).toMatchObject({ exitCode: -1, timedOut: true });
		expect(performance.now() - started).toBeLessThan(3_000);
	});

	test("abort kills the child", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 100);
		const result = await runner.run(step(["/bin/sleep", "10"]), {
			attached: false,
			signal: controller.signal,
		});
		expect(result).toMatchObject({ exitCode: -1, timedOut: false });
	});

	test("an already aborted signal spawns nothing", async () => {
		const result = await runner.run(step(["/bin/sleep", "10"]), {
			attached: false,
			signal: AbortSignal.abort(),
		});
		expect(result).toEqual({ exitCode: -1, timedOut: false, output: "" });
	});

	test("merges step.env over the base environment and honours cwd", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ls-runner-"));
		try {
			const custom = new BunProcessRunner({
				env: { BASE: "base", PATH: "/usr/bin:/bin" },
			});
			const result = await custom.run(
				step(["/bin/sh", "-c", 'echo "$BASE $EXTRA $(pwd -P)"'], {
					env: { EXTRA: "extra" },
					cwd: dir,
				}),
				{ attached: false },
			);
			const real = await realpath(dir);
			expect(result.output).toBe(`base extra ${real}\n`);
			const override = await custom.run(
				step(["/bin/pwd"], { cwd: "/nonexistent" }),
				{ attached: false, cwd: dir },
			);
			expect(override.output?.trim()).toBe(real);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("prependPath: later steps find binaries in the new folders", async () => {
		const dir = await mkdtemp(join(tmpdir(), "locastack-path-"));
		try {
			const bin = join(dir, "bin");
			await Bun.write(join(bin, "zz-fresh-brew"), "#!/bin/sh\necho fresh\n");
			await Bun.spawn(["chmod", "755", join(bin, "zz-fresh-brew")]).exited;
			const env: Record<string, string | undefined> = { PATH: "/usr/bin:/bin" };
			const custom = new BunProcessRunner({ env });
			const before = await custom.run(step(["zz-fresh-brew"]), {
				attached: false,
			});
			expect(before.exitCode).toBe(127);
			custom.prependPath([bin, "/usr/bin"]);
			custom.prependPath([bin]);
			expect(env.PATH).toBe(`${bin}:/usr/bin:/bin`);
			const after = await custom.run(step(["zz-fresh-brew"]), {
				attached: false,
			});
			expect(after.exitCode).toBe(0);
			expect(after.output).toContain("fresh");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("keeps only the last 64 KiB of output", async () => {
		const result = await runner.run(
			step([
				"/bin/sh",
				"-c",
				"head -c 200000 /dev/zero | tr '\\0' a; printf END",
			]),
			{ attached: false },
		);
		expect(result.exitCode).toBe(0);
		expect(new TextEncoder().encode(result.output).length).toBe(
			PROCESS_OUTPUT_MAX_BYTES,
		);
		expect(result.output?.endsWith("aEND")).toBe(true);
	});

	test("attached steps inherit stdio and return no output", async () => {
		const result = await runner.run(step(["/usr/bin/true"]), {
			attached: true,
		});
		expect(result).toEqual({ exitCode: 0, timedOut: false, output: undefined });
	});

	test("never adds sudo: argv runs exactly as planned", async () => {
		const result = await runner.run(
			step(["/bin/echo", "sudo-free"], { sudo: true }),
			{ attached: false },
		);
		expect(result.output).toBe("sudo-free\n");
	});

	test("creates the private folder of a download step's script", async () => {
		const root = await mkdtemp(join(tmpdir(), "ls-runner-"));
		const folder = join(root, "locastack-setup-x");
		const path = join(folder, "get-docker.sh");
		try {
			const result = await runner.run(
				step(["/bin/sh", "-c", `echo ok > "${path}"`], {
					remoteScript: {
						url: "https://get.docker.com",
						path,
						inspectHint: `less ${path}`,
					},
				}),
				{ attached: false },
			);
			expect(result.exitCode).toBe(0);
			expect((await stat(folder)).mode & 0o777).toBe(0o700);
			expect(await Bun.file(path).text()).toBe("ok\n");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("does not hang when a forked grandchild keeps the pipe open", async () => {
		const started = performance.now();
		const result = await runner.run(
			step(["/bin/sh", "-c", "(sleep 3 &) ; echo started"]),
			{ attached: false },
		);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("started");
		expect(performance.now() - started).toBeLessThan(2_500);
	});
});
