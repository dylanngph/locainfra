import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render-app";

describe("Service detail", () => {
	it("shows the published host as 127.0.0.1, not localhost", async () => {
		renderApp("/p/shop-api/s/main-db");
		expect(await screen.findByText("127.0.0.1:5433")).toBeInTheDocument();
		expect(screen.queryByText(/localhost:/)).toBeNull();
	});

	it("hides the CLI hint while the service runs", async () => {
		renderApp("/p/shop-api/s/main-db");
		await screen.findByText("127.0.0.1:5433");
		expect(screen.queryByText(/locainfra up --service/)).toBeNull();
		expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
	});

	it("shows `up --service` for a stopped service with a short folder", async () => {
		renderApp("/p/shop-api/s/rest");
		expect(
			await screen.findByText("locainfra up --service rest"),
		).toHaveAttribute(
			"title",
			"cd '/Users/dev/Developer/shop-api' && locainfra up --service rest",
		);
		expect(screen.getByText("…/shop-api")).toHaveAttribute(
			"title",
			"/Users/dev/Developer/shop-api",
		);
	});

	it("shows `up --service` for a port conflict", async () => {
		renderApp("/p/shop-api/s/events");
		expect(
			await screen.findByText("locainfra up --service events"),
		).toBeInTheDocument();
	});
});
