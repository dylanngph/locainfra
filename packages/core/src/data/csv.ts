/** Outcome of {@link parseCsv}. */
export interface CsvParse {
	/** Parsed records (header first), at most `maxRecords`. */
	readonly records: string[][];
	/** More records followed the last one returned. */
	readonly more: boolean;
	/**
	 * The text ended inside a record (no final line break, or inside quotes):
	 * the last record may be cut, e.g. when the output hit its byte cap.
	 */
	readonly partialTail: boolean;
}

/**
 * Parses RFC 4180 CSV as printed by `psql --csv`: `,` separates fields,
 * `"…"` quotes a field (`""` is a literal quote, line breaks allowed
 * inside), records end with `\n` or `\r\n`. An unquoted empty field (psql's
 * NULL) is the empty string. Stops after `maxRecords` records.
 *
 * @param text - CSV text.
 * @param maxRecords - Most records to return (header included).
 * @returns Records, whether more followed, and whether the tail was cut.
 */
export function parseCsv(text: string, maxRecords: number): CsvParse {
	const records: string[][] = [];
	let record: string[] = [];
	let field = "";
	let quoted = false;
	let inRecord = false;
	let i = 0;
	const n = text.length;
	while (i < n) {
		const c = text[i] as string;
		if (quoted) {
			if (c === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				quoted = false;
				i++;
				continue;
			}
			field += c;
			i++;
			continue;
		}
		if (c === '"' && field === "") {
			quoted = true;
			inRecord = true;
			i++;
			continue;
		}
		if (c === ",") {
			record.push(field);
			field = "";
			inRecord = true;
			i++;
			continue;
		}
		if (c === "\n" || (c === "\r" && text[i + 1] === "\n")) {
			record.push(field);
			if (records.length >= maxRecords)
				return { records, more: true, partialTail: false };
			records.push(record);
			record = [];
			field = "";
			inRecord = false;
			i += c === "\r" ? 2 : 1;
			continue;
		}
		field += c;
		inRecord = true;
		i++;
	}
	if (quoted || inRecord || field !== "") {
		record.push(field);
		if (records.length >= maxRecords)
			return { records, more: true, partialTail: true };
		records.push(record);
		return { records, more: false, partialTail: true };
	}
	return { records, more: false, partialTail: false };
}

/**
 * Parses the output of `redis-cli --csv` into a flat list of values.
 * `redis-cli` prints strings with C-style escapes (`"a\"b\n"`, `\xHH`),
 * integers, doubles, `true`/`false` and `NULL` bare, flattens arrays and
 * maps with `,`, and ends each reply with a line break. `NULL` becomes the
 * empty string.
 *
 * An error reply is printed as `ERROR,"<message>"`; it is returned in
 * `error` instead of `values`.
 *
 * @param text - stdout of `redis-cli --csv`.
 * @returns The values, or the error message of an error reply.
 */
export function parseRedisCsv(text: string): {
	readonly values: string[];
	readonly error?: string;
} {
	const values: string[] = [];
	const bare: boolean[] = [];
	let i = 0;
	const n = text.length;
	while (i < n) {
		const c = text[i];
		if (c === "," || c === "\n" || c === "\r") {
			i++;
			continue;
		}
		if (c === '"') {
			const bytes: number[] = [];
			i++;
			while (i < n && text[i] !== '"') {
				const d = text[i] as string;
				if (d === "\\" && i + 1 < n) {
					const e = text[i + 1] as string;
					if (e === "x" && HEX2.test(text.slice(i + 2, i + 4))) {
						bytes.push(Number.parseInt(text.slice(i + 2, i + 4), 16));
						i += 4;
						continue;
					}
					pushUtf8(bytes, REPR_ESCAPES[e] ?? e);
					i += 2;
					continue;
				}
				const point = text.codePointAt(i) ?? 0;
				const char = String.fromCodePoint(point);
				pushUtf8(bytes, char);
				i += char.length;
			}
			i++;
			const value = UTF8.decode(new Uint8Array(bytes));
			values.push(value);
			bare.push(false);
			continue;
		}
		let token = "";
		while (i < n && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") {
			token += text[i];
			i++;
		}
		values.push(token === "NULL" ? "" : token);
		bare.push(true);
	}
	if (values[0] === "ERROR" && bare[0] === true && values.length >= 2) {
		return { values: [], error: values[1] ?? "" };
	}
	return { values };
}

const HEX2 = /^[0-9a-fA-F]{2}$/;
const UTF8 = new TextDecoder();
const ENCODER = new TextEncoder();

function pushUtf8(bytes: number[], text: string): void {
	for (const byte of ENCODER.encode(text)) bytes.push(byte);
}

const REPR_ESCAPES: Readonly<Record<string, string>> = {
	n: "\n",
	r: "\r",
	t: "\t",
	a: "\x07",
	b: "\b",
	"\\": "\\",
	'"': '"',
};
