import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { mockDb } from "@/test/msw/mock-db";
import { recordRequests } from "@/test/msw/record-requests";
import { renderApp } from "@/test/render-app";
import type { ImportItem } from "../api/import.api";
import {
	importLabel,
	itemNote,
	itemPortText,
	nameFromFileName,
	validateImportName,
} from "../lib/import-plan";

const item = (over: Partial<ImportItem>): ImportItem => ({
	composeName: "db",
	name: "db",
	image: "postgres:16",
	type: "postgres",
	supported: true,
	include: true,
	hostPort: 5432,
	wantedPort: 5432,
	config: {},
	secrets: {},
	...over,
});

describe("import plan helpers", () => {
	it("derives a project name from the file name", () => {
		expect(nameFromFileName("docker-compose.yml")).toBeUndefined();
		expect(nameFromFileName("compose.yaml")).toBeUndefined();
		expect(nameFromFileName("shop.docker-compose.yml")).toBe("shop");
		expect(nameFromFileName("docker-compose.blog.yaml")).toBe("blog");
		expect(nameFromFileName("My App.yml")).toBeUndefined();
	});

	it("validates the project name like the prototype", () => {
		expect(validateImportName("", [])).toBe("Project name is required.");
		expect(validateImportName("Shop", [])).toBe(
			"Use lowercase letters, numbers and dashes.",
		);
		expect(validateImportName("blog", ["blog"])).toBe("That name is taken.");
		expect(validateImportName("shop", ["blog"])).toBeUndefined();
	});

	it("labels ports, notes and the import button", () => {
		expect(itemPortText(item({}))).toBe("5432");
		expect(
			itemPortText(
				item({ hostPort: 5434, remapNote: "5432 is used by shop-api/events" }),
			),
		).toBe("5432 → 5434");
		expect(
			itemNote(item({ remapNote: "5432 is used by shop-api/events" })),
		).toBe("Remapped, 5432 is used by shop-api/events");
		expect(itemNote(item({ include: false }))).toBe("Excluded");
		expect(
			itemNote(item({ supported: false, include: false, type: undefined })),
		).toBe("Skipped");
		expect(importLabel(1)).toBe("Import 1 service");
		expect(importLabel(3)).toBe("Import 3 services");
	});
});

