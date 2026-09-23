import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CONTAINER,
	createTestDeps,
	PROJECT,
	TOKEN,
} from "../../__tests__/support/fixtures";
import { waitFor } from "../../__tests__/support/wait";
import type { ServerMessage } from "../../modules/observer/observer.model";
import { probeDashboard, readDashboardFile } from "../dashboard-file";
import { type RunningServer, startServer } from "../start-server";

let dir: string;
let server: RunningServer;
let dashboardFile: string;
const deps = createTestDeps({
	observer: { logs: { batchMs: 10 }, status: { intervalMs: 50 } },
});

/** Opens an authenticated socket and collects its messages. */
async function openSocket(token = TOKEN) {
	const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?t=${token}`);
	const messages: ServerMessage[] = [];
	ws.onmessage = (event) => {
		messages.push(JSON.parse(String(event.data)) as ServerMessage);
	};
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = () => reject(new Error("socket failed"));
	});
	return { ws, messages };
}

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "locainfra-server-"));
	await mkdir(join(dir, "dist", "assets"), { recursive: true });
	await writeFile(
		join(dir, "dist", "index.html"),
		"<!doctype html><title>LocaInfra</title>",
	);
	await writeFile(join(dir, "dist", "assets", "app-1234.js"), "console.log(1)");
	dashboardFile = join(dir, "home", "dashboard.json");
	server = await startServer({
		port: 0,
		token: TOKEN,
		deps,
		staticDir: join(dir, "dist"),
		dashboardFile,
		handleSignals: false,
	});
});

afterAll(async () => {
	await server.stop();
	await rm(dir, { recursive: true, force: true });
});

describe("startServer", () => {
	it("listens on 127.0.0.1 and writes a 0600 dashboard file", async () => {
		expect(server.origin).toBe(`http://127.0.0.1:${server.port}`);
		expect(server.url).toBe(`http://127.0.0.1:${server.port}/?t=${TOKEN}`);
		const info = await readDashboardFile(dashboardFile);
		expect(info).toMatchObject({
			pid: process.pid,
			port: server.port,
			token: TOKEN,
		});
		expect((await stat(dashboardFile)).mode & 0o777).toBe(0o600);
		const probed = await probeDashboard(dashboardFile);
		expect(probed?.url).toBe(server.url);
	});

	it("serves the SPA with an index.html fallback, but never for /api", async () => {
		const get = (path: string) => fetch(`${server.origin}${path}`);
		const root = await get("/");
		expect(root.status).toBe(200);
		expect(await root.text()).toContain("<title>LocaInfra</title>");
		const deep = await get(`/p/${PROJECT}/s/main-db?tab=logs`);
		expect(await deep.text()).toContain("<title>LocaInfra</title>");
		expect(deep.headers.get("cache-control")).toBe("no-cache");
		const asset = await get("/assets/app-1234.js");
		expect(await asset.text()).toBe("console.log(1)");
		expect(asset.headers.get("cache-control")).toContain("immutable");
		expect((await get("/assets/missing.js")).status).toBe(404);
		expect((await get("/api/nope")).status).toBe(404);
		expect((await get("/../../etc/passwd")).status).toBe(200); // normalized to the SPA
		expect((await get("/api/health")).status).toBe(200);
		expect((await get("/api/projects")).status).toBe(401);
	});

	it("rejects a WebSocket without the token", async () => {
		const res = await fetch(`${server.origin}/ws`, {
			headers: { upgrade: "websocket", connection: "upgrade" },
		});
		expect(res.status).toBe(401);
		await expect(openSocket("wrong")).rejects.toThrow();
	});

	it("streams op progress, status and logs over /ws", async () => {
		const { ws, messages } = await openSocket();
		const res = await fetch(`${server.origin}/api/projects/${PROJECT}/up`, {
			method: "POST",
			headers: { "x-locainfra-token": TOKEN },
		});
		expect(res.status).toBe(202);
		const { opId } = (await res.json()) as { opId: string };
		ws.send(JSON.stringify({ type: "subscribe", channel: `op:${opId}` }));
		ws.send(
			JSON.stringify({ type: "subscribe", channel: `status:${PROJECT}` }),
		);
		ws.send(
			JSON.stringify({
				type: "subscribe",
				channel: `logs:${CONTAINER}`,
				tail: 0,
			}),
		);
		await waitFor(() =>
			messages.some((m) => m.type === "progress" && m.payload.kind === "done"),
		);
		expect(
			messages.filter((m) => m.type === "progress").map((m) => m.payload.kind),
		).toEqual(["step", "done"]);
		await waitFor(() => messages.some((m) => m.type === "snapshot"));
		await waitFor(() => deps.ports.streams.open >= 3);
		deps.ports.streams.pushLog(CONTAINER, {
			stream: "stderr",
			text: "\u001b[33mWARN\u001b[0m slow query",
		});
		await waitFor(() => messages.some((m) => m.type === "log"));
		const log = messages.find((m) => m.type === "log");
		expect(log?.type === "log" && log.payload.lines[0]?.text).toContain("WARN");

		ws.close();
		// Closing the socket releases every upstream stream.
		await waitFor(() => deps.ports.streams.open === 0);
	});

	it("stop() closes the server and removes the dashboard file", async () => {
		const other = await startServer({
			port: 0,
			token: "t2",
			deps: createTestDeps(),
			dashboardFile: join(dir, "second.json"),
			handleSignals: false,
		});
		expect(await probeDashboard(join(dir, "second.json"))).not.toBeNull();
		await other.stop();
		await other.stop();
		expect(await readDashboardFile(join(dir, "second.json"))).toBeNull();
		await expect(fetch(`${other.origin}/api/health`)).rejects.toThrow();
	});
});
