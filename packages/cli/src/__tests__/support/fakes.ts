import { Writable } from "node:stream";
import {
	type DoctorReport,
	err,
	type FileStore,
	OpError,
	ok,
	type PlanSetupInput,
	type Progress,
	type RunSetupPlanInput,
	type SetupPlan,
	type Stack,
} from "@locastack/core";
import {
	FakeDaemonWaiter,
	FakePlatformInspector,
	FakeProcessRunner,
} from "@locastack/core/testing";
import type {
	CliDeps,
	CliDepsLoader,
	CliIo,
	CliOps,
	DashboardLauncher,
	ExitCode,
	RunningDashboardInfo,
} from "../../cli.types";

/** Writable that records everything written to it (test-only). */
export class MemoryStream extends Writable {
	/** Accumulated output. */
	text = "";

	/** @inheritdoc */
	override _write(
		chunk: Buffer | string,
		_encoding: BufferEncoding,
		callback: (error?: Error | null) => void,
	): void {
		this.text += chunk.toString();
		callback();
	}
}

/** A {@link CliIo} backed by memory streams (test-only). */
export interface FakeIo extends CliIo {
	/** Captured stdout. */
	readonly out: MemoryStream;
	/** Captured stderr. */
	readonly errOut: MemoryStream;
	/** Every exit code set, in order. */
	readonly exitCodes: ExitCode[];
	/** Every question asked (confirmations and selects), in order. */
	readonly questions: string[];
}

/**
 * Scripted answer to one prompt: a boolean answers a confirmation, a string
 * picks a select option, `false` cancels a select, `undefined` falls back to
 * the default (`confirm` option; the select's initial value).
 */
export type FakeAnswer = boolean | string | undefined;

/**
 * Builds a fake IO.
 *
 * @param options - TTY mode and the answer to confirmations.
 * @returns A {@link FakeIo}.
 */
export function createFakeIo(
	options: {
		isTTY?: boolean;
		confirm?: boolean;
		cwd?: string;
		/** Question hook: answers each prompt by its message. */
		answer?: (question: string) => FakeAnswer;
	} = {},
): FakeIo {
	const out = new MemoryStream();
	const errOut = new MemoryStream();
	const exitCodes: ExitCode[] = [];
	const questions: string[] = [];
	return {
		stdout: out,
		stderr: errOut,
		out,
		errOut,
		exitCodes,
		questions,
		isTTY: options.isTTY ?? false,
		prompter: {
			confirm: async (message) => {
				questions.push(message);
				const answer = options.answer?.(message);
				return typeof answer === "boolean"
					? answer
					: (options.confirm ?? false);
			},
			select: async (message, choices, initialValue) => {
				questions.push(message);
				const answer = options.answer?.(message);
				if (answer === false) return undefined;
				return (
					choices.find((choice) => choice.value === answer)?.value ??
					initialValue
				);
			},
		},
		cwd: () => options.cwd ?? "/work/acme",
		setExitCode: (code) => {
			exitCodes.push(code);
		},
	};
}

/**
 * A port object that fails loudly if any member is touched. The CLI only
 * forwards deps to (faked) ops, so real ports are never needed in these tests.
 *
 * @param name - Port name for the error message.
 * @returns A value typed as `T`.
 */
export function unusedPort<T extends object>(name: string): T {
	return new Proxy({} as T, {
		get(_target, prop) {
			if (prop === "then") return undefined;
			throw new Error(
				`port ${name} should not be used (touched ${String(prop)})`,
			);
		},
	});
}

/** A sample project stack. */
export const sampleStack: Stack = {
	name: "acme",
	root: "/work/acme",
	filePath: "/work/acme/locastack.yaml",
	file: { version: 1, name: "acme", services: { db: { type: "postgres" } } },
};

/** A healthy doctor report with one warning. */
export const sampleReport: DoctorReport = {
	ok: true,
	generatedAt: "2026-09-23T10:00:00.000Z",
	checks: [
		{
			id: "docker.daemon",
			label: "Docker reachable",
			status: "ok",
			detail: "Engine 29.6.1",
		},
		{
			id: "compose.version",
			label: "Compose version",
			status: "warn",
			detail: "2.25.0",
			fix: "Update Docker Desktop",
		},
	],
};

