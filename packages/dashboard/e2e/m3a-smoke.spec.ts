import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test, type WebSocket } from "@playwright/test";
import { docker, leftovers } from "./support/docker.ts";
import {
	E2E_ENABLED,
	E2E_PORT,
	E2E_SCRATCH_ENV,
	E2E_TOKEN,
	M3A_PROJECT,
	M3A_SCREENSHOT_DIR,
	REPO_ROOT,
} from "./support/env.ts";

/** Image pulls on a cold machine can take minutes. */
const UP_TIMEOUT = 5 * 60_000;
const PROJECT = M3A_PROJECT;

interface ServiceRow {
	readonly name: string;
	readonly hostPort: number;
	readonly state: string;
}

async function api(method: string, path: string): Promise<Response> {
	return fetch(`http://127.0.0.1:${E2E_PORT}${path}`, {
		method,
		headers: { "x-locastack-token": E2E_TOKEN },
	});
}

async function services(): Promise<ServiceRow[]> {
	const res = await api("GET", `/api/projects/${PROJECT}/services`);
	expect(res.status).toBe(200);
	return (await res.json()) as ServiceRow[];
}

async function service(name: string): Promise<ServiceRow> {
	const found = (await services()).find((s) => s.name === name);
	if (!found) throw new Error(`no service ${name}`);
	return found;
}

async function shot(page: Page, name: string): Promise<void> {
	await expect(page.getByText(/^Docker \d/)).toBeVisible();
	mkdirSync(M3A_SCREENSHOT_DIR, { recursive: true });
	await page.screenshot({ path: join(M3A_SCREENSHOT_DIR, `${name}.png`) });
}

const detailHeader = (page: Page, name: string) =>
	page.getByRole("heading", { name, level: 1 }).locator("..");

const overviewRow = (page: Page, name: string) =>
	page.getByRole("row").filter({ has: page.getByRole("link", { name }) });

const liveSwitch = (page: Page) => page.getByRole("switch", { name: "Live" });

/** The CLI under test: the compiled binary when built, else the source entry. */
function cli(): string[] {
	const bin =
		process.env.LOCASTACK_E2E_BIN ?? join(REPO_ROOT, "dist/locastack");
	return existsSync(bin)
		? [bin]
		: ["bun", join(REPO_ROOT, "packages/cli/src/index.ts")];
}

async function addFromCatalog(
	page: Page,
	card: string,
	name: string,
): Promise<void> {
	await page.goto(`/p/${PROJECT}/add/${card}`);
	const nameInput = page.getByLabel("Name", { exact: true });
	await expect(nameInput).toBeVisible();
	await nameInput.fill(name);
	await page.getByLabel("Host port").fill("auto");
	await page.getByRole("button", { name: "Add & start" }).click();
	await expect(page).toHaveURL(new RegExp(`/p/${PROJECT}/s/${name}`));
	await expect(detailHeader(page, name).getByText("Running")).toBeVisible({
		timeout: UP_TIMEOUT,
	});
}

