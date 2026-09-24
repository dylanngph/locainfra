import { composeProjectName, serviceVolumeName } from "../paths/layout";
import type { SnapshotRecord } from "../ports/snapshot.port";
import { provisionStack } from "../resolve/provision";
import { instanceSecretKey } from "../resolve/secrets/generator";
import { OpError } from "../shared/op-error";
import {
	terminalProgress,
	withService,
	withTimestamp,
} from "../shared/progress";
import type { Progress } from "../shared/progress.model";
import type { Stack } from "../stack/stack.model";
import { removeStackService, updateStackFile } from "../stack/writer";
import { loadProject } from "./load-project.op";
import type { RemoveService, RemoveServiceDeps } from "./ops.contract";
import { loadDefinitions } from "./support/catalog";
import { composeTarget, writeComposeProject } from "./support/compose";
import { dependentsOf, findService } from "./support/service-input";
import { serviceError, serviceStep } from "./support/service-lifecycle";
import { deleteSnapshotFiles } from "./support/snapshots";

/**
 * Removes a service instance from a project:
 *
 * 1. refuses (`INVALID_INPUT`) while another service depends on it;
 * 2. `LifecycleRunner.remove` stops and removes its container and, with
 *    `volumes: true`, deletes its named volumes (`ls-<project>-<name>-<vol>`
 *    for every catalog volume; adapters ignore ones that do not exist);
 *    skipped when the project was never rendered; removing the last
 *    instance also deletes the project network `ls-<project>` (best effort:
 *    a busy network is logged and the next `down` retries it). "Last" is
 *    decided from the stack loaded here, so callers serialize mutating ops
 *    per project (the server's `OpRegistry` does);
 * 3. removes the entry from `locastack.yaml` (comments kept), unpins its
 *    port and, with `volumes: true`, forgets its secrets and deletes its
 *    snapshots (a new instance of that name starts fresh; otherwise kept so
 *    re-adding it reuses the data);
 * 4. re-renders the compose project (a failure there is reported as a `log`
 *    event; the next `up` re-renders anyway).
 *
 * Every event names the service; ends with exactly one `done` or `error`.
 */
export const removeService: RemoveService = async function* (deps, input) {
	const { name } = input;
	const clock = deps.clock;
	yield serviceStep(`Removing ${name}`, name, clock);

	const loaded = await loadProject(deps, input);
	if (!loaded.ok) {
		yield serviceError(loaded.error, name, clock);
		return;
	}
	const stack = loaded.value;
	const entry = findService(stack, name);
	if (!entry.ok) {
		yield serviceError(entry.error, name, clock);
		return;
	}
	const definitions = await loadDefinitions(deps.catalog);
	if (!definitions.ok) {
		yield serviceError(definitions.error, name, clock);
		return;
	}
	const dependents = dependentsOf(stack, definitions.value, name);
	if (dependents.length > 0) {
		yield serviceError(
			new OpError(
				"INVALID_INPUT",
				`"${name}" is used by ${dependents.join(", ")}`,
				{
					details: {
						service: name,
						dependents,
						fix: `Remove ${dependents.join(", ")} first, or point their uses at another instance.`,
					},
				},
			),
			name,
			clock,
		);
		return;
	}

	const definition = definitions.value.find((d) => d.id === entry.value.type);
	const volumes = input.volumes
		? (definition?.volumes ?? []).map((v) =>
				serviceVolumeName(stack.name, name, v.name),
			)
		: [];
	const target = composeTarget(deps.paths, stack.name);
	// The last instance takes the project network with it: once no service is
	// left, `docker compose down` finds nothing and would leave ls-<project>.
	const last = Object.keys(stack.file.services).every((s) => s === name);
	const networks = last ? [composeProjectName(stack.name)] : [];
	let rendered: boolean;
	try {
		rendered = await deps.files.exists(target.composeFile);
	} catch {
		rendered = true;
	}
	if (rendered) {
		let failed = false;
		for await (const event of withService(
			terminalProgress(
				() =>
					deps.lifecycle.remove({
						...target,
						services: [name],
						...(volumes.length > 0 && { volumes }),
						...(networks.length > 0 && { networks }),
					}),
				`Removed the ${name} container`,
				clock,
			),
			name,
		)) {
			if (event.kind === "error") {
				failed = true;
				yield event;
			} else if (event.kind === "done") {
				yield { ...event, kind: "step" };
			} else {
				yield event;
			}
		}
		if (failed) return;
	}

	yield* forget(
		deps,
		stack,
		name,
		input.volumes === true,
		definition?.secrets ?? [],
	);
};

