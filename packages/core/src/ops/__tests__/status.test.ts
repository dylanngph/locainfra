import { describe, expect, test } from "bun:test";
import { getService } from "../get-service.op";
import { listServices } from "../list-services.op";
import { statusForProject } from "../status-for-project.op";
import { classifyContainer } from "../support/service-status";
import { addContainer, createWorld } from "./world";

const summary = {
	id: "c1",
	name: "ls-shop-main-db",
	image: "postgres:17-alpine",
	state: "running",
	labels: {},
	ports: [],
};

describe("classifyContainer", () => {
	test("maps Docker states to dashboard states", () => {
		expect(classifyContainer(undefined)).toEqual({
			state: "stopped",
			health: "none",
			active: false,
		});
		expect(classifyContainer(summary)).toMatchObject({
			state: "running",
			containerId: "c1",
			active: true,
		});
		expect(
			classifyContainer(summary, {
				...summary,
				health: "starting",
				startedAt: "2026-09-23T07:00:00Z",
			}),
		).toMatchObject({ state: "starting", startedAt: "2026-09-23T07:00:00Z" });
		expect(
			classifyContainer(summary, { ...summary, health: "unhealthy" }),
		).toMatchObject({ state: "error", problem: { code: "UNKNOWN" } });
		for (const state of ["created", "restarting"]) {
			expect(classifyContainer({ ...summary, state }).state).toBe("starting");
		}
		for (const state of ["paused", "removing"]) {
			expect(classifyContainer({ ...summary, state }).state).toBe("stopped");
		}
		expect(classifyContainer({ ...summary, state: "dead" }).state).toBe(
			"error",
		);
	});

	test("exit codes: 0/137/143 are stopped, others are errors", () => {
		for (const exitCode of [0, 137, 143]) {
			expect(
				classifyContainer(summary, { ...summary, state: "exited", exitCode })
					.state,
			).toBe("stopped");
		}
		expect(
			classifyContainer(summary, { ...summary, state: "exited", exitCode: 1 }),
		).toMatchObject({
			state: "error",
			problem: { message: "The container exited with code 1." },
		});
		expect(classifyContainer({ ...summary, state: "exited" }).state).toBe(
			"stopped",
		);
	});

	test("a bind failure in State.Error is a port conflict", () => {
		const result = classifyContainer(summary, {
			...summary,
			state: "created",
			error:
				"driver failed programming external connectivity: Bind for 127.0.0.1:5433 failed: port is already allocated",
		});
		expect(result).toMatchObject({
			state: "port-conflict",
			active: false,
			problem: { code: "PORT_CONFLICT" },
		});
	});
});

