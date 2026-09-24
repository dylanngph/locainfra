import type { ImportItem, ImportPreview } from "@locastack/server";
import { api, unwrap } from "@/shared/lib/api";
import { ApiRequestError } from "@/shared/lib/api-error";
import { terminalEvent } from "@/shared/lib/observer/observer-state";
import { useObserverStore } from "@/shared/lib/observer/observer-store";

/**
 * `POST /api/import/preview`: parses compose YAML and maps it onto the
 * catalog. Nothing is written.
 *
 * @param yaml - The compose file's text.
 * @param projectName - Preferred project name (e.g. from the file name).
 * @returns Suggested name and one item per compose service.
 */
export const previewImport = (yaml: string, projectName?: string) =>
	unwrap(
		api.api.import.preview.post(projectName ? { yaml, projectName } : { yaml }),
	);

/** Result of the preview (`Import.Preview`) and one compose service of it. */
export type { ImportItem, ImportPreview };

/** Body of `POST /api/import`. */
export interface ImportRequest {
	readonly name: string;
	readonly root: string;
	readonly items: readonly ImportItem[];
	readonly start: boolean;
}

/**
 * `POST /api/import`: creates the project from the reviewed preview.
 *
 * @param body - Project name, folder, reviewed items, start flag.
 * @returns The op id.
 */
export const importProject = async (body: ImportRequest) =>
	(await unwrap(api.api.import.post({ ...body, items: [...body.items] }))).opId;

/**
 * Whether the import op wrote the project's `locastack.yaml` (or settled).
 * The op registers the project before it stores the secrets and writes the
 * stack file (and unregisters it again when either fails), so a
 * `GET /api/projects/:name` only finds it once the "Writing locastack.yaml"
 * step is followed by another event ("Starting N services", or `done`).
 */
const writtenOrSettled = (
	events: ReturnType<typeof useObserverStore.getState>["ops"][string],
) => {
	const list = events ?? [];
	if (terminalEvent(list) !== undefined) return true;
	const writing = list.findIndex(
		(e) => e.kind === "step" && e.message.startsWith("Writing "),
	);
	return writing !== -1 && writing < list.length - 1;
};

/**
 * Resolves once the import op `opId` wrote `name`'s `locastack.yaml` (an
 * event followed its "Writing locastack.yaml" step) or settled, then
 * confirms with one `GET /api/projects/:name`. Like `waitForService`,
 * nothing is polled: it waits on the op's events, which `trackOp` follows
 * over NDJSON.
 *
 * @param name - Project name.
 * @param opId - The import op.
 * @param until - Settles when waiting is pointless (terminal event or timeout).
 * @returns Whether the project exists.
 */
export async function waitForProject(
	name: string,
	opId: string,
	until: Promise<unknown>,
): Promise<boolean> {
	await new Promise<void>((resolve) => {
		let unsubscribe = () => {};
		const done = () => {
			unsubscribe();
			resolve();
		};
		unsubscribe = useObserverStore.subscribe((state) => {
			if (writtenOrSettled(state.ops[opId])) done();
		});
		if (writtenOrSettled(useObserverStore.getState().ops[opId])) done();
		void until.then(done, done);
	});
	try {
		await unwrap(api.api.projects({ project: name }).get());
		return true;
	} catch (error) {
		if (error instanceof ApiRequestError && error.status === 404) return false;
		throw error;
	}
}
