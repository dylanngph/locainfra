import { Writable } from "node:stream";
import {
	type DoctorReport,
	err,
	type FileStore,
	OpError,
	ok,
	type Progress,
	type Stack,
} from "@locainfra/core";
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
	/** Every confirmation question asked. */
	readonly questions: string[];
}

/**
 * Builds a fake IO.
 *
 * @param options - TTY mode and the answer to confirmations.
 * @returns A {@link FakeIo}.
 */
export function createFakeIo(
	options: { isTTY?: boolean; confirm?: boolean; cwd?: string } = {},
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
				return options.confirm ?? false;
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
	filePath: "/work/acme/locainfra.yaml",
	file: { version: 1, name: "acme", services: { db: { type: "postgres" } } },
};

/** A healthy doctor report with one warning. */
export const sampleReport: DoctorReport = {
	ok: true,
	generatedAt: "2026-09-23T10:00:00.000Z",
	checks: [
		{
			id: "docker.reachable",
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
}

/** Behaviour switches for {@link createFakeDeps}. */
export interface FakeDepsOptions {
	/** Report returned by `runDoctor`. */
	readonly report?: DoctorReport;
	/** Events emitted by `upStack` / `downStack`. */
	readonly events?: readonly Progress[];
	/** Make `discoverStack` fail with `STACK_NOT_FOUND`. */
	readonly noStack?: boolean;
	/** Make `envForStack` fail. */
	readonly envFails?: boolean;
	/** A dashboard that is already running (reused instead of started). */
	readonly running?: RunningDashboardInfo;
	/** Folders (absolute) that contain a `locainfra.yaml`, with its text. */
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
} {
	const calls: OpCalls = {
		up: [],
		down: [],
		env: [],
		discover: [],
		projects: [],
		dashboard: [],
		doctor: 0,
	};
	const events = options.events ?? [
		{ kind: "step", message: "Rendering compose file" },
		{
			kind: "log",
			message: "Container li-acme-postgres Started",
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
			return options.report ?? sampleReport;
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
					new OpError("STACK_NOT_FOUND", "No locainfra.yaml found", {
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
				filePath: `${input.root}/locainfra.yaml`,
				file: { version: 1, name: input.name, services: {} },
			});
		},
	};
	const stackFiles = options.stackFiles ?? {};
	const files = {
		exists: async (path: string) =>
			Object.hasOwn(stackFiles, path.replace(/\/locainfra\.yaml$/, "")),
		readText: async (path: string) =>
			stackFiles[path.replace(/\/locainfra\.yaml$/, "")] ?? null,
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
		dashboard,
	};
	return { loadDeps: async () => deps, calls };
}
