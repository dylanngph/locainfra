import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { mockDb } from "@/test/msw/mock-db";
import { recordRequests } from "@/test/msw/record-requests";
import { renderApp } from "@/test/render-app";
import {
	formatAgo,
	formatSize,
	validateSnapshotName,
} from "../lib/snapshot-format";
import { noSnapshotCopy, snapshotVolumeOf } from "../lib/snapshot-volume";

const NOW = Date.parse("2026-09-23T12:00:00Z");

describe("snapshot formatting", () => {
	it("formats sizes and relative times", () => {
		expect(formatSize(512)).toBe("512 B");
		expect(formatSize(820 * 1024)).toBe("820 KB");
		expect(formatSize(4.5 * 1024 * 1024)).toBe("4.5 MB");
		expect(formatSize(48 * 1024 * 1024)).toBe("48 MB");
		expect(formatSize(1.2 * 1024 ** 3)).toBe("1.2 GB");
		expect(formatAgo("2026-09-23T11:59:40Z", NOW)).toBe("just now");
		expect(formatAgo("2026-09-23T11:55:00Z", NOW)).toBe("5 min ago");
		expect(formatAgo("2026-09-23T09:00:00Z", NOW)).toBe("3 h ago");
		expect(formatAgo("2026-09-22T09:00:00Z", NOW)).toBe("yesterday");
		expect(formatAgo("2026-09-19T12:00:00Z", NOW)).toBe("4 days ago");
	});

	it("accepts an empty name and rejects odd ones", () => {
		expect(validateSnapshotName("")).toBeUndefined();
		expect(validateSnapshotName("before migration.1")).toBeUndefined();
		expect(validateSnapshotName("-dash")).toBeDefined();
		expect(validateSnapshotName("a/b")).toBeDefined();
	});
});

describe("snapshotVolumeOf", () => {
	it("needs persist volume and exactly one catalog volume", () => {
		const one = { volumes: [{ name: "data", path: "/data" }] };
		expect(snapshotVolumeOf({ persist: "volume" }, one)).toBe("ok");
		expect(snapshotVolumeOf({ persist: "volume" }, undefined)).toBe("ok");
		expect(snapshotVolumeOf({ persist: "ephemeral" }, one)).toBe("ephemeral");
		expect(snapshotVolumeOf({ persist: "volume" }, { volumes: [] })).toBe(
			"none",
		);
		expect(
			snapshotVolumeOf(
				{ persist: "volume" },
				{ volumes: [...one.volumes, { name: "logs", path: "/logs" }] },
			),
		).toBe("several");
		expect(noSnapshotCopy("rest", "none")).toBe(
			"rest keeps no data volume to snapshot.",
		);
	});
});

