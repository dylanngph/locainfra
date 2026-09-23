import { dirname } from "node:path";
import type { FileStore } from "../ports/files.port";
import { OpError } from "../shared/op-error";
import { err, ok, type Result } from "../shared/result";
import {
	decodeWithSchema,
	formatIssues,
	readYamlSource,
} from "../shared/yaml-schema";
import { type Stack, StackError, StackFile } from "./stack.model";

/** Treats a bare `services:` (YAML null) like an omitted key, i.e. `{}`. */
function withEmptyServicesAsDefault(data: unknown): unknown {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return data;
	}
	const record = data as Record<string, unknown>;
	if (record.services !== null) return data;
	const { services: _empty, ...rest } = record;
	return rest;
}

/**
 * Parses and validates stack file text (`locainfra.yaml`).
 *
 * Uses the yaml Document API (so the same parse can drive comment-preserving
 * edits) and the {@link StackFile} schema with `Value.Parse` semantics
 * (defaults, scalar conversion), reporting every problem as
 * `file:line:col: /pointer: message`.
 *
 * @param text - YAML text.
 * @param filePath - Path used in messages.
 * @returns The parsed file, or a {@link StackError} listing every issue.
 */
export function parseStackFile(
	text: string,
	filePath: string,
): Result<StackFile, StackError> {
	const yaml = readYamlSource(text, filePath);
	if (!yaml.ok) {
		return err(
			new StackError(`${filePath}: invalid YAML`, {
				filePath,
				issues: yaml.error,
			}),
		);
	}
	const decoded = decodeWithSchema(
		StackFile,
		withEmptyServicesAsDefault(yaml.value.data),
	);
	if (!decoded.ok) {
		const issues = formatIssues(yaml.value, decoded.error);
		return err(
			new StackError(
				`${filePath}: invalid stack file (${issues.length} issue${issues.length === 1 ? "" : "s"})`,
				{ filePath, issues },
			),
		);
	}
	return ok(decoded.value);
}

/**
 * Converts a {@link StackError} into the op-boundary {@link OpError}
 * (`INVALID_STACK`, with `filePath` and `issues` in `details`).
 *
 * @param error - The stack error.
 * @returns An equivalent `OpError` whose `cause` is `error`.
 */
export function stackErrorToOpError(error: StackError): OpError {
	return new OpError("INVALID_STACK", error.message, {
		details: { filePath: error.filePath, issues: error.issues },
		cause: error,
	});
}

/** Input of {@link loadStack}. */
export interface LoadStackInput {
	/** Absolute path of the stack file. */
	readonly filePath: string;
	/** Project folder (default: the file's directory). */
	readonly root?: string;
}

/**
 * Reads, validates and wraps a stack file as a {@link Stack}.
 *
 * @param files - File access.
 * @param input - File path and project root.
 * @returns The stack; `STACK_NOT_FOUND` when the file is missing, `IO` when
 *   it cannot be read, `INVALID_STACK` when it is invalid.
 */
export async function loadStack(
	files: FileStore,
	input: LoadStackInput,
): Promise<Result<Stack, OpError>> {
	const { filePath } = input;
	const root = input.root ?? dirname(filePath);
	let text: string | null;
	try {
		text = await files.readText(filePath);
	} catch (cause) {
		return err(
			new OpError("IO", `${filePath}: could not be read`, {
				details: { filePath },
				cause,
			}),
		);
	}
	if (text === null) {
		return err(
			new OpError("STACK_NOT_FOUND", `${filePath}: not found`, {
				details: { filePath },
			}),
		);
	}
	const parsed = parseStackFile(text, filePath);
	if (!parsed.ok) return err(stackErrorToOpError(parsed.error));
	const file = parsed.value;
	return ok({ name: file.name, root, filePath, file });
}
