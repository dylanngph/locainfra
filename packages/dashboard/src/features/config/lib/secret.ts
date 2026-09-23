/** Random bytes behind one generated secret (base64url: 43 characters). */
export const SECRET_BYTES = 32;

/** Pattern a client-chosen secret must match (mirrors core's `SECRET_VALUE_PATTERN`). */
export const SECRET_VALUE_PATTERN = /^[A-Za-z0-9._~-]{16,256}$/;

/**
 * Generates a secret in the browser (Config page "Regenerate"): 32 bytes
 * from `crypto.getRandomValues` as unpadded base64url, 43 characters of
 * `A-Z a-z 0-9 - _`, safe in URLs, `.env` files and argv.
 *
 * @returns The secret.
 */
export function generateSecret(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}
