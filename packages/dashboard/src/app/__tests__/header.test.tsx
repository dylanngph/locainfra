import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render-app";

describe("App header", () => {
	it("renders the LocaStack mark, not the rotated-square placeholder", async () => {
		const { container } = renderApp("/");
		const home = await screen.findByRole("link", { name: "LocaStack" });
		expect(home.querySelector("svg")).not.toBeNull();
		expect(container.querySelector(".rotate-45")).toBeNull();
	});

	it("opens the command palette from the header search", async () => {
		const { user } = renderApp("/");
		const search = await screen.findByRole("button", {
			name: /Search or add a service/,
		});
		expect(search).toBeEnabled();
		await user.click(search);
		expect(
			await screen.findByPlaceholderText("Type a service, project or command…"),
		).toBeInTheDocument();
	});

	it("toggles the palette with ⌘K / Ctrl+K", async () => {
		renderApp("/");
		await screen.findByRole("link", { name: "LocaStack" });
		const press = (init: KeyboardEventInit) => {
			const event = new KeyboardEvent("keydown", {
				key: "k",
				bubbles: true,
				cancelable: true,
				...init,
			});
			fireEvent(window, event);
			return event;
		};
		expect(press({ metaKey: true }).defaultPrevented).toBe(true);
		expect(
			await screen.findByPlaceholderText("Type a service, project or command…"),
		).toBeInTheDocument();
		press({ ctrlKey: true });
		await waitFor(() =>
			expect(
				screen.queryByPlaceholderText("Type a service, project or command…"),
			).toBeNull(),
		);
	});
});
