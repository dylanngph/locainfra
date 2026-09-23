import type { ServicePatch } from "@locainfra/server";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { mockDb } from "@/test/msw/mock-db";
import { server } from "@/test/msw/node";
import { renderApp } from "@/test/render-app";

const rowOf = async (name: string) => {
	const link = await screen.findByRole("link", { name });
	const row = link.closest("tr");
	if (!row) throw new Error(`no row for ${name}`);
	return row;
};

describe("Project overview", () => {
	it("shows every row state", async () => {
		renderApp("/p/shop-api");
		expect(
			await screen.findByText("2 of 4 running on network li-shop-api"),
		).toBeInTheDocument();
		expect(
			within(await rowOf("main-db")).getByText("Running"),
		).toBeInTheDocument();
		expect(
			within(await rowOf("rest")).getByText("Stopped"),
		).toBeInTheDocument();
		const events = await rowOf("events");
		expect(within(events).getByText("Port conflict")).toBeInTheDocument();
		expect(
			within(events).getByText("Port 5432 is already in use"),
		).toBeInTheDocument();
		expect(
			within(events).queryByRole("button", { name: "Copy URL" }),
		).toBeNull();
	});

	it("shows — instead of 0 for CPU/MEM of running rows while Live is off", async () => {
		renderApp("/p/shop-api");
		const row = await rowOf("main-db");
		expect(within(row).getByText("Running")).toBeInTheDocument();
		const dashes = within(row).getAllByText("—");
		expect(dashes).toHaveLength(2);
		for (const dash of dashes)
			expect(dash.closest("[title]")).toHaveAttribute(
				"title",
				"Turn on Live to see CPU and memory",
			);
		expect(within(row).queryByText("0.0%")).toBeNull();
		expect(within(row).queryByText("0 MB")).toBeNull();
	});

	it("fixes a port conflict with PATCH { port }", async () => {
		const patches: ServicePatch[] = [];
		server.use(
			http.patch(
				"*/api/projects/:project/services/:name",
				async ({ request, params }) => {
					expect(params).toMatchObject({ project: "shop-api", name: "events" });
					patches.push((await request.json()) as ServicePatch);
					// Known to the mock backend but never settles: the row stays optimistic.
					mockDb.ops.set("op-fix", []);
					return HttpResponse.json({ opId: "op-fix" }, { status: 202 });
				},
			),
		);
		const { user } = renderApp("/p/shop-api");
		const events = await rowOf("events");
		await user.click(
			within(events).getByRole("button", { name: "Use port 5434" }),
		);
		await waitFor(() => expect(patches).toEqual([{ port: 5434 }]));
		// Optimistic state while the op runs.
		expect(
			within(await rowOf("events")).getByText("Starting…"),
		).toBeInTheDocument();
	});

	it("shows the empty state for a project without services", async () => {
		renderApp("/p/scratch");
		expect(await screen.findByText("No services yet")).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: "Browse catalog" }),
		).toHaveAttribute("href", "/p/scratch/add");
	});

	it("renders the not-found boundary for an unknown project", async () => {
		renderApp("/p/nope");
		expect(await screen.findByText("Not found")).toBeInTheDocument();
	});
});