/** Records of what the fake ops were called with. */
export interface OpCalls {
	/** `upStack` inputs. */
	readonly up: { stack: Stack; services?: readonly string[] }[];
	/** `downStack` inputs. */
	readonly down: { stack: Stack; volumes?: boolean }[];
	/** `envForStack` formats. */
	readonly env: string[];
	/** `discoverStack` inputs. */
	readonly discover: { cwd: string }[];
	/** `registerProject` / `createProject` inputs. */
	readonly projects: {
		op: "register" | "create";
		name: string;
		root: string;
	}[];
	/** Dashboard launcher calls, in order (`find`, `port:<from>`, `start:<port>`, `open:<url>`, `wait`, `stop`). */
	readonly dashboard: string[];
	/** `runDoctor` call count. */
	doctor: number;
	/** `planSetup` inputs. */
	readonly planSetup: PlanSetupInput[];
	/** `runSetupPlan` inputs. */
	readonly setupRuns: RunSetupPlanInput[];
}

/** Behaviour switches for {@link createFakeDeps}. */
export interface FakeDepsOptions {
	/** Report returned by `runDoctor` (after {@link FakeDepsOptions.reports} is used up). */
	readonly report?: DoctorReport;
	/** Reports returned by the first `runDoctor` calls, one per call (e.g. failing, then ok after setup). */
	readonly reports?: readonly DoctorReport[];
	/** Plan returned by `planSetup` (default: {@link macColimaInstallPlan}), or a function of its input. */
	readonly plan?: SetupPlan | ((input: PlanSetupInput) => SetupPlan);
	/** Events emitted by `upStack` / `downStack`. */
	readonly events?: readonly Progress[];
	/** Make `discoverStack` fail with `STACK_NOT_FOUND`. */
	readonly noStack?: boolean;
	/** Make `envForStack` fail. */
	readonly envFails?: boolean;
	/** A dashboard that is already running (reused instead of started). */
	readonly running?: RunningDashboardInfo;
	/** Folders (absolute) that contain a `locastack.yaml`, with its text. */
	readonly stackFiles?: Readonly<Record<string, string>>;
	/** Make `launcher.start` throw. */
	readonly startFails?: boolean;
}

/**
 * Builds fake {@link CliDeps} with recording ops.
 *
 * @param options - Behaviour switches.
 * @returns The loader, and the call log.
 */
export function createFakeDeps(options: FakeDepsOptions = {}): {
	loadDeps: CliDepsLoader;
	calls: OpCalls;
	runner: FakeProcessRunner;
	waiter: FakeDaemonWaiter;
	platform: FakePlatformInspector;
} {
	const calls: OpCalls = {
		up: [],
		down: [],
		env: [],
		discover: [],
		projects: [],
		dashboard: [],
		doctor: 0,
		planSetup: [],
		setupRuns: [],
	};
	const reports = [...(options.reports ?? [])];
	const runner = new FakeProcessRunner();
	const waiter = new FakeDaemonWaiter();
	const platform = new FakePlatformInspector();
	const events = options.events ?? [
		{ kind: "step", message: "Rendering compose file" },
		{
			kind: "log",
			message: "Container ls-acme-postgres Started",
			service: "postgres",
		},
		{ kind: "done", message: "Stack acme is up" },
	];
	async function* stream(): AsyncIterable<Progress> {
		for (const e of events) yield e;
	}
	const ops: CliOps = {
		runDoctor: async () => {
			calls.doctor += 1;
			return reports.shift() ?? options.report ?? sampleReport;
		},
		planSetup: async (_deps, input) => {
			calls.planSetup.push(input);
			const plan = options.plan ?? macColimaInstallPlan;
			return typeof plan === "function" ? plan(input) : plan;
		},
		runSetupPlan: (deps, input) => {
			calls.setupRuns.push(input);
			return fakeRunSetupPlan(deps.runner, deps.waiter, input);
		},
		upStack: (_deps, input) => {
			calls.up.push(input);
			return stream();
		},
		downStack: (_deps, input) => {
			calls.down.push(input);
			return stream();
		},
		envForStack: async (_deps, input) => {
			calls.env.push(input.format);
			if (options.envFails) {
				return err(new OpError("IO", "cannot read secrets"));
			}
			return ok(
				input.format === "json"
					? '{"DATABASE_URL":"postgres://x"}'
					: "DATABASE_URL=postgres://x",
			);
		},
		discoverStack: async (_deps, input) => {
			calls.discover.push(input);
			if (options.noStack) {
				return err(
					new OpError("STACK_NOT_FOUND", "No locastack.yaml found", {
						details: { cwd: input.cwd },
					}),
				);
			}
			return ok(sampleStack);
		},
		registerProject: async (_deps, input) => {
			calls.projects.push({ op: "register", ...input });
			return ok({ name: input.name, root: input.root });
		},
		createProject: async (_deps, input) => {
			calls.projects.push({ op: "create", name: input.name, root: input.root });
			return ok({
				name: input.name,
				root: input.root,
				filePath: `${input.root}/locastack.yaml`,
				file: { version: 1, name: input.name, services: {} },
			});
		},
	};
	const stackFiles = options.stackFiles ?? {};
	const files = {
		exists: async (path: string) =>
			Object.hasOwn(stackFiles, path.replace(/\/locastack\.yaml$/, "")),
		readText: async (path: string) =>
			stackFiles[path.replace(/\/locastack\.yaml$/, "")] ?? null,
	} as unknown as FileStore;
	const dashboard: DashboardLauncher = {
		findRunning: async () => {
			calls.dashboard.push("find");
			return options.running ?? null;
		},
		findFreePort: async (from) => {
			calls.dashboard.push(`port:${from}`);
			return from + 1;
		},
		createToken: () => "tok",
		start: async ({ port, token }) => {
			calls.dashboard.push(`start:${port}`);
			if (options.startFails) throw new Error("EADDRINUSE");
			return {
				port,
				url: `http://127.0.0.1:${port}/?t=${token}`,
				servesSpa: true,
				stop: async () => {
					calls.dashboard.push("stop");
				},
			};
		},
		openBrowser: async (url) => {
			calls.dashboard.push(`open:${url}`);
		},
		waitForShutdown: async () => {
			calls.dashboard.push("wait");
		},
	};
	const deps: CliDeps = {
		ops,
		doctor: unusedPort("doctor"),
		up: unusedPort("up"),
		down: unusedPort("down"),
		env: unusedPort("env"),
		discover: unusedPort("discover"),
		projects: { files, state: unusedPort("state") },
		setup: { platform, runner, waiter, doctor: unusedPort("doctor") },
		dashboard,
	};
	return { loadDeps: async () => deps, calls, runner, waiter, platform };
}

