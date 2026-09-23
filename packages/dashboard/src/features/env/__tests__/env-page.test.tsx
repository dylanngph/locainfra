import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { currentSearch, renderApp } from "@/test/render-app";

describe("Environment page", () => {
	it("switches the preview format through ?fmt=", async () => {
		const { user } = renderApp("/p/shop-api/env");
		const preview = await screen.findByTestId("env-preview");
		expect(preview).toHaveTextContent("# main-db (postgres)");
		expect(preview).toHaveTextContent(
			"DATABASE_URL=postgres://postgres:••••••••@127.0.0.1:5433/shop",
		);
		// events collides with main-db, so its keys get the EVENTS_ prefix.
		expect(preview).toHaveTextContent("EVENTS_DATABASE_URL=");
		expect(
			screen.getByRole("button", { name: "Write to ./.env" }),
		).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "JSON" }));
		await waitFor(() => expect(currentSearch()).toBe("?fmt=json"));
		await waitFor(() =>
			expect(screen.getByTestId("env-preview")).toHaveTextContent(
				'"DATABASE_URL":',
			),
		);

		await user.click(screen.getByRole("button", { name: "Shell export" }));
		await waitFor(() => expect(currentSearch()).toBe("?fmt=shell"));
		await waitFor(() =>
			expect(screen.getByTestId("env-preview")).toHaveTextContent(
				'export DATABASE_URL="',
			),
		);

		await user.click(screen.getByRole("button", { name: ".env" }));
		await waitFor(() => expect(currentSearch()).toBe(""));
	});

	it("reads the initial format from the URL and reveals secrets on demand", async () => {
		const { user } = renderApp("/p/blog/env?fmt=shell");
		const preview = await screen.findByTestId("env-preview");
		expect(preview).toHaveTextContent(
			'export MYSQL_URL="mysql://app:••••••••@',
		);
		expect(
			screen.getByRole("button", { name: "Write to ./.env.local" }),
		).toBeInTheDocument();
		await user.click(screen.getByRole("switch", { name: "Reveal secrets" }));
		await waitFor(() =>
			expect(screen.getByTestId("env-preview")).not.toHaveTextContent(
				"••••••••",
			),
		);
	});
});
