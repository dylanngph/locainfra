import { describe, expect, test } from "bun:test";
import type { ServiceDefinition } from "../../catalog/catalog.model";
import type { StateFile } from "../../ports/state.port";
import { OpError } from "../../shared/op-error";
import type { Stack } from "../../stack/stack.model";
import {
	builtinTestDefinitions,
	createProjectStack,
	redisDefinition,
} from "../../testing/catalog-fixtures";
import {
	FakePortProbe,
	FixedClock,
	InMemoryStateStore,
} from "../../testing/fakes";
import { planStack } from "../plan";
import {
	allocatePorts,
	MAX_PORT_ALLOCATION_ATTEMPTS,
} from "../ports/allocator";
import { portsInRange } from "../ports/ranges";

function setup(busy: number[] = [], initial?: StateFile) {
	const probe = new FakePortProbe(busy);
	const state = new InMemoryStateStore(initial);
	const clock = new FixedClock("2026-09-23T10:00:00.000Z");
	return { probe, state, clock };
}

async function run(
	deps: ReturnType<typeof setup>,
	stack: Stack,
	definitions: readonly ServiceDefinition[] = builtinTestDefinitions,
) {
	const plan = planStack(stack, definitions);
	if (!plan.ok) throw plan.error;
	return allocatePorts(deps, { stack, services: plan.value });
}

