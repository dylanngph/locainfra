/**
 * Drains an async iterable into an array (test helper).
 *
 * @param iterable - Events to collect.
 * @returns Every event, in order.
 */
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of iterable) out.push(item);
	return out;
}
