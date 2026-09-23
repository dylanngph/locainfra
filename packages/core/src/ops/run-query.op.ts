import { parseCsv, parseRedisCsv } from "../data/csv";
import { buildQueryArgv, splitRedisWords } from "../data/query-argv";
import type { ExecResult } from "../ports/exec.port";
import { OpError } from "../shared/op-error";
import { err, ok, type Result } from "../shared/result";
import type { RunQuery, RunQueryInput } from "./ops.contract";
import {
	DATA_QUERY_MAX_BYTES,
	DATA_QUERY_MAX_LENGTH,
	DATA_QUERY_MAX_ROWS,
	DATA_QUERY_TIMEOUT_MS,
	type DataQueryResult,
} from "./ops.model";
import { DATA_TAB_CHECK } from "./support/data-tab";
import {
	dockerUnreachable,
	execFailure,
	loadRunningService,
} from "./support/running-service";

/** Column of a one-line psql command tag (`INSERT 0 1`, `CREATE TABLE`). */
export const COMMAND_TAG_COLUMN = "status";

/**
 * A psql command tag: upper-case words, then optional counts. psql prints
 * one instead of a CSV table for statements without a result set.
 */
const COMMAND_TAG = /^[A-Z]+(?: [A-Z]+)*(?: \d+)*$/;

/**
 * Runs one query of the Data tab with the catalog's `data.runQuery` argv
 * (`docker exec`, no shell; the query is one argv item for `sql`, its words
 * for `redis`) and parses the CSV output into columns and rows.
 *
 * Limits: {@link DATA_QUERY_TIMEOUT_MS}, {@link DATA_QUERY_MAX_BYTES} of
 * output and `limit` (≤ {@link DATA_QUERY_MAX_ROWS}) rows; hitting the byte
 * or row cap sets `truncated`. `sql`: the CSV header is `columns`; a
 * statement without a result set (psql prints its command tag, e.g.
 * `INSERT 0 1`) is one row in a `status` column (one row per statement
 * when several ran). `redis`: one column named
 * after the command (e.g. `SCAN`), one row per value of the flattened reply.
 *
 * Errors: as `listDataObjects`, plus `INVALID_INPUT` for a blank, too long
 * or NUL-containing query, a bad `limit`, a rejected query or a timeout
 * (message: the tool's first error lines, secrets masked; `details.exitCode`
 * and `details.timedOut`).
 */
export const runQuery: RunQuery = async (deps, input) => {
	const checked = checkQuery(input);
	if (!checked.ok) return checked;
	const limit = checked.value;

	const running = await loadRunningService(deps, input, DATA_TAB_CHECK);
	if (!running.ok) return running;
	const { checked: data, context, container, secretValues } = running.value;

	const argv = buildQueryArgv(
		data.runQuery ?? [],
		data.kind,
		input.query,
		context,
	);
	if (!argv.ok) return argv;

	const started = performance.now();
	let result: ExecResult;
	try {
		result = await deps.exec.run(container, argv.value, {
			timeoutMs: DATA_QUERY_TIMEOUT_MS,
			maxBytes: DATA_QUERY_MAX_BYTES,
		});
	} catch (cause) {
		return err(dockerUnreachable(cause));
	}
	const durationMs = Math.max(0, Math.round(performance.now() - started));
	const failure = (message?: string) =>
		err(
			execFailure(result, {
				secrets: secretValues,
				what: "Query",
				timeoutMs: DATA_QUERY_TIMEOUT_MS,
				timeoutFix:
					"Narrow the query down (add a LIMIT or a WHERE clause) and run it again.",
				...(message !== undefined && { message }),
			}),
		);
	if (result.timedOut) return failure();
	// The adapter may kill the tool once stdout hits the byte cap (exit code
	// -1): that output is a truncated result, not a failure.
	const failed = result.exitCode !== 0 && !result.truncated;

	if (data.kind === "redis") {
		const parsed = parseRedisCsv(result.stdout);
		if (parsed.error !== undefined || failed) {
			return failure(parsed.error);
		}
		// A cut output ends mid-value: drop the partial last one.
		const values = result.truncated
			? parsed.values.slice(0, -1)
			: parsed.values;
		const command = splitRedisWords(input.query);
		const column = command.ok
			? (command.value[0] ?? "value").toUpperCase()
			: "value";
		const rows = values.slice(0, limit).map((value) => [value]);
		return ok(
			queryResult(
				[column],
				rows,
				result.truncated || values.length > limit,
				durationMs,
			),
		);
	}

	if (failed) return failure();
	return ok(sqlResult(result, limit, durationMs));
};

function checkQuery(input: RunQueryInput): Result<number> {
	const invalid = (message: string, fix: string) =>
		err(new OpError("INVALID_INPUT", message, { details: { fix } }));
	if (input.query.trim() === "") {
		return invalid("Query is empty.", "Type a query, then run it.");
	}
	if (input.query.length > DATA_QUERY_MAX_LENGTH) {
		return invalid(
			`Query is longer than ${DATA_QUERY_MAX_LENGTH} characters.`,
			"Run a shorter query, or load large scripts as a seed file.",
		);
	}
	if (input.query.includes("\u0000")) {
		return invalid(
			"Query contains a NUL character.",
			"Remove it and run the query again.",
		);
	}
	const limit = input.limit ?? DATA_QUERY_MAX_ROWS;
	if (!Number.isInteger(limit) || limit < 1 || limit > DATA_QUERY_MAX_ROWS) {
		return invalid(
			`limit must be an integer between 1 and ${DATA_QUERY_MAX_ROWS}.`,
			`Use a limit between 1 and ${DATA_QUERY_MAX_ROWS}.`,
		);
	}
	return ok(limit);
}

function sqlResult(
	result: ExecResult,
	limit: number,
	durationMs: number,
): DataQueryResult {
	// Header + limit rows + one more to detect that rows were dropped.
	const parsed = parseCsv(result.stdout, limit + 2);
	let records = parsed.records;
	// Output cut at the byte cap ends inside a record: drop it.
	if (result.truncated && parsed.partialTail && !parsed.more) {
		records = records.slice(0, -1);
	}
	const [header, ...body] = records;
	if (header === undefined)
		return queryResult([], [], result.truncated, durationMs);
	// Statements without a result set print only command tags, one per line
	// (`CREATE TABLE`, then `INSERT 0 2` for a two-statement query).
	if (
		!result.truncated &&
		!parsed.more &&
		records.every((r) => r.length === 1 && COMMAND_TAG.test(r[0] ?? ""))
	) {
		return queryResult(
			[COMMAND_TAG_COLUMN],
			records.map((r) => [r[0] ?? ""]),
			false,
			durationMs,
		);
	}
	const rows = body.slice(0, limit).map((row) => fit(row, header.length));
	const truncated = result.truncated || parsed.more || body.length > limit;
	return queryResult(header, rows, truncated, durationMs);
}

function fit(row: readonly string[], width: number): string[] {
	if (row.length === width) return [...row];
	if (row.length > width) return row.slice(0, width);
	return [...row, ...Array.from({ length: width - row.length }, () => "")];
}

function queryResult(
	columns: string[],
	rows: string[][],
	truncated: boolean,
	durationMs: number,
): DataQueryResult {
	return { columns, rows, rowCount: rows.length, truncated, durationMs };
}
