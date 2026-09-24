import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import type { PlatformFacts } from "../../../ports/platform.port";
import {
	FakeComposeInfo,
	FakeDockerInfo,
	FakeSocketLocator,
	FixedClock,
} from "../../../testing/fakes";
import {
	createLinuxPlatformFacts,
	createPlatformFacts,
	FakePlatformInspector,
} from "../../../testing/setup-fakes";
import { DOCTOR_CHECK, DoctorReport } from "../doctor.model";
import { runDoctor } from "../run-doctor.op";

const macDesktop = (overrides: Partial<PlatformFacts> = {}) =>
	createPlatformFacts({
		dockerCliPath: "/usr/local/bin/docker",
		installedRuntimes: ["docker-desktop"],
		runningRuntime: "docker-desktop",
		...overrides,
	});

function deps(facts: PlatformFacts = macDesktop()) {
	return {
		docker: new FakeDockerInfo(),
		compose: new FakeComposeInfo("5.3.0"),
		socket: new FakeSocketLocator(),
		clock: new FixedClock("2026-09-23T12:00:00.000Z"),
		platform: new FakePlatformInspector(facts),
	};
}

function find(report: DoctorReport, id: string) {
	return report.checks.find((check) => check.id === id);
}

function statusOf(report: DoctorReport, id: string) {
	return find(report, id)?.status;
}

/** A stopped runtime: the daemon refuses and nothing runs. */
function stopped(d: ReturnType<typeof deps>) {
	d.docker.error = new Error("connect ECONNREFUSED");
	d.socket.path = null;
	d.platform.facts = { ...d.platform.facts };
	delete d.platform.facts.runningRuntime;
	return d;
}

describe("runDoctor: healthy", () => {
	test("macOS: every check ok in order, platform summary, setupNeeded none", async () => {
		const report = await runDoctor(deps());
		expect(report.ok).toBe(true);
		expect(report.generatedAt).toBe("2026-09-23T12:00:00.000Z");
		expect(report.checks.map((c) => [c.id, c.status])).toEqual([
			[DOCTOR_CHECK.dockerCli, "ok"],
			[DOCTOR_CHECK.socket, "ok"],
			[DOCTOR_CHECK.daemon, "ok"],
			[DOCTOR_CHECK.api, "ok"],
			[DOCTOR_CHECK.composePlugin, "ok"],
			[DOCTOR_CHECK.composeVersion, "ok"],
			[DOCTOR_CHECK.homebrew, "ok"],
		]);
		expect(find(report, DOCTOR_CHECK.dockerCli)?.detail).toBe(
			"/usr/local/bin/docker",
		);
		expect(report.platform).toEqual({
			os: "darwin",
			arch: "arm64",
			hasBrew: true,
			hasSystemd: false,
			installedRuntimes: ["docker-desktop"],
			runningRuntime: "docker-desktop",
		});
		expect(report.setupNeeded).toBe("none");
		expect(Value.Check(DoctorReport, report)).toBe(true);
	});

	test("the platform summary never carries paths or the user name", async () => {
		const report = await runDoctor(deps());
		const text = JSON.stringify(report.platform);
		expect(text).not.toContain("/Users/test");
		expect(text).not.toContain('"test"');
		expect(text).not.toContain("/tmp");
	});

	test("Linux: docker.group instead of homebrew", async () => {
		const report = await runDoctor(
			deps(
				createLinuxPlatformFacts({
					dockerCliPath: "/usr/bin/docker",
					installedRuntimes: ["docker-engine"],
					runningRuntime: "docker-engine",
					inDockerGroup: true,
				}),
			),
		);
		expect(report.ok).toBe(true);
		expect(report.checks.map((c) => c.id)).toEqual([
			DOCTOR_CHECK.dockerCli,
			DOCTOR_CHECK.socket,
			DOCTOR_CHECK.daemon,
			DOCTOR_CHECK.api,
			DOCTOR_CHECK.composePlugin,
			DOCTOR_CHECK.composeVersion,
			DOCTOR_CHECK.dockerGroup,
		]);
		expect(report.platform?.inDockerGroup).toBe(true);
		expect(Value.Check(DoctorReport, report)).toBe(true);
	});
});

