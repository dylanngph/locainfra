import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { helperContainers, leftovers } from "./support/docker.ts";
import {
	E2E_ENABLED,
	E2E_PORT,
	E2E_SCRATCH_ENV,
	E2E_TOKEN,
	M3B_PROJECT,
	M3B_SCREENSHOT_DIR,
} from "./support/env.ts";

/** Image pulls on a cold machine can take minutes. */
const UP_TIMEOUT = 5 * 60_000;
const PROJECT = M3B_PROJECT;
/** Host ports of a separately run stack on this machine: never bound here. */
const RESERVED_PORTS = [5432, 6379, 8079];

/** The Import modal's "Use sample file" compose, pasted as text. */
const SAMPLE_COMPOSE = `services:
  web:
    build: .
    ports:
      - "3000:3000"
  db:
    image: postgres:16
    environment:
      POSTGRES_DB: shop
      POSTGRES_USER: app
      POSTGRES_PASSWORD: secret
    ports:
      - "5432:5432"
  cache:
    image: redis:7.4
    ports:
      - "6379:6379"
  storage:
    image: minio/minio:latest
    environment:
      MINIO_ROOT_USER: minio
      MINIO_ROOT_PASSWORD: minio123
    ports:
      - "9000:9000"
  mailhog:
    image: mailhog/mailhog
    ports:
      - "8025:8025"`;

const SEED_SQL = `CREATE TABLE seeded_items (id int PRIMARY KEY, label text);
INSERT INTO seeded_items VALUES (1, 'alpha'), (2, 'beta');
`;

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
			"x-locainfra-token": E2E_TOKEN,
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

async function services(): Promise<ServiceRow[]> {
	const res = await api("GET", `/api/projects/${PROJECT}/services`);
	if (res.status === 404) return [];
	expect(res.status).toBe(200);
	return (await res.json()) as ServiceRow[];
}

async function states(): Promise<Record<string, string>> {
	return Object.fromEntries((await services()).map((s) => [s.name, s.state]));
}

/** Table names the Data tab lists for `name` (`null` while it is not running). */
async function tables(name: string): Promise<string[] | null> {
	const res = await api(
		"GET",
		`/api/projects/${PROJECT}/services/${name}/data`,
	);
	if (res.status !== 200) return null;
	const body = (await res.json()) as { objects: { name: string }[] };
	return body.objects.map((o) => o.name);
}

async function connectionUrl(name: string): Promise<string> {
	const res = await api(
		"GET",
		`/api/projects/${PROJECT}/services/${name}/connection?reveal=true`,
	);
	expect(res.status).toBe(200);
	return ((await res.json()) as { primary: { value: string } }).primary.value;
}

async function shot(page: Page, name: string): Promise<void> {
	await expect(page.getByText(/^Docker \d/)).toBeVisible();
	mkdirSync(M3B_SCREENSHOT_DIR, { recursive: true });
	await page.screenshot({ path: join(M3B_SCREENSHOT_DIR, `${name}.png`) });
}

const detailHeader = (page: Page, name: string) =>
	page.getByRole("heading", { name, level: 1 }).locator("..");

const queryBox = (page: Page) =>
	page.getByRole("textbox", { name: "Query", exact: true });

const runButton = (page: Page) => page.getByRole("button", { name: /^Run/ });

/** Snapshot rows in SQLite, through the `sqlite3` CLI when it is installed. */
function sqliteSnapshotRows(db: string): number | undefined {
	try {
		const out = execFileSync(
			"sqlite3",
			[db, `SELECT count(*) FROM snapshots WHERE project = '${PROJECT}'`],
			{ encoding: "utf8" },
		);
		return Number(out.trim());
	} catch {
		return undefined;
	}
}

function archives(home: string, service: string): string[] {
	const dir = join(home, "snapshots", PROJECT, service);
	return existsSync(dir)
		? readdirSync(dir).filter((f) => f.endsWith(".tgz"))
		: [];
}

