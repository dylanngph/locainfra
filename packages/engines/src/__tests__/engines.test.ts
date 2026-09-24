import { describe, expect, test } from "bun:test";
import type {
	BrowserOpener,
	ContainerExec,
	ContainerStreams,
	DownProjectDeps,
	DownStackDeps,
	EnvForStackDeps,
	FolderPicker,
	GetSystemInfoDeps,
	ListProjectsDeps,
	OpJournal,
	RemoveServiceDeps,
	RunDoctorDeps,
	ServiceLifecycleDeps,
	SnapshotIndex,
	StatusForProjectDeps,
	UnregisterProjectDeps,
	UpProjectDeps,
	UpStackDeps,
	VolumeArchiver,
} from "@locastack/core";
import { createEngines } from "../engines";
import { resolveDefaultPaths } from "../paths/default-paths";

describe("createEngines", () => {
	test("wires every adapter under the op-deps field names", () => {
		const paths = resolveDefaultPaths({
			env: { LOCASTACK_HOME: "/tmp/ls-test" },
		});
		const engines = createEngines(paths);
		expect(engines.paths).toBe(paths);
		expect(engines.compose).toBe(engines.lifecycle);
		expect(engines.containers).toBe(engines.docker);
		expect(engines.inspector).toBe(engines.docker);

		// Compile-time check: the adapter set satisfies core's op dependency contracts
		// (catalog comes from core, not engines).
		type NoCatalog<T> = Omit<T, "catalog">;
		const deps: unknown[] = [
			engines satisfies RunDoctorDeps,
			engines satisfies GetSystemInfoDeps,
			engines satisfies ListProjectsDeps,
			engines satisfies UnregisterProjectDeps,
			engines satisfies NoCatalog<UpProjectDeps>,
			engines satisfies NoCatalog<DownProjectDeps>,
			engines satisfies NoCatalog<StatusForProjectDeps>,
			engines satisfies NoCatalog<RemoveServiceDeps>,
			engines satisfies NoCatalog<ServiceLifecycleDeps>,
			engines satisfies DownStackDeps,
			engines satisfies NoCatalog<EnvForStackDeps>,
			engines satisfies NoCatalog<UpStackDeps>,
		];
		const streams: ContainerStreams = engines.streams;
		const picker: FolderPicker = engines.folderPicker;
		const browser: BrowserOpener = engines.browser;
		const exec: ContainerExec = engines.exec;
		const archiver: VolumeArchiver = engines.archiver;
		const snapshots: SnapshotIndex = engines.snapshots;
		const journal: OpJournal = engines.journal;
		expect(deps.every((d) => d === engines)).toBe(true);
		expect(
			[streams, picker, browser, exec, archiver, snapshots, journal].every(
				(a) => a !== undefined,
			),
		).toBe(true);
	});

	test("defaults paths from the environment", () => {
		expect(createEngines().paths.stateDir).toBe(resolveDefaultPaths().stateDir);
	});
});