describe("runDoctor: detection", () => {
	test("Docker CLI missing: fail with `locastack setup`, compose needs the CLI, install", async () => {
		const d = stopped(deps(createPlatformFacts()));
		d.compose.current = null;
		const report = await runDoctor(d);
		expect(report.ok).toBe(false);
		const cli = find(report, DOCTOR_CHECK.dockerCli);
		expect(cli?.status).toBe("fail");
		expect(cli?.fix).toContain("locastack setup");
		expect(find(report, DOCTOR_CHECK.composePlugin)?.detail).toContain(
			"needs the docker CLI",
		);
		expect(report.setupNeeded).toBe("install");
	});

	test("runtime installed but stopped: the fix starts it; setupNeeded start", async () => {
		const d = stopped(
			deps(
				createPlatformFacts({
					dockerCliPath: "/opt/homebrew/bin/docker",
					installedRuntimes: ["colima"],
				}),
			),
		);
		const report = await runDoctor(d);
		const daemon = find(report, DOCTOR_CHECK.daemon);
		expect(daemon?.status).toBe("fail");
		expect(daemon?.fix).toBe(
			"Start Colima (`colima start`) or run `locastack setup`.",
		);
		expect(statusOf(report, DOCTOR_CHECK.api)).toBeUndefined();
		expect(find(report, DOCTOR_CHECK.socket)?.fix).toContain("DOCKER_HOST");
		expect(report.setupNeeded).toBe("start");
	});

	test("Docker Desktop stopped: fix is `open -a Docker`", async () => {
		const report = await runDoctor(stopped(deps()));
		expect(find(report, DOCTOR_CHECK.daemon)?.fix).toContain("open -a Docker");
		expect(report.setupNeeded).toBe("start");
	});

	test("a running runtime whose socket is unreachable points at docker context", async () => {
		const d = deps(
			createPlatformFacts({
				dockerCliPath: "/opt/homebrew/bin/docker",
				installedRuntimes: ["colima"],
				runningRuntime: "colima",
			}),
		);
		d.docker.error = new Error("connect ENOENT /var/run/docker.sock");
		const report = await runDoctor(d);
		expect(find(report, DOCTOR_CHECK.daemon)?.fix).toContain(
			"docker context ls",
		);
		expect(report.setupNeeded).toBe("unsupported");
	});

	test("compose plugin missing while the docker CLI exists (macOS)", async () => {
		const d = deps();
		d.compose.current = null;
		const report = await runDoctor(d);
		const plugin = find(report, DOCTOR_CHECK.composePlugin);
		expect(plugin?.status).toBe("fail");
		expect(plugin?.detail).toContain("docker CLI is installed");
		expect(plugin?.fix).toContain("~/.docker/cli-plugins");
		expect(statusOf(report, DOCTOR_CHECK.composeVersion)).toBeUndefined();
		expect(report.setupNeeded).toBe("install");
	});

	test("compose plugin missing on Linux names docker-compose-plugin", async () => {
		const d = deps(
			createLinuxPlatformFacts({
				dockerCliPath: "/usr/bin/docker",
				installedRuntimes: ["docker-engine"],
				runningRuntime: "docker-engine",
				inDockerGroup: true,
			}),
		);
		d.compose.current = null;
		const report = await runDoctor(d);
		expect(find(report, DOCTOR_CHECK.composePlugin)?.fix).toContain(
			"docker-compose-plugin",
		);
		expect(report.setupNeeded).toBe("unsupported");
	});

	test("Linux permission denied: daemon and docker.group fail with the usermod fix", async () => {
		const d = deps(
			createLinuxPlatformFacts({
				dockerCliPath: "/usr/bin/docker",
				installedRuntimes: ["docker-engine"],
				runningRuntime: "docker-engine",
				inDockerGroup: false,
			}),
		);
		d.docker.error = new Error(
			"connect EACCES /var/run/docker.sock: permission denied",
		);
		const report = await runDoctor(d);
		const daemon = find(report, DOCTOR_CHECK.daemon);
		expect(daemon?.detail).toContain("Permission denied");
		expect(daemon?.fix).toContain("sudo usermod -aG docker test");
		expect(statusOf(report, DOCTOR_CHECK.dockerGroup)).toBe("fail");
		expect(report.setupNeeded).toBe("install");
	});

	test("Linux: not in the group but the daemon answers → warn, still ok", async () => {
		const d = deps(
			createLinuxPlatformFacts({
				dockerCliPath: "/usr/bin/docker",
				installedRuntimes: ["docker-engine"],
				runningRuntime: "docker-engine",
				inDockerGroup: false,
			}),
		);
		const report = await runDoctor(d);
		expect(report.ok).toBe(true);
		expect(statusOf(report, DOCTOR_CHECK.dockerGroup)).toBe("warn");
	});

	test("Linux: root and unknown membership", async () => {
		const root = await runDoctor(
			stopped(deps(createLinuxPlatformFacts({ isRoot: true }))),
		);
		expect(statusOf(root, DOCTOR_CHECK.dockerGroup)).toBe("ok");
		const facts = createLinuxPlatformFacts();
		delete facts.inDockerGroup;
		const unknown = await runDoctor(stopped(deps(facts)));
		expect(statusOf(unknown, DOCTOR_CHECK.dockerGroup)).toBe("warn");
	});

	test("Linux Docker Desktop only: the group is not needed", async () => {
		const report = await runDoctor(
			stopped(
				deps(
					createLinuxPlatformFacts({
						dockerCliPath: "/usr/bin/docker",
						installedRuntimes: ["docker-desktop"],
					}),
				),
			),
		);
		expect(statusOf(report, DOCTOR_CHECK.dockerGroup)).toBe("warn");
		expect(find(report, DOCTOR_CHECK.daemon)?.fix).toContain(
			"systemctl --user start docker-desktop",
		);
		expect(report.setupNeeded).toBe("start");
	});

	test("Linux stopped Docker Engine: sudo start command in the fix", async () => {
		const report = await runDoctor(
			stopped(
				deps(
					createLinuxPlatformFacts({
						dockerCliPath: "/usr/bin/docker",
						installedRuntimes: ["docker-engine"],
						inDockerGroup: true,
						hasSystemd: false,
					}),
				),
			),
		);
		expect(find(report, DOCTOR_CHECK.daemon)?.fix).toContain(
			"sudo service docker start",
		);
		expect(report.setupNeeded).toBe("start");
	});

	test("Homebrew missing is a warning only", async () => {
		const facts = macDesktop({ hasBrew: false });
		delete facts.brewPrefix;
		const report = await runDoctor(deps(facts));
		expect(report.ok).toBe(true);
		const brew = find(report, DOCTOR_CHECK.homebrew);
		expect(brew?.status).toBe("warn");
		expect(brew?.fix).toContain("brew.sh");
	});

	test("Windows: unsupported with the Docker Desktop link", async () => {
		const d = stopped(
			deps(createPlatformFacts({ os: "win32", hasBrew: false })),
		);
		const report = await runDoctor(d);
		expect(find(report, DOCTOR_CHECK.dockerCli)?.fix).toContain(
			"docs.docker.com/desktop",
		);
		expect(statusOf(report, DOCTOR_CHECK.homebrew)).toBeUndefined();
		expect(statusOf(report, DOCTOR_CHECK.dockerGroup)).toBeUndefined();
		expect(report.setupNeeded).toBe("unsupported");
	});

	test("inspection failure: other-OS platform, CLI inferred from compose", async () => {
		const d = deps();
		d.platform.error = new Error("spawn id ENOENT");
		const healthy = await runDoctor(d);
		expect(healthy.ok).toBe(true);
		expect(healthy.platform?.os).toBe("other");
		expect(statusOf(healthy, DOCTOR_CHECK.dockerCli)).toBe("ok");
		expect(healthy.setupNeeded).toBe("none");
		d.compose.current = null;
		const broken = await runDoctor(stopped(d));
		expect(statusOf(broken, DOCTOR_CHECK.dockerCli)).toBe("fail");
		expect(broken.setupNeeded).toBe("unsupported");
		expect(Value.Check(DoctorReport, broken)).toBe(true);
	});
});

