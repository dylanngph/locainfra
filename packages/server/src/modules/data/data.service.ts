import {
	DATA_MAX_OBJECTS,
	DATA_QUERY_MAX_ROWS,
	type DataObjects,
	type DataQueryResult,
} from "@locastack/core";
import type { ServerOps, ServerPorts } from "../../deps";
import { unwrap } from "../../shared/unwrap";
import type { DataQueryBody } from "./data.model";

/** Ops used by {@link DataService}. */
export type DataOps = Pick<ServerOps, "listDataObjects" | "runQuery">;

/**
 * Data tab use-cases: the object list and the query runner of one service
 * instance. One-shot calls answered directly (no op registry, nothing
 * streamed). Limits (15 s, 2 MiB of output, 1000 rows) are enforced by the
 * ops; the service re-applies the row and object caps so a response can never
 * exceed its schema. Failures are thrown as `OpError`s: a timed-out command
 * becomes `504 TIMEOUT` in the error handler, other failures keep their
 * `OP_ERROR_STATUS`.
 */
export class DataService {
	/**
	 * @param ops - Core ops.
	 * @param ports - Ports passed to the ops.
	 */
	constructor(
		private readonly ops: DataOps,
		private readonly ports: ServerPorts,
	) {}

	/**
	 * @param project - Project name.
	 * @param name - Service instance.
	 * @returns The Data tab's side list (at most `DATA_MAX_OBJECTS` objects).
	 * @throws OpError `PROJECT_NOT_FOUND`, `SERVICE_NOT_FOUND`,
	 * `SERVICE_NOT_RUNNING`, `INVALID_INPUT` (no Data tab, listing failed; with
	 * `details.timedOut` on a timeout).
	 */
	async objects(project: string, name: string): Promise<DataObjects> {
		const result = unwrap(
			await this.ops.listDataObjects(this.ports, { project, name }),
		);
		if (result.objects.length <= DATA_MAX_OBJECTS) return result;
		return {
			...result,
			objects: result.objects.slice(0, DATA_MAX_OBJECTS),
			truncated: true,
		};
	}

	/**
	 * Runs one query in the service container.
	 *
	 * @param project - Project name.
	 * @param name - Service instance.
	 * @param body - Query text and optional row limit.
	 * @returns The result grid (at most `limit` rows).
	 * @throws OpError as {@link DataService.objects}; a blank or rejected query
	 * is `INVALID_INPUT`.
	 */
	async query(
		project: string,
		name: string,
		body: DataQueryBody,
	): Promise<DataQueryResult> {
		const limit = Math.min(
			body.limit ?? DATA_QUERY_MAX_ROWS,
			DATA_QUERY_MAX_ROWS,
		);
		const result = unwrap(
			await this.ops.runQuery(this.ports, {
				project,
				name,
				query: body.query,
				limit,
			}),
		);
		if (result.rows.length <= limit) return result;
		const rows = result.rows.slice(0, limit);
		return { ...result, rows, rowCount: rows.length, truncated: true };
	}
}
