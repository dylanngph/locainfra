#!/usr/bin/env node

/**
 * npm launcher for LocaStack.
 *
 * The `locastack` package ships no binary itself. npm installs exactly one
 * `@locastack/cli-<target>` optional dependency (selected by its `os`, `cpu`
 * and `libc` fields); this script finds that package's `bin/locastack` and
 * runs it with the caller's arguments, stdio, exit code and signals.
 */

const fs = require("node:fs");
const os = require("node:os");
const { execFileSync, spawn } = require("node:child_process");

/** One-line installer shown when no platform package is available. */
const INSTALLER =
	"curl -fsSL https://raw.githubusercontent.com/dylanngph/locastack/main/install.sh | sh";

/** Printed when an Intel Node on Apple silicon can only run the x64 binary. */
const ROSETTA_WARNING =
	"locastack: running the Intel build under Rosetta because Node is Intel; install an Apple Silicon Node for a native binary.";

/** Signals forwarded to the child so it can shut down cleanly. */
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * Maps a Node platform/arch/libc triple to a release target name.
 *
 * @param {string} platform `process.platform`
 * @param {string} arch `process.arch`
 * @param {boolean} musl whether the Linux C library is musl
 * @returns {string | null} e.g. `linux-x64-musl`, or `null` when unsupported
 */
function targetFor(platform, arch, musl) {
	if (platform !== "darwin" && platform !== "linux") return null;
	if (arch !== "arm64" && arch !== "x64") return null;
	const base = `${platform}-${arch}`;
	return platform === "linux" && musl ? `${base}-musl` : base;
}

/**
 * Detects whether the running Linux system uses musl (Alpine and friends).
 * Prefers Node's diagnostic report, which only has `glibcVersionRuntime` on
 * glibc; falls back to looking for the musl dynamic loader in `/lib`.
 *
 * @returns {boolean}
 */
function isMusl() {
	if (process.platform !== "linux") return false;
	try {
		if (process.report) {
			if ("excludeNetwork" in process.report)
				process.report.excludeNetwork = true;
			const header = process.report.getReport().header;
			if (header) return !header.glibcVersionRuntime;
		}
	} catch {
		// fall through to the filesystem check
	}
	try {
		return fs.readdirSync("/lib").some((name) => name.startsWith("ld-musl-"));
	} catch {
		return false;
	}
}

/**
 * Whether this process is an Intel binary translated by Rosetta 2 (an x64
 * Node on an Apple silicon Mac): `sysctl -n sysctl.proc_translated` prints
 * `1` then, `0` for a native process, and fails on Intel Macs.
 *
 * @param {typeof execFileSync} [exec] runs `sysctl` (injectable for tests)
 * @returns {boolean}
 */
function isRosettaTranslated(exec = execFileSync) {
	try {
		const out = exec("sysctl", ["-n", "sysctl.proc_translated"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return String(out).trim() === "1";
	} catch {
		return false;
	}
}

/**
 * Picks the platform binary to run. An Intel Node under Rosetta installs the
 * `darwin-x64` package, but the Mac is Apple silicon: prefer
 * `@locastack/cli-darwin-arm64` when it is resolvable (it runs natively),
 * else run the x64 binary with a one-line warning.
 *
 * @param {{
 *   platform: string,
 *   arch: string,
 *   musl: boolean,
 *   translated: () => boolean,
 *   resolve: (request: string) => string,
 * }} host `process.platform`/`arch`, libc, the Rosetta check and `require.resolve`
 * @returns {{ kind: "unsupported" }
 *   | { kind: "missing", target: string }
 *   | { kind: "found", target: string, binary: string, warning?: string }}
 */
function selectBinary(host) {
	const target = targetFor(host.platform, host.arch, host.musl);
	if (target === null) return { kind: "unsupported" };
	const find = (name) => {
		try {
			return host.resolve(`@locastack/cli-${name}/bin/locastack`);
		} catch {
			return null;
		}
	};
	const underRosetta =
		host.platform === "darwin" && host.arch === "x64" && host.translated();
	if (underRosetta) {
		const native = find("darwin-arm64");
		if (native !== null)
			return { kind: "found", target: "darwin-arm64", binary: native };
	}
	const binary = find(target);
	if (binary === null) return { kind: "missing", target };
	return underRosetta
		? { kind: "found", target, binary, warning: ROSETTA_WARNING }
		: { kind: "found", target, binary };
}

/**
 * Prints a message to stderr and exits with status 1.
 *
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
	process.stderr.write(`locastack: ${message}\n`);
	process.exit(1);
}

/** Resolves the platform binary and runs it, mirroring its exit and signals. */
function main() {
	const selected = selectBinary({
		platform: process.platform,
		arch: process.arch,
		musl: isMusl(),
		translated: () => isRosettaTranslated(),
		resolve: (request) => require.resolve(request),
	});
	if (selected.kind === "unsupported") {
		const planned =
			process.platform === "win32" ? " (Windows support is planned)" : "";
		fail(
			`unsupported platform ${process.platform}-${process.arch}${planned}.\n` +
				"Supported: macOS and Linux on arm64 or x64.",
		);
	}

	if (selected.kind === "missing") {
		const target = selected.target;
		const pkg = `@locastack/cli-${target}`;
		fail(
			`the prebuilt binary for ${target} (${pkg}) is not installed.\n` +
				"npm skips it when optional dependencies are omitted (--omit=optional, --no-optional)\n" +
				"or when the lockfile was generated on another platform. Reinstall with optional\n" +
				"dependencies enabled, or install the standalone binary instead:\n\n" +
				`  ${INSTALLER}\n`,
		);
	}
	const binary = selected.binary;
	if (selected.warning) process.stderr.write(`${selected.warning}\n`);

	// Some package managers drop the executable bit when unpacking.
	try {
		fs.accessSync(binary, fs.constants.X_OK);
	} catch {
		try {
			fs.chmodSync(binary, 0o755);
		} catch {
			// spawn reports the real error below
		}
	}

	const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });

	// Forward termination signals instead of dying first and orphaning the child.
	const forward = (signal) => {
		if (child.exitCode === null && child.signalCode === null)
			child.kill(signal);
	};
	const handlers = FORWARDED_SIGNALS.map((signal) => {
		const handler = () => forward(signal);
		process.on(signal, handler);
		return [signal, handler];
	});

	child.on("error", (error) =>
		fail(`could not run ${binary}: ${error.message}`),
	);
	child.on("exit", (code, signal) => {
		for (const [name, handler] of handlers) process.off(name, handler);
		if (signal) {
			// Re-raise so our parent sees the same termination signal.
			process.kill(process.pid, signal);
			process.exit(128 + (os.constants.signals[signal] || 0));
		}
		process.exit(code === null ? 1 : code);
	});
}

module.exports = {
	targetFor,
	isMusl,
	isRosettaTranslated,
	selectBinary,
	ROSETTA_WARNING,
};

if (require.main === module) main();
