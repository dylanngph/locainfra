import { describe, expect, test } from "bun:test";
import { PlatformFacts } from "@locastack/core";
import { Value } from "@sinclair/typebox/value";
import {
	classifyRuntime,
	HostPlatformInspector,
	type HostPlatformInspectorOptions,
	hasDockerGroup,
	type PlatformProbe,
	type ProbeOutput,
	type SocketPing,
	toPlatformOs,
} from "../platform-inspector";

/** Scripted, read-only machine that records every probe. */
class RecordingProbe implements PlatformProbe {
	readonly calls: string[] = [];
	readonly onPath = new Map<string, string>();
	readonly files = new Set<string>();
	readonly links = new Map<string, string>();
	readonly commands = new Map<string, ProbeOutput>();
	readonly answering = new Set<string>();
	readonly denying = new Set<string>();
	failAll = false;

	async which(name: string): Promise<string | undefined> {
		this.calls.push(`which ${name}`);
		if (this.failAll) throw new Error("boom");
		return this.onPath.get(name);
	}

	async exists(path: string): Promise<boolean> {
		this.calls.push(`exists ${path}`);
		if (this.failAll) throw new Error("boom");
		return this.files.has(path);
	}

	async realpath(path: string): Promise<string | undefined> {
		this.calls.push(`realpath ${path}`);
		return this.links.get(path) ?? (this.files.has(path) ? path : undefined);
	}

	async exec(argv: readonly string[]): Promise<ProbeOutput | undefined> {
		const line = argv.join(" ");
		this.calls.push(`exec ${line}`);
		if (this.failAll) throw new Error("boom");
		return this.commands.get(line);
	}

	async ping(socketPath: string): Promise<SocketPing> {
		this.calls.push(`ping ${socketPath}`);
		if (this.answering.has(socketPath)) return "answers";
		return this.denying.has(socketPath) ? "denied" : "down";
	}

	execs(): string[] {
		return this.calls.filter((c) => c.startsWith("exec "));
	}
}

const CONTEXT_FORMAT =
	"context inspect --format {{.Name}} {{.Endpoints.docker.Host}}";

function inspector(
	probe: PlatformProbe,
	overrides: HostPlatformInspectorOptions = {},
): HostPlatformInspector {
	return new HostPlatformInspector({
		probe,
		platform: "darwin",
		arch: "arm64",
		env: { SHELL: "/bin/zsh" },
		homeDir: "/Users/dev",
		username: "dev",
		uid: 501,
		tmpRoot: "/tmp/root",
		randomId: () => "abc123",
		...overrides,
	});
}

function macWithDesktop(): RecordingProbe {
	const probe = new RecordingProbe();
	probe.onPath.set("brew", "/opt/homebrew/bin/brew");
	probe.onPath.set("docker", "/usr/local/bin/docker");
	probe.commands.set("/opt/homebrew/bin/brew --prefix", {
		exitCode: 0,
		stdout: "/opt/homebrew\n",
	});
	probe.commands.set(`/usr/local/bin/docker ${CONTEXT_FORMAT}`, {
		exitCode: 0,
		stdout: "desktop-linux unix:///Users/dev/.docker/run/docker.sock\n",
	});
	probe.files.add("/Applications/Docker.app");
	probe.files.add("/Users/dev/.docker/run/docker.sock");
	probe.answering.add("/Users/dev/.docker/run/docker.sock");
	return probe;
}

