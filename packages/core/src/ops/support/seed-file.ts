import { resolve, sep } from "node:path";
import type { FileStore } from "../../ports/files.port";
import type {
	ResolvedService,
	ResolvedStack,
} from "../../resolve/resolved.model";
import { ioErrorFrom, OpError } from "../../shared/op-error";
import { err, ok, type Result } from "../../shared/result";
import { SEED_MAX_BYTES } from "../ops.model";

/** A seed file checked by {@link checkSeedFile}. */
export interface SeedFile {
	/** Canonical path (symlinks resolved), inside the canonical project folder. */
	readonly realPath: string;
	/** Size in bytes. */
	readonly sizeBytes: number;
}

/** Options of {@link checkSeedFile}. */
export interface CheckSeedOptions {
	/** Also refuse files over {@link SEED_MAX_BYTES} (they are read into memory). */
	readonly maxBytes?: boolean;
}

/**
 * Checks a stack entry's seed file on disk before it is read or bind-mounted.
 * The stack schema already rejects absolute and `..` paths, but both reading
 * and Docker's bind mount follow symlinks, so the path is canonicalised
 * (`realpath`) and must stay inside the canonical project folder, name a
 * regular file (not a directory, FIFO or device such as `/dev/zero`) and,
 * with `maxBytes`, be at most {@link SEED_MAX_BYTES}.
 *
 * Errors carry `details.field: "seed"` and a `fix`: `IO` when the file is
 * missing (`details.reason: "missing"`) or cannot be inspected; `INVALID_INPUT` when it escapes the project
 * folder, is not a regular file, or is too large.
 *
 * @param files - File access.
 * @param root - Project folder.
 * @param seed - Seed path relative to `root` (the entry's `seed`).
 * @param options - Whether to enforce the size limit.
 * @returns The canonical path and size.
 */
export async function checkSeedFile(
	files: FileStore,
	root: string,
	seed: string,
	options: CheckSeedOptions = {},
): Promise<Result<SeedFile>> {
	const shown = `./${seed}`;
	const invalid = (message: string, fix: string) =>
		err(
			new OpError("INVALID_INPUT", message, {
				details: { field: "seed", file: seed, fix },
			}),
		);
	const base = resolve(root);
	const lexical = resolve(base, seed);
	if (!lexical.startsWith(`${base}${sep}`)) {
		return invalid(
			`Seed file ${shown} is not a file inside the project folder`,
			`Pick a file inside ${root}.`,
		);
	}
	let info: Awaited<ReturnType<FileStore["fileInfo"]>>;
	let realRoot: string;
	try {
		info = await files.fileInfo(lexical);
		realRoot = (await files.fileInfo(base))?.realPath ?? base;
	} catch (cause) {
		return err(
			ioErrorFrom(`Could not read ${shown}`, cause, {
				field: "seed",
				file: seed,
			}),
		);
	}
	if (info === null) {
		return err(
			new OpError(
				"IO",
				`Seed file ${shown} was not found in the project folder`,
				{
					details: {
						field: "seed",
						file: seed,
						reason: "missing",
						fix: `Create ${shown} next to locastack.yaml, or change the seed file on the Config page.`,
					},
				},
			),
		);
	}
	if (!info.realPath.startsWith(`${realRoot}${sep}`)) {
		return invalid(
			`Seed file ${shown} links to a file outside the project folder`,
			`Replace the symlink ${shown} with a real file inside ${root}.`,
		);
	}
	if (info.kind !== "file") {
		return invalid(
			`Seed file ${shown} is not a regular file`,
			`Point the seed at a .sql file inside ${root}.`,
		);
	}
	if (options.maxBytes === true && info.sizeBytes > SEED_MAX_BYTES) {
		return invalid(
			`Seed file ${shown} is larger than 64 MB`,
			"Load large dumps with the service's own client.",
		);
	}
	return ok({ realPath: info.realPath, sizeBytes: info.sizeBytes });
}

/**
 * Re-checks every seed bind mount of a resolved stack on disk before the
 * compose file is written ({@link checkSeedFile} without the size limit: the
 * container reads the mount itself) and points each mount at the canonical
 * file, so Docker never follows a symlink out of the project folder. A seed
 * file that does not exist yet is left as is (compose refuses the missing
 * bind source at `up`, it never creates it).
 *
 * @param files - File access.
 * @param resolved - The resolved stack.
 * @returns The stack with canonical seed sources, or the first refused seed.
 */
export async function verifySeedMounts(
	files: FileStore,
	resolved: ResolvedStack,
): Promise<Result<ResolvedStack>> {
	const services: ResolvedService[] = [];
	for (const service of resolved.services) {
		const seed = service.seed;
		if (seed === undefined) {
			services.push(service);
			continue;
		}
		const relative = seed.source.slice(resolve(seed.root).length + 1);
		const checked = await checkSeedFile(files, seed.root, relative);
		if (!checked.ok) {
			if (checked.error.details?.reason === "missing") {
				services.push(service);
				continue;
			}
			return err(
				new OpError(checked.error.code, checked.error.message, {
					cause: checked.error,
					details: { ...checked.error.details, service: service.name },
				}),
			);
		}
		services.push({
			...service,
			seed: { ...seed, source: checked.value.realPath },
		});
	}
	return ok({ ...resolved, services });
}
