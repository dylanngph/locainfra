import { describe, expect, test } from "bun:test";
import type {
	DownStackDeps,
	EnvForStackDeps,
	RunDoctorDeps,
	UpStackDeps,
} from "@locainfra/core";
import { createEngines } from "../engines";
import { resolveDefaultPaths } from "../paths/default-paths";

describe("createEngines", () => {
	test("wires every adapter under the op-deps field names", () => {
		const paths = resolveDefaultPaths({
			env: { LOCAINFRA_HOME: "/tmp/li-test" },
		});
		const engines = createEngines(paths);
		expect(engines.paths).toBe(paths);
		expect(engines.compose).toBe(engines.lifecycle);

		// Compile-time check: the adapter set satisfies core's op dependency contracts
		// (catalog comes from core, not engines).
		const doctor: RunDoctorDeps = engines;
		const down: DownStackDeps = engines;
		const env: Omit<EnvForStackDeps, "catalog"> = engines;
		const up: Omit<UpStackDeps, "catalog"> = engines;
		expect([doctor, down, env, up].every((d) => d === engines)).toBe(true);
	});

	test("defaults paths from the environment", () => {
		expect(createEngines().paths.stateDir).toBe(resolveDefaultPaths().stateDir);
	});
});
