import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { docker, leftovers } from "./support/docker.ts";
import {
	E2E_ENABLED,
	E2E_PORT,
	E2E_PROJECT,
	E2E_SCRATCH_ENV,
	E2E_TOKEN,
	SCREENSHOT_DIR,
} from "./support/env.ts";

/** Image pulls on a cold machine can take minutes. */
const UP_TIMEOUT = 5 * 60_000;

interface ServiceRow {
	readonly name: string;
	readonly hostPort: number;
	readonly state: string;
}

async function api(
	method: string,
	path: string,
	body?: unknown,
): Promise<Response> {
	return fetch(`http://127.0.0.1:${E2E_PORT}${path}`, {
		method,
		headers: {
			"x-locastack-token": E2E_TOKEN,
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

async function services(): Promise<ServiceRow[]> {
	const res = await api("GET", `/api/projects/${E2E_PROJECT}/services`);
	expect(res.status).toBe(200);
	return (await res.json()) as ServiceRow[];
}

async function service(name: string): Promise<ServiceRow> {
	const found = (await services()).find((s) => s.name === name);
	if (!found) throw new Error(`no service ${name}`);
	return found;
}

async function shot(page: Page, name: string): Promise<void> {
	// The header's Docker status loads separately; wait for it so shots are settled.
	await expect(page.getByText(/^Docker \d/)).toBeVisible();
	await page.screenshot({ path: join(SCREENSHOT_DIR, `${name}.png`) });
}

/** Header of the service detail page (title + status pill). */
const detailHeader = (page: Page, name: string) =>
	page.getByRole("heading", { name, level: 1 }).locator("..");

const overviewRow = (page: Page, name: string) =>
	page.getByRole("row").filter({ has: page.getByRole("link", { name }) });

/**
 * Adds a service from the catalog through the Config form and waits until it
 * is Running on its detail page.
 */
async function addFromCatalog(
	page: Page,
	card: string,
	name: string,
	port?: string,
	screenshot?: { catalog: string; config: string },
): Promise<void> {
	await page.goto(`/p/${E2E_PROJECT}`);
	await page.getByRole("link", { name: "Add service" }).first().click();
	await expect(page).toHaveURL(new RegExp(`/p/${E2E_PROJECT}/add$`));
	await expect(page.getByLabel("Search services")).toBeVisible();
	if (screenshot) await shot(page, screenshot.catalog);
	await page.locator(`a[href="/p/${E2E_PROJECT}/add/${card}"]`).click();
	const nameInput = page.getByLabel("Name", { exact: true });
	await expect(nameInput).toBeVisible();
	await nameInput.fill(name);
	if (port !== undefined) await page.getByLabel("Host port").fill(port);
	if (screenshot) await shot(page, screenshot.config);
	await page.getByRole("button", { name: "Add & start" }).click();
	await expect(page).toHaveURL(new RegExp(`/p/${E2E_PROJECT}/s/${name}`));
	await expect(detailHeader(page, name).getByText("Running")).toBeVisible({
		timeout: UP_TIMEOUT,
	});
}

test.describe("M2 live smoke (real Docker)", () => {
	test.skip(!E2E_ENABLED, "set LOCASTACK_E2E=1 to run against real Docker");

	test("create a project, add named instances, connect, env, stop/start, remove", async ({
		page,
	}) => {
		const scratch = process.env[E2E_SCRATCH_ENV];
		if (!scratch) throw new Error("global setup did not run");
		const root = join(scratch, E2E_PROJECT);

		await test.step("open with the session token and create a project", async () => {
			await page.goto(`/?t=${E2E_TOKEN}`);
			await expect(page).toHaveURL(/\/$/);
			// Brand mark, not the prototype's rotated square; ⌘K opens the palette.
			await expect(
				page.getByRole("link", { name: "LocaStack" }).locator("svg"),
			).toBeVisible();
			await expect(
				page.getByRole("button", { name: /Search or add a service/ }),
			).toBeEnabled();
			await page.getByRole("button", { name: "New project" }).first().click();
			const form = page.getByRole("form", { name: "New project" });
			await form.getByLabel("Project name").fill(E2E_PROJECT);
			await form.getByLabel("Folder").fill(root);
			await form.getByRole("button", { name: "Create" }).click();
			await expect(page).toHaveURL(new RegExp(`/p/${E2E_PROJECT}$`));
			await expect(page.getByText("No services yet")).toBeVisible();
			expect(existsSync(join(root, "locastack.yaml"))).toBe(true);
		});

		await test.step("add Postgres main-db with port auto (lands on 5433, never 5432)", async () => {
			await addFromCatalog(page, "postgres", "main-db", "auto", {
				catalog: "catalog",
				config: "config",
			});
			const mainDb = await service("main-db");
			expect(mainDb.hostPort).toBe(5433);
			await expect(
				page.getByText("127.0.0.1:5433", { exact: true }),
			).toBeVisible();
			await expect(page.getByText(/localhost:/)).toHaveCount(0);
			// Running: no CLI equivalent, so no hint bar.
			await expect(page.getByText(/locastack up --service/)).toHaveCount(0);
		});

		await test.step("add Redis cache", async () => {
			await addFromCatalog(page, "redis", "cache");
			const cache = await service("cache");
			expect(cache.hostPort).not.toBe(6379);
		});

		await test.step("service detail: Connect, Logs, Metrics", async () => {
			await page.goto(`/p/${E2E_PROJECT}/s/main-db`);
			await expect(
				detailHeader(page, "main-db").getByText("Running"),
			).toBeVisible();
			await expect(page.getByText(/DATABASE_URL=/).first()).toBeVisible();
			await expect(
				page.getByText(/postgres:\/\/postgres:/).first(),
			).toBeVisible();
			await shot(page, "detail-connect");

			await page.getByRole("tab", { name: "Logs" }).click();
			const log = page.getByRole("log");
			await expect(log).toContainText("ready to accept connections");
			// Rows read `time LEVEL message`: the container's own UTC timestamp,
			// pid and `LOG:` prefix are stripped from the message.
			await expect(log).toContainText(
				/LOG\s*database system is ready to accept connections/,
			);
			await expect(log).not.toContainText(
				/UTC \[\d+\] LOG:\s+database system is ready/,
			);
			// Loaded once (last 200 lines); Follow streams.
			await expect(page.getByText("Last 200 lines")).toBeVisible();
			await page.getByRole("switch", { name: "Follow" }).click();
			await expect(page.getByText("Streaming")).toBeVisible();
			await shot(page, "detail-logs");

			await page.getByRole("tab", { name: "Metrics" }).click();
			const cpu = page.locator("section", { hasText: "CPU" }).first();
			const memory = page.locator("section", { hasText: "Memory" }).first();
			// Live off: one-shot numbers and a hint instead of charts.
			await expect(cpu).toContainText(/\d+(\.\d+)?%/);
			await expect(memory).toContainText(/\d+(\.\d+)?\s?(KB|MB|GB|B)/);
			await expect(cpu).toContainText("Turn on Live for charts");
			await expect(page.getByText("127.0.0.1:5433 → 5432")).toBeVisible();
			await page.getByRole("switch", { name: "Live" }).click();
			await expect(page.getByRole("img", { name: "CPU usage" })).toBeVisible();
			// Let a few samples accumulate so the bars show.
			await page.waitForTimeout(6_000);
			await shot(page, "detail-metrics");
		});

		await test.step("Environment: Write to ./.env creates the file in the project root", async () => {
			await page.goto(`/p/${E2E_PROJECT}/env`);
			const preview = page.getByTestId("env-preview");
			await expect(preview).toContainText("DATABASE_URL=");
			await expect(preview).toContainText("# main-db (postgres)");
			await expect(preview).toContainText("# cache (redis)");
			await shot(page, "env");
			await page.getByRole("button", { name: "Write to ./.env" }).click();
			await expect
				.poll(() => existsSync(join(root, ".env")), { timeout: 10_000 })
				.toBe(true);
			const written = readFileSync(join(root, ".env"), "utf8");
			expect(written).toContain("# locastack:start");
			expect(written).toMatch(
				/DATABASE_URL=postgres:\/\/postgres:[^•\s]+@127\.0\.0\.1:5433\//,
			);
		});

		await test.step("overview: Stop then Start main-db", async () => {
			await page.goto(`/p/${E2E_PROJECT}`);
			const row = overviewRow(page, "main-db");
			await expect(row.getByText("Running")).toBeVisible();
			await row
				.getByRole("button", { name: "Stop main-db", exact: true })
				.click();
			await expect(row.getByText("Stopped")).toBeVisible({ timeout: 60_000 });
			await expect
				.poll(async () => (await service("main-db")).state)
				.toBe("stopped");
			await row
				.getByRole("button", { name: "Start main-db", exact: true })
				.click();
			await expect(row.getByText("Running")).toBeVisible({
				timeout: UP_TIMEOUT,
			});
		});

		await test.step("a second Postgres instance (events) proves named instances", async () => {
			await addFromCatalog(page, "postgres", "events", "auto");
			const events = await service("events");
			expect(events.hostPort).toBe(5434);
			await page.goto(`/p/${E2E_PROJECT}`);
			for (const name of ["main-db", "cache", "events"])
				await expect(
					overviewRow(page, name).getByText("Running"),
				).toBeVisible();
			await expect(page.getByText("3 of 3 running")).toBeVisible();
			await page.waitForTimeout(3_000);
			await shot(page, "overview");
			await page.goto("/");
			await expect(
				page.getByRole("article", { name: E2E_PROJECT }),
			).toBeVisible();
			await page.waitForTimeout(3_000);
			await shot(page, "projects");
		});

		await test.step("an ephemeral instance leaves no anonymous volume behind", async () => {
			await page.goto(`/p/${E2E_PROJECT}/add/redis`);
			await page.getByLabel("Name", { exact: true }).fill("scratch");
			await page.getByRole("button", { name: "Ephemeral" }).click();
			await page.getByRole("button", { name: "Add & start" }).click();
			await expect(
				detailHeader(page, "scratch").getByText("Running"),
			).toBeVisible({ timeout: UP_TIMEOUT });
			const anonymous = docker([
				"inspect",
				"--format",
				'{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}\n{{end}}{{end}}',
				`ls-${E2E_PROJECT}-scratch`,
			]);
			expect(anonymous.length).toBeGreaterThan(0);
			expect(anonymous.every((v) => !v.startsWith("ls-"))).toBe(true);
			// Remove through the UI: typed confirmation, then back to the overview.
			await page.getByRole("button", { name: "Remove", exact: true }).click();
			const dialog = page.getByRole("alertdialog");
			const confirm = dialog.getByRole("button", { name: "Remove service" });
			await expect(confirm).toBeDisabled();
			await dialog.getByLabel(/to confirm/).fill("scratch");
			await confirm.click();
			await expect(page).toHaveURL(new RegExp(`/p/${E2E_PROJECT}$`));
			await expect
				.poll(async () => (await services()).map((s) => s.name), {
					timeout: 120_000,
				})
				.not.toContain("scratch");
			const volumes = docker(["volume", "ls", "--format", "{{.Name}}"]);
			for (const v of anonymous) expect(volumes).not.toContain(v);
		});

		await test.step("remove every instance with its volumes; Docker keeps no li-* leftovers", async () => {
			// Sent together on purpose: the server serializes ops per project,
			// so the last removal still sees itself as last and drops ls-<project>.
			const responses = await Promise.all(
				["events", "cache", "main-db"].map((name) =>
					api(
						"DELETE",
						`/api/projects/${E2E_PROJECT}/services/${name}?volumes=true`,
					),
				),
			);
			expect(responses.map((r) => r.status)).toEqual([202, 202, 202]);
			await expect
				.poll(async () => (await services()).length, { timeout: 180_000 })
				.toBe(0);
			await expect
				.poll(() => leftovers(E2E_PROJECT), { timeout: 120_000 })
				.toEqual([]);
			expect((await api("DELETE", `/api/projects/${E2E_PROJECT}`)).status).toBe(
				200,
			);
		});
	});
});