describe("Import docker-compose.yml", () => {
	it("previews the sample file, validates the name, toggles services and imports", async () => {
		const previews = recordRequests("POST", /\/api\/import\/preview$/);
		const imports = recordRequests("POST", /\/api\/import$/);
		const { user, router } = renderApp("/");
		await user.click(
			await screen.findByRole("button", { name: "Import docker-compose.yml" }),
		);
		const dialog = await screen.findByRole("dialog");
		expect(
			within(dialog).getByText("Drop your compose file here"),
		).toBeInTheDocument();
		await user.click(
			within(dialog).getByRole("button", { name: "Use sample file" }),
		);

		const review = await within(dialog).findByRole("form", {
			name: "Review import",
		});
		expect(previews).toHaveLength(1);
		expect(within(review).getByText("docker-compose.yml")).toBeInTheDocument();
		expect(
			within(review).getByText("5 services found, 3 will be imported"),
		).toBeInTheDocument();

		const rows = within(review).getAllByRole("row").slice(1);
		expect(rows).toHaveLength(5);
		const [web, db, cache, , mailhog] = rows as HTMLElement[];
		expect(web).toHaveTextContent("Your app, runs outside LocaStack");
		expect(web).toHaveTextContent("Skipped");
		expect(
			within(web as HTMLElement).getByRole("checkbox", { name: "Import web" }),
		).toHaveAttribute("aria-disabled", "true");
		expect(db).toHaveTextContent("PostgreSQL 16");
		expect(db).toHaveTextContent("Remapped, 5432 is used by shop-api/events");
		expect(db).toHaveTextContent("5432 → 5434");
		expect(cache).toHaveTextContent("Redis 7");
		expect(mailhog).toHaveTextContent("No matching service in catalog");

		const name = within(review).getByLabelText("Project name");
		expect(name).toHaveValue("compose-app");
		await user.clear(name);
		expect(
			within(review).getByText("Project name is required."),
		).toBeInTheDocument();
		const submit = within(review).getByRole("button", {
			name: "Import 3 services",
		});
		expect(submit).toHaveAttribute("aria-disabled", "true");
		await user.type(name, "Shop App");
		expect(
			within(review).getByText("Use lowercase letters, numbers and dashes."),
		).toBeInTheDocument();
		await user.clear(name);
		await user.type(name, "blog");
		expect(within(review).getByText("That name is taken.")).toBeInTheDocument();
		await user.clear(name);
		await user.type(name, "shop-compose");
		expect(submit).toHaveAttribute("aria-disabled", "false");

		await user.click(
			within(cache as HTMLElement).getByRole("checkbox", {
				name: "Import cache",
			}),
		);
		expect(cache).toHaveTextContent("Excluded");
		expect(
			within(review).getByText("5 services found, 2 will be imported"),
		).toBeInTheDocument();
		await user.click(within(review).getByRole("switch"));
		await user.click(
			within(review).getByRole("button", { name: "Import 2 services" }),
		);

		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/p/shop-compose"),
		);
		expect(imports).toHaveLength(1);
		const body = imports[0]?.body as {
			name: string;
			root: string;
			start: boolean;
			items: ImportItem[];
		};
		expect(body).toMatchObject({
			name: "shop-compose",
			root: "/Users/dev/Developer/shop-compose",
			start: false,
		});
		expect(
			body.items.map((i) => [i.composeName, i.supported && i.include]),
		).toEqual([
			["web", false],
			["db", true],
			["cache", false],
			["storage", true],
			["mailhog", false],
		]);
		expect(
			mockDb.project("shop-compose")?.services.map((s) => [s.name, s.hostPort]),
		).toEqual([
			["db", 5434],
			["storage", 9000],
		]);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("reads a chosen file and names the project after it", async () => {
		const previews = recordRequests("POST", /\/api\/import\/preview$/);
		const { user } = renderApp("/");
		await user.click(
			await screen.findByRole("button", { name: "Import docker-compose.yml" }),
		);
		const dialog = await screen.findByRole("dialog");
		await user.upload(
			within(dialog).getByLabelText("Compose file"),
			new File(
				["services:\n  db:\n    image: postgres:17-alpine\n"],
				"notes.docker-compose.yml",
				{ type: "application/yaml" },
			),
		);
		const review = await within(dialog).findByRole("form", {
			name: "Review import",
		});
		await waitFor(() =>
			expect(previews[0]?.body).toEqual({
				yaml: "services:\n  db:\n    image: postgres:17-alpine\n",
				projectName: "notes",
			}),
		);
		expect(
			within(review).getByText("notes.docker-compose.yml"),
		).toBeInTheDocument();
		expect(within(review).getByLabelText("Project name")).toHaveValue("notes");
		expect(within(review).getByText("PostgreSQL 17")).toBeInTheDocument();
		await user.click(within(review).getByRole("button", { name: "Back" }));
		expect(
			await within(dialog).findByText("Drop your compose file here"),
		).toBeInTheDocument();
	});

	it("shows the server's error for pasted YAML without services", async () => {
		const { user } = renderApp("/");
		await user.click(
			await screen.findByRole("button", { name: "Import docker-compose.yml" }),
		);
		const dialog = await screen.findByRole("dialog");
		const continueButton = within(dialog).getByRole("button", {
			name: "Continue",
		});
		expect(continueButton).toHaveAttribute("aria-disabled", "true");
		await user.click(
			within(dialog).getByRole("textbox", { name: "Compose YAML" }),
		);
		await user.paste("version: '3'\n");
		await user.click(continueButton);
		expect(await within(dialog).findByRole("alert")).toHaveTextContent(
			"No services found in this file.",
		);
	});
});
