import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MOCK_CATALOG } from "@/test/msw/catalog.fixture";
import { mockDb } from "@/test/msw/mock-db";
import { recordRequests } from "@/test/msw/record-requests";
import { renderApp } from "@/test/render-app";
import {
	buildDefaults,
	type ConfigContext,
	toAddBody,
} from "../lib/config-form";
import { yamlToEntry } from "../lib/entry-yaml";
import { generateSecret, SECRET_VALUE_PATTERN } from "../lib/secret";
import { normalizeSeedPath, validateSeedPath } from "../lib/seed-path";

const postgres = MOCK_CATALOG.find((d) => d.id === "postgres");
if (!postgres) throw new Error("fixture");
const ctx: ConfigContext = {
	project: "shop-api",
	definition: postgres,
	services: [],
};

describe("client-side secrets", () => {
	it("generates 43-character url-safe secrets", () => {
		const a = generateSecret();
		const b = generateSecret();
		expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(a).toMatch(SECRET_VALUE_PATTERN);
		expect(a).not.toBe(b);
	});

	it("sends only the definition's regenerated secrets", () => {
		const values = buildDefaults(ctx);
		expect(toAddBody(values, ctx)).not.toHaveProperty("secrets");
		expect(
			toAddBody(
				{
					...values,
					secrets: { POSTGRES_PASSWORD: "x".repeat(20), OTHER: "y" },
				},
				ctx,
			).secrets,
		).toEqual({ POSTGRES_PASSWORD: "x".repeat(20) });
	});
});

describe("seed paths", () => {
	it("accepts project-relative paths only", () => {
		expect(validateSeedPath("")).toBeUndefined();
		expect(validateSeedPath("./seed.sql")).toBeUndefined();
		expect(validateSeedPath("db/seed.sql")).toBeUndefined();
		for (const bad of [
			"/etc/passwd",
			"../x.sql",
			"db/../../x",
			"~/x.sql",
			"C:x",
		])
			expect(validateSeedPath(bad), bad).toBe(
				"Use a path inside the project folder, e.g. db/seed.sql.",
			);
		expect(normalizeSeedPath(" ./db/seed.sql ")).toBe("db/seed.sql");
	});

	it("round-trips seed through the stack entry and the YAML editor", () => {
		const values = { ...buildDefaults(ctx), seed: "./db/seed.sql" };
		expect(toAddBody(values, ctx)).toMatchObject({ seed: "db/seed.sql" });
		expect(
			yamlToEntry("services:\n  db:\n    seed: db/init.sql\n", "postgres"),
		).toMatchObject({ ok: true, seed: "db/init.sql" });
	});
});

describe("Config page: Regenerate and Seed file", () => {
	it("regenerates the password client-side and sends it as secrets on Add", async () => {
		const adds = recordRequests("POST", /\/api\/projects\/shop-api\/services$/);
		const { user, router } = renderApp("/p/shop-api/add/postgres");
		const password = await screen.findByLabelText("Password");
		expect(password).toHaveValue("");
		expect(password).toHaveAttribute("readonly");
		expect(password).toHaveAttribute("placeholder", "generated on create");
		await user.click(
			screen.getByRole("button", { name: "Regenerate password" }),
		);
		const first = (password as HTMLInputElement).value;
		expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
		await user.click(
			screen.getByRole("button", { name: "Regenerate password" }),
		);
		const chosen = (password as HTMLInputElement).value;
		expect(chosen).not.toBe(first);
		// Secrets never go into locainfra.yaml.
		const editor = screen.getByLabelText("locainfra.yaml entry");
		expect((editor as HTMLTextAreaElement).value).not.toContain(chosen);

		await user.click(screen.getByRole("button", { name: "Add & start" }));
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/p/shop-api/s/db"),
		);
		expect(adds[0]?.body).toMatchObject({
			name: "db",
			type: "postgres",
			secrets: { POSTGRES_PASSWORD: chosen },
		});
		expect(
			mockDb.project("shop-api")?.services.find((s) => s.name === "db")
				?.secrets,
		).toEqual({ POSTGRES_PASSWORD: chosen });
	});

	it("shows Seed file for databases with a seed block and sends it", async () => {
		const adds = recordRequests("POST", /\/api\/projects\/shop-api\/services$/);
		const { user, router } = renderApp("/p/shop-api/add/postgres");
		const seed = await screen.findByLabelText(/Seed file/);
		expect(seed).toHaveAttribute("placeholder", "./seed.sql");
		expect(screen.getByText(/Mounted read-only at/).textContent).toContain(
			"/docker-entrypoint-initdb.d/seed.sql",
		);
		await user.type(seed, "../outside.sql");
		expect(
			screen.getByText(
				"Use a path inside the project folder, e.g. db/seed.sql.",
			),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Add & start" })).toHaveAttribute(
			"aria-disabled",
			"true",
		);
		await user.clear(seed);
		await user.type(seed, "./db/seed.sql");
		const editor = screen.getByLabelText("locainfra.yaml entry");
		expect((editor as HTMLTextAreaElement).value).toContain(
			"seed: db/seed.sql",
		);
		await user.click(screen.getByRole("button", { name: "Add & start" }));
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/p/shop-api/s/db"),
		);
		expect(adds[0]?.body).toMatchObject({ seed: "db/seed.sql" });
		expect(adds[0]?.body).not.toHaveProperty("secrets");
	});

	it("has no Seed file for types without a seed block", async () => {
		renderApp("/p/shop-api/add/redis");
		await screen.findByLabelText("Password");
		expect(screen.queryByLabelText(/Seed file/)).toBeNull();
	});
});
