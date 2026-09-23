/**
 * Per-stack secret storage (`~/.locainfra/secrets/<stack>.env`, mode 0600).
 * Implementations must never log values.
 */
export interface SecretStore {
	/**
	 * @param stack - Stack name.
	 * @returns The stack's secrets; empty when none are stored.
	 */
	read(stack: string): Promise<Record<string, string>>;
	/**
	 * Replaces the stack's secrets file with `secrets`.
	 *
	 * @param stack - Stack name.
	 * @param secrets - Complete secret map to persist.
	 */
	write(stack: string, secrets: Record<string, string>): Promise<void>;
	/**
	 * Atomic read-modify-write of the stack's secrets under a per-stack lock,
	 * so concurrent callers (two `up` runs, CLI plus dashboard) never both
	 * generate a value for the same missing secret.
	 *
	 * @param stack - Stack name.
	 * @param mutate - Receives the current secrets (a private copy); returns the
	 *   complete map to persist, or `undefined` to leave the file untouched.
	 * @returns The stack's secrets after the update.
	 */
	update(
		stack: string,
		mutate: (
			current: Record<string, string>,
		) => Record<string, string> | undefined,
	): Promise<Record<string, string>>;
}
