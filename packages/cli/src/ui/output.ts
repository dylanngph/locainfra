import type { Writable } from "node:stream";
import type { OpError } from "@locainfra/core";
import type { CliIo } from "../cli.types";
import { glyph, theme } from "./theme";

/**
 * Writes one line of text.
 *
 * @param sink - Destination stream.
 * @param text - Line content (a newline is appended).
 */
export function writeLine(sink: Writable, text = ""): void {
	sink.write(`${text}\n`);
}

/**
 * Writes a JSON document followed by a newline.
 *
 * @param sink - Destination stream.
 * @param value - Any JSON-serialisable value.
 * @param pretty - Indent with two spaces (default) or emit one compact line (NDJSON).
 */
export function writeJson(sink: Writable, value: unknown, pretty = true): void {
	sink.write(`${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`);
}

/**
 * Machine-readable shape of an {@link OpError} (no stack, no cause).
 *
 * @param error - The operation error.
 * @returns `{ ok: false, error: { code, message, details } }`.
 */
export function opErrorJson(error: OpError): {
	ok: false;
	error: {
		code: string;
		message: string;
		details: Readonly<Record<string, unknown>>;
	};
} {
	return {
		ok: false,
		error: { code: error.code, message: error.message, details: error.details },
	};
}

/**
 * @param details - Structured error details.
 * @returns The `fix` hint when `details.fix` is a non-empty string.
 */
export function fixHint(
	details: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
	const fix = details?.fix;
	return typeof fix === "string" && fix.trim() !== "" ? fix : undefined;
}

/**
 * Renders an operation failure: JSON on stdout in `--json` mode, otherwise a
 * red line on stderr. Messages are secret-free by the {@link OpError} contract.
 *
 * @param io - Process streams.
 * @param error - The failure.
 * @param json - Whether `--json` is active.
 */
export function renderOpError(io: CliIo, error: OpError, json: boolean): void {
	if (json) {
		writeJson(io.stdout, opErrorJson(error));
		return;
	}
	writeLine(
		io.stderr,
		`${theme.fail(`${glyph.fail} ${error.message}`)} ${theme.muted(`(${error.code})`)}`,
	);
	const fix = fixHint(error.details);
	if (fix) writeLine(io.stderr, theme.muted(`  fix: ${fix}`));
}

/**
 * Renders a usage problem (bad flag combination) on stderr, or as JSON.
 *
 * @param io - Process streams.
 * @param message - What is wrong and how to fix it.
 * @param json - Whether `--json` is active.
 */
export function renderUsageError(
	io: CliIo,
	message: string,
	json: boolean,
): void {
	if (json) {
		writeJson(io.stdout, { ok: false, error: { code: "USAGE", message } });
		return;
	}
	writeLine(io.stderr, theme.fail(`error: ${message}`));
}