async function* forget(
	deps: RemoveServiceDeps,
	stack: Stack,
	name: string,
	dropSecrets: boolean,
	secretNames: readonly string[],
): AsyncIterable<Progress> {
	const clock = deps.clock;
	const written = await updateStackFile(deps.files, stack.filePath, (text) =>
		removeStackService(text, name, stack.filePath),
	);
	if (!written.ok) {
		yield serviceError(written.error, name, clock);
		return;
	}
	yield serviceStep(`Removed ${name} from ${stack.filePath}`, name, clock);
	try {
		await deps.state.update((state) => {
			const pins = state.stacks[stack.name];
			if (pins === undefined || !Object.hasOwn(pins.ports, name)) return state;
			const { [name]: _released, ...ports } = pins.ports;
			return {
				...state,
				stacks: { ...state.stacks, [stack.name]: { ...pins, ports } },
			};
		});
		if (dropSecrets && secretNames.length > 0) {
			const keys = new Set(secretNames.map((s) => instanceSecretKey(name, s)));
			await deps.secrets.update(stack.name, (current) => {
				if (![...keys].some((key) => Object.hasOwn(current, key))) {
					return undefined;
				}
				return Object.fromEntries(
					Object.entries(current).filter(([key]) => !keys.has(key)),
				);
			});
		}
	} catch (cause) {
		yield serviceError(
			new OpError("IO", `Could not update the state of "${stack.name}"`, {
				cause,
				details: { stack: stack.name },
			}),
			name,
			clock,
		);
		return;
	}
	if (dropSecrets) yield* dropSnapshots(deps, stack.name, name);

	const remaining: Stack = { ...stack, file: written.value };
	const rerendered = await rerender(deps, remaining);
	if (rerendered !== undefined) {
		yield {
			...withTimestamp(
				{
					kind: "log",
					message: `Compose file not re-rendered: ${rerendered.message}`,
				},
				clock,
			),
			service: name,
		};
	}
	yield {
		...withTimestamp({ kind: "done", message: `Removed ${name}` }, clock),
		service: name,
	};
}

/**
 * Deletes the snapshots of a service whose volumes were deleted: their data
 * and baked-in secrets belong to an instance that no longer exists, and
 * without the service they would be invisible (listing needs the service)
 * while piling up on disk. Failures are reported as a `log` event; the
 * removal itself already happened.
 */
async function* dropSnapshots(
	deps: RemoveServiceDeps,
	project: string,
	name: string,
): AsyncIterable<Progress> {
	const clock = deps.clock;
	const log = (message: string): Progress => ({
		...withTimestamp({ kind: "log", message }, clock),
		service: name,
	});
	let rows: SnapshotRecord[];
	try {
		rows = await deps.snapshots.list(project, name);
	} catch (cause) {
		yield log(`Snapshots of ${name} not deleted: ${errorText(cause)}`);
		return;
	}
	if (rows.length === 0) return;
	yield serviceStep(
		`Deleting ${rows.length} snapshot${rows.length === 1 ? "" : "s"} of ${name}`,
		name,
		clock,
	);
	for (const row of rows) {
		try {
			await deleteSnapshotFiles(deps, row);
		} catch (cause) {
			yield log(`Snapshot “${row.name}” not deleted: ${errorText(cause)}`);
		}
	}
}

function errorText(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

async function rerender(
	deps: RemoveServiceDeps,
	stack: Stack,
): Promise<OpError | undefined> {
	const definitions = await loadDefinitions(deps.catalog);
	if (!definitions.ok) return definitions.error;
	const resolved = await provisionStack(deps, stack, definitions.value);
	if (!resolved.ok) return resolved.error;
	const written = await writeComposeProject(deps, resolved.value);
	return written.ok ? undefined : written.error;
}
