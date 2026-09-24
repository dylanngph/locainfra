import { defineConfig } from "@playwright/test";
import { E2E_PORT } from "./e2e/support/env.ts";

/**
 * Live end-to-end smoke against real Docker. Skipped unless `LOCASTACK_E2E=1`
 * (see the package README). `LOCASTACK_E2E_CHANNEL=chrome` uses the installed
 * Google Chrome instead of Playwright's bundled Chromium.
 */
export default defineConfig({
	testDir: "e2e",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 15 * 60_000,
	expect: { timeout: 30_000 },
	reporter: [["list"]],
	globalSetup: "./e2e/support/global-setup.ts",
	use: {
		baseURL: `http://127.0.0.1:${E2E_PORT}`,
		viewport: { width: 1280, height: 800 },
		...(process.env.LOCASTACK_E2E_CHANNEL
			? { channel: process.env.LOCASTACK_E2E_CHANNEL }
			: {}),
		trace: "retain-on-failure",
	},
});
