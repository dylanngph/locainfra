/**
 * Polls `predicate` until it holds (test helper for background streams).
 *
 * @param predicate - Condition to wait for.
 * @param timeoutMs - Give up after this long.
 */
export async function waitFor(
	predicate: () => boolean,
	timeoutMs = 2000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("waitFor: timed out");
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
}

/**
 * @param ms - Delay.
 * @returns Resolves after `ms`.
 */
export const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));
