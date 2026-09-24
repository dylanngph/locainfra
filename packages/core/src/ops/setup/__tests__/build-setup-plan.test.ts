import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import type { PlatformFacts } from "../../../ports/platform.port";
import { formatCommandStep } from "../../../shared/command-format";
import {
	createLinuxPlatformFacts,
	createPlatformFacts,
} from "../../../testing/setup-fakes";
import { DOCTOR_CHECK } from "../../doctor/doctor.model";
import { SETUP_INSTALLER_URLS, SetupPlan } from "../../ops.model";
import { buildSetupPlan } from "../build-setup-plan.op";
import { SETUP_STEP } from "../setup-steps";
import { DOWN, reportWith } from "./setup-world";

const NOTHING = [DOCTOR_CHECK.dockerCli, ...DOWN, DOCTOR_CHECK.composePlugin];

function commands(plan: SetupPlan): string[] {
	return plan.steps.map(formatCommandStep);
}

function build(
	facts: PlatformFacts,
	fails: Parameters<typeof reportWith>[0],
	options: Parameters<typeof buildSetupPlan>[2] = {},
): SetupPlan {
	const plan = buildSetupPlan(facts, reportWith(fails), options);
	expect(Value.Check(SetupPlan, plan)).toBe(true);
	return plan;
}

describe("buildSetupPlan: common", () => {
	test("a passing report plans nothing", () => {
		const plan = build(createPlatformFacts(), []);
		expect(plan.kind).toBe("none");
		expect(plan.steps).toEqual([]);
		expect(plan.needsTerminal).toBe(false);
	});

	test("Windows and other OSes are unsupported with manual instructions", () => {
		const win = build(createPlatformFacts({ os: "win32" }), NOTHING);
		expect(win.kind).toBe("unsupported");
		expect(win.postNotes.join(" ")).toContain("windows-install");
		const other = build(createPlatformFacts({ os: "other" }), NOTHING);
		expect(other.kind).toBe("unsupported");
		expect(other.postNotes.join(" ")).toContain("docs.docker.com/engine");
	});

	test("a runtime that does not fit the OS is unsupported", () => {
		expect(
			build(createPlatformFacts(), NOTHING, { runtime: "docker-engine" }).kind,
		).toBe("unsupported");
		const linux = build(createLinuxPlatformFacts(), NOTHING, {
			runtime: "colima",
		});
		expect(linux.kind).toBe("unsupported");
		expect(linux.reason).toContain("Colima is not available on Linux");
	});
});

