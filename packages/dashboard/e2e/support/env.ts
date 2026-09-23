import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Dashboard port used by the e2e server (never 4488, so a real dashboard can
 * keep running). `LOCAINFRA_E2E_PORT` overrides the default 4598.
 */
export const E2E_PORT = Number(process.env.LOCAINFRA_E2E_PORT ?? 4598);

/** Fixed session token passed through `LOCAINFRA_SESSION_TOKEN`. */
export const E2E_TOKEN = "locainfra-e2e-session-token";

/** Project the M2 smoke creates (containers `li-m2-smoke-*`). */
export const E2E_PROJECT = "m2-smoke";

/** Project the M3a smoke creates (containers `li-m3a-smoke-*`). */
export const M3A_PROJECT = "m3a-smoke";

/** Project the M3b smoke imports (containers `li-m3b-smoke-*`). */
export const M3B_PROJECT = "m3b-smoke";

/** Every project a smoke may leave behind; the global teardown cleans them all. */
export const E2E_PROJECTS = [E2E_PROJECT, M3A_PROJECT, M3B_PROJECT] as const;

/** Whether the live suite is enabled. */
export const E2E_ENABLED = process.env.LOCAINFRA_E2E === "1";

/** Repository root. */
export const REPO_ROOT = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../..",
);

/** Where smoke screenshots go (git-ignored). */
export const SCREENSHOT_DIR = join(
	REPO_ROOT,
	"packages/dashboard/e2e/.screenshots/m2",
);

/** Screenshots of the M3a smoke (git-ignored). */
export const M3A_SCREENSHOT_DIR = join(
	REPO_ROOT,
	"packages/dashboard/e2e/.screenshots/m3a",
);

/** Screenshots of the M3b smoke (git-ignored). */
export const M3B_SCREENSHOT_DIR = join(
	REPO_ROOT,
	"packages/dashboard/e2e/.screenshots/m3b",
);

/** Env var the global setup uses to hand the scratch folder to the tests. */
export const E2E_SCRATCH_ENV = "LOCAINFRA_E2E_SCRATCH";
