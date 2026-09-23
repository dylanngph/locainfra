import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render-app";
import { validateProjectName } from "../components/new-project-card";
import { suggestedRoot } from "../lib/project-health";

describe("Projects page", () => {
	it("renders a card per project from the API", async () => {
		renderApp("/");
		const shop = await screen.findByRole("article", { name: "shop-api" });
		expect(within(shop).getByText("4 services")).toBeInTheDocument();
		expect(within(shop).getByText("2/4 running, 1 error")).toBeInTheDocument();
		expect(
			within(shop).getByRole("button", { name: "Stop all" }),
		).toBeInTheDocument();

		const blog = screen.getByRole("article", { name: "blog" });
		expect(within(blog).getByText("Stopped")).toBeInTheDocument();
		expect(within(blog).getByText("Not running")).toBeInTheDocument();

		const scratch = screen.getByRole("article", { name: "scratch" });
		expect(within(scratch).getByText("No services")).toBeInTheDocument();
		expect(
			screen.getByText("3 projects, 2 containers running"),
		).toBeInTheDocument();
	});

	it("shows — for CPU/MEM when the list carries no usage, never 0", async () => {
		renderApp("/");
		const shop = await screen.findByRole("article", { name: "shop-api" });
		expect(within(shop).getAllByText("—")).toHaveLength(2);
		expect(within(shop).queryByText("0.0%")).toBeNull();
		expect(within(shop).queryByText("0 MB")).toBeNull();
	});

	it("validates and creates a new project inline", async () => {
		const { user, router } = renderApp("/");
		await user.click(
			(
				await screen.findAllByRole("button", { name: "New project" })
			)[0] as HTMLElement,
		);
		const form = screen.getByRole("form", { name: "New project" });
		const name = within(form).getByLabelText("Project name");
		await user.type(name, "Shop");
		expect(
			within(form).getByText("Use lowercase letters, numbers and dashes."),
		).toBeInTheDocument();
		await user.clear(name);
		await user.type(name, "blog");
		expect(within(form).getByText("That name is taken.")).toBeInTheDocument();
		await user.clear(name);
		await user.type(name, "notes");
		await user.click(within(form).getByRole("button", { name: "Choose…" }));
		expect(
			await within(form).findByDisplayValue("/Users/dev/Developer/notes"),
		).toBeInTheDocument();
		await user.click(within(form).getByRole("button", { name: "Create" }));
		await screen.findByRole("heading", { name: "notes" });
		expect(router.state.location.pathname).toBe("/p/notes");
	});
});

describe("?project= from `locainfra --project`", () => {
	it("opens the preselected project", async () => {
		const { router } = renderApp("/?project=blog");
		await waitFor(() => expect(router.state.location.pathname).toBe("/p/blog"));
	});
});

describe("project helpers", () => {
	it("validates names", () => {
		expect(validateProjectName("", [])).toBe("Name is required.");
		expect(validateProjectName("9lives", [])).toMatch(/lowercase/);
		expect(validateProjectName("shop", ["shop"])).toBe("That name is taken.");
		expect(validateProjectName("shop-2", ["shop"])).toBeUndefined();
	});

	it("suggests a folder next to existing projects", () => {
		expect(suggestedRoot("app", ["/Users/me/Developer/shop"])).toBe(
			"/Users/me/Developer/app",
		);
		expect(suggestedRoot("app", [])).toBe("~/Developer/app");
	});
});
