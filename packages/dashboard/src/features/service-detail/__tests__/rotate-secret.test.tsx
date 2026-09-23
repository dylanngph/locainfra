import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { server } from "@/test/msw/node";
import { recordRequests } from "@/test/msw/record-requests";
import { renderApp } from "@/test/render-app";

const rotations = () => recordRequests("PATCH", /\/secrets\/[^/]+\/rotate$/);

describe("Connect tab: Rotate secret", () => {
	it("rotates a free secret after one confirmation", async () => {
		const calls = rotations();
		const { user } = renderApp("/p/shop-api/s/cache");
		await user.click(
			await screen.findByRole("button", { name: "Rotate REDIS_PASSWORD" }),
		);
		const dialog = await screen.findByRole("alertdialog");
		expect(
			within(dialog).getByRole("heading", { name: "Rotate REDIS_PASSWORD?" }),
		).toBeInTheDocument();
		await user.click(
			within(dialog).getByRole("button", { name: "Rotate secret" }),
		);
		await waitFor(() =>
			expect(calls).toEqual([
				{
					url: "/api/projects/shop-api/services/cache/secrets/REDIS_PASSWORD/rotate",
					body: {},
				},
			]),
		);
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		expect(
			await screen.findByText("Rotating REDIS_PASSWORD of cache…"),
		).toBeInTheDocument();
	});

	it("guards a secret baked into the volume and offers Wipe data and rotate", async () => {
		const calls = rotations();
		const { user } = renderApp("/p/shop-api/s/main-db");
		expect(
			await screen.findByText("Stored in the data volume"),
		).toBeInTheDocument();
		await user.click(
			screen.getByRole("button", { name: "Rotate POSTGRES_PASSWORD" }),
		);
		const dialog = await screen.findByRole("alertdialog");
		expect(
			within(dialog).getByRole("heading", {
				name: "POSTGRES_PASSWORD is stored in the data volume",
			}),
		).toBeInTheDocument();
		expect(dialog).toHaveTextContent("Take a snapshot first");
		const wipe = within(dialog).getByRole("button", {
			name: "Wipe data and rotate",
		});
		expect(wipe).toBeDisabled();
		await user.type(within(dialog).getByLabelText(/to confirm/), "main-db");
		expect(wipe).toBeEnabled();
		await user.click(wipe);
		await waitFor(() =>
			expect(calls[0]?.body).toEqual({ force: true, wipeVolume: true }),
		);
	});

	it("switches to the guard when the server refuses with a fix", async () => {
		server.use(
			http.patch(
				"*/api/projects/:project/services/:name/secrets/:key/rotate",
				async ({ request }) => {
					const body = (await request.json()) as { wipeVolume?: boolean };
					if (body.wipeVolume)
						return HttpResponse.json({ opId: "op-rotate" }, { status: 202 });
					return HttpResponse.json(
						{
							code: "INVALID_INPUT",
							message: "REDIS_PASSWORD is stored in cache's data volume.",
							details: { fix: "Wipe the volume to rotate it." },
						},
						{ status: 422 },
					);
				},
			),
		);
		const { user } = renderApp("/p/shop-api/s/cache");
		await user.click(
			await screen.findByRole("button", { name: "Rotate REDIS_PASSWORD" }),
		);
		const dialog = await screen.findByRole("alertdialog");
		await user.click(
			within(dialog).getByRole("button", { name: "Rotate secret" }),
		);
		expect(
			await within(dialog).findByRole("heading", {
				name: "REDIS_PASSWORD is stored in the data volume",
			}),
		).toBeInTheDocument();
		expect(dialog).toHaveTextContent("Wipe the volume to rotate it.");
		expect(
			within(dialog).getByRole("button", { name: "Wipe data and rotate" }),
		).toBeDisabled();
	});
});