describe("HostPlatformInspector (macOS)", () => {
	test("Docker Desktop installed and running, Homebrew on PATH", async () => {
		const probe = macWithDesktop();
		const facts = await inspector(probe).inspect();
		expect(facts).toEqual({
			os: "darwin",
			arch: "arm64",
			hasBrew: true,
			brewOnPath: true,
			brewNative: true,
			brewPrefix: "/opt/homebrew",
			hasSystemd: false,
			installedRuntimes: ["docker-desktop"],
			runningRuntime: "docker-desktop",
			dockerContext: "desktop-linux",
			dockerCliPath: "/usr/local/bin/docker",
			shell: "/bin/zsh",
			homeDir: "/Users/dev",
			username: "dev",
			tmpDir: "/tmp/root/locastack-setup-abc123",
			isRoot: false,
		});
		expect(Value.Check(PlatformFacts, facts)).toBe(true);
		// Read only: exactly these two commands, no systemd or group probes on macOS.
		expect(probe.execs()).toEqual([
			"exec /opt/homebrew/bin/brew --prefix",
			`exec /usr/local/bin/docker ${CONTEXT_FORMAT}`,
		]);
		expect(probe.calls).not.toContain("exists /run/systemd/system");
		expect(probe.calls).toContain(
			"exists /Users/dev/Applications/OrbStack.app",
		);
		expect(probe.calls).toContain("exists /opt/homebrew/bin/colima");
		expect("inDockerGroup" in facts).toBe(false);
	});

	test("brew off PATH: found at its default prefix, prefix derived when `brew --prefix` fails", async () => {
		const probe = new RecordingProbe();
		probe.files.add("/usr/local/bin/brew");
		probe.files.add("/usr/local/bin/colima");
		probe.files.add("/Users/dev/Applications/OrbStack.app");
		probe.files.add("/Applications/Docker.app");
		const facts = await inspector(probe).inspect();
		expect(facts.hasBrew).toBe(true);
		expect(facts.brewOnPath).toBe(false);
		expect(facts.brewPrefix).toBe("/usr/local");
		expect(facts.installedRuntimes).toEqual([
			"colima",
			"docker-desktop",
			"orbstack",
		]);
		expect(probe.calls).toContain("exists /opt/homebrew/bin/brew");
		expect(probe.execs()).toEqual(["exec /usr/local/bin/brew --prefix"]);
	});

	test("Apple silicon with the Intel Homebrew at /usr/local: not native, its Colima formulae listed", async () => {
		const probe = new RecordingProbe();
		probe.onPath.set("brew", "/usr/local/bin/brew");
		probe.onPath.set("colima", "/usr/local/bin/colima");
		probe.commands.set("/usr/local/bin/brew --prefix", {
			exitCode: 0,
			stdout: "/usr/local\n",
		});
		probe.files.add("/usr/local/Cellar/colima");
		probe.files.add("/usr/local/Cellar/lima");
		probe.files.add("/usr/local/Cellar/docker-compose");
		const facts = await inspector(probe).inspect();
		expect(facts.brewPrefix).toBe("/usr/local");
		expect(facts.brewNative).toBe(false);
		expect(facts.intelBrewFormulae).toEqual([
			"colima",
			"lima",
			"docker-compose",
		]);
		expect(facts.nativeBrewPrefix).toBeUndefined();
		expect(facts.installedRuntimes).toEqual(["colima"]);
		expect(Value.Check(PlatformFacts, facts)).toBe(true);
		// The prefix alone tells: no `file` probe.
		expect(probe.execs()).toEqual(["exec /usr/local/bin/brew --prefix"]);

		probe.files.add("/opt/homebrew/bin/brew");
		const both = await inspector(probe).inspect();
		expect(both.brewPrefix).toBe("/usr/local");
		expect(both.nativeBrewPrefix).toBe("/opt/homebrew");
	});

	test("a custom Homebrew prefix is Intel only when `file` says x86_64-only", async () => {
		const probe = new RecordingProbe();
		probe.onPath.set("brew", "/opt/brew/bin/brew");
		probe.commands.set("/opt/brew/bin/brew --prefix", {
			exitCode: 0,
			stdout: "/opt/brew\n",
		});
		probe.commands.set("file -b /opt/brew/bin/brew", {
			exitCode: 0,
			stdout: "Mach-O 64-bit executable x86_64\n",
		});
		expect((await inspector(probe).inspect()).brewNative).toBe(false);
		probe.commands.set("file -b /opt/brew/bin/brew", {
			exitCode: 0,
			stdout: "Bourne-Again shell script text executable, ASCII text\n",
		});
		const script = await inspector(probe).inspect();
		expect(script.brewNative).toBe(true);
		expect(script.intelBrewFormulae).toBeUndefined();
	});

	test("an Intel Mac's /usr/local Homebrew is native; Linux reports no nativity", async () => {
		const probe = new RecordingProbe();
		probe.onPath.set("brew", "/usr/local/bin/brew");
		probe.commands.set("/usr/local/bin/brew --prefix", {
			exitCode: 0,
			stdout: "/usr/local\n",
		});
		const intelMac = await inspector(probe, { arch: "x64" }).inspect();
		expect(intelMac.brewNative).toBe(true);
		expect(intelMac.intelBrewFormulae).toBeUndefined();
		expect(probe.calls).not.toContain("exists /opt/homebrew/bin/brew");

		const linux = await inspector(probe, {
			platform: "linux",
			arch: "x64",
		}).inspect();
		expect("brewNative" in linux).toBe(false);
	});

	test("nothing installed: no brew, no docker CLI, no context lookup, nothing running", async () => {
		const probe = new RecordingProbe();
		const facts = await inspector(probe).inspect();
		expect(facts.hasBrew).toBe(false);
		expect(facts.brewPrefix).toBeUndefined();
		expect(facts.dockerCliPath).toBeUndefined();
		expect(facts.installedRuntimes).toEqual([]);
		expect(facts.runningRuntime).toBeUndefined();
		expect(probe.execs()).toEqual([]);
		expect(probe.calls.filter((c) => c.startsWith("ping"))).toEqual([]);
		expect(Value.Check(PlatformFacts, facts)).toBe(true);
	});

	test("Colima context → colima", async () => {
		const probe = macWithDesktop();
		probe.onPath.set("colima", "/opt/homebrew/bin/colima");
		probe.commands.set(`/usr/local/bin/docker ${CONTEXT_FORMAT}`, {
			exitCode: 0,
			stdout: "colima unix:///Users/dev/.colima/default/docker.sock\n",
		});
		probe.files.add("/Users/dev/.colima/default/docker.sock");
		probe.answering.add("/Users/dev/.colima/default/docker.sock");
		const facts = await inspector(probe).inspect();
		expect(facts.runningRuntime).toBe("colima");
		expect(facts.installedRuntimes).toEqual(["colima", "docker-desktop"]);
	});

	test("installed but stopped: the socket exists but does not answer", async () => {
		const probe = macWithDesktop();
		probe.answering.clear();
		const facts = await inspector(probe).inspect();
		expect(facts.installedRuntimes).toEqual(["docker-desktop"]);
		expect(facts.runningRuntime).toBeUndefined();
		expect(probe.calls).toContain("ping /Users/dev/.docker/run/docker.sock");
	});

	test("default context on /var/run/docker.sock resolves through the symlink", async () => {
		const probe = macWithDesktop();
		probe.commands.set(`/usr/local/bin/docker ${CONTEXT_FORMAT}`, {
			exitCode: 0,
			stdout: "default unix:///var/run/docker.sock\n",
		});
		probe.files.add("/var/run/docker.sock");
		probe.links.set(
			"/var/run/docker.sock",
			"/Users/dev/.orbstack/run/docker.sock",
		);
		probe.answering.add("/var/run/docker.sock");
		const facts = await inspector(probe).inspect();
		expect(facts.runningRuntime).toBe("orbstack");
	});

	test("DOCKER_HOST wins over the context; a tcp host is not classified", async () => {
		const probe = macWithDesktop();
		probe.files.add("/Users/dev/.orbstack/run/docker.sock");
		probe.answering.add("/Users/dev/.orbstack/run/docker.sock");
		const unix = await inspector(probe, {
			env: { DOCKER_HOST: "unix:///Users/dev/.orbstack/run/docker.sock" },
		}).inspect();
		expect(unix.runningRuntime).toBe("orbstack");
		expect(probe.execs().some((c) => c.includes("context inspect"))).toBe(
			false,
		);

		const tcp = await inspector(macWithDesktop(), {
			env: { DOCKER_HOST: "tcp://10.0.0.2:2375" },
		}).inspect();
		expect(tcp.runningRuntime).toBeUndefined();
	});

	test("context name, DOCKER_HOST and brew off PATH are reported even with the daemon down", async () => {
		const probe = macWithDesktop();
		probe.answering.clear();
		const down = await inspector(probe).inspect();
		expect(down.runningRuntime).toBeUndefined();
		expect(down.dockerContext).toBe("desktop-linux");
		expect(down.dockerHost).toBeUndefined();

		const withHost = await inspector(macWithDesktop(), {
			env: { DOCKER_HOST: "  tcp://10.0.0.2:2375 " },
		}).inspect();
		expect(withHost.dockerHost).toBe("tcp://10.0.0.2:2375");
		expect(withHost.dockerContext).toBeUndefined();
		expect(Value.Check(PlatformFacts, withHost)).toBe(true);
	});

	test("a context without a socket falls back to the platform defaults", async () => {
		const probe = macWithDesktop();
		probe.commands.set(`/usr/local/bin/docker ${CONTEXT_FORMAT}`, {
			exitCode: 1,
			stdout: "",
		});
		const facts = await inspector(probe).inspect();
		expect(facts.runningRuntime).toBe("docker-desktop");
		expect(probe.calls).toContain("exists /Users/dev/.docker/run/docker.sock");
	});

	test("never rejects when every probe throws", async () => {
		const probe = macWithDesktop();
		probe.failAll = true;
		const facts = await inspector(probe).inspect();
		expect(facts.hasBrew).toBe(false);
		expect(facts.installedRuntimes).toEqual([]);
		expect(facts.runningRuntime).toBeUndefined();
		expect(Value.Check(PlatformFacts, facts)).toBe(true);
	});

	test("tmpDir is fresh per inspection", async () => {
		let n = 0;
		const subject = inspector(new RecordingProbe(), {
			randomId: () => `id${++n}`,
		});
		const first = await subject.inspect();
		const second = await subject.inspect();
		expect(first.tmpDir).toBe("/tmp/root/locastack-setup-id1");
		expect(second.tmpDir).toBe("/tmp/root/locastack-setup-id2");
	});
});

