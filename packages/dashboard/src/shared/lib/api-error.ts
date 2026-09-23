/** Body of `Common.Error` responses (`{ code, message, details? }`). */
export interface ApiErrorBody {
	readonly code: string;
	readonly message: string;
	readonly details?: Readonly<Record<string, unknown>>;
}

/** A failed API call, normalised from Eden's `{ status, value }` error. */
export class ApiRequestError extends Error {
	/** HTTP status (0 when the request never reached the server). */
	readonly status: number;
	/** `OpErrorCode`, or `HTTP_<status>` for plain-text errors. */
	readonly code: string;
	/** Structured context (`fix`, `port`, …); never secrets. */
	readonly details: Readonly<Record<string, unknown>>;

	/**
	 * @param status - HTTP status.
	 * @param body - Error code, message and details.
	 */
	constructor(status: number, body: ApiErrorBody) {
		super(body.message);
		this.name = "ApiRequestError";
		this.status = status;
		this.code = body.code;
		this.details = body.details ?? {};
	}

	/**
	 * Suggested port of a `PORT_CONFLICT` (`details.suggestedPort`; `details.port`
	 * is the busy one), when the server found one.
	 */
	get suggestedPort(): number | undefined {
		const port = this.details.suggestedPort;
		return typeof port === "number" ? port : undefined;
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

/**
 * Builds an {@link ApiRequestError} from a status and an arbitrary error value.
 *
 * @param status - HTTP status.
 * @param value - Parsed response body (object or text).
 * @returns The normalised error.
 */
export function toApiError(status: number, value: unknown): ApiRequestError {
	if (
		isRecord(value) &&
		typeof value.code === "string" &&
		typeof value.message === "string"
	) {
		return new ApiRequestError(status, {
			code: value.code,
			message: value.message,
			details: isRecord(value.details) ? value.details : undefined,
		});
	}
	const text =
		typeof value === "string" && value.length > 0
			? value
			: `Request failed (${status})`;
	return new ApiRequestError(status, {
		code: `HTTP_${status}`,
		message: text,
	});
}

/**
 * A human-readable message for any thrown value.
 *
 * @param error - Anything caught.
 * @returns A message safe to show in a toast.
 */
export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return "Something went wrong";
}