describe("runDoctor: versions", () => {
	test("API older than 1.44 fails", async () => {
		const d = deps();
		d.docker.value = { ...d.docker.value, apiVersion: "1.43" };
		const report = await runDoctor(d);
		expect(report.ok).toBe(false);
		expect(statusOf(report, DOCTOR_CHECK.api)).toBe("fail");
		expect(find(report, DOCTOR_CHECK.api)?.fix).toContain("Docker Desktop");
		expect(report.setupNeeded).toBe("unsupported");
	});

	test("API exactly 1.44 passes", async () => {
		const d = deps();
		d.docker.value = { ...d.docker.value, apiVersion: "1.44" };
		expect(statusOf(await runDoctor(d), DOCTOR_CHECK.api)).toBe("ok");
	});

	test("compose older than 2.24 fails; Colima users get brew upgrade", async () => {
		const d = deps(
			createPlatformFacts({
				dockerCliPath: "/opt/homebrew/bin/docker",
				installedRuntimes: ["colima"],
				runningRuntime: "colima",
			}),
		);
		d.compose.current = "2.23.3";
		const report = await runDoctor(d);
		expect(report.ok).toBe(false);
		expect(statusOf(report, DOCTOR_CHECK.composeVersion)).toBe("fail");
		expect(find(report, DOCTOR_CHECK.composeVersion)?.fix).toContain(
			"brew upgrade docker-compose",
		);
		expect(report.setupNeeded).toBe("install");
	});

	test("compose between 2.24 and 2.30 warns but stays ok", async () => {
		const d = deps();
		d.compose.current = "v2.29.1-desktop.1";
		const report = await runDoctor(d);
		expect(report.ok).toBe(true);
		expect(statusOf(report, DOCTOR_CHECK.composeVersion)).toBe("warn");
	});

	test("unparsable versions warn", async () => {
		const d = deps();
		d.compose.current = "dev";
		d.docker.value = { ...d.docker.value, apiVersion: "unknown" };
		const report = await runDoctor(d);
		expect(report.ok).toBe(true);
		expect(statusOf(report, DOCTOR_CHECK.composeVersion)).toBe("warn");
		expect(statusOf(report, DOCTOR_CHECK.api)).toBe("warn");
	});

	test("never throws when ports throw", async () => {
		const d = deps();
		d.socket.locate = async () => {
			throw new Error("context broken");
		};
		d.compose.version = async () => {
			throw new Error("spawn ENOENT");
		};
		d.platform.error = new Error("inspect failed");
		const report = await runDoctor(d);
		expect(report.ok).toBe(false);
		expect(statusOf(report, DOCTOR_CHECK.socket)).toBe("fail");
		expect(statusOf(report, DOCTOR_CHECK.composePlugin)).toBe("fail");
		expect(Value.Check(DoctorReport, report)).toBe(true);
	});
});
