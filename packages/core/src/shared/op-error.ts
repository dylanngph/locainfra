/** Every error code an operation can return. */
export const OP_ERROR_CODES = [
	"DOCKER_UNREACHABLE",
	"COMPOSE_MISSING",
	"COMPOSE_TOO_OLD",
	"STACK_NOT_FOUND",
	"PROJECT_NOT_FOUND",
	"PROJECT_EXISTS",
	"SERVICE_NOT_FOUND",
	"SERVICE_EXISTS",
	"SERVICE_NOT_RUNNING",
	"SNAPSHOT_NOT_FOUND",
	"INVALID_INPUT",
	"INVALID_STACK",
	"INVALID_CATALOG",
	"PORT_CONFLICT",
	"IO",
	"UNKNOWN",
] as const;

/** Machine-readable error code carried by {@link OpError}. */
export type OpErrorCode = (typeof OP_ERROR_CODES)[number];

/** Optional extras for {@link OpError}. */
export interface OpErrorOptions {
	/** Structured, secret-free context (e.g. `{ port: 5432 }`). */
	readonly details?: Readonly<Record<string, unknown>>;
	/** Underlying error, if any. */
	readonly cause?: unknown;
}

/**
 * Typed failure returned (inside a {@link Result}) by operations.
 *
 * Servers map {@link OpError.code} to HTTP status; the CLI maps it to an exit code.
 */
export class OpError extends Error {
	/** Machine-readable error code. */
	readonly code: OpErrorCode;
	/** Structured, secret-free context. */
	readonly details: Readonly<Record<string, unknown>>;

	/**
	 * @param code - Machine-readable error code.
	 * @param message - Human-readable message (no secrets).
	 * @param options - Optional details and cause.
	 */
	constructor(
		code: OpErrorCode,
		message: string,
		options: OpErrorOptions = {},
	) {
		super(
			message,
			options.cause === undefined ? undefined : { cause: options.cause },
		);
		this.name = "OpError";
		this.code = code;
		this.details = options.details ?? {};
	}
}

/**
 * Type guard for {@link OpError}.
 *
 * @param value - Anything.
 * @returns Whether `value` is an {@link OpError}.
 */
export function isOpError(value: unknown): value is OpError {
	return value instanceof OpError;
}

/**
 * Wraps a port failure (state store, secrets…) as an `IO` {@link OpError}.
 * A cause that already is an `OpError` is user-facing (e.g. the state store's
 * "created by a newer LocaInfra; update LocaInfra" with its `fix`), so its
 * code and message are kept and `details` are only added to.
 *
 * @param message - Message for an unexpected (non-`OpError`) cause.
 * @param cause - What the port threw.
 * @param details - Context added to the error's details.
 * @returns The error to return.
 */
export function ioErrorFrom(
	message: string,
	cause: unknown,
	details?: Readonly<Record<string, unknown>>,
): OpError {
	if (isOpError(cause)) {
		return new OpError(cause.code, cause.message, {
			cause,
			details: { ...details, ...cause.details },
		});
	}
	return new OpError("IO", message, {
		cause,
		...(details === undefined ? {} : { details }),
	});
}
