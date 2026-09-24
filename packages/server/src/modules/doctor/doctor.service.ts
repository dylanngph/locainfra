import {
	type DoctorReport,
	type RunDoctor,
	type RunDoctorDeps,
	runDoctor,
} from "@locastack/core";

/** The doctor op and the ports it reads, injected by the composition root. */
export interface DoctorRunner {
	/** Core's `runDoctor` op (a stub in tests). */
	readonly run: RunDoctor;
	/** Ports handed to the op on every call. */
	readonly deps: RunDoctorDeps;
}

/**
 * Binds core's `runDoctor` op to concrete ports.
 *
 * @param deps - Docker, compose, socket and clock ports (from engines).
 * @returns A {@link DoctorRunner} that calls `runDoctor(deps)`.
 */
export function createDoctorRunner(deps: RunDoctorDeps): DoctorRunner {
	return { run: runDoctor, deps };
}

/** Produces doctor reports. No HTTP knowledge; the controller only routes. */
export class DoctorService {
	/** @param runner - The op and its ports. */
	constructor(private readonly runner: DoctorRunner) {}

	/**
	 * Runs every check. Never throws: core turns failures into `fail` checks.
	 *
	 * @returns The report, `ok` when no check failed.
	 */
	report(): Promise<DoctorReport> {
		return this.runner.run(this.runner.deps);
	}
}
