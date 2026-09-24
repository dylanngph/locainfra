import type { PlatformFacts } from "../../../ports/platform.port";
import {
	FakeComposeInfo,
	FakeDockerInfo,
	FakeSocketLocator,
	FixedClock,
} from "../../../testing/fakes";
import {
	FakeDaemonWaiter,
	FakePlatformInspector,
	FakeProcessRunner,
} from "../../../testing/setup-fakes";
import type { DoctorCheckId, DoctorReport } from "../../doctor/doctor.model";
import { DOCTOR_CHECK } from "../../doctor/doctor.model";

/**
 * A hand-built doctor report: every check present and ok except `fails`
 * (test helper for the pure planner).
 */
export function reportWith(fails: readonly DoctorCheckId[] = []): DoctorReport {
	return {
		ok: fails.length === 0,
		checks: Object.values(DOCTOR_CHECK).map((id) => ({
			id,
			label: id,
			status: fails.includes(id) ? "fail" : "ok",
			...(fails.includes(id) ? { fix: `fix ${id}` } : {}),
		})),
		generatedAt: "2026-09-24T00:00:00.000Z",
	};
}

/** Daemon down (socket + daemon fail). */
export const DOWN: DoctorCheckId[] = [DOCTOR_CHECK.socket, DOCTOR_CHECK.daemon];

/** Fakes for the setup ops; Docker answers unless `down()` is called. */
export function setupWorld(facts: PlatformFacts) {
	const platform = new FakePlatformInspector(facts);
	const docker = new FakeDockerInfo();
	const compose = new FakeComposeInfo("5.3.0");
	const socket = new FakeSocketLocator();
	const clock = new FixedClock("2026-09-24T00:00:00.000Z");
	const runner = new FakeProcessRunner();
	const waiter = new FakeDaemonWaiter(true);
	const doctor = { docker, compose, socket, clock, platform };
	return {
		platform,
		docker,
		compose,
		socket,
		runner,
		waiter,
		deps: { platform, doctor, runner, waiter },
		/** Stops the daemon (the doctor then fails socket + daemon). */
		down() {
			docker.error = new Error("connect ECONNREFUSED");
			socket.path = null;
		},
		/** Starts the daemon again. */
		up() {
			docker.error = undefined;
			socket.path = "/home/test/.docker/run/docker.sock";
		},
	};
}