describe("Snapshots tab", () => {
	it("lists snapshots newest first with size and age", async () => {
		renderApp("/p/shop-api/s/main-db?tab=snapshots");
		const list = await screen.findByRole("list", { name: "Snapshots" });
		const rows = await within(list).findAllByRole("listitem");
		expect(rows.map((r) => r.textContent)).toEqual([
			expect.stringContaining("before-migration48 MB, created 2 h ago"),
			expect.stringContaining("clean-seed12 MB, created yesterday"),
		]);
	});

	it("shows the empty state and creates a named snapshot", async () => {
		const calls = recordRequests("POST", /\/snapshots$/);
		const { user } = renderApp("/p/blog/s/db?tab=snapshots");
		expect(
			await screen.findByText(
				"No snapshots yet. Snapshots copy this service's volume so you can roll back data.",
			),
		).toBeInTheDocument();
		const name = screen.getByRole("textbox", { name: "Snapshot name" });
		await user.type(name, "-bad");
		expect(
			screen.getByText(/Start with a letter or digit/),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Create snapshot" }),
		).toBeDisabled();
		await user.clear(name);
		await user.type(name, "before-deploy{Enter}");
		await waitFor(() =>
			expect(calls).toEqual([
				{
					url: "/api/projects/blog/services/db/snapshots",
					body: { name: "before-deploy" },
				},
			]),
		);
		expect(name).toHaveValue("");
		expect(
			await screen.findByText("Creating snapshot “before-deploy” of db…"),
		).toBeInTheDocument();
		// The list is refetched once the op settles.
		const list = await screen.findByRole(
			"list",
			{ name: "Snapshots" },
			{ timeout: 3000 },
		);
		expect(
			await within(list).findByText("before-deploy", {}, { timeout: 3000 }),
		).toBeInTheDocument();
	});

	it("confirms before restoring, then restores", async () => {
		const calls = recordRequests("POST", /\/restore$/);
		const { user } = renderApp("/p/shop-api/s/main-db?tab=snapshots");
		await user.click(
			await screen.findByRole("button", { name: "Restore clean-seed" }),
		);
		const dialog = await screen.findByRole("alertdialog");
		expect(
			within(dialog).getByRole("heading", { name: "Restore “clean-seed”?" }),
		).toBeInTheDocument();
		expect(dialog).toHaveTextContent(
			"This stops main-db and replaces its data with the snapshot from yesterday.",
		);
		await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		expect(calls).toEqual([]);

		await user.click(
			screen.getByRole("button", { name: "Restore clean-seed" }),
		);
		await user.click(
			within(await screen.findByRole("alertdialog")).getByRole("button", {
				name: "Restore snapshot",
			}),
		);
		await waitFor(() =>
			expect(calls.map((c) => c.url)).toEqual([
				"/api/projects/shop-api/services/main-db/snapshots/s1/restore",
			]),
		);
		expect(
			await screen.findByText("Restoring main-db to “clean-seed”…"),
		).toBeInTheDocument();
	});

	it("refetches the Data tab's tables once a restore settles", async () => {
		const lists = recordRequests("GET", /\/services\/main-db\/data$/);
		const { user } = renderApp("/p/shop-api/s/main-db?tab=data");
		const tables = await screen.findByRole("navigation", { name: "Tables" });
		await within(tables).findByRole("button", { name: "orders" });
		expect(lists).toHaveLength(1);
		await user.click(screen.getByRole("tab", { name: "Snapshots" }));
		await user.click(
			await screen.findByRole("button", { name: "Restore clean-seed" }),
		);
		await user.click(
			within(await screen.findByRole("alertdialog")).getByRole("button", {
				name: "Restore snapshot",
			}),
		);
		expect(
			await screen.findByText(
				"Restored main-db to “clean-seed”",
				{},
				{ timeout: 3000 },
			),
		).toBeInTheDocument();
		await user.click(screen.getByRole("tab", { name: "Data" }));
		await waitFor(() => expect(lists).toHaveLength(2));
	});

	it("deletes a snapshot after confirming", async () => {
		const { user } = renderApp("/p/shop-api/s/main-db?tab=snapshots");
		await user.click(
			await screen.findByRole("button", { name: "Delete before-migration" }),
		);
		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent("The 48 MB archive is deleted from disk.");
		await user.click(
			within(dialog).getByRole("button", { name: "Delete snapshot" }),
		);
		await waitFor(() =>
			expect(
				screen.queryByRole("button", { name: "Restore before-migration" }),
			).toBeNull(),
		);
		expect(screen.getByText("Deleted “before-migration”")).toBeInTheDocument();
	});

	it("seeds from the entry's seed file", async () => {
		const calls = recordRequests("POST", /\/seed$/);
		const { user } = renderApp("/p/shop-api/s/main-db?tab=snapshots");
		await user.click(
			await screen.findByRole("button", { name: "Seed from ./db/seed.sql" }),
		);
		await waitFor(() =>
			expect(calls.map((c) => c.url)).toEqual([
				"/api/projects/shop-api/services/main-db/seed",
			]),
		);
		expect(
			await screen.findByText("Seeding main-db from ./db/seed.sql…"),
		).toBeInTheDocument();
	});

	it("has no Seed button without a seed file", async () => {
		renderApp("/p/shop-api/s/cache?tab=snapshots");
		await screen.findByRole("list", { name: "Snapshots" });
		expect(screen.queryByRole("button", { name: /Seed from/ })).toBeNull();
	});

	it("hides the tab for a volume-less type even when persist is volume (Upstash)", async () => {
		const rest = mockDb
			.project("shop-api")
			?.services.find((s) => s.name === "rest");
		if (rest) rest.persist = "volume";
		renderApp("/p/shop-api/s/rest?tab=snapshots");
		const tabs = await screen.findByRole("tablist");
		await waitFor(() =>
			expect(within(tabs).queryByRole("tab", { name: "Snapshots" })).toBeNull(),
		);
		expect(
			screen.queryByRole("button", { name: "Create snapshot" }),
		).toBeNull();
	});

	it("hides the tab for an ephemeral service whose type cannot seed", async () => {
		renderApp("/p/shop-api/s/rest?tab=snapshots");
		const tabs = await screen.findByRole("tablist");
		await waitFor(() =>
			expect(within(tabs).queryByRole("tab", { name: "Snapshots" })).toBeNull(),
		);
	});
});