describe("statusForProject", () => {
	test("joins the stack with its containers, in file order", async () => {
		const world = createWorld({ provisioned: true });
		addContainer(world, "main-db", {
			state: "running",
			health: "healthy",
			startedAt: "2026-09-23T07:00:00Z",
		});
		addContainer(world, "cache", { state: "exited", exitCode: 0 });
		const result = await statusForProject(world, { project: "shop" });
		if (!result.ok) throw result.error;
		expect(result.value.project).toBe("shop");
		expect(result.value.network).toBe("ls-shop");
		expect(result.value.services.map((s) => [s.name, s.state])).toEqual([
			["main-db", "running"],
			["events", "stopped"],
			["cache", "stopped"],
			["rest", "stopped"],
		]);
		expect(result.value.services[0]).toEqual({
			name: "main-db",
			type: "postgres",
			version: "17",
			image: "postgres:17-alpine",
			hostPort: 5433,
			containerPort: 5432,
			containerName: "ls-shop-main-db",
			containerId: "id-main-db",
			persist: "volume",
			state: "running",
			health: "healthy",
			startedAt: "2026-09-23T07:00:00Z",
		});
		expect(result.value.services[1]?.persist).toBe("ephemeral");
		// The running container holds its port; only inactive services are probed.
		expect(world.probe.probed).not.toContain(5433);
	});

	test("a stopped service whose port is busy is port-conflict with a suggestion", async () => {
		const world = createWorld({ provisioned: true, busy: [6380, 6381] });
		const result = await statusForProject(world, { project: "shop" });
		if (!result.ok) throw result.error;
		const cache = result.value.services.find((s) => s.name === "cache");
		expect(cache).toMatchObject({
			state: "port-conflict",
			problem: {
				code: "PORT_CONFLICT",
				message:
					"Port 6380 is already in use by another process on this machine, so the container could not bind.",
				suggestedPort: 6382,
			},
		});
	});

	test("never-started services show port 0 and are not probed", async () => {
		const world = createWorld();
		const result = await statusForProject(world, { project: "shop" });
		if (!result.ok) throw result.error;
		expect(result.value.services.every((s) => s.hostPort === 0)).toBe(true);
		expect(result.value.services.every((s) => s.state === "stopped")).toBe(
			true,
		);
		expect(world.probe.probed).toEqual([]);
		expect(world.state.updates).toBe(0);
		expect(world.secrets.writes).toBe(0);
	});

	test("Docker down is DOCKER_UNREACHABLE; unknown project is PROJECT_NOT_FOUND", async () => {
		const world = createWorld({ provisioned: true });
		world.containers.list = async () => {
			throw new Error("ECONNREFUSED");
		};
		const down = await statusForProject(world, { project: "shop" });
		expect(!down.ok && down.error.code).toBe("DOCKER_UNREACHABLE");
		const missing = await statusForProject(world, { project: "nope" });
		expect(!missing.ok && missing.error.code).toBe("PROJECT_NOT_FOUND");
	});

	test("inspect and probe failures degrade gracefully", async () => {
		const world = createWorld({ provisioned: true });
		addContainer(world, "main-db", { state: "running" });
		world.inspector.inspect = async () => {
			throw new Error("gone");
		};
		world.probe.isFree = async () => {
			throw new Error("probe failed");
		};
		const result = await statusForProject(world, { project: "shop" });
		if (!result.ok) throw result.error;
		expect(result.value.services[0]?.state).toBe("running");
		expect(result.value.services[1]?.state).toBe("stopped");
	});
});

describe("getService and listServices", () => {
	test("detail adds network, config, secret names and volumes", async () => {
		const world = createWorld({ provisioned: true });
		const result = await getService(world, {
			project: "shop",
			name: "main-db",
		});
		if (!result.ok) throw result.error;
		expect(result.value).toMatchObject({
			name: "main-db",
			network: "ls-shop",
			config: { POSTGRES_USER: "postgres", POSTGRES_DB: "shop" },
			secretNames: ["POSTGRES_PASSWORD"],
			volumes: [
				{
					name: "ls-shop-main-db-data",
					source: "data",
					path: "/var/lib/postgresql/data",
				},
			],
		});
		expect(JSON.stringify(result.value)).not.toContain("main-db-password");
		const events = await getService(world, { project: "shop", name: "events" });
		expect(events.ok && events.value.volumes).toEqual([]);
	});

	test("SERVICE_NOT_FOUND for an unknown service", async () => {
		const world = createWorld({ provisioned: true });
		const result = await getService(world, { project: "shop", name: "nope" });
		expect(!result.ok && result.error.code).toBe("SERVICE_NOT_FOUND");
		const project = await getService(world, { project: "nope", name: "x" });
		expect(!project.ok && project.error.code).toBe("PROJECT_NOT_FOUND");
	});

	test("listServices returns every detail in file order", async () => {
		const world = createWorld({ provisioned: true });
		const result = await listServices(world, { project: "shop" });
		if (!result.ok) throw result.error;
		expect(result.value.map((s) => [s.name, s.type, s.hostPort])).toEqual([
			["main-db", "postgres", 5433],
			["events", "postgres", 5434],
			["cache", "redis", 6380],
			["rest", "upstash-redis", 8080],
		]);
		const missing = await listServices(world, { project: "nope" });
		expect(!missing.ok && missing.error.code).toBe("PROJECT_NOT_FOUND");
	});
});
