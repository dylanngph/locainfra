/** A mock query result grid (mirrors core's `DataQueryResult`). */
export interface MockQueryResult {
	readonly columns: string[];
	readonly rows: string[][];
	readonly rowCount: number;
	readonly truncated: boolean;
	readonly durationMs: number;
}

/** A query the mock engine rejects (the tool's first error line). */
export interface MockQueryError {
	readonly error: string;
}

/** Public tables of every mock Postgres instance. */
export const MOCK_TABLES: Readonly<
	Record<string, { columns: string[]; rows: string[][] }>
> = {
	orders: {
		columns: ["id", "user_id", "total", "status"],
		rows: [
			["1001", "1", "42.50", "paid"],
			["1002", "2", "19.00", "pending"],
			["1003", "1", "7.25", "paid"],
			["1004", "3", "120.00", "refunded"],
		],
	},
	products: {
		columns: ["id", "name", "price"],
		rows: [
			["1", "Mug, large", "12.00"],
			["2", 'Poster "Local"', "25.00"],
		],
	},
	users: {
		columns: ["id", "email", "created_at"],
		rows: [
			["1", "ada@example.com", "2026-09-01 10:12:00+00"],
			["2", "linus@example.com", "2026-09-02 08:01:44+00"],
			["3", "grace@example.com", ""],
		],
	},
};

/** Keys of every mock Redis instance. */
export const MOCK_KEYS: Readonly<Record<string, string>> = {
	"session:ada": '{"user":1}',
	"session:linus": '{"user":2}',
	"rate:127.0.0.1": "14",
	"cache:products": "[1,2]",
};

const duration = () => 3 + Math.floor(Math.random() * 20);

const grid = (columns: string[], rows: string[][], limit: number) => ({
	columns,
	rows: rows.slice(0, limit),
	rowCount: Math.min(rows.length, limit),
	truncated: rows.length > limit,
	durationMs: duration(),
});

const globToRegExp = (glob: string) =>
	new RegExp(
		`^${glob
			.replace(/[.+^${}()|[\]\\]/g, "\\$&")
			.replace(/\*/g, ".*")
			.replace(/\?/g, ".")}$`,
	);

/**
 * Runs a query against the mock data set, like `runQuery` would in the
 * container: SQL `SELECT … FROM <table>` for `sql`, `SCAN`/`GET`/`KEYS`
 * for `redis`. Anything else is rejected like psql/redis-cli would.
 *
 * @param kind - The catalog's `data.kind`.
 * @param query - Query text (already checked non-blank).
 * @param limit - Most rows to return.
 * @returns The result grid or an error line.
 */
export function runMockQuery(
	kind: "sql" | "redis",
	query: string,
	limit: number,
): MockQueryResult | MockQueryError {
	if (kind === "sql") {
		const from = /\bfrom\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i.exec(query);
		if (!from) {
			if (/^\s*select\s+1\b/i.test(query))
				return grid(["?column?"], [["1"]], limit);
			return {
				error: `ERROR:  syntax error at or near "${query.trim().split(/\s+/)[0] ?? ""}"`,
			};
		}
		const table = MOCK_TABLES[from[1] ?? ""];
		if (!table)
			return { error: `ERROR:  relation "${from[1]}" does not exist` };
		return grid(table.columns, table.rows, limit);
	}
	const [command = "", ...args] = query.trim().split(/\s+/);
	const upper = command.toUpperCase();
	if (upper === "SCAN" || upper === "KEYS") {
		const matchAt = args.findIndex((a) => a.toUpperCase() === "MATCH");
		const pattern =
			upper === "KEYS" ? (args[0] ?? "*") : (args[matchAt + 1] ?? "*");
		const re = globToRegExp(matchAt < 0 && upper === "SCAN" ? "*" : pattern);
		return grid(
			[upper],
			Object.keys(MOCK_KEYS)
				.filter((k) => re.test(k))
				.map((k) => [k]),
			limit,
		);
	}
	if (upper === "GET") {
		const value = MOCK_KEYS[args[0] ?? ""];
		return grid(["value"], value === undefined ? [] : [[value]], limit);
	}
	return { error: `ERR unknown command '${command}'` };
}
