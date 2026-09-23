import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forceCleanup } from "./docker.ts";
import {
	E2E_ENABLED,
	E2E_PORT,
	E2E_PROJECTS,
	E2E_SCRATCH_ENV,
	E2E_TOKEN,
	REPO_ROOT,
} from "./env.ts";

/**
 * Starts the dashboard for the live smoke: the compiled binary
 * (`dist/locainfra`, or `LOCAINFRA_E2E_BIN`) when present, else the CLI from
 * source (which serves `packages/dashboard/dist`). `LOCAINFRA_HOME` points at
 * a scratch folder (`LOCAINFRA_E2E_SCRATCH` or a new temp dir), so the
 * user's `~/.locainfra` is never touched. Returns the teardown.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
	if (!E2E_ENABLED) return async () => {};
	const scratch =
		process.env[E2E_SCRATCH_ENV] ??
		(await mkdtemp(join(tmpdir(), "locainfra-e2e-")));
	await rm(scratch, { recursive: true, force: true });
	await mkdir(join(scratch, "home"), { recursive: true });
	process.env[E2E_SCRATCH_ENV] = scratch;

	const bin =
		process.env.LOCAINFRA_E2E_BIN ?? join(REPO_ROOT, "dist/locainfra");
	const command = existsSync(bin)
		? [bin]
		: ["bun", join(REPO_ROOT, "packages/cli/src/index.ts")];
	const server: ChildProcess = spawn(
		command[0] as string,
		[...command.slice(1), "--no-open", "--port", String(E2E_PORT)],
		{
			cwd: scratch,
			env: {
				...process.env,
				LOCAINFRA_HOME: join(scratch, "home"),
				LOCAINFRA_SESSION_TOKEN: E2E_TOKEN,
				NO_COLOR: "1",
			},
			stdio: ["ignore", "inherit", "inherit"],
		},
	);
	const deadline = Date.now() + 30_000;
	for (;;) {
		try {
			const res = await fetch(`http://127.0.0.1:${E2E_PORT}/api/health`);
			if (res.ok) break;
		} catch {
			// not listening yet
		}
		if (server.exitCode !== null || Date.now() > deadline) {
			server.kill("SIGTERM");
			throw new Error(`The e2e dashboard did not start (${command.join(" ")})`);
		}
		await new Promise((r) => setTimeout(r, 250));
	}

	return async () => {
		server.kill("SIGINT");
		await new Promise((r) => setTimeout(r, 500));
		for (const project of E2E_PROJECTS) forceCleanup(project);
	};
}