test.describe("M3a live smoke: load once, opt-in Live, remove, ⌘K (real Docker)", () => {
	test.skip(!E2E_ENABLED, "set LOCASTACK_E2E=1 to run against real Docker");

	test("no WebSocket until Live; Live streams; remove dialog; palette; SQLite state", async ({
		page,
	}) => {
		const scratch = process.env[E2E_SCRATCH_ENV];
		if (!scratch) throw new Error("global setup did not run");
		const root = join(scratch, PROJECT);
		const home = join(scratch, "home");
		const sockets: WebSocket[] = [];
		page.on("websocket", (ws) => sockets.push(ws));
		const openSockets = () => sockets.filter((ws) => !ws.isClosed()).length;

		await test.step("create a project and add Postgres + Redis without any WebSocket", async () => {
			await page.goto(`/?t=${E2E_TOKEN}`);
			await page.getByRole("button", { name: "New project" }).first().click();
			const form = page.getByRole("form", { name: "New project" });
			await form.getByLabel("Project name").fill(PROJECT);
			await form.getByLabel("Folder").fill(root);
			await form.getByRole("button", { name: "Create" }).click();
			await expect(page).toHaveURL(new RegExp(`/p/${PROJECT}$`));
			await expect(liveSwitch(page)).toHaveAttribute("aria-checked", "false");

			await addFromCatalog(page, "postgres", "main-db");
			expect((await service("main-db")).hostPort).toBe(5433);
			await addFromCatalog(page, "redis", "cache");
			expect((await service("cache")).hostPort).not.toBe(6379);
			// Op progress is followed over HTTP (NDJSON), never over /ws.
			expect(sockets).toHaveLength(0);
		});

		await test.step("Logs: a REST tail without Live, streaming only with Follow", async () => {
			await page.goto(`/p/${PROJECT}/s/main-db?tab=logs`);
			const log = page.getByRole("log");
			await expect(page.getByText("Last 200 lines")).toBeVisible();
			await expect(log).toContainText("ready to accept connections");
			await page.getByRole("tab", { name: "Metrics" }).click();
			const cpu = page.locator("section", { hasText: "CPU" }).first();
			await expect(cpu).toContainText(/\d+(\.\d+)?%/);
			await expect(cpu).toContainText("Turn on Live for charts");
			expect(sockets).toHaveLength(0);

			await page.getByRole("tab", { name: "Logs" }).click();
			await page.getByRole("switch", { name: "Follow" }).click();
			await expect(page.getByText("Streaming")).toBeVisible();
			await expect.poll(openSockets).toBe(1);
			await page.getByRole("switch", { name: "Follow" }).click();
			await expect.poll(openSockets, { timeout: 10_000 }).toBe(0);
		});

		const beforeLive = sockets.length;
		test.info().annotations.push({
			type: "ws upgrades before Live (Follow only)",
			description: String(beforeLive),
		});

		await test.step("Live on: status and stats stream; Docker changes show without Refresh", async () => {
			await page.goto(`/p/${PROJECT}`);
			await expect(
				overviewRow(page, "cache").getByText("Running"),
			).toBeVisible();
			expect(sockets.length).toBe(beforeLive);
			// Live off: no reading yet, so CPU/MEM read — instead of a made-up 0.
			await expect(overviewRow(page, "main-db")).toContainText("—");
			await expect(overviewRow(page, "main-db")).not.toContainText("0.0%");
			await liveSwitch(page).click();
			await expect(liveSwitch(page)).toHaveAttribute("aria-checked", "true");
			await expect.poll(openSockets).toBe(1);
			// Stats: running rows get a CPU figure.
			await expect(overviewRow(page, "main-db")).toContainText(/\d+(\.\d+)?%/, {
				timeout: 15_000,
			});
			// Status: a container stopped behind the dashboard's back.
			docker(["stop", `ls-${PROJECT}-cache`]);
			await expect(overviewRow(page, "cache").getByText("Stopped")).toBeVisible(
				{
					timeout: 30_000,
				},
			);
			docker(["start", `ls-${PROJECT}-cache`]);
			await expect(overviewRow(page, "cache").getByText("Running")).toBeVisible(
				{
					timeout: 60_000,
				},
			);
			await page.waitForTimeout(3_000);
			await shot(page, "live-on");
		});

		await test.step("Live off: the socket closes", async () => {
			await liveSwitch(page).click();
			await expect(liveSwitch(page)).toHaveAttribute("aria-checked", "false");
			await expect.poll(openSockets, { timeout: 10_000 }).toBe(0);
		});

		await test.step("Logs tab: Live switches Follow; Live off closes the socket; a reload starts with Live off", async () => {
			await page.goto(`/p/${PROJECT}/s/main-db?tab=logs`);
			const follow = page.getByRole("switch", { name: "Follow" });
			await expect(page.getByText("Last 200 lines")).toBeVisible();
			await expect(follow).toHaveAttribute("aria-checked", "false");
			await liveSwitch(page).click();
			await expect(follow).toHaveAttribute("aria-checked", "true");
			await expect(page.getByText("Streaming")).toBeVisible();
			await expect.poll(openSockets).toBe(1);
			await liveSwitch(page).click();
			await expect(follow).toHaveAttribute("aria-checked", "false");
			await expect.poll(openSockets, { timeout: 10_000 }).toBe(0);

			// Live on, then reload: a fresh load never auto-connects.
			await liveSwitch(page).click();
			await expect.poll(openSockets).toBe(1);
			const beforeReload = sockets.length;
			await page.reload();
			await expect(liveSwitch(page)).toHaveAttribute("aria-checked", "false");
			await expect(page.getByText("Last 200 lines")).toBeVisible();
			await page.waitForTimeout(1_500);
			// No socket was opened by the fresh load (the pre-reload one died with the page).
			expect(sockets.length).toBe(beforeReload);
			await page.goto(`/p/${PROJECT}`);
		});

		const afterLive = sockets.length;
		test.info().annotations.push({
			type: "ws upgrades after Live on/off",
			description: String(afterLive),
		});

		await test.step("remove cache through the dialog (typed name + delete volume)", async () => {
			const volumes = docker([
				"volume",
				"ls",
				"-q",
				"--filter",
				`label=locastack.stack=${PROJECT}`,
			]).filter((v) => v.includes("cache"));
			expect(volumes.length).toBeGreaterThan(0);
			await overviewRow(page, "cache")
				.getByRole("button", { name: "More actions for cache" })
				.click();
			await page.getByRole("menuitem", { name: /Remove service/ }).click();
			const dialog = page.getByRole("alertdialog");
			const confirm = dialog.getByRole("button", { name: "Remove service" });
			await expect(confirm).toBeDisabled();
			await dialog.getByLabel(/to confirm/).fill("cache");
			await dialog
				.getByRole("checkbox", {
					name: "Also delete its data volume and snapshots",
				})
				.click();
			await expect(confirm).toBeEnabled();
			await shot(page, "remove-dialog");
			await confirm.click();
			await expect
				.poll(async () => (await services()).map((s) => s.name), {
					timeout: 120_000,
				})
				.not.toContain("cache");
			await expect(overviewRow(page, "cache")).toHaveCount(0);
			await expect
				.poll(() => docker(["ps", "-a", "--format", "{{.Names}}"]))
				.not.toContain(`ls-${PROJECT}-cache`);
			const remaining = docker(["volume", "ls", "--format", "{{.Name}}"]);
			for (const v of volumes) expect(remaining).not.toContain(v);
			expect(sockets.length).toBe(afterLive);
		});

		await test.step("⌘K palette lists groups and navigates to a service", async () => {
			await page.keyboard.press("ControlOrMeta+k");
			const palette = page.getByRole("dialog");
			await expect(
				palette.getByPlaceholder("Type a service, project or command…"),
			).toBeVisible();
			for (const heading of ["Services", "Projects", "Actions"])
				await expect(palette.getByText(heading, { exact: true })).toBeVisible();
			// Let the open animation finish so the shot is not half-transparent.
			await page.waitForTimeout(500);
			await shot(page, "palette");
			await palette
				.getByPlaceholder("Type a service, project or command…")
				.fill("main-db");
			await page.keyboard.press("Enter");
			await expect(page).toHaveURL(new RegExp(`/p/${PROJECT}/s/main-db`));
			expect(sockets.length).toBe(afterLive);
		});

		await test.step("state lives in SQLite (0600) and the CLI still reads it", async () => {
			const db = join(home, "locastack.db");
			expect(existsSync(db)).toBe(true);
			expect(statSync(db).mode & 0o777).toBe(0o600);
			expect(existsSync(join(home, "state.json"))).toBe(false);
			const [command, ...args] = cli();
			const out = execFileSync(command as string, [...args, "env"], {
				cwd: root,
				encoding: "utf8",
				env: { ...process.env, LOCASTACK_HOME: home, NO_COLOR: "1" },
			});
			expect(out).toMatch(
				/DATABASE_URL=postgres:\/\/[^\s]+@127\.0\.0\.1:5433\//,
			);
		});

		await test.step("clean up: remove main-db with its volume; no li-* leftovers", async () => {
			const res = await api(
				"DELETE",
				`/api/projects/${PROJECT}/services/main-db?volumes=true`,
			);
			expect(res.status).toBe(202);
			await expect
				.poll(async () => (await services()).length, { timeout: 180_000 })
				.toBe(0);
			await expect
				.poll(() => leftovers(PROJECT), { timeout: 120_000 })
				.toEqual([]);
			expect((await api("DELETE", `/api/projects/${PROJECT}`)).status).toBe(
				200,
			);
		});
	});
});