describe("buildSetupPlan: macOS", () => {
	test("Homebrew present, nothing installed: Colima install (default)", () => {
		const plan = build(createPlatformFacts(), NOTHING);
		expect(plan.kind).toBe("install");
		expect(plan.provider).toBe("colima");
		expect(plan.alternatives).toEqual(["docker-desktop", "orbstack"]);
		expect(commands(plan)).toEqual([
			"/opt/homebrew/bin/brew install colima docker docker-compose",
			"mkdir -p /Users/test/.docker/cli-plugins",
			"ln -sfn /opt/homebrew/opt/docker-compose/bin/docker-compose /Users/test/.docker/cli-plugins/docker-compose",
			"colima start",
		]);
		expect(plan.needsTerminal).toBe(false);
		expect(plan.reason).toBe(
			"Docker is not installed. Install Colima with Homebrew and start it.",
		);
		expect(plan.postNotes.join(" ")).toContain("brew services start colima");
		expect(plan.steps.every((s) => s.title.length > 0)).toBe(true);
	});

	test("Colima with start at login uses brew services", () => {
		const plan = build(createPlatformFacts(), NOTHING, { startAtLogin: true });
		expect(plan.steps.at(-1)?.id).toBe(SETUP_STEP.colimaStartAtLogin);
		expect(commands(plan).at(-1)).toBe(
			"/opt/homebrew/bin/brew services start colima",
		);
		expect(plan.postNotes).toEqual([]);
	});

	test("Homebrew missing: download + attached installer first, absolute paths after", () => {
		const facts = createPlatformFacts({ hasBrew: false });
		delete facts.brewPrefix;
		const plan = build(facts, NOTHING);
		expect(plan.steps.map((s) => s.id)).toEqual([
			SETUP_STEP.brewDownload,
			SETUP_STEP.brewInstall,
			SETUP_STEP.colimaInstall,
			SETUP_STEP.composePluginDir,
			SETUP_STEP.composePluginLink,
			SETUP_STEP.colimaStart,
		]);
		const [download, install] = plan.steps;
		expect(download?.remoteScript).toEqual({
			url: SETUP_INSTALLER_URLS.homebrew,
			path: "/tmp/locastack-setup-test/brew-install.sh",
			inspectHint: "less /tmp/locastack-setup-test/brew-install.sh",
		});
		expect(download?.argv).toEqual([
			"curl",
			"-fsSL",
			"--create-dirs",
			"-o",
			"/tmp/locastack-setup-test/brew-install.sh",
			SETUP_INSTALLER_URLS.homebrew,
		]);
		expect(install?.argv).toEqual([
			"/bin/bash",
			"/tmp/locastack-setup-test/brew-install.sh",
		]);
		expect(install?.attached).toBe(true);
		expect(plan.needsTerminal).toBe(true);
		expect(commands(plan).at(-1)).toBe(
			"PATH=/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin /opt/homebrew/bin/colima start",
		);
		expect(plan.reason).toContain(
			"Install Homebrew first, then Colima with Homebrew",
		);
		expect(plan.postNotes[0]).toContain(
			`eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile`,
		);
	});

	test("Intel Mac without Homebrew uses /usr/local and needs no shellenv note", () => {
		const facts = createPlatformFacts({ hasBrew: false, arch: "x64" });
		delete facts.brewPrefix;
		const plan = build(facts, NOTHING, { runtime: "orbstack" });
		expect(commands(plan).slice(2)).toEqual([
			"/usr/local/bin/brew install --cask orbstack",
			"open -a OrbStack",
		]);
		expect(plan.postNotes).toEqual([]);
	});

	test("Docker Desktop install: cask attached, then open -a Docker with a note", () => {
		const plan = build(createPlatformFacts(), NOTHING, {
			runtime: "docker-desktop",
		});
		expect(plan.provider).toBe("docker-desktop");
		expect(plan.alternatives).toEqual(["colima", "orbstack"]);
		expect(commands(plan)).toEqual([
			"/opt/homebrew/bin/brew install --cask docker",
			"open -a Docker",
		]);
		expect(plan.steps[0]?.attached).toBe(true);
		expect(plan.steps[1]?.note).toContain("its own window");
		expect(plan.needsTerminal).toBe(true);
	});

	test("OrbStack install", () => {
		const plan = build(createPlatformFacts(), NOTHING, { runtime: "orbstack" });
		expect(plan.provider).toBe("orbstack");
		expect(plan.alternatives).toEqual(["colima", "docker-desktop"]);
		expect(commands(plan)).toEqual([
			"/opt/homebrew/bin/brew install --cask orbstack",
			"open -a OrbStack",
		]);
	});

	test("Colima installed but stopped: start only", () => {
		const plan = build(
			createPlatformFacts({
				installedRuntimes: ["colima"],
				dockerCliPath: "/opt/homebrew/bin/docker",
			}),
			DOWN,
		);
		expect(plan.kind).toBe("start");
		expect(plan.provider).toBe("colima");
		expect(plan.alternatives).toEqual([]);
		expect(commands(plan)).toEqual(["colima start"]);
		expect(plan.reason).toBe("Colima is installed but not running; start it.");
		expect(plan.needsTerminal).toBe(false);
	});

	test("Colima stopped and the Docker CLI missing: install it, link compose, start", () => {
		const plan = build(createPlatformFacts({ installedRuntimes: ["colima"] }), [
			DOCTOR_CHECK.dockerCli,
			...DOWN,
			DOCTOR_CHECK.composePlugin,
		]);
		expect(plan.kind).toBe("install");
		expect(commands(plan)).toEqual([
			"/opt/homebrew/bin/brew install docker docker-compose",
			"mkdir -p /Users/test/.docker/cli-plugins",
			"ln -sfn /opt/homebrew/opt/docker-compose/bin/docker-compose /Users/test/.docker/cli-plugins/docker-compose",
			"colima start",
		]);
		expect(plan.reason).toContain("needs the Docker CLI");
	});

	test("Docker Desktop stopped: open -a Docker (start), even with the CLI link missing", () => {
		const plan = build(
			createPlatformFacts({ installedRuntimes: ["docker-desktop"] }),
			[DOCTOR_CHECK.dockerCli, ...DOWN],
		);
		expect(plan.kind).toBe("start");
		expect(commands(plan)).toEqual(["open -a Docker"]);
	});

	test("OrbStack stopped: open -a OrbStack", () => {
		const plan = build(
			createPlatformFacts({
				installedRuntimes: ["orbstack"],
				dockerCliPath: "/usr/local/bin/docker",
			}),
			DOWN,
		);
		expect(plan.kind).toBe("start");
		expect(plan.provider).toBe("orbstack");
		expect(commands(plan)).toEqual(["open -a OrbStack"]);
	});

	test("several installed: the most preferred starts; --runtime picks another", () => {
		const facts = createPlatformFacts({
			installedRuntimes: ["colima", "orbstack"],
			dockerCliPath: "/opt/homebrew/bin/docker",
		});
		// A desktop app before Colima when the docker context names none.
		const preferred = build(facts, DOWN);
		expect(preferred.provider).toBe("orbstack");
		expect(preferred.alternatives).toEqual(["colima"]);
		const picked = build(facts, DOWN, { runtime: "orbstack" });
		expect(picked.kind).toBe("start");
		expect(picked.provider).toBe("orbstack");
		const other = build(facts, DOWN, { runtime: "docker-desktop" });
		expect(other.kind).toBe("install");
		expect(other.reason).toContain("Docker Desktop was requested");
	});

	test("compose plugin missing with a working daemon: compose only", () => {
		const plan = build(
			createPlatformFacts({
				installedRuntimes: ["colima"],
				runningRuntime: "colima",
				dockerCliPath: "/opt/homebrew/bin/docker",
			}),
			[DOCTOR_CHECK.composePlugin],
		);
		expect(plan.kind).toBe("install");
		expect(plan.provider).toBeUndefined();
		expect(commands(plan)).toEqual([
			"/opt/homebrew/bin/brew install docker-compose",
			"mkdir -p /Users/test/.docker/cli-plugins",
			"ln -sfn /opt/homebrew/opt/docker-compose/bin/docker-compose /Users/test/.docker/cli-plugins/docker-compose",
		]);
		expect(plan.reason).toContain("needs the Compose plugin");
	});

	test("compose too old with Colima: brew upgrade and relink", () => {
		const plan = build(
			createPlatformFacts({
				installedRuntimes: ["colima"],
				runningRuntime: "colima",
				dockerCliPath: "/opt/homebrew/bin/docker",
			}),
			[DOCTOR_CHECK.composeVersion],
		);
		expect(plan.steps.map((s) => s.id)).toEqual([
			SETUP_STEP.composeUpgrade,
			SETUP_STEP.composePluginDir,
			SETUP_STEP.composePluginLink,
		]);
		expect(commands(plan)[0]).toBe(
			"/opt/homebrew/bin/brew upgrade docker-compose",
		);
	});

	test("compose too old bundled with Docker Desktop: update Docker Desktop", () => {
		const plan = build(
			createPlatformFacts({
				installedRuntimes: ["docker-desktop"],
				runningRuntime: "docker-desktop",
				dockerCliPath: "/usr/local/bin/docker",
			}),
			[DOCTOR_CHECK.composeVersion],
		);
		expect(plan.kind).toBe("unsupported");
		expect(plan.postNotes).toEqual([
			"Update Docker Desktop to the latest version.",
		]);
	});

	test("Engine API too old: unsupported with the failing fixes", () => {
		const plan = build(createPlatformFacts(), [DOCTOR_CHECK.api]);
		expect(plan.kind).toBe("unsupported");
		expect(plan.postNotes).toEqual([`fix ${DOCTOR_CHECK.api}`]);
	});

	test("Colima running but its socket unreachable: docker context hint", () => {
		const plan = build(
			createPlatformFacts({
				installedRuntimes: ["colima"],
				runningRuntime: "colima",
			}),
			DOWN,
		);
		expect(plan.kind).toBe("unsupported");
		expect(plan.postNotes[0]).toContain("docker context use colima");
		expect(plan.postNotes[0]).toContain(
			"/Users/test/.colima/default/docker.sock",
		);
	});
});

