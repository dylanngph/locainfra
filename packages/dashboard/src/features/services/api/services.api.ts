import type { AddServiceBody, Progress, ServicePatch } from "@locastack/server";
import { api, unwrap } from "@/shared/lib/api";
import { ApiRequestError } from "@/shared/lib/api-error";
import { terminalEvent } from "@/shared/lib/observer/observer-state";
import { useObserverStore } from "@/shared/lib/observer/observer-store";

/** Container action of the start/stop/restart routes. */
export type ServiceAction = "start" | "stop" | "restart";

const service = (project: string, name: string) =>
	api.api.projects({ project }).services({ name });

/**
 * Starts, stops or restarts one service.
 *
 * @param project - Project name.
 * @param name - Service instance name.
 * @param action - Action to run.
 * @returns The op id.
 */
export async function runServiceAction(
	project: string,
	name: string,
	action: ServiceAction,
): Promise<string> {
	const target = service(project, name);
	const request =
		action === "start"
			? target.start.post()
			: action === "stop"
				? target.stop.post()
				: target.restart.post();
	return (await unwrap(request)).opId;
}

/**
 * Updates an instance (e.g. the "Use port N" fix).
 *
 * @param project - Project name.
 * @param name - Service instance name.
 * @param patch - Fields to change.
 * @returns The op id.
 */
export const patchService = async (
	project: string,
	name: string,
	patch: ServicePatch,
) => (await unwrap(service(project, name).patch(patch))).opId;

/**
 * Adds an instance to `locastack.yaml` and starts it.
 *
 * @param project - Project name.
 * @param body - Instance entry.
 * @returns The op id.
 */
export const addService = async (project: string, body: AddServiceBody) =>
	(await unwrap(api.api.projects({ project }).services.post(body))).opId;

/**
 * Removes an instance from `locastack.yaml` and deletes its container.
 *
 * @param project - Project name.
 * @param name - Service instance name.
 * @param volumes - Also delete the instance's named volumes (data loss).
 * @returns The op id.
 */
export const removeService = async (
	project: string,
	name: string,
	volumes: boolean,
) =>
	(
		await unwrap(
			service(project, name).delete(undefined, { query: { volumes } }),
		)
	).opId;

/**
 * The primary connection URL with secrets revealed (Copy URL).
 *
 * @param project - Project name.
 * @param name - Service instance name.
 * @returns e.g. `postgres://…`.
 */
export const revealedPrimaryUrl = async (project: string, name: string) =>
	(
		await unwrap(
			service(project, name).connection.get({ query: { reveal: true } }),
		)
	).primary.value;

/**
 * Whether an add op's events show that `name` is in `locastack.yaml` (the
 * `Added <name> to <file>` step) or that the op settled.
 */
const addSettledOrWritten = (
	events: readonly Progress[] | undefined,
	name: string,
): boolean =>
	terminalEvent(events) !== undefined ||
	(events ?? []).some(
		(e) =>
			e.kind === "step" &&
			(e.service === undefined || e.service === name) &&
			e.message.startsWith(`Added ${name} to `),
	);

/**
 * Resolves once the add op `opId` has written `name` to `locastack.yaml`,
 * then confirms with a single `GET …/services/:name`: `true` when it exists,
 * `false` when the op failed before writing it. Nothing is polled: it waits
 * on the op's events (followed over NDJSON by `trackOp`, which fills the
 * observer store), and stops waiting when `until` settles. The `202` of Add
 * returns before the file is written, so navigating to the detail page right
 * away would 404.
 *
 * @param project - Project name.
 * @param name - Service instance name.
 * @param opId - The add op (its events must be followed, e.g. by `trackOp`).
 * @param until - Settles when waiting is pointless (the op's terminal event or timeout).
 * @returns Whether the service exists.
 */
export async function waitForService(
	project: string,
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
			if (addSettledOrWritten(state.ops[opId], name)) done();
		});
		if (addSettledOrWritten(useObserverStore.getState().ops[opId], name))
			done();
		void until.then(done, done);
	});
	try {
		await unwrap(service(project, name).get());
		return true;
	} catch (error) {
		if (error instanceof ApiRequestError && error.status === 404) return false;
		throw error;
	}
}

/**
 * Rotates one secret (`PATCH …/secrets/:key/rotate`): a new value, the
 * container recreated. A secret baked into the data volume is refused with a
 * `422` whose `details.fix` explains the wipe, unless `force` and
 * `wipeVolume` are both set.
 *
 * @param project - Project name.
 * @param name - Service instance name.
 * @param key - Catalog secret name, e.g. `POSTGRES_PASSWORD`.
 * @param wipe - Also delete the data volume (destructive).
 * @returns The op id.
 */
export const rotateSecret = async (
	project: string,
	name: string,
	key: string,
	wipe: boolean,
) =>
	(
		await unwrap(
			service(project, name)
				.secrets({ key })
				.rotate.patch(wipe ? { force: true, wipeVolume: true } : {}),
		)
	).opId;
