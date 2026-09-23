import { describe, expect, test } from "bun:test";
import { DockerClient } from "../docker-client";
import { DockerSocketLocator } from "../socket-locator";
import { UnixSocketTransport } from "../unix-socket-transport";

// READ ONLY: these tests only call GET /version and GET /containers/json.
const socket = await new DockerSocketLocator().locate();
const dockerAvailable =
	socket !== null &&
	(await fetch("http://localhost/_ping", { unix: socket })
		.then((r) => r.ok)
		.catch(() => false));

describe.skipIf(!dockerAvailable)("DockerClient (live, read-only)", () => {
	const client = new DockerClient(
		new UnixSocketTransport({ socketPath: socket ?? "" }),
	);

	test("info() reports the daemon", async () => {
		const info = await client.info();
		expect(info.serverVersion).toMatch(/^\d+\.\d+/);
		expect(info.apiVersion).toMatch(/^\d+\.\d+$/);
		expect(info.os).toBe("linux");
	});

	test("list() filters by compose project label", async () => {
		const containers = await client.list({
			labels: { "com.docker.compose.project": "local-infra" },
		});
		for (const container of containers) {
			expect(container.labels["com.docker.compose.project"]).toBe(
				"local-infra",
			);
			expect(container.name.startsWith("/")).toBe(false);
			expect(["healthy", "unhealthy", "starting", "none"]).toContain(
				container.health ?? "none",
			);
		}
		const none = await client.list({
			labels: { "com.docker.compose.project": "li-no-such-project-xyz" },
		});
		expect(none).toEqual([]);
	});
});