describe("buildSetupPlan: Linux", () => {
	test("nothing installed (systemd): script download, sudo sh, enable, usermod", () => {
		const plan = build(createLinuxPlatformFacts(), [
			...NOTHING,
			DOCTOR_CHECK.dockerGroup,
		]);
		expect(plan.kind).toBe("install");
		expect(plan.provider).toBe("docker-engine");
		expect(plan.alternatives).toEqual([]);
		expect(commands(plan)).toEqual([
			"curl -fsSL --create-dirs -o /tmp/locastack-setup-test/get-docker.sh https://get.docker.com",
			"sudo sh /tmp/locastack-setup-test/get-docker.sh",
			"sudo systemctl enable --now docker",
			"sudo usermod -aG docker test",
		]);
		expect(plan.steps[0]?.remoteScript).toEqual({
			url: "https://get.docker.com",
			path: "/tmp/locastack-setup-test/get-docker.sh",
			inspectHint: "less /tmp/locastack-setup-test/get-docker.sh",
		});
		expect(plan.steps.slice(1).every((s) => s.sudo === true)).toBe(true);
		expect(plan.requiresRelogin).toBe(true);
		expect(plan.needsTerminal).toBe(true);
		expect(plan.postNotes[0]).toContain("newgrp docker");
	});

	test("nothing installed without systemd: service start and a boot note", () => {
		const plan = build(
			createLinuxPlatformFacts({ hasSystemd: false }),
			NOTHING,
		);
		expect(commands(plan)[2]).toBe("sudo service docker start");
		expect(plan.postNotes.join(" ")).toContain("after a reboot");
	});

	test("root: no sudo, no group step, no re-login", () => {
		const plan = build(createLinuxPlatformFacts({ isRoot: true }), NOTHING);
		expect(commands(plan)).toEqual([
			"curl -fsSL --create-dirs -o /tmp/locastack-setup-test/get-docker.sh https://get.docker.com",
			"sh /tmp/locastack-setup-test/get-docker.sh",
			"systemctl enable --now docker",
		]);
		expect(plan.requiresRelogin).toBeUndefined();
		expect(plan.needsTerminal).toBe(false);
	});

	test("Docker Engine stopped (systemd, in group): start", () => {
		const plan = build(
			createLinuxPlatformFacts({
				installedRuntimes: ["docker-engine"],
				inDockerGroup: true,
				dockerCliPath: "/usr/bin/docker",
			}),
			DOWN,
		);
		expect(plan.kind).toBe("start");
		expect(commands(plan)).toEqual(["sudo systemctl start docker"]);
		expect(plan.needsTerminal).toBe(true);
	});

	test("Docker Engine stopped without systemd: sudo service docker start", () => {
		const plan = build(
			createLinuxPlatformFacts({
				installedRuntimes: ["docker-engine"],
				inDockerGroup: true,
				hasSystemd: false,
			}),
			DOWN,
		);
		expect(commands(plan)).toEqual(["sudo service docker start"]);
	});

	test("Docker Engine stopped and not in the group: start + usermod", () => {
		const plan = build(
			createLinuxPlatformFacts({ installedRuntimes: ["docker-engine"] }),
			[...DOWN, DOCTOR_CHECK.dockerGroup],
		);
		expect(plan.kind).toBe("install");
		expect(plan.steps.map((s) => s.id)).toEqual([
			SETUP_STEP.engineStart,
			SETUP_STEP.groupAdd,
		]);
		expect(plan.requiresRelogin).toBe(true);
	});

	test("Docker Engine running but not in the group: usermod only", () => {
		const plan = build(
			createLinuxPlatformFacts({
				installedRuntimes: ["docker-engine"],
				runningRuntime: "docker-engine",
			}),
			[DOCTOR_CHECK.daemon, DOCTOR_CHECK.dockerGroup],
		);
		expect(plan.kind).toBe("install");
		expect(plan.provider).toBeUndefined();
		expect(commands(plan)).toEqual(["sudo usermod -aG docker test"]);
		expect(plan.requiresRelogin).toBe(true);
	});

	test("Docker Desktop for Linux stopped: systemctl --user start", () => {
		const plan = build(
			createLinuxPlatformFacts({ installedRuntimes: ["docker-desktop"] }),
			DOWN,
		);
		expect(plan.kind).toBe("start");
		expect(commands(plan)).toEqual(["systemctl --user start docker-desktop"]);
		expect(plan.needsTerminal).toBe(false);
	});

	test("Docker Desktop for Linux cannot be installed", () => {
		const plan = build(createLinuxPlatformFacts(), NOTHING, {
			runtime: "docker-desktop",
		});
		expect(plan.kind).toBe("unsupported");
		expect(plan.postNotes[0]).toContain("docs.docker.com/desktop");
	});

	test("compose plugin missing with a working daemon: unsupported, names the package", () => {
		const plan = build(
			createLinuxPlatformFacts({
				installedRuntimes: ["docker-engine"],
				runningRuntime: "docker-engine",
				inDockerGroup: true,
				dockerCliPath: "/usr/bin/docker",
			}),
			[DOCTOR_CHECK.composePlugin],
		);
		expect(plan.kind).toBe("unsupported");
		expect(plan.postNotes[0]).toContain("docker-compose-plugin");
	});
});