describe("HostPlatformInspector (Linux)", () => {
	function linuxBox(): RecordingProbe {
		const probe = new RecordingProbe();
		probe.onPath.set("docker", "/usr/bin/docker");
		probe.files.add("/run/systemd/system");
		probe.files.add("/lib/systemd/system/docker.service");
		probe.files.add("/var/run/docker.sock");
		probe.commands.set(`/usr/bin/docker ${CONTEXT_FORMAT}`, {
			exitCode: 0,
			stdout: "default unix:///var/run/docker.sock\n",
		});
		probe.commands.set("id -nG", { exitCode: 0, stdout: "dev sudo docker\n" });
		probe.answering.add("/var/run/docker.sock");
		return probe;
	}
	const linux: HostPlatformInspectorOptions = {
		platform: "linux",
		arch: "x64",
		env: { SHELL: "/bin/bash" },
		homeDir: "/home/dev",
	};

	test("systemd + docker-engine running, user in the docker group", async () => {
		const probe = linuxBox();
		const facts = await inspector(probe, linux).inspect();
		expect(facts).toMatchObject({
			os: "linux",
			hasSystemd: true,
			hasBrew: false,
			installedRuntimes: ["docker-engine"],
			runningRuntime: "docker-engine",
			inDockerGroup: true,
			isRoot: false,
		});
		expect(probe.calls).toContain("exists /home/linuxbrew/.linuxbrew/bin/brew");
		expect(probe.calls).toContain("exec id -nG");
		expect(probe.calls).not.toContain("exists /Applications/Docker.app");
		expect(Value.Check(PlatformFacts, facts)).toBe(true);
	});

	test("not in the docker group; dockerd found without a unit file", async () => {
		const probe = new RecordingProbe();
		probe.files.add("/usr/bin/dockerd");
		probe.commands.set("id -nG", { exitCode: 0, stdout: "dev sudo" });
		const facts = await inspector(probe, linux).inspect();
		expect(facts.installedRuntimes).toEqual(["docker-engine"]);
		expect(facts.inDockerGroup).toBe(false);
		expect(facts.hasSystemd).toBe(false);
	});

	test("root: in the group without asking `id`", async () => {
		const probe = linuxBox();
		const facts = await inspector(probe, { ...linux, uid: 0 }).inspect();
		expect(facts.isRoot).toBe(true);
		expect(facts.inDockerGroup).toBe(true);
		expect(probe.calls).not.toContain("exec id -nG");
	});

	test("running engine refusing this user (EACCES): counts as running docker-engine", async () => {
		const probe = linuxBox();
		probe.answering.clear();
		probe.denying.add("/var/run/docker.sock");
		probe.commands.set("id -nG", { exitCode: 0, stdout: "dev sudo" });
		const facts = await inspector(probe, linux).inspect();
		expect(facts.runningRuntime).toBe("docker-engine");
		expect(facts.inDockerGroup).toBe(false);
		expect(facts.dockerContext).toBe("default");
	});

	test("Docker Desktop for Linux", async () => {
		const probe = new RecordingProbe();
		probe.files.add("/opt/docker-desktop");
		probe.files.add("/home/dev/.docker/desktop/docker.sock");
		probe.answering.add("/home/dev/.docker/desktop/docker.sock");
		const facts = await inspector(probe, linux).inspect();
		expect(facts.installedRuntimes).toEqual(["docker-desktop"]);
		expect(facts.runningRuntime).toBe("docker-desktop");
	});
});