test.describe("M3b live smoke: import, Data, Snapshots, seed, rotate (real Docker)", () => {
	test.skip(!E2E_ENABLED, "set LOCAINFRA_E2E=1 to run against real Docker");

	test("import → query → snapshot/restore → seed → rotate → clean up", async ({
		page,
	}) => {
		const scratch = process.env[E2E_SCRATCH_ENV];
		if (!scratch) throw new Error("global setup did not run");
		const root = join(scratch, PROJECT);
		const home = join(scratch, "home");

		await test.step("import the sample compose (pasted): preview, remapped ports, start", async () => {
			await page.goto(`/?t=${E2E_TOKEN}`);
			await page
				.getByRole("button", { name: "Import docker-compose.yml" })
				.click();
			const dialog = page.getByRole("dialog");
			await dialog.getByLabel("Compose YAML").fill(SAMPLE_COMPOSE);
			await dialog.getByRole("button", { name: "Continue" }).click();

			const review = dialog.getByRole("form", { name: "Review import" });
			await expect(review).toBeVisible();
			const table = review.getByRole("table", { name: "Compose services" });
			const row = (name: string) =>
				table.getByRole("row").filter({
					has: page.getByRole("checkbox", { name: `Import ${name}` }),
				});
			await expect(row("db")).toContainText("PostgreSQL 16");
			await expect(row("cache")).toContainText("Redis 7");
			await expect(row("web")).toContainText(
				"Your app, runs outside LocaInfra",
			);
			for (const skipped of ["storage", "mailhog", "web"]) {
				await expect(row(skipped)).toContainText("Skipped");
				await expect(
					review.getByRole("checkbox", { name: `Import ${skipped}` }),
				).toBeDisabled();
			}
			// A separately run stack owns 5432/6379 here: the preview remaps.
			const dbPort = (
				await row("db").getByRole("cell").nth(3).innerText()
			).trim();
			const cachePort = (
				await row("cache").getByRole("cell").nth(3).innerText()
			).trim();
			for (const text of [dbPort, cachePort]) {
				const target = Number(text.split("→").at(-1)?.trim());
				expect(RESERVED_PORTS).not.toContain(target);
			}

			await review.getByLabel("Project name").fill(PROJECT);
			await review.getByLabel("Folder").fill(root);
			await expect(
				review.getByRole("button", { name: "Import 2 services" }),
			).toBeVisible();
			await page.waitForTimeout(300);
			await shot(page, "import-preview");
			await review.getByRole("button", { name: "Import 2 services" }).click();

			// The dialog opens the project as soon as it is registered.
			await expect(page).toHaveURL(new RegExp(`/p/${PROJECT}$`), {
				timeout: 60_000,
			});
			await expect
				.poll(states, { timeout: UP_TIMEOUT, intervals: [2_000] })
				.toEqual({ db: "running", cache: "running" });
			for (const s of await services())
				expect(RESERVED_PORTS).not.toContain(s.hostPort);
			expect(readFileSync(join(root, "locainfra.yaml"), "utf8")).toContain(
				"POSTGRES_DB: shop",
			);
		});

		await test.step("Data tab on postgres: objects, select 1, export CSV", async () => {
			await page.goto(`/p/${PROJECT}/s/db?tab=data`);
			await expect(
				page.getByRole("navigation", { name: "Tables" }),
			).toContainText("None yet");
			await queryBox(page).fill("select 1 as one");
			await runButton(page).click();
			const results = page.getByRole("table", { name: "Query results" });
			await expect(results.getByRole("columnheader")).toHaveText(["one"]);
			await expect(results.getByRole("cell")).toHaveText(["1"]);
			await expect(page.getByText(/^1 row/)).toBeVisible();

			const download = page.waitForEvent("download");
			await page.getByRole("button", { name: "Export CSV" }).click();
			const file = await download;
			expect(file.suggestedFilename()).toMatch(/\.csv$/);
			const saved = join(scratch, file.suggestedFilename());
			await file.saveAs(saved);
			expect(readFileSync(saved, "utf8").trim().split(/\r?\n/)).toEqual([
				"one",
				"1",
			]);

			// A rejected query shows the engine's error line, not a crash.
			await queryBox(page).fill("select * from nope");
			await runButton(page).click();
			await expect(page.getByRole("alert")).toContainText(
				'relation "nope" does not exist',
			);
		});

		await test.step("Data tab on redis: PING → PONG", async () => {
			await page.goto(`/p/${PROJECT}/s/cache?tab=data`);
			await expect(
				page.getByRole("navigation", { name: "Key patterns" }),
			).toContainText("*");
			await queryBox(page).fill("PING");
			await queryBox(page).press("ControlOrMeta+Enter");
			await expect(
				page.getByRole("table", { name: "Query results" }).getByRole("cell"),
			).toHaveText(["PONG"]);
		});

		await test.step("Snapshots: create on postgres (stop, archive, start), file + SQLite row", async () => {
			await page.goto(`/p/${PROJECT}/s/db?tab=snapshots`);
			const list = page.getByRole("list", { name: "Snapshots" });
			await expect(list).toContainText("No snapshots yet");
			await page.getByLabel("Snapshot name").fill("before-smoke");
			await page.getByRole("button", { name: "Create snapshot" }).click();
			await expect(list).toContainText("before-smoke", { timeout: UP_TIMEOUT });
			await expect(detailHeader(page, "db").getByText("Running")).toBeVisible({
				timeout: 60_000,
			});
			expect(archives(home, "db")).toHaveLength(1);
			const rows = sqliteSnapshotRows(join(home, "locainfra.db"));
			if (rows !== undefined) expect(rows).toBe(1);
			expect(helperContainers()).toEqual([]);
			await page.waitForTimeout(500);
			await shot(page, "snapshots");
		});

		await test.step("Data tab: create a table, restore the snapshot → table gone", async () => {
			await page.goto(`/p/${PROJECT}/s/db?tab=data`);
			await queryBox(page).fill("CREATE TABLE smoke_marker (id int)");
			await runButton(page).click();
			await expect(
				page.getByRole("table", { name: "Query results" }).getByRole("cell"),
			).toHaveText(["CREATE TABLE"]);
			await page.reload();
			const nav = page.getByRole("navigation", { name: "Tables" });
			await expect(
				nav.getByRole("button", { name: "smoke_marker" }),
			).toBeVisible();
			await nav.getByRole("button", { name: "smoke_marker" }).click();
			await expect(queryBox(page)).toHaveValue(
				'SELECT *\nFROM "smoke_marker"\nLIMIT 100;',
			);
			await runButton(page).click();
			await expect(page.getByText("No rows")).toBeVisible();
			await page.waitForTimeout(300);
			await shot(page, "data");

			await page.getByRole("tab", { name: "Snapshots" }).click();
			await page.getByRole("button", { name: "Restore before-smoke" }).click();
			const confirm = page.getByRole("alertdialog");
			await expect(confirm).toContainText("Anything written since is lost");
			await confirm.getByRole("button", { name: "Restore snapshot" }).click();
			// The op settles once db is healthy again; the page refetches it then.
			await expect(
				page.getByText("Restored “before-smoke” into db"),
			).toBeVisible({ timeout: UP_TIMEOUT });
			await expect(detailHeader(page, "db").getByText("Running")).toBeVisible({
				timeout: UP_TIMEOUT,
			});
			expect(await tables("db")).toEqual([]);
			await page.goto(`/p/${PROJECT}/s/db?tab=data`);
			await expect(
				page.getByRole("navigation", { name: "Tables" }),
			).toContainText("None yet");
			expect(helperContainers()).toEqual([]);
		});

		await test.step("Snapshots: delete removes the archive and the row", async () => {
			await page.getByRole("tab", { name: "Snapshots" }).click();
			await page.getByRole("button", { name: "Delete before-smoke" }).click();
			await page
				.getByRole("alertdialog")
				.getByRole("button", { name: "Delete snapshot" })
				.click();
			await expect(page.getByRole("list", { name: "Snapshots" })).toContainText(
				"No snapshots yet",
			);
			expect(archives(home, "db")).toEqual([]);
			const rows = sqliteSnapshotRows(join(home, "locainfra.db"));
			if (rows !== undefined) expect(rows).toBe(0);
		});

		await test.step("Config: another postgres with a Regenerated password and a seed file", async () => {
			writeFileSync(join(root, "seed.sql"), SEED_SQL);
			await page.goto(`/p/${PROJECT}/add/postgres`);
			const nameInput = page.getByLabel("Name", { exact: true });
			await expect(nameInput).toBeVisible();
			await nameInput.fill("seeded-db");
			await page.getByLabel("Host port").fill("auto");
			const password = page.getByLabel("Password", { exact: true });
			await expect(password).toHaveValue("");
			await page.getByRole("button", { name: "Regenerate password" }).click();
			await expect(password).toHaveValue(/^[A-Za-z0-9_-]{43}$/);
			const chosen = await password.inputValue();
			await page.getByLabel(/Seed file/).fill("./seed.sql");
			await expect(page.getByLabel("locainfra.yaml entry")).toHaveValue(
				/seed: \.?\/?seed\.sql/,
			);
			await page.waitForTimeout(300);
			await shot(page, "config-seed");
			await page.getByRole("button", { name: "Add & start" }).click();
			await expect(page).toHaveURL(new RegExp(`/p/${PROJECT}/s/seeded-db`));
			await expect(
				detailHeader(page, "seeded-db").getByText("Running"),
			).toBeVisible({ timeout: UP_TIMEOUT });
			expect(await connectionUrl("seeded-db")).toContain(`:${chosen}@`);
			const port = (await services()).find((s) => s.name === "seeded-db");
			expect(RESERVED_PORTS).not.toContain(port?.hostPort);

			await page.getByRole("tab", { name: "Data" }).click();
			const nav = page.getByRole("navigation", { name: "Tables" });
			await nav.getByRole("button", { name: "seeded_items" }).click();
			await runButton(page).click();
			await expect(
				page.getByRole("table", { name: "Query results" }).getByRole("cell"),
			).toHaveText(["1", "alpha", "2", "beta"]);
		});

		await test.step("Rotate: redis rotates in place; postgres asks to wipe the volume", async () => {
			const before = await connectionUrl("cache");
			await page.goto(`/p/${PROJECT}/s/cache?tab=connect`);
			await page.getByRole("button", { name: "Rotate REDIS_PASSWORD" }).click();
			const dialog = page.getByRole("alertdialog");
			await expect(dialog).toContainText("Rotate REDIS_PASSWORD?");
			await dialog.getByRole("button", { name: "Rotate secret" }).click();
			await expect
				.poll(() => connectionUrl("cache"), { timeout: UP_TIMEOUT })
				.not.toBe(before);
			await expect
				.poll(states, { timeout: UP_TIMEOUT, intervals: [2_000] })
				.toMatchObject({ cache: "running" });
			// The Data tab authenticates with the new value.
			const ping = await api(
				"POST",
				`/api/projects/${PROJECT}/services/cache/data/query`,
				{ query: "PING" },
			);
			expect(ping.status).toBe(200);

			await page.goto(`/p/${PROJECT}/s/db?tab=connect`);
			await page
				.getByRole("button", { name: "Rotate POSTGRES_PASSWORD" })
				.click();
			const guard = page.getByRole("alertdialog");
			await expect(guard).toContainText(
				"POSTGRES_PASSWORD is stored in the data volume",
			);
			const wipe = guard.getByRole("button", { name: "Wipe data and rotate" });
			await expect(wipe).toBeDisabled();
			await guard.getByLabel(/to confirm/).fill("db");
			await expect(wipe).toBeEnabled();
			await guard.getByRole("button", { name: "Cancel" }).click();
			// Without force + wipeVolume the server refuses too.
			const refused = await api(
				"PATCH",
				`/api/projects/${PROJECT}/services/db/secrets/POSTGRES_PASSWORD/rotate`,
				{},
			);
			expect(refused.status).toBe(422);
			expect(
				((await refused.json()) as { details: { fix?: string } }).details.fix,
			).toMatch(/Wipe volume/);
		});

		await test.step("clean up: remove every service with its volume; no li-* leftovers", async () => {
			for (const s of await services()) {
				const res = await api(
					"DELETE",
					`/api/projects/${PROJECT}/services/${s.name}?volumes=true`,
				);
				expect(res.status).toBe(202);
			}
			await expect
				.poll(async () => (await services()).length, { timeout: 180_000 })
				.toBe(0);
			await expect
				.poll(() => leftovers(PROJECT), { timeout: 120_000 })
				.toEqual([]);
			expect(helperContainers()).toEqual([]);
			expect((await api("DELETE", `/api/projects/${PROJECT}`)).status).toBe(
				200,
			);
		});
	});
});
