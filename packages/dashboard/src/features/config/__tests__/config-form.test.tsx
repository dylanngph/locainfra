import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MOCK_CATALOG } from "@/test/msw/catalog.fixture";
import { renderApp } from "@/test/render-app";
import {
	buildDefaults,
	type ConfigContext,
	configLabel,
	toStackEntry,
	validateHostPort,
	validateInstanceName,
} from "../lib/config-form";

const postgres = MOCK_CATALOG.find((d) => d.id === "postgres");
if (!postgres) throw new Error("fixture");
const ctx: ConfigContext = {
	project: "shop-api",
	definition: postgres,
	services: [
		{ name: "main-db", hostPort: 5433 },
		{ name: "events", hostPort: 5432 },
	],
};

describe("config form rules", () => {
	it("validates the instance name pattern and uniqueness", () => {
		expect(validateInstanceName("", ctx)).toBe("Name is required.");
		expect(validateInstanceName("Main", ctx)).toBe(
			"Use lowercase letters, numbers and dashes.",
		);
		expect(validateInstanceName("1db", ctx)).toBe(
			"Use lowercase letters, numbers and dashes.",
		);
		expect(validateInstanceName("main-db", ctx)).toMatch(
			/already exists in shop-api/,
		);
		expect(validateInstanceName("orders-db", ctx)).toBeUndefined();
	});

	it("validates the port range and in-project conflicts", () => {
		expect(validateHostPort("80", ctx)).toBe(
			"Port must be between 1024 and 65535, or auto.",
		);
		expect(validateHostPort("70000", ctx)).toBe(
			"Port must be between 1024 and 65535, or auto.",
		);
		expect(validateHostPort("54a", ctx)).toBe(
			"Port must be between 1024 and 65535, or auto.",
		);
		expect(validateHostPort("5433", ctx)).toBe(
			"Port 5433 is in use by main-db.",
		);
		expect(validateHostPort("5440", ctx)).toBeUndefined();
		expect(validateHostPort("auto", ctx)).toBeUndefined();
	});

	it("builds defaults with a free port and resolved config", () => {
		const values = buildDefaults(ctx);
		expect(values).toMatchObject({
			name: "db",
			version: "17",
			port: "5434",
			persist: "volume",
			config: { POSTGRES_USER: "postgres", POSTGRES_DB: "shop-api" },
		});
		expect(toStackEntry(values, ctx)).toEqual({
			type: "postgres",
			version: "17",
			port: 5434,
			persist: "volume",
		});
		expect(
			toStackEntry(
				{ ...values, config: { ...values.config, POSTGRES_DB: "shop" } },
				ctx,
			),
		).toMatchObject({ config: { POSTGRES_DB: "shop" } });
		expect(buildDefaults({ ...ctx, suggestedPort: 5440 }).port).toBe("5440");
		expect(buildDefaults({ ...ctx, suggestedPort: 5433 }).port).toBe("5434");
		expect(toStackEntry({ ...values, port: "auto" }, ctx)).toMatchObject({
			port: "auto",
		});
		expect(configLabel("POSTGRES_DB")).toBe("Database");
		expect(configLabel("POSTGRES_USER")).toBe("User");
	});
});

describe("Config page", () => {
	it("shows name and port errors and offers a free port", async () => {
		const { user } = renderApp("/p/shop-api/add/postgres");
		const name = await screen.findByLabelText("Name");
		expect(name).toHaveValue("db");
		const submit = screen.getByRole("button", { name: "Add & start" });
		expect(submit).toHaveAttribute("aria-disabled", "false");

		await user.clear(name);
		await user.type(name, "Orders DB");
		expect(
			screen.getByText("Use lowercase letters, numbers and dashes."),
		).toBeInTheDocument();
		expect(submit).toHaveAttribute("aria-disabled", "true");
		await user.clear(name);
		await user.type(name, "orders");

		const port = screen.getByLabelText("Host port");
		await user.clear(port);
		await user.type(port, "80");
		expect(
			screen.getByText("Port must be between 1024 and 65535, or auto."),
		).toBeInTheDocument();

		await user.clear(port);
		await user.type(port, "5433");
		const alert = screen
			.getByText("Port 5433 is in use by main-db.")
			.closest("[role=alert]");
		expect(alert).not.toBeNull();
		await user.click(
			within(alert as HTMLElement).getByRole("button", { name: "Use 5434" }),
		);
		expect(port).toHaveValue("5434");
		expect(submit).toHaveAttribute("aria-disabled", "false");
	});

	it("round-trips the YAML side editor into the form", async () => {
		const { user } = renderApp("/p/shop-api/add/postgres");
		const editor = await screen.findByLabelText("locainfra.yaml entry");
		expect((editor as HTMLTextAreaElement).value).toContain(
			"db:\n    type: postgres",
		);
		await user.clear(editor);
		await user.click(editor);
		await user.paste(
			'services:\n  analytics:\n    type: postgres\n    version: "16"\n    port: 5500\n    persist: ephemeral\n',
		);
		await waitFor(() =>
			expect(screen.getByLabelText("Name")).toHaveValue("analytics"),
		);
		expect(screen.getByLabelText("Host port")).toHaveValue("5500");
		expect(
			screen.getByText("Data is wiped every time the container is removed."),
		).toBeInTheDocument();
	});

	it("adds the service and opens its detail page", async () => {
		const { user, router } = renderApp("/p/shop-api/add/redis");
		const name = await screen.findByLabelText("Name");
		await user.clear(name);
		await user.type(name, "queue-cache");
		await user.click(screen.getByRole("button", { name: "Add & start" }));
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/p/shop-api/s/queue-cache"),
		);
	});
});