/**
 * Minimal stand-in for core's `runSetupPlan` (same event contract): a `step`
 * per command after `beforeStep`, stop at the first non-zero exit with
 * `SETUP_STEP_FAILED`, `SETUP_CANCELLED` on abort, then wait for the daemon
 * (skipped with `requiresRelogin`); `done` carries the plan's `postNotes`.
 */
async function* fakeRunSetupPlan(
	runner: FakeProcessRunner | { run: FakeProcessRunner["run"] },
	waiter: { waitForDocker(timeoutMs: number): Promise<boolean> },
	input: RunSetupPlanInput,
): AsyncIterable<Progress> {
	const { plan } = input;
	for (const [index, step] of plan.steps.entries()) {
		const decision = (await input.beforeStep?.(step, index, plan)) ?? "run";
		if (decision === "abort") {
			yield {
				kind: "error",
				message: "Setup cancelled",
				error: { code: "SETUP_CANCELLED", message: "Setup cancelled" },
			};
			return;
		}
		yield { kind: "step", message: step.title };
		const result = await runner.run(step, { attached: input.attached });
		if (result.exitCode !== 0) {
			const message = `${step.title} failed (exit ${result.exitCode})`;
			yield {
				kind: "error",
				message,
				error: {
					code: "SETUP_STEP_FAILED",
					message,
					details: { stepId: step.id, exitCode: result.exitCode },
				},
			};
			return;
		}
	}
	if (plan.requiresRelogin === true) {
		yield {
			kind: "done",
			message: [
				"Setup finished. Docker works for your user after you log out and back in (or run `newgrp docker`).",
				...plan.postNotes,
			].join("\n"),
		};
		return;
	}
	if (!(await waiter.waitForDocker(1000))) {
		yield {
			kind: "error",
			message: "Docker did not start in time",
			error: { code: "DOCKER_START_TIMEOUT", message: "timeout" },
		};
		return;
	}
	yield {
		kind: "done",
		message: ["Docker is ready: Engine 29.6.1", ...plan.postNotes].join("\n"),
	};
}

/** A failing report: Docker CLI missing on a Mac (setup: install). */
export const noDockerReport: DoctorReport = {
	ok: false,
	generatedAt: "2026-09-24T00:00:00.000Z",
	setupNeeded: "install",
	checks: [
		{
			id: "docker.cli",
			label: "Docker CLI",
			status: "fail",
			detail: "docker not found on PATH",
			fix: "Run `locastack setup` to install Docker.",
		},
	],
};

