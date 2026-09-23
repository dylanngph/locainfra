import { describe, expect, it } from "bun:test";
import { collect } from "../collect";
import {
	FakeContainerExec,
	FakeSnapshotIndex,
	FakeVolumeArchiver,
} from "../data-fakes";

const OPTIONS = { timeoutMs: 15_000, maxBytes: 1024 };

describe("FakeContainerExec", () => {
	it("records calls and answers by command name", async () => {
		const exec = new FakeContainerExec();
		exec.scripts.set("psql", { stdout: "a\n1\n" });
		const result = await exec.run("c1", ["psql", "-c", "SELECT 1"], OPTIONS);
		expect(result).toEqual({
			exitCode: 0,
			stdout: "a\n1\n",
			stderr: "",
			truncated: false,
			timedOut: false,
		});
		expect(exec.calls[0]?.argv).toEqual(["psql", "-c", "SELECT 1"]);
	});

	it("rejects with a scripted error", async () => {
		const exec = new FakeContainerExec();
		exec.defaultScript = new Error("no such container");
		await expect(exec.run("c1", ["x"], OPTIONS)).rejects.toThrow(
			"no such container",
		);
	});
});

describe("FakeVolumeArchiver", () => {
	it("registers a written archive and removes it", async () => {
		const archiver = new FakeVolumeArchiver();
		const signal = new AbortController().signal;
		const events = await collect(archiver.archive("vol", "/s/a.tgz", signal));
		expect(events.at(-1)?.kind).toBe("done");
		expect(await archiver.sizeOf("/s/a.tgz")).toBe(1024);
		await archiver.removeArchive("/s/a.tgz");
		await expect(archiver.sizeOf("/s/a.tgz")).rejects.toThrow();
	});

	it("writes no archive when the script fails", async () => {
		const archiver = new FakeVolumeArchiver();
		archiver.archiveScript = [{ kind: "error", message: "tar failed" }];
		const signal = new AbortController().signal;
		await collect(archiver.archive("vol", "/s/b.tgz", signal));
		expect(archiver.archives.has("/s/b.tgz")).toBe(false);
	});
});

describe("FakeSnapshotIndex", () => {
	it("lists one service's rows newest first and deletes by id", async () => {
		const row = (id: string, service: string, createdAt: string) => ({
			id,
			project: "shop",
			service,
			name: id,
			path: `/s/${id}.tgz`,
			sizeBytes: 1,
			createdAt,
		});
		const index = new FakeSnapshotIndex([
			row("a", "db", "2026-09-01T00:00:00.000Z"),
			row("b", "db", "2026-09-02T00:00:00.000Z"),
			row("c", "cache", "2026-09-03T00:00:00.000Z"),
		]);
		expect((await index.list("shop", "db")).map((r) => r.id)).toEqual([
			"b",
			"a",
		]);
		await expect(index.insert(row("a", "db", "x"))).rejects.toThrow();
		expect(await index.delete("a")).toBe(true);
		expect(await index.get("a")).toBeNull();
	});
});
