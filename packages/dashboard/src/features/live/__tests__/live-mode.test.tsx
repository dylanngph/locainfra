import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useLiveModeStore } from "@/shared/lib/live/live-mode";
import { useObserverStore } from "@/shared/lib/observer/observer-store";
import { installFakeSockets } from "@/test/fake-socket";
import { mockDb } from "@/test/msw/mock-db";
import { server } from "@/test/msw/node";
import { renderApp } from "@/test/render-app";

const PROJECT = "shop-api";
const liveSwitch = () => screen.findByRole("switch", { name: "Live" });
const mainDbId = () => mockDb.containerId(PROJECT, "main-db");

const shop = () => {
	const project = mockDb.project(PROJECT);
	if (!project) throw new Error(`no mock project ${PROJECT}`);
	return project;
};

/** Counts GETs of one API path while the test runs. */
const countGets = (path: string) => {
	const counter = { count: 0 };
	server.events.on("request:start", ({ request }) => {
		if (request.method === "GET" && new URL(request.url).pathname === path)
			counter.count += 1;
	});
	return counter;
};

describe("Live mode", () => {
	it("is off by default and never opens the WebSocket", async () => {
		const { factory } = installFakeSockets();
		renderApp(`/p/${PROJECT}`);
		const toggle = await liveSwitch();
		expect(toggle).toHaveAttribute("aria-checked", "false");
		expect(
			await screen.findByText("2 of 4 running on network ls-shop-api"),
		).toBeInTheDocument();
		// Give any stray effect a chance to connect.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(factory).not.toHaveBeenCalled();
		expect(screen.queryByTestId("live-pulse")).toBeNull();
	});

	it("follows actions over HTTP without opening the WebSocket while Live is off", async () => {
		const { factory } = installFakeSockets();
		const follows = { count: 0 };
		server.events.on("request:start", ({ request }) => {
			if (new URL(request.url).pathname.startsWith("/api/ops/"))
				follows.count += 1;
		});
		const { user } = renderApp(`/p/${PROJECT}`);
		expect(
			await screen.findByText("2 of 4 running on network ls-shop-api"),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Stop all" }));
		expect(
			await screen.findByText(/0 of 4 running/, undefined, { timeout: 5_000 }),
		).toBeInTheDocument();
		expect(follows.count).toBeGreaterThan(0);
		expect(factory).not.toHaveBeenCalled();
	});

	it("subscribes the project's status and running rows' stats when turned on, and closes when turned off", async () => {
		const { factory, sockets } = installFakeSockets();
		const { user } = renderApp(`/p/${PROJECT}`);
		await user.click(await liveSwitch());

		await waitFor(() => expect(factory).toHaveBeenCalledTimes(1));
		const socket = sockets[0];
		if (!socket) throw new Error("no socket");
		await waitFor(() =>
			expect(socket.subscribed).toEqual(
				expect.arrayContaining([`status:${PROJECT}`, `stats:${mainDbId()}`]),
			),
		);
		expect(socket.subscribed.every((c) => !c.includes("blog"))).toBe(true);
		expect(screen.getByTestId("live-pulse")).toBeInTheDocument();
		// Session-only: nothing is persisted for the next load.
		expect(window.localStorage.length).toBe(0);
		expect(window.sessionStorage.length).toBe(0);

		// A snapshot drives the page while Live is on.
		const status = mockDb.projectStatus(shop());
		socket.receive({
			channel: `status:${PROJECT}`,
			type: "snapshot",
			payload: {
				...status,
				services: status.services.map((s) => ({ ...s, state: "running" })),
			},
		});
		expect(
			await screen.findByText("4 of 4 running on network ls-shop-api"),
		).toBeInTheDocument();

		await user.click(await liveSwitch());
		await waitFor(() => expect(socket.closed).toBe(true));
		expect(socket.sent).toContainEqual({
			type: "unsubscribe",
			channel: `status:${PROJECT}`,
		});
		expect(useObserverStore.getState().status[PROJECT]).toBeUndefined();
		// The last snapshot stays on screen without a refetch.
		expect(
			screen.getByText("4 of 4 running on network ls-shop-api"),
		).toBeInTheDocument();
		expect(factory).toHaveBeenCalledTimes(1);
	});

	it("starts off on every fresh load, even after Live was on", async () => {
		const first = installFakeSockets();
		const { user, unmount } = renderApp(`/p/${PROJECT}`);
		await user.click(await liveSwitch());
		await waitFor(() => expect(first.factory).toHaveBeenCalledTimes(1));
		unmount();
		// A reload drops the in-memory choice.
		useLiveModeStore.getState().reset();

		const { factory } = installFakeSockets();
		renderApp(`/p/${PROJECT}`);
		expect(await liveSwitch()).toHaveAttribute("aria-checked", "false");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(factory).not.toHaveBeenCalled();
	});

	it("keeps Live per project in memory and releases it when leaving the project", async () => {
		useLiveModeStore.getState().setLive(PROJECT, true);
		const { factory, sockets } = installFakeSockets();
		const { router } = renderApp(`/p/${PROJECT}`);
		expect(await liveSwitch()).toHaveAttribute("aria-checked", "true");
		await waitFor(() =>
			expect(sockets[0]?.subscribed).toContain(`status:${PROJECT}`),
		);

		// Another project keeps its own (default off) choice.
		await router.navigate("/p/blog");
		await screen.findByText(/running on network ls-blog|Empty project/);
		expect(await liveSwitch()).toHaveAttribute("aria-checked", "false");
		await waitFor(() => expect(sockets[0]?.closed).toBe(true));
		expect(sockets[0]?.sent).toContainEqual({
			type: "unsubscribe",
			channel: `status:${PROJECT}`,
		});

		// The Projects home never subscribes, even for a Live project.
		await router.navigate("/");
		await screen.findByRole("article", { name: PROJECT });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(factory).toHaveBeenCalledTimes(1);
	});

	it("refetches the project once on Refresh (no polling)", async () => {
		const gets = countGets(`/api/projects/${PROJECT}`);
		const system = countGets("/api/system");
		const { user } = renderApp(`/p/${PROJECT}`);
		await screen.findByText("2 of 4 running on network ls-shop-api");
		const before = gets.count;
		const systemBefore = system.count;
		expect(before).toBeGreaterThan(0);

		const rest = shop().services.find((s) => s.name === "rest");
		if (!rest) throw new Error("no rest service");
		mockDb.setState(shop(), rest, "running");
		await user.click(screen.getByRole("button", { name: "Refresh" }));
		expect(
			await screen.findByText("3 of 4 running on network ls-shop-api"),
		).toBeInTheDocument();
		expect(gets.count).toBe(before + 1);
		await waitFor(() => expect(system.count).toBe(systemBefore + 1));
	});

	it("loads the last 200 log lines once over REST and streams only while following", async () => {
		const { factory, sockets } = installFakeSockets();
		const tails = countGets(`/api/projects/${PROJECT}/services/main-db/logs`);
		const { user } = renderApp(`/p/${PROJECT}/s/main-db?tab=logs`);
		const channel = `logs:${mainDbId()}`;
		expect(await screen.findByText("Last 200 lines")).toBeInTheDocument();
		await waitFor(() =>
			expect(
				useObserverStore.getState().logs[mainDbId()]?.entries.length,
			).toBeGreaterThan(0),
		);
		expect(tails.count).toBe(1);
		// The pane is virtualized (no layout in happy-dom): check the buffer.
		expect(
			useObserverStore
				.getState()
				.logs[mainDbId()]?.entries.map((e) =>
					e.kind === "line" ? e.text : "",
				),
		).toContainEqual(expect.stringMatching(/ready to accept connections/));
		expect(factory).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: "Reload" }));
		await waitFor(() => expect(tails.count).toBe(2));
		expect(factory).not.toHaveBeenCalled();

		await user.click(screen.getByRole("switch", { name: "Follow" }));
		await waitFor(() => expect(sockets[0]?.subscribed).toEqual([channel]));
		expect(sockets[0]?.sent).toContainEqual({
			type: "subscribe",
			channel,
			tail: 200,
		});
		expect(screen.getByText("Streaming")).toBeInTheDocument();
		await user.click(screen.getByRole("switch", { name: "Follow" }));
		await waitFor(() => expect(sockets[0]?.closed).toBe(true));
	});

	it("switches Follow with Live on the Logs tab, so Live off closes the socket", async () => {
		const { factory, sockets } = installFakeSockets();
		const { user } = renderApp(`/p/${PROJECT}/s/main-db?tab=logs`);
		const channel = `logs:${mainDbId()}`;
		const follow = () => screen.getByRole("switch", { name: "Follow" });
		expect(await screen.findByText("Last 200 lines")).toBeInTheDocument();
		expect(follow()).toHaveAttribute("aria-checked", "false");

		// Live on → Follow starts.
		await user.click(await liveSwitch());
		await waitFor(() =>
			expect(follow()).toHaveAttribute("aria-checked", "true"),
		);
		await waitFor(() => expect(sockets[0]?.subscribed).toContain(channel));
		expect(sockets[0]?.subscribed).toContain(`status:${PROJECT}`);

		// Live off → Follow stops and every channel is released.
		await user.click(await liveSwitch());
		await waitFor(() =>
			expect(follow()).toHaveAttribute("aria-checked", "false"),
		);
		await waitFor(() => expect(sockets[0]?.closed).toBe(true));
		expect(sockets[0]?.sent).toContainEqual({ type: "unsubscribe", channel });
		expect(factory).toHaveBeenCalledTimes(1);
	});

	it("releases logs when Live is turned off after the Logs tab opened with Live on", async () => {
		useLiveModeStore.getState().setLive(PROJECT, true);
		const { sockets } = installFakeSockets();
		const { user } = renderApp(`/p/${PROJECT}/s/main-db?tab=logs`);
		const channel = `logs:${mainDbId()}`;
		await waitFor(() => expect(sockets[0]?.subscribed).toContain(channel));
		expect(screen.getByRole("switch", { name: "Follow" })).toHaveAttribute(
			"aria-checked",
			"true",
		);
		await user.click(await liveSwitch());
		await waitFor(() => expect(sockets[0]?.closed).toBe(true));
		expect(sockets[0]?.sent).toContainEqual({ type: "unsubscribe", channel });
	});

	it("shows one-shot metrics over REST with a hint to turn Live on for charts", async () => {
		const { factory } = installFakeSockets();
		const readings = countGets(
			`/api/projects/${PROJECT}/services/main-db/stats`,
		);
		const { user } = renderApp(`/p/${PROJECT}/s/main-db?tab=metrics`);
		expect((await screen.findAllByText("Turn on Live for charts")).length).toBe(
			2,
		);
		expect(screen.queryByRole("img", { name: "CPU usage" })).toBeNull();
		await waitFor(() => expect(readings.count).toBe(1));
		await waitFor(() =>
			expect(
				useObserverStore.getState().stats[mainDbId()]?.length,
			).toBeGreaterThan(0),
		);
		expect(factory).not.toHaveBeenCalled();
		const [turnOn] = screen.getAllByRole("button", { name: "Turn on Live" });
		if (!turnOn) throw new Error("no Turn on Live button");
		await user.click(turnOn);
		expect(
			await screen.findByRole("img", { name: "CPU usage" }),
		).toBeInTheDocument();
		expect(await liveSwitch()).toHaveAttribute("aria-checked", "true");
	});
});
