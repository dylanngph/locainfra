import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { server } from "@/test/msw/node";
import { renderApp } from "@/test/render-app";
import { validateRemoveConfirmation } from "../components/remove-service-dialog";

/** Captures DELETE …/services/:name calls. */
const captureDeletes = () => {
	const calls: { name: string; volumes: string | null }[] = [];
	server.use(
		http.delete(
			"*/api/projects/:project/services/:name",
			({ params, request }) => {
				calls.push({
					name: String(params.name),
					volumes: new URL(request.url).searchParams.get("volumes"),
				});
				return HttpResponse.json({ opId: "op-remove" }, { status: 202 });
			},
		),
	);
	return calls;
};

describe("Remove service", () => {
	it("requires the exact service name", () => {
		expect(validateRemoveConfirmation("main-db", "main-db")).toBeUndefined();
		expect(validateRemoveConfirmation("main-d", "main-db")).toBe(
			"Type main-db to confirm.",
		);
		expect(validateRemoveConfirmation("MAIN-DB", "main-db")).toBeDefined();
	});

	it("removes from the overview row menu with a typed confirmation and the volume option", async () => {
		const calls = captureDeletes();
		const { user, router } = renderApp("/p/shop-api");
		await user.click(
			await screen.findByRole("button", { name: "More actions for main-db" }),
		);
		await user.click(
			await screen.findByRole("menuitem", { name: /Remove service/ }),
		);
		const dialog = await screen.findByRole("alertdialog");
		const confirm = within(dialog).getByRole("button", {
			name: "Remove service",
		});
		expect(confirm).toBeDisabled();
		const input = within(dialog).getByLabelText(/to confirm/);
		await user.type(input, "main-d");
		expect(confirm).toBeDisabled();
		await user.type(input, "b");
		expect(confirm).toBeEnabled();
		await user.click(
			within(dialog).getByRole("checkbox", {
				name: "Also delete its data volume and snapshots",
			}),
		);
		await user.click(confirm);
		await waitFor(() =>
			expect(calls).toEqual([{ name: "main-db", volumes: "true" }]),
		);
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		// The row click-through did not navigate.
		expect(router.state.location.pathname).toBe("/p/shop-api");
	});

	it("removes from the detail page and returns to the overview", async () => {
		const calls = captureDeletes();
		const { user, router } = renderApp("/p/shop-api/s/cache");
		await user.click(await screen.findByRole("button", { name: "Remove" }));
		const dialog = await screen.findByRole("alertdialog");
		await user.type(within(dialog).getByLabelText(/to confirm/), "cache");
		await user.click(
			within(dialog).getByRole("button", { name: "Remove service" }),
		);
		await waitFor(() =>
			expect(calls).toEqual([{ name: "cache", volumes: "false" }]),
		);
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/p/shop-api"),
		);
	});

	it("keeps the dialog open and shows the error when the request fails", async () => {
		server.use(
			http.delete("*/api/projects/:project/services/:name", () =>
				HttpResponse.json(
					{ code: "SERVICE_NOT_FOUND", message: "Service is gone." },
					{ status: 404 },
				),
			),
		);
		const { user } = renderApp("/p/shop-api/s/rest");
		await user.click(await screen.findByRole("button", { name: "Remove" }));
		const dialog = await screen.findByRole("alertdialog");
		await user.type(within(dialog).getByLabelText(/to confirm/), "rest");
		await user.click(
			within(dialog).getByRole("button", { name: "Remove service" }),
		);
		expect(await within(dialog).findByRole("alert")).toHaveTextContent(
			"Service is gone.",
		);
	});
});
