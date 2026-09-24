import type { SecretGenerator } from "@locastack/core";

/**
 * Encodes bytes as unpadded base64url (RFC 4648 §5): URL-, shell- and dotenv-safe.
 *
 * @param bytes - Raw bytes.
 * @returns The base64url string without `=` padding.
 */
export function toBase64Url(bytes: Uint8Array): string {
	return Buffer.from(bytes)
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/** {@link SecretGenerator} using `crypto.getRandomValues`, encoded as base64url. */
export class CryptoSecretGenerator implements SecretGenerator {
	/**
	 * @param bytes - Number of random bytes (positive integer, at most 65536).
	 * @returns base64url encoding of `bytes` cryptographically random bytes.
	 * @throws RangeError when `bytes` is not a positive integer or exceeds 65536.
	 */
	generate(bytes: number): string {
		if (!Number.isInteger(bytes) || bytes <= 0 || bytes > 65536) {
			throw new RangeError(
				`Secret length must be an integer in 1..65536, got ${bytes}`,
			);
		}
		const buffer = new Uint8Array(bytes);
		crypto.getRandomValues(buffer);
		return toBase64Url(buffer);
	}
}
