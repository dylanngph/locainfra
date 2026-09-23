import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MOCK_CATALOG } from "@/test/msw/catalog.fixture";
import { currentSearch, renderApp } from "@/test/render-app";
import { categoryId, filterCatalog } from "../lib/filter-catalog";

describe("Catalog page", () => {
	it("keeps the search and category filters in the URL", async () => {
		const { user } = renderApp("/p/shop-api/add");
		await screen.findByRole("link", { name: /PostgreSQL/ });

		await user.click(screen.getByRole("button", { name: "Redis" }));
		await waitFor(() => expect(currentSearch()).toContain("cat=redis"));
		expect(screen.queryByRole("link", { name: /PostgreSQL/ })).toBeNull();
		expect(
			screen.getByRole("link", { name: /Upstash Redis/ }),
		).toBeInTheDocument();

		await user.type(
			screen.getByRole("searchbox", { name: "Search services" }),
			"upstash",
		);
		await waitFor(() => expect(currentSearch()).toContain("q=upstash"));
		expect(screen.queryByRole("link", { name: /^Redis/ })).toBeNull();

		await user.click(screen.getByRole("button", { name: "All" }));
		await waitFor(() => expect(currentSearch()).not.toContain("cat="));
	});

	it("restores filters from the URL and shows the empty state", async () => {
		renderApp("/p/shop-api/add?q=cassandra");
		expect(await screen.findByText("No services match")).toBeInTheDocument();
	});
});

describe("filterCatalog", () => {
	it("filters by category slug and text", () => {
		expect(categoryId(MOCK_CATALOG[0] as (typeof MOCK_CATALOG)[number])).toBe(
			"database",
		);
		expect(filterCatalog(MOCK_CATALOG, "", "redis").map((d) => d.id)).toEqual([
			"redis",
			"upstash-redis",
		]);
		expect(
			filterCatalog(MOCK_CATALOG, "pgvector", "all").map((d) => d.id),
		).toEqual(["postgres"]);
	});

	it("opens the command palette from Quick add", async () => {
		const { user } = renderApp("/p/shop-api/add");
		const quick = await screen.findByRole("button", { name: /Quick add/ });
		expect(quick).toBeEnabled();
		await user.click(quick);
		expect(
			await screen.findByPlaceholderText("Type a service, project or command…"),
		).toBeInTheDocument();
	});
});
