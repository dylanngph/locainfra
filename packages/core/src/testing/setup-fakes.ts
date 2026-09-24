import type { DaemonWaiter } from "../ports/docker.port";
import type { PlatformFacts, PlatformInspector } from "../ports/platform.port";
import type {
	CommandStep,
	ProcessRunner,
	ProcessRunOptions,
	ProcessRunResult,
} from "../ports/process.port";

/**
 * Facts of a typical Apple silicon Mac with Homebrew and nothing Docker
 * installed, overridden by `overrides` (test helper).
 *
 * @param overrides - Fields to replace.
 * @returns Complete, schema-valid facts.
 */
export function createPlatformFacts(
	overrides: Partial<PlatformFacts> = {},
): PlatformFacts {
	return {
		os: "darwin",
		arch: "arm64",
		hasBrew: true,
		hasSystemd: false,
		installedRuntimes: [],
		shell: "/bin/zsh",
		homeDir: "/Users/test",
		username: "test",
		tmpDir: "/tmp/locastack-setup-test",
		brewPrefix: "/opt/homebrew",
		isRoot: false,
		...overrides,
	};
}

/**
 * Facts of a typical systemd Linux box with nothing Docker installed,
 * overridden by `overrides` (test helper).
 *
 * @param overrides - Fields to replace.
 * @returns Complete, schema-valid facts.
 */
export function createLinuxPlatformFacts(
	overrides: Partial<PlatformFacts> = {},
): PlatformFacts {
	return {
		os: "linux",
		arch: "x64",
		hasBrew: false,
		hasSystemd: true,
		installedRuntimes: [],
		inDockerGroup: false,
		shell: "/bin/bash",
		homeDir: "/home/test",
		username: "test",
		tmpDir: "/tmp/locastack-setup-test",
		isRoot: false,
		...overrides,
	};
}

/** {@link PlatformInspector} returning configurable facts, or rejecting with `error`; counts calls. */
export class FakePlatformInspector implements PlatformInspector {
	/** When set, `inspect()` rejects with it. */
	error: Error | undefined;
	/** Number of `inspect()` calls. */
	calls = 0;

	/** @param facts - Facts returned by `inspect()` (default {@link createPlatformFacts}). */
	constructor(public facts: PlatformFacts = createPlatformFacts()) {}

	/** @inheritdoc */
	async inspect(): Promise<PlatformFacts> {
		this.calls += 1;
		if (this.error) throw this.error;
		return structuredClone(this.facts);
	}
}

/** One recorded {@link FakeProcessRunner.run} call. */
export interface ProcessCall {
	/** The step run. */
	readonly step: CommandStep;
	/** Options passed. */
	readonly options: ProcessRunOptions;
}

/**
 * Answer of a {@link FakeProcessRunner} script: a partial result (default
 * exit 0, not timed out), an error to reject with, or a function of the call.
 */
export type ProcessScript =
	| Partial<ProcessRunResult>
	| Error
	| ((call: ProcessCall) => Partial<ProcessRunResult> | Error);

/**
 * {@link ProcessRunner} that never spawns anything: records every call and
 * answers from `scripts[step.id]`, else `fallback` (exit 0).
 */
export class FakeProcessRunner implements ProcessRunner {
	/** Recorded calls, in order. */
	readonly calls: ProcessCall[] = [];
	/** Scripted answers by step id. */
	readonly scripts = new Map<string, ProcessScript>();
	/** Answer for steps without a script. */
	fallback: ProcessScript = { exitCode: 0 };
	/** Every {@link FakeProcessRunner.prependPath} call, in order. */
	readonly pathPrepends: string[][] = [];
	/** Simulated PATH entries (prepended ones first). */
	path: string[] = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

	/**
	 * Scripts the answer for one step id.
	 *
	 * @param stepId - `CommandStep.id`.
	 * @param script - Result, error or function.
	 * @returns This runner (chainable).
	 */
	on(stepId: string, script: ProcessScript): this {
		this.scripts.set(stepId, script);
		return this;
	}

	/** @returns The ids of the steps run so far, in order. */
	ranIds(): string[] {
		return this.calls.map((call) => call.step.id);
	}

	/** @inheritdoc */
	prependPath(dirs: readonly string[]): void {
		this.pathPrepends.push([...dirs]);
		this.path = [
			...dirs.filter((dir) => !this.path.includes(dir)),
			...this.path,
		];
	}

	/** @inheritdoc */
	async run(
		step: CommandStep,
		options: ProcessRunOptions,
	): Promise<ProcessRunResult> {
		const call: ProcessCall = { step, options };
		this.calls.push(call);
		const script = this.scripts.get(step.id) ?? this.fallback;
		const answer = typeof script === "function" ? script(call) : script;
		if (answer instanceof Error) throw answer;
		const result: ProcessRunResult = {
			exitCode: answer.exitCode ?? 0,
			timedOut: answer.timedOut ?? false,
		};
		if (answer.output !== undefined && !options.attached)
			return { ...result, output: answer.output };
		return result;
	}
}

/** {@link DaemonWaiter} answering `ready` (or each value of `sequence` in turn); records calls. */
export class FakeDaemonWaiter implements DaemonWaiter {
	/** Recorded `timeoutMs` of every call. */
	readonly calls: number[] = [];
	/** Answers consumed one per call before falling back to `ready`. */
	readonly sequence: boolean[] = [];

	/** @param ready - Default answer. */
	constructor(public ready = true) {}

	/** @inheritdoc */
	async waitForDocker(
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<boolean> {
		this.calls.push(timeoutMs);
		if (signal?.aborted) return false;
		return this.sequence.shift() ?? this.ready;
	}
}
