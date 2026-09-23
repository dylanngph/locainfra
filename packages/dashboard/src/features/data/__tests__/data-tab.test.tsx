import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordRequests } from "@/test/msw/record-requests";
import { renderApp } from "@/test/render-app";
import { csvFileName, toCsv } from "../lib/csv";

describe("CSV export helpers", () => {
	it("quotes cells with commas, quotes, newlines and edge spaces", () => {
		expect(
			toCsv(
				["id", "name"],
				[
					["1", 'Poster "Local"'],
					["2", "a,b"],
					["3", "two\nlines"],
					["4", " padded"],
					["5", ""],
				],
			),
		).toBe(
			'id,name\r\n1,"Poster ""Local"""\r\n2,"a,b"\r\n3,"two\nlines"\r\n4," padded"\r\n5,\r\n',
		);
	});

	it("names the file after the object, falling back to the service", () => {
		expect(csvFileName("users", "main-db")).toBe("users.csv");
		expect(csvFileName("*", "cache")).toBe("cache.csv");
		expect(csvFileName("session:*", "cache")).toBe("session.csv");
		expect(csvFileName(undefined, "cache")).toBe("cache.csv");
	});
});

describe("Data tab", () => {
	afterEach(() => vi.restoreAllMocks());

	it("lists tables, prefills the default query and runs it", async () => {
		const { user } = renderApp("/p/shop-api/s/main-db?tab=data");
		const tables = await screen.findByRole("navigation", { name: "Tables" });
		const orders = await within(tables).findByRole("button", {
			name: "orders",
		});
		expect(orders).toHaveAttribute("aria-pressed", "true");
		const editor = screen.getByRole("textbox", { name: "Query" });
		expect(editor).toHaveValue('SELECT *\nFROM "orders"\nLIMIT 100;');
		expect(screen.getByText("Run a query to see results")).toBeInTheDocument();

		await user.click(within(tables).getByRole("button", { name: "users" }));
		expect(editor).toHaveValue('SELECT *\nFROM "users"\nLIMIT 100;');
		await user.click(screen.getByRole("button", { name: "Run" }));

		const grid = await screen.findByRole("table", { name: "Query results" });
		expect(
			within(grid)
				.getAllByRole("columnheader")
				.map((h) => h.textContent),
		).toEqual(["id", "email", "created_at"]);
		expect(within(grid).getAllByRole("row")).toHaveLength(4);
		expect(within(grid).getByText("ada@example.com")).toBeInTheDocument();
		expect(screen.getByText(/^3 rows in \d+ ms$/)).toBeInTheDocument();
	});

	it("refetches the table list once after a successful Run", async () => {
		const lists = recordRequests("GET", /\/services\/main-db\/data$/);
		const { user } = renderApp("/p/shop-api/s/main-db?tab=data");
		const tables = await screen.findByRole("navigation", { name: "Tables" });
		await within(tables).findByRole("button", { name: "orders" });
		expect(lists).toHaveLength(1);
		await user.click(screen.getByRole("button", { name: "Run" }));
		await screen.findByRole("table", { name: "Query results" });
		await waitFor(() => expect(lists).toHaveLength(2));
	});

	it("runs with ⌘↵ and shows the engine's error in a card", async () => {
		const { user } = renderApp("/p/shop-api/s/main-db?tab=data");
		const editor = await screen.findByRole("textbox", { name: "Query" });
		await screen.findByRole("button", { name: "orders" });
		await user.clear(editor);
		await user.type(editor, "SELECT * FROM nope");
		await user.keyboard("{Meta>}{Enter}{/Meta}");
		expect(await screen.findByRole("alert")).toHaveTextContent(
			'ERROR: relation "nope" does not exist',
		);
		expect(screen.queryByRole("table", { name: "Query results" })).toBeNull();
		expect(screen.queryByRole("button", { name: /Export CSV/ })).toBeNull();
	});

	it("exports the result as CSV in the browser", async () => {
		const blobs: Blob[] = [];
		const create = vi
			.spyOn(URL, "createObjectURL")
			.mockImplementation((blob) => {
				blobs.push(blob as Blob);
				return "blob:mock";
			});
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		const click = vi
			.spyOn(HTMLAnchorElement.prototype, "click")
			.mockImplementation(() => {});
		const { user } = renderApp("/p/shop-api/s/main-db?tab=data");
		await user.click(await screen.findByRole("button", { name: "products" }));
		await user.click(screen.getByRole("button", { name: "Run" }));
		await screen.findByRole("table", { name: "Query results" });
		await user.click(screen.getByRole("button", { name: "Export CSV" }));

		expect(create).toHaveBeenCalledTimes(1);
		expect(click).toHaveBeenCalledTimes(1);
		const anchor = click.mock.contexts[0] as HTMLAnchorElement;
		expect(anchor.download).toBe("products.csv");
		expect(blobs[0]?.type).toBe("text/csv");
		expect(await blobs[0]?.text()).toBe(
			'id,name,price\r\n1,"Mug, large",12.00\r\n2,"Poster ""Local""",25.00\r\n',
		);
		expect(
			await screen.findByText("Exported 2 rows to products.csv"),
		).toBeInTheDocument();
	});

	it("uses key patterns for Redis", async () => {
		const { user } = renderApp("/p/shop-api/s/cache?tab=data");
		const patterns = await screen.findByRole("navigation", {
			name: "Key patterns",
		});
		await within(patterns).findByRole("button", { name: "*" });
		expect(screen.getByRole("textbox", { name: "Query" })).toHaveValue(
			"SCAN 0 MATCH * COUNT 100",
		);
		await user.click(screen.getByRole("button", { name: "Run" }));
		const grid = await screen.findByRole("table", { name: "Query results" });
		expect(within(grid).getByText("session:ada")).toBeInTheDocument();
		expect(screen.getByText(/^4 rows in/)).toBeInTheDocument();
	});

	it("guards a service that is not running", async () => {
		renderApp("/p/shop-api/s/events?tab=data");
		expect(
			await screen.findByText(
				"events is not running. Start it to run queries.",
			),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
	});

	it("is hidden when the catalog's data.kind is none", async () => {
		renderApp("/p/shop-api/s/rest?tab=data");
		const tabs = await screen.findByRole("tablist");
		await waitFor(() =>
			expect(within(tabs).queryByRole("tab", { name: "Data" })).toBeNull(),
		);
		expect(within(tabs).getByRole("tab", { name: "Connect" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
	});
});
