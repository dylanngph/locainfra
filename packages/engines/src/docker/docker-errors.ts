import { OpError } from "@locainfra/core";

/**
 * Reads the `message` of an Engine API error body, falling back to the raw
 * text (truncated) or the status text.
 *
 * @param response - A non-2xx Engine API response (its body is consumed).
 * @returns A short, human-readable message.
 */
export async function readDockerErrorMessage(
	response: Response,
): Promise<string> {
	const text = await response.text().catch(() => "");
	try {
		const parsed: unknown = JSON.parse(text);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"message" in parsed &&
			typeof parsed.message === "string"
		) {
			return parsed.message;
		}
	} catch {
		// Not JSON: fall through to the raw text.
	}
	return text.slice(0, 200) || response.statusText;
}

/**
 * Converts a non-2xx Engine API response into a typed {@link OpError}.
 *
 * @param response - The failed response (its body is consumed).
 * @param path - Requested path, for the message (query is dropped).
 * @param container - Container id or name the request concerned, if any:
 *   a `404` then becomes `SERVICE_NOT_FOUND`.
 * @returns `SERVICE_NOT_FOUND` for a missing container, otherwise `UNKNOWN`.
 */
export async function dockerApiError(
	response: Response,
	path: string,
	container?: string,
): Promise<OpError> {
	const message = await readDockerErrorMessage(response);
	if (response.status === 404 && container !== undefined) {
		return new OpError("SERVICE_NOT_FOUND", `No such container: ${container}`, {
			details: { container, status: 404 },
		});
	}
	return new OpError(
		"UNKNOWN",
		`Docker API ${path.split("?")[0]} failed with ${response.status}: ${message}`,
		{ details: { status: response.status } },
	);
}