/** A failing report: the daemon is installed but stopped (setup: start). */
export const stoppedDockerReport: DoctorReport = {
	ok: false,
	generatedAt: "2026-09-24T00:00:00.000Z",
	setupNeeded: "start",
	checks: [
		{ id: "docker.cli", label: "Docker CLI", status: "ok" },
		{
			id: "docker.daemon",
			label: "Docker daemon",
			status: "fail",
			detail: "Docker is not running",
			fix: "Run `locastack setup` to start it.",
		},
	],
};

/** Colima install plan for an Apple silicon Mac with Homebrew (what core plans by default). */
export const macColimaInstallPlan: SetupPlan = {
	kind: "install",
	provider: "colima",
	alternatives: ["docker-desktop", "orbstack"],
	reason:
		"Docker is not installed; install Colima, the Docker CLI and Compose with Homebrew, then start Colima.",
	steps: [
		{
			id: "brew.install-colima",
			title: "Installing Colima, the Docker CLI and Compose",
			argv: [
				"/opt/homebrew/bin/brew",
				"install",
				"colima",
				"docker",
				"docker-compose",
			],
		},
		{
			id: "compose.plugin-dir",
			title: "Creating the Docker CLI plugins folder",
			argv: ["mkdir", "-p", "/Users/test/.docker/cli-plugins"],
		},
		{
			id: "compose.plugin-link",
			title: "Linking the Compose plugin",
			argv: [
				"ln",
				"-sfn",
				"/opt/homebrew/opt/docker-compose/bin/docker-compose",
				"/Users/test/.docker/cli-plugins/docker-compose",
			],
		},
		{
			id: "colima.start",
			title: "Starting Colima",
			argv: ["/opt/homebrew/bin/colima", "start"],
		},
	],
	postNotes: [
		"Colima does not start at login: run `colima start` after a reboot.",
	],
	needsTerminal: false,
};

/** Docker Desktop install plan (the runtime select's second option). */
export const macDesktopInstallPlan: SetupPlan = {
	kind: "install",
	provider: "docker-desktop",
	alternatives: ["colima", "orbstack"],
	reason:
		"Docker is not installed; install Docker Desktop with Homebrew and open it.",
	steps: [
		{
			id: "brew.install-docker-desktop",
			title: "Installing Docker Desktop",
			argv: ["/opt/homebrew/bin/brew", "install", "--cask", "docker"],
		},
		{
			id: "docker-desktop.open",
			title: "Opening Docker Desktop",
			argv: ["open", "-a", "Docker"],
			note: "Docker Desktop finishes setup in its own window.",
		},
	],
	postNotes: [],
	needsTerminal: false,
};

/** Linux: Docker Engine installed but stopped (systemd). */
export const linuxStartPlan: SetupPlan = {
	kind: "start",
	provider: "docker-engine",
	alternatives: [],
	reason: "Docker Engine is installed but not running; start it.",
	steps: [
		{
			id: "docker.start",
			title: "Starting Docker Engine",
			argv: ["sudo", "systemctl", "start", "docker"],
			sudo: true,
		},
	],
	postNotes: [],
	needsTerminal: true,
};

/** Linux: nothing installed (get.docker.com download, then sudo steps). */
export const linuxInstallPlan: SetupPlan = {
	kind: "install",
	provider: "docker-engine",
	alternatives: [],
	reason:
		"Docker is not installed; install Docker Engine with Docker's official script.",
	steps: [
		{
			id: "get-docker.download",
			title: "Downloading Docker's install script",
			argv: [
				"curl",
				"-fsSL",
				"https://get.docker.com",
				"-o",
				"/tmp/locastack-setup-test/get-docker.sh",
			],
			remoteScript: {
				url: "https://get.docker.com",
				path: "/tmp/locastack-setup-test/get-docker.sh",
				inspectHint: "less /tmp/locastack-setup-test/get-docker.sh",
			},
		},
		{
			id: "get-docker.run",
			title: "Installing Docker Engine",
			argv: ["sudo", "sh", "/tmp/locastack-setup-test/get-docker.sh"],
			sudo: true,
		},
		{
			id: "docker.group",
			title: "Adding you to the docker group",
			argv: ["sudo", "usermod", "-aG", "docker", "test"],
			sudo: true,
		},
	],
	postNotes: [
		"Log out and back in (or run `newgrp docker`) so the docker group applies.",
	],
	requiresRelogin: true,
	needsTerminal: true,
};