describe("HostPlatformInspector (other OS)", () => {
	test("win32 probes nothing", async () => {
		const probe = new RecordingProbe();
		const facts = await inspector(probe, { platform: "win32" }).inspect();
		expect(facts.os).toBe("win32");
		expect(facts.installedRuntimes).toEqual([]);
		expect(probe.calls).toEqual([]);
		expect(Value.Check(PlatformFacts, facts)).toBe(true);
	});
});

describe("helpers", () => {
	test("toPlatformOs folds unknown platforms", () => {
		expect(toPlatformOs("darwin")).toBe("darwin");
		expect(toPlatformOs("freebsd")).toBe("other");
	});

	test("hasDockerGroup matches whole names only", () => {
		expect(hasDockerGroup("dev docker\n")).toBe(true);
		expect(hasDockerGroup("dev dockerroot")).toBe(false);
	});

	test("classifyRuntime", () => {
		expect(classifyRuntime("darwin", "colima-work", ["/x"])).toBe("colima");
		expect(classifyRuntime("darwin", "orbstack", ["/x"])).toBe("orbstack");
		expect(
			classifyRuntime("darwin", undefined, ["/Users/a/.rd/docker.sock"]),
		).toBe("rancher-desktop");
		expect(classifyRuntime("linux", "default", ["/run/docker.sock"])).toBe(
			"docker-engine",
		);
		expect(classifyRuntime("darwin", "default", ["/var/run/docker.sock"])).toBe(
			"unknown",
		);
		expect(classifyRuntime("darwin", "my-remote", ["/tmp/x.sock"])).toBe(
			"my-remote",
		);
	});
});
