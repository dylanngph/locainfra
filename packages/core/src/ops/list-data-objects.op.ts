import { renderArgv, renderDefaultQuery } from "../data/query-argv";
import type { ExecResult } from "../ports/exec.port";
import { err, ok } from "../shared/result";
import type { ListDataObjects } from "./ops.contract";
import {
	DATA_MAX_OBJECTS,
	DATA_QUERY_MAX_BYTES,
	DATA_QUERY_TIMEOUT_MS,
	type DataObject,
} from "./ops.model";
import { DATA_TAB_CHECK } from "./support/data-tab";
import {
	dockerUnreachable,
	execFailure,
	loadRunningService,
} from "./support/running-service";

/**
 * Object list of the Data tab (tables, key patterns): the catalog's static
 * `data.objects`, or the stdout lines of `data.listObjects` run with
 * `docker exec` in the running container (no shell; blank lines dropped; at
 * most {@link DATA_MAX_OBJECTS}, `truncated` beyond). Each object carries
 * the catalog's `defaultQuery` with `{{object}}` filled in.
 *
 * Errors: `PROJECT_NOT_FOUND`, `SERVICE_NOT_FOUND`, `INVALID_INPUT` (no Data
 * tab; listing command failed or timed out, message secret-free),
 * `SERVICE_NOT_RUNNING`, `DOCKER_UNREACHABLE`, `INVALID_CATALOG`.
 */
export const listDataObjects: ListDataObjects = async (deps, input) => {
	const running = await loadRunningService(deps, input, DATA_TAB_CHECK);
	if (!running.ok) return running;
	const { checked: data, context, container, secretValues } = running.value;

	let names: string[];
	let truncated = false;
	if (data.listObjects !== undefined) {
		const argv = renderArgv(data.listObjects, context);
		if (!argv.ok) return argv;
		let result: ExecResult;
		try {
			result = await deps.exec.run(container, argv.value, {
				timeoutMs: DATA_QUERY_TIMEOUT_MS,
				maxBytes: DATA_QUERY_MAX_BYTES,
			});
		} catch (cause) {
			return err(dockerUnreachable(cause));
		}
		// A tool killed at the byte cap (exit code -1) still listed objects.
		if (result.timedOut || (result.exitCode !== 0 && !result.truncated)) {
			return err(
				execFailure(result, {
					secrets: secretValues,
					what: "Listing objects",
					timeoutMs: DATA_QUERY_TIMEOUT_MS,
					timeoutFix:
						"Check that the service is healthy, then reload the Data tab.",
				}),
			);
		}
		const lines = result.stdout.split("\n");
		// A cut output ends mid-line: drop the partial last name.
		if (result.truncated) lines.pop();
		names = lines
			.map((line) => line.replace(/\r$/, ""))
			.filter((line) => line.trim() !== "");
		truncated = result.truncated;
	} else {
		names = [...(data.objects ?? [])];
	}
	if (names.length > DATA_MAX_OBJECTS) {
		names = names.slice(0, DATA_MAX_OBJECTS);
		truncated = true;
	}

	const objects: DataObject[] = [];
	for (const name of names) {
		const query = renderDefaultQuery(data.defaultQuery ?? "", name, context);
		if (!query.ok) return query;
		objects.push({ name, defaultQuery: query.value });
	}
	return ok({
		kind: data.kind,
		label: data.label ?? "Objects",
		objects,
		truncated,
	});
};
