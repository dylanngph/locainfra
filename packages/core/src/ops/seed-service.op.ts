import type { ServiceSeed } from "../catalog/catalog.model";
import { renderArgv } from "../data/query-argv";
import type { ExecResult } from "../ports/exec.port";
import { ioErrorFrom, OpError } from "../shared/op-error";
import { err, ok } from "../shared/result";
import type { SeedService } from "./ops.contract";
import { SEED_MAX_BYTES, SEED_TIMEOUT_MS } from "./ops.model";
import {
	dockerUnreachable,
	execFailure,
	loadRunningService,
	type RunningServiceCheck,
} from "./support/running-service";
import { checkSeedFile } from "./support/seed-file";
import { serviceError, serviceStep } from "./support/service-lifecycle";

/** Most stdout bytes kept from the seed command (it is discarded). */
const SEED_OUTPUT_MAX_BYTES = 64 * 1024;

/** What {@link seedService}'s precondition extracts. */
interface SeedPlan {
	/** The catalog's seed block. */
	readonly seed: ServiceSeed;
	/** The entry's seed path, relative to the project root. */
	readonly file: string;
}

const SEED_CHECK: RunningServiceCheck<SeedPlan> = {
	precondition: (definition, entry, stack) => {
		const invalid = (message: string, fix: string) =>
			err(
				new OpError("INVALID_INPUT", message, {
					details: { project: stack.name, type: definition.id, fix },
				}),
			);
		if (definition.seed === undefined) {
			return invalid(
				`${definition.name} does not support seed files`,
				"Load data with the service's own client instead.",
			);
		}
		if (entry.seed === undefined) {
			return invalid(
				"No seed file is set",
				"Set a seed file on the Config page (e.g. db/seed.sql), then seed again.",
			);
		}
		return ok({ seed: definition.seed, file: entry.seed });
	},
	startHint: "Start it to seed it.",
};

/**
 * Re-applies a service's seed file: reads `<root>/<seed>` and pipes it to the
 * catalog's `seed.run` argv in the running container (`docker exec -i`, no
 * shell, {@link SEED_TIMEOUT_MS}). Steps: "Seeding <name> from ./<seed>",
 * then `done` "Seeded <name> from ./<seed>".
 *
 * Errors (one `error` event): `INVALID_INPUT` (no `seed` block, no seed
 * set, a path escaping the project, also through a symlink, not a regular
 * file, a file over {@link SEED_MAX_BYTES} (checked before reading), or
 * the command failed / timed out: message is its first error lines, secrets
 * masked), `IO` (file missing or unreadable), `SERVICE_NOT_RUNNING`,
 * `PROJECT_NOT_FOUND`, `SERVICE_NOT_FOUND`, `DOCKER_UNREACHABLE`.
 */
export const seedService: SeedService = async function* (deps, input) {
	const { name } = input;
	const fail = (error: OpError) => serviceError(error, name);

	const running = await loadRunningService(deps, input, SEED_CHECK);
	if (!running.ok) {
		yield fail(running.error);
		return;
	}
	const { checked, stack, context, container, secretValues } = running.value;
	const shown = `./${checked.file}`;
	yield serviceStep(`Seeding ${name} from ${shown}`, name);

	// Canonical path inside the project, a regular file, at most 64 MB:
	// checked before reading, since a symlink to /dev/zero would otherwise be
	// read without bound.
	const file = await checkSeedFile(deps.files, stack.root, checked.file, {
		maxBytes: true,
	});
	if (!file.ok) {
		yield fail(file.error);
		return;
	}
	let text: string | null;
	try {
		text = await deps.files.readText(file.value.realPath);
	} catch (cause) {
		yield fail(
			ioErrorFrom(`Could not read ${shown}`, cause, { file: checked.file }),
		);
		return;
	}
	if (text === null) {
		yield fail(
			new OpError("IO", `Seed file ${shown} not found`, {
				details: {
					file: checked.file,
					fix: `Create ${shown} in ${stack.root}, or change the seed file on the Config page.`,
				},
			}),
		);
		return;
	}
	if (Buffer.byteLength(text, "utf8") > SEED_MAX_BYTES) {
		yield fail(
			new OpError("INVALID_INPUT", `Seed file ${shown} is larger than 64 MB`, {
				details: { fix: "Load large dumps with the service's own client." },
			}),
		);
		return;
	}

	const argv = renderArgv(checked.seed.run, context);
	if (!argv.ok) {
		yield fail(argv.error);
		return;
	}
	let result: ExecResult;
	try {
		result = await deps.exec.run(container, argv.value, {
			timeoutMs: SEED_TIMEOUT_MS,
			maxBytes: SEED_OUTPUT_MAX_BYTES,
			stdin: text,
		});
	} catch (cause) {
		yield fail(dockerUnreachable(cause));
		return;
	}
	if (result.timedOut || result.exitCode !== 0) {
		// Killed at the output cap: say so rather than "exit code -1".
		const cut =
			result.truncated && result.stderr.trim() === ""
				? `Seeding printed more than ${SEED_OUTPUT_MAX_BYTES / 1024} KB of output and was stopped.`
				: undefined;
		yield fail(
			execFailure(result, {
				secrets: secretValues,
				what: "Seeding",
				timeoutMs: SEED_TIMEOUT_MS,
				timeoutFix:
					"Split the seed file, or load large dumps with the service's own client.",
				...(cut !== undefined && { message: cut }),
			}),
		);
		return;
	}
	yield { ...serviceStep(`Seeded ${name} from ${shown}`, name), kind: "done" };
};