describe("buildSetupPlan: review fixes", () => {
	test("Docker Desktop user who also has Colima: starts Docker Desktop, offers Colima", () => {
		const facts = createPlatformFacts({
			installedRuntimes: ["colima", "docker-desktop"],
			dockerCliPath: "/usr/local/bin/docker",
			dockerContext: "desktop-linux",
		});
		const plan = build(facts, DOWN);
		expect(plan.kind).toBe("start");
		expect(plan.provider).toBe("docker-desktop");
		expect(commands(plan)).toEqual(["open -a Docker"]);
		expect(plan.alternatives).toEqual(["colima"]);
		// Without a context the desktop app still wins over Colima.
		const noContext = build({ ...facts, dockerContext: undefined }, DOWN);
		expect(noContext.provider).toBe("docker-desktop");
	});

	test("the docker context picks Colima; starting it from another context says it switches", () => {
		const facts = createPlatformFacts({
			installedRuntimes: ["colima", "docker-desktop"],
			dockerCliPath: "/opt/homebrew/bin/docker",
			dockerContext: "colima",
		});
		const plan = build(facts, DOWN);
		expect(plan.provider).toBe("colima");
		expect(plan.alternatives).toEqual(["docker-desktop"]);
		expect(plan.steps[0]?.note).toBeUndefined();
		const fromDesktop = build(
			{ ...facts, dockerContext: "desktop-linux" },
			DOWN,
			{ runtime: "colima" },
		);
		expect(fromDesktop.provider).toBe("colima");
		expect(fromDesktop.steps[0]?.note).toContain(
			"switches the docker context from `desktop-linux` to `colima`",
		);
	});

	test("DOCKER_HOST that does not answer: never starts or installs another runtime", () => {
		const unix = build(
			createPlatformFacts({
				installedRuntimes: ["docker-desktop"],
				dockerCliPath: "/usr/local/bin/docker",
				dockerHost: "unix:///nonexistent/docker.sock",
			}),
			DOWN,
		);
		expect(unix.kind).toBe("unsupported");
		expect(unix.steps).toEqual([]);
		expect(unix.reason).toBe(
			"DOCKER_HOST=unix:///nonexistent/docker.sock does not answer; start that daemon or unset DOCKER_HOST.",
		);
		const remote = build(
			createPlatformFacts({
				hasBrew: false,
				brewPrefix: undefined,
				dockerHost: "tcp://10.0.0.2:2375",
			}),
			NOTHING,
		);
		expect(remote.kind).toBe("unsupported");
		expect(remote.steps).toEqual([]);
		expect(remote.reason).toContain("DOCKER_HOST=tcp://10.0.0.2:2375");
	});

	test("DOCKER_HOST on an installed runtime's socket: starts only that runtime", () => {
		const facts = createPlatformFacts({
			installedRuntimes: ["colima", "docker-desktop"],
			dockerCliPath: "/opt/homebrew/bin/docker",
			dockerHost: "unix:///Users/test/.colima/default/docker.sock",
		});
		const plan = build(facts, DOWN);
		expect(plan.kind).toBe("start");
		expect(plan.provider).toBe("colima");
		expect(plan.alternatives).toEqual([]);
		expect(build(facts, DOWN, { runtime: "docker-desktop" }).kind).toBe(
			"unsupported",
		);
		const linux = build(
			createLinuxPlatformFacts({
				installedRuntimes: ["docker-engine"],
				inDockerGroup: true,
				dockerCliPath: "/usr/bin/docker",
				dockerHost: "unix:///var/run/docker.sock",
			}),
			DOWN,
		);
		expect(commands(linux)).toEqual(["sudo systemctl start docker"]);
	});

	test("fresh Homebrew in the plan: the run puts its prefix on PATH", () => {
		const plan = build(
			createPlatformFacts({ hasBrew: false, brewPrefix: undefined }),
			NOTHING,
		);
		expect(plan.pathAdditions).toEqual([
			"/opt/homebrew/bin",
			"/opt/homebrew/sbin",
		]);
		const onPath = build(createPlatformFacts({ brewOnPath: true }), NOTHING);
		expect(onPath.pathAdditions).toBeUndefined();
	});

	test("Homebrew installed but off PATH: Colima by its brew path, PATH added, shellenv note", () => {
		const install = build(createPlatformFacts({ brewOnPath: false }), NOTHING);
		const start = install.steps.find((s) => s.id === SETUP_STEP.colimaStart);
		expect(start?.argv).toEqual(["/opt/homebrew/bin/colima", "start"]);
		expect(start?.env?.PATH).toStartWith("/opt/homebrew/bin:");
		expect(install.pathAdditions).toEqual([
			"/opt/homebrew/bin",
			"/opt/homebrew/sbin",
		]);
		expect(install.postNotes.join(" ")).toContain("brew shellenv");
		expect(install.steps.some((s) => s.id === SETUP_STEP.brewInstall)).toBe(
			false,
		);

		const stopped = build(
			createPlatformFacts({
				brewOnPath: false,
				installedRuntimes: ["colima"],
				dockerCliPath: "/opt/homebrew/bin/docker",
			}),
			DOWN,
		);
		expect(stopped.kind).toBe("start");
		expect(stopped.steps[0]?.argv).toEqual([
			"/opt/homebrew/bin/colima",
			"start",
		]);
		expect(stopped.pathAdditions).toEqual([
			"/opt/homebrew/bin",
			"/opt/homebrew/sbin",
		]);
	});

	test("Colima requested next to Docker Desktop (Intel): keeps Desktop's docker CLI and compose", () => {
		const facts = createPlatformFacts({
			arch: "x64",
			brewPrefix: "/usr/local",
			installedRuntimes: ["docker-desktop"],
			dockerCliPath: "/usr/local/bin/docker",
		});
		const plan = build(facts, DOWN, { runtime: "colima" });
		expect(plan.kind).toBe("install");
		expect(commands(plan)).toEqual([
			"/usr/local/bin/brew install colima",
			"colima start",
		]);
		expect(plan.postNotes.join(" ")).toContain(
			"Keeps the Docker CLI at /usr/local/bin/docker",
		);
		// Compose broken too: only docker-compose joins, and the link is shown.
		const compose = build(facts, [...DOWN, DOCTOR_CHECK.composePlugin], {
			runtime: "colima",
		});
		expect(commands(compose).slice(0, 1)).toEqual([
			"/usr/local/bin/brew install colima docker-compose",
		]);
		expect(
			compose.steps.find((s) => s.id === SETUP_STEP.composePluginLink)?.note,
		).toContain("Replaces any docker-compose plugin");
		// Desktop installed but its CLI missing: the docker formula, with a warning.
		const noCli = build(
			{ ...facts, dockerCliPath: undefined },
			[DOCTOR_CHECK.dockerCli, ...DOWN],
			{ runtime: "colima" },
		);
		expect(commands(noCli)[0]).toBe(
			"/usr/local/bin/brew install colima docker docker-compose",
		);
		expect(noCli.postNotes.join(" ")).toContain("brew link --overwrite docker");
	});
});
