import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { mockDb } from "@/test/msw/mock-db";
import { mockSystemSetup } from "@/test/msw/mock-system";
import { server } from "@/test/msw/node";
import { recordRequests } from "@/test/msw/record-requests";
import { renderApp } from "@/test/render-app";

describe("Docker unavailable screen", () => {
	it("is not shown (and /api/system/setup not fetched) while Docker runs", async () => {
		const setupCalls = recordRequests("GET", /\/api\/system\/setup$/);
		renderApp("/");
		expect(
			await screen.findByRole("heading", { name: "Projects" }),
		).toBeInTheDocument();
		expect(screen.getByText("Docker 27.1.1")).toBeInTheDocument();
		expect(setupCalls).toHaveLength(0);
	});

	it("replaces the pages with the start remedy when Colima is stopped", async () => {
		mockDb.docker = "stopped";
		renderApp("/");
		expect(
			await screen.findByRole("heading", { name: "Docker is not running" }),
		).toBeInTheDocument();
		expect(
			screen.getByText("Colima is installed but not running; start it."),
		).toBeInTheDocument();
		const checks = screen.getByRole("list", { name: "Failing checks" });
		expect(within(checks).getByText("Docker daemon")).toBeInTheDocument();
		expect(
			within(checks).getByText("Start Colima: colima start"),
		).toBeInTheDocument();
		const commands = screen.getByRole("list", {
			name: "Commands Start Docker runs",
		});
		expect(within(commands).getByText("colima start")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Start Docker" })).toBeEnabled();
		expect(screen.queryByRole("heading", { name: "Projects" })).toBeNull();
		expect(screen.getByText("Docker unavailable")).toBeInTheDocument();
	});

	it("shows the copyable locastack setup command and the read-only steps when nothing is installed", async () => {
		mockDb.docker = "missing";
		renderApp("/p/shop-api");
		expect(
			await screen.findByRole("heading", { name: "Docker is not installed" }),
		).toBeInTheDocument();
		expect(screen.getByText("Run this in your terminal")).toBeInTheDocument();
		expect(screen.getByText("locastack setup")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
		const steps = screen.getByRole("list", { name: "Setup steps" });
		expect(within(steps).getAllByRole("listitem")).toHaveLength(4);
		expect(
			within(steps).getByText(
				"/opt/homebrew/bin/brew install colima docker docker-compose",
			),
		).toBeInTheDocument();
		expect(
			screen.getByText("locastack setup --runtime orbstack"),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Start Docker" })).toBeNull();
		expect(screen.getByText("Docker unavailable")).toBeInTheDocument();
	});

	it("Start Docker posts, follows the op and leaves the screen once Docker is ready", async () => {
		mockDb.docker = "stopped";
		const posts = recordRequests("POST", /\/api\/system\/docker\/start$/);
		const { user } = renderApp("/");
		await user.click(
			await screen.findByRole("button", { name: "Start Docker" }),
		);
		expect(posts).toHaveLength(1);
		await waitFor(() => expect(posts[0]?.body).toEqual({ provider: "colima" }));
		expect(
			await screen.findByRole(
				"heading",
				{ name: "Projects" },
				{ timeout: 3000 },
			),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("heading", { name: "Docker is not running" }),
		).toBeNull();
		expect(await screen.findByText("Docker 27.1.1")).toBeInTheDocument();
	});

	it("a running runtime LocaStack cannot reach: named as such, with a hand fix", async () => {
		mockDb.docker = "stopped";
		const stopped = mockSystemSetup("stopped");
		server.use(
			http.get("*/api/system/setup", () =>
				HttpResponse.json({
					doctor: {
						...stopped.doctor,
						setupNeeded: "unsupported",
						platform: {
							...stopped.doctor.platform,
							runningRuntime: "colima",
						},
					},
					plan: {
						kind: "unsupported",
						alternatives: [],
						reason:
							"Colima is running but LocaStack cannot reach its Docker socket.",
						steps: [],
						postNotes: [
							"Run `docker context use colima`, then `locastack doctor`.",
						],
						needsTerminal: false,
					},
				}),
			),
		);
		renderApp("/");
		expect(
			await screen.findByRole("heading", {
				name: "LocaStack can't reach Docker",
			}),
		).toBeInTheDocument();
		expect(screen.getByText("Fix it by hand")).toBeInTheDocument();
		expect(screen.queryByText("Install Docker manually")).toBeNull();
		expect(
			screen.queryByText("Docker is not supported on this platform"),
		).toBeNull();
	});

	it("shows why Start Docker was refused, with the fix", async () => {
		mockDb.docker = "stopped";
		server.use(
			http.post("*/api/system/docker/start", () =>
				HttpResponse.json(
					{
						code: "SETUP_NEEDS_TERMINAL",
						message: "Starting Docker needs a terminal (sudo).",
						details: { fix: "Run `locastack setup` in a terminal" },
					},
					{ status: 409 },
				),
			),
		);
		const { user } = renderApp("/");
		await user.click(
			await screen.findByRole("button", { name: "Start Docker" }),
		);
		const alert = await screen.findByRole("alert");
		expect(within(alert).getByText("Docker did not start")).toBeInTheDocument();
		expect(
			within(alert).getByText("Starting Docker needs a terminal (sudo)."),
		).toBeInTheDocument();
		expect(
			within(alert).getByText("Run `locastack setup` in a terminal"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "Docker is not running" }),
		).toBeInTheDocument();
	});

	it("Re-check re-fetches once and stays while Docker is still down", async () => {
		mockDb.docker = "stopped";
		const setupCalls = recordRequests("GET", /\/api\/system\/setup$/);
		const systemCalls = recordRequests("GET", /\/api\/system$/);
		const { user } = renderApp("/");
		await screen.findByRole("heading", { name: "Docker is not running" });
		expect(setupCalls).toHaveLength(1);
		expect(systemCalls).toHaveLength(1);
		await user.click(screen.getByRole("button", { name: "Re-check" }));
		await waitFor(() => expect(setupCalls).toHaveLength(2));
		expect(systemCalls).toHaveLength(2);
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Re-check" })).toBeEnabled(),
		);
		expect(
			screen.getByRole("heading", { name: "Docker is not running" }),
		).toBeInTheDocument();
	});

	it("Re-check leaves the screen when Docker was started elsewhere", async () => {
		mockDb.docker = "missing";
		const { user } = renderApp("/");
		await screen.findByRole("heading", { name: "Docker is not installed" });
		mockDb.docker = "running";
		await user.click(screen.getByRole("button", { name: "Re-check" }));
		expect(
			await screen.findByRole("heading", { name: "Projects" }),
		).toBeInTheDocument();
		expect(screen.getByText("Docker 27.1.1")).toBeInTheDocument();
	});
});
