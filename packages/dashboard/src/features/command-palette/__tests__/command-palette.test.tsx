import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useCommandPaletteStore } from "@/features/command-palette/hooks/use-command-palette";
import { renderApp } from "@/test/render-app";

const PLACEHOLDER = "Type a service, project or command…";

const openPalette = async (path: string) => {
	const view = renderApp(path);
	await view.user.click(
		await screen.findByRole("button", { name: /Search or add a service/ }),
	);
	const input = await screen.findByPlaceholderText(PLACEHOLDER);
	const dialog = input.closest("[role=dialog]");
	if (!(dialog instanceof HTMLElement)) throw new Error("no palette dialog");
	return { ...view, input, dialog };
};

const headings = (dialog: HTMLElement) =>
	Array.from(
		dialog.querySelectorAll("[cmdk-group-heading]"),
		(h) => h.textContent,
	);

describe("Command palette", () => {
	it("lists the prototype's groups for the current project", async () => {
		const { dialog } = await openPalette("/p/shop-api");
		await waitFor(() =>
			expect(headings(dialog)).toEqual([
				"Add to shop-api",
				"Services",
				"Projects",
				"Actions",
			]),
		);
		// Services of every project, not just the current one.
		await waitFor(() =>
			expect(within(dialog).getByText("blog, port 3307")).toBeInTheDocument(),
		);
		expect(
			within(dialog).getByText("Export .env for shop-api"),
		).toBeInTheDocument();
	});

	it("adds to the first project and has no Actions outside a project", async () => {
		const { dialog } = await openPalette("/");
		await waitFor(() =>
			expect(headings(dialog)).toEqual([
				"Add to shop-api",
				"Services",
				"Projects",
			]),
		);
	});

	it("navigates to a catalog entry's config page", async () => {
		const { user, input, router } = await openPalette("/p/blog");
		await user.type(input, "redis");
		await waitFor(() =>
			expect(screen.getAllByRole("option")[0]).toHaveTextContent(/^Redis/),
		);
		const [option] = screen.getAllByRole("option");
		if (!option) throw new Error("no option");
		await user.click(option);
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/p/blog/add/redis"),
		);
		expect(screen.queryByPlaceholderText(PLACEHOLDER)).toBeNull();
	});

	it("navigates to a service with the keyboard and shows real CLI commands only", async () => {
		const { user, input, dialog, router } = await openPalette("/p/shop-api");
		await user.type(input, "blog");
		// First match: blog's `db` service (no CLI equivalent → empty footer).
		await waitFor(() =>
			expect(
				within(dialog).getByRole("option", { selected: true }),
			).toHaveTextContent("db"),
		);
		expect(within(dialog).queryByTestId("palette-cli")).toBeNull();
		// Next: the blog project → `locainfra up`.
		await user.keyboard("{ArrowDown}");
		await waitFor(() =>
			expect(within(dialog).getByTestId("palette-cli")).toHaveTextContent(
				"locainfra up",
			),
		);
		await user.keyboard("{ArrowUp}{Enter}");
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/p/blog/s/db"),
		);
	});

	it("highlights the first row again every time it reopens", async () => {
		const { user, input, dialog } = await openPalette("/p/shop-api");
		const firstRow = async () => {
			const options = await within(dialog).findAllByRole("option");
			return options[0];
		};
		await waitFor(async () =>
			expect(within(dialog).getByRole("option", { selected: true })).toBe(
				await firstRow(),
			),
		);
		const initial = within(dialog)
			.getByRole("option", { selected: true })
			.getAttribute("data-value");
		await user.type(input, "blog");
		await user.keyboard("{ArrowDown}");
		await waitFor(() =>
			expect(within(dialog).getByTestId("palette-cli")).toHaveTextContent(
				"locainfra up",
			),
		);
		await user.keyboard("{Escape}");
		await waitFor(() =>
			expect(screen.queryByPlaceholderText(PLACEHOLDER)).toBeNull(),
		);

		useCommandPaletteStore.getState().setOpen(true);
		const reopened = await screen.findByPlaceholderText(PLACEHOLDER);
		const again = reopened.closest("[role=dialog]");
		if (!(again instanceof HTMLElement)) throw new Error("no palette dialog");
		await waitFor(() =>
			expect(
				within(again)
					.getByRole("option", { selected: true })
					.getAttribute("data-value"),
			).toBe(initial),
		);
		expect(within(again).queryByTestId("palette-cli")).toBeNull();
	});

	it("opens the Environment page from Actions with `locainfra env`", async () => {
		const { user, input, dialog, router } = await openPalette("/p/shop-api");
		await user.type(input, "export");
		await waitFor(() =>
			expect(within(dialog).getByTestId("palette-cli")).toHaveTextContent(
				"locainfra env",
			),
		);
		await user.keyboard("{Enter}");
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/p/shop-api/env"),
		);
	});
});