describe("allocatePorts", () => {
	test("picks the lowest free, non-reserved port and pins it", async () => {
		const deps = setup([5433, 5435], {
			projects: [],
			stacks: {
				other: { ports: { postgres: 5434 }, createdAt: "2026-01-01T00:00:00Z" },
			},
		});
		const result = await run(
			deps,
			createProjectStack("app", { postgres: { type: "postgres" } }),
		);
		// 5432 is the canonical port (never auto-picked), 5433/5435 busy, 5434 reserved by "other".
		expect(result).toEqual({ ok: true, value: { postgres: 5436 } });
		expect(deps.state.state.stacks.app).toEqual({
			ports: { postgres: 5436 },
			createdAt: "2026-09-23T10:00:00.000Z",
		});
		expect(deps.probe.probed).toEqual([5433, 5435, 5436]);
	});

	test("reuses the pinned port without probing it", async () => {
		const deps = setup([5440], {
			projects: [],
			stacks: {
				app: { ports: { postgres: 5440 }, createdAt: "2026-01-01T00:00:00Z" },
			},
		});
		const result = await run(
			deps,
			createProjectStack("app", { postgres: { type: "postgres" } }),
		);
		expect(result).toEqual({ ok: true, value: { postgres: 5440 } });
		expect(deps.probe.probed).toEqual([]);
		expect(deps.state.state.stacks.app?.createdAt).toBe("2026-01-01T00:00:00Z");
	});

	test("does not hand two auto services the same port", async () => {
		const cacheA = { ...redisDefinition, id: "cache-a" };
		const cacheB = { ...redisDefinition, id: "cache-b" };
		const deps = setup([6381]);
		const stack = createProjectStack("app", {
			"cache-a": { type: "cache-a" },
			"cache-b": { type: "cache-b" },
		});
		const result = await run(deps, stack, [cacheA, cacheB]);
		expect(result).toEqual({
			ok: true,
			value: { "cache-a": 6380, "cache-b": 6382 },
		});
	});

	test("probes a fixed port and reports PORT_CONFLICT with a fix hint", async () => {
		const deps = setup([6380]);
		const result = await run(
			deps,
			createProjectStack("app", { redis: { type: "redis", port: 6380 } }),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("PORT_CONFLICT");
			expect(result.error.details.port).toBe(6380);
			expect(String(result.error.details.fix)).toContain("port: auto");
		}
		expect(deps.state.updates).toBe(0);
	});

	test("a fixed port pinned by another stack is a conflict", async () => {
		const deps = setup([], {
			projects: [],
			stacks: {
				other: { ports: { redis: 6390 }, createdAt: "2026-01-01T00:00:00Z" },
			},
		});
		const result = await run(
			deps,
			createProjectStack("app", { redis: { type: "redis", port: 6390 } }),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("PORT_CONFLICT");
			expect(result.error.details.reservedBy).toEqual({
				stack: "other",
				service: "redis",
			});
		}
	});

	test("a fixed port equal to the pin is not probed (stack may be running)", async () => {
		const deps = setup([6390], {
			projects: [],
			stacks: {
				app: { ports: { redis: 6390 }, createdAt: "2026-01-01T00:00:00Z" },
			},
		});
		const result = await run(
			deps,
			createProjectStack("app", { redis: { type: "redis", port: 6390 } }),
		);
		expect(result).toEqual({ ok: true, value: { redis: 6390 } });
	});

	test("two instances of one type get distinct ports pinned by instance name", async () => {
		const deps = setup([5433]);
		const result = await run(
			deps,
			createProjectStack("shop", {
				"main-db": { type: "postgres" },
				events: { type: "postgres" },
			}),
		);
		expect(result).toEqual({
			ok: true,
			value: { "main-db": 5434, events: 5435 },
		});
		expect(deps.state.state.stacks.shop?.ports).toEqual({
			"main-db": 5434,
			events: 5435,
		});
	});

	test("auto never takes the canonical default port", async () => {
		const deps = setup();
		const result = await run(
			deps,
			createProjectStack("app", { cache: { type: "redis", port: "auto" } }),
		);
		expect(result).toEqual({ ok: true, value: { cache: 6380 } });
		expect(deps.probe.probed).not.toContain(6379);
	});

	test("an exhausted range is a PORT_CONFLICT", async () => {
		const deps = setup(portsInRange([5432, 5499]));
		const result = await run(
			deps,
			createProjectStack("app", { postgres: { type: "postgres" } }),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("PORT_CONFLICT");
			expect(result.error.details.range).toEqual([5432, 5499]);
		}
	});

	test("probe failures become IO errors", async () => {
		const deps = setup();
		deps.probe.isFree = async () => {
			throw new Error("boom");
		};
		const result = await run(
			deps,
			createProjectStack("app", { postgres: { type: "postgres" } }),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("IO");
	});

	test("a PORT_CONFLICT thrown by the state store passes through unchanged", async () => {
		const deps = setup();
		const conflict = new OpError("PORT_CONFLICT", "Port 5433 is pinned twice", {
			details: { port: 5433 },
		});
		deps.state.update = async () => {
			throw conflict;
		};
		const result = await run(
			deps,
			createProjectStack("app", { postgres: { type: "postgres" } }),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toBe(conflict);
	});

	test("concurrent allocations for two stacks never pin the same port", async () => {
		const deps = setup();
		const [alpha, beta] = await Promise.all([
			run(
				deps,
				createProjectStack("alpha", { postgres: { type: "postgres" } }),
			),
			run(deps, createProjectStack("beta", { postgres: { type: "postgres" } })),
		]);
		if (!alpha.ok) throw alpha.error;
		if (!beta.ok) throw beta.error;
		expect(alpha.value.postgres).not.toBe(beta.value.postgres);
		expect(
			new Set([
				deps.state.state.stacks.alpha?.ports.postgres,
				deps.state.state.stacks.beta?.ports.postgres,
			]).size,
		).toBe(2);
		expect([alpha.value.postgres, beta.value.postgres].sort()).toEqual([
			5433, 5434,
		]);
	});

	test("a pin written by another stack between read and write triggers a retry", async () => {
		const deps = setup();
		const update = deps.state.update.bind(deps.state);
		let injected = false;
		deps.state.update = async (mutate) => {
			if (!injected) {
				injected = true;
				// Another process pins 5433 after our read and probe, before our write.
				await update((state) => ({
					...state,
					stacks: {
						...state.stacks,
						other: { ports: { postgres: 5433 }, createdAt: "x" },
					},
				}));
			}
			return update(mutate);
		};
		const result = await run(
			deps,
			createProjectStack("app", { postgres: { type: "postgres" } }),
		);
		expect(result).toEqual({ ok: true, value: { postgres: 5434 } });
		expect(deps.state.state.stacks.other?.ports.postgres).toBe(5433);
		expect(deps.state.state.stacks.app?.ports.postgres).toBe(5434);
	});

	test("a concurrent re-pin of the same stack is adopted, not overwritten", async () => {
		const deps = setup();
		const update = deps.state.update.bind(deps.state);
		let injected = false;
		deps.state.update = async (mutate) => {
			if (!injected) {
				injected = true;
				await update((state) => ({
					...state,
					stacks: {
						...state.stacks,
						app: { ports: { postgres: 5440 }, createdAt: "x" },
					},
				}));
			}
			return update(mutate);
		};
		const result = await run(
			deps,
			createProjectStack("app", { postgres: { type: "postgres" } }),
		);
		expect(result).toEqual({ ok: true, value: { postgres: 5440 } });
		expect(deps.state.state.stacks.app).toEqual({
			ports: { postgres: 5440 },
			createdAt: "x",
		});
	});

	test("endless races give up with PORT_CONFLICT after MAX_PORT_ALLOCATION_ATTEMPTS", async () => {
		const deps = setup();
		const update = deps.state.update.bind(deps.state);
		let next = 5433;
		let attempts = 0;
		deps.state.update = async (mutate) => {
			attempts++;
			const port = next++;
			await update((state) => ({
				...state,
				stacks: {
					...state.stacks,
					[`other${port}`]: { ports: { postgres: port }, createdAt: "x" },
				},
			}));
			return update(mutate);
		};
		const result = await run(
			deps,
			createProjectStack("app", { postgres: { type: "postgres" } }),
		);
		expect(attempts).toBe(MAX_PORT_ALLOCATION_ATTEMPTS);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("PORT_CONFLICT");
		expect(deps.state.state.stacks.app).toBeUndefined();
	});
});
