/** The part of a TanStack Form field's meta these helpers touch. */
export interface ServerErrorMeta {
	readonly errorMap: { readonly onServer?: unknown };
}

/**
 * First displayable message of a TanStack Form field's error list.
 *
 * @param errors - `field.state.meta.errors`.
 * @returns The message, or `undefined`.
 */
export function firstError(errors: readonly unknown[]): string | undefined {
	const first = errors.find((e) => typeof e === "string" && e.length > 0);
	return typeof first === "string" ? first : undefined;
}

/**
 * Meta updater that shows a server-side error on a field (TanStack Form's
 * `onServer` slot). Use with `form.setFieldMeta(name, withServerError(msg))`.
 *
 * @param message - Error returned by the API.
 * @returns The updater.
 */
export function withServerError(
	message: string,
): <M extends ServerErrorMeta>(meta: M) => M {
	return (meta) => ({
		...meta,
		errorMap: { ...meta.errorMap, onServer: message },
	});
}

/**
 * Meta updater that clears a field's server-side error (on the next edit).
 *
 * @param meta - Current field meta.
 * @returns The same meta when nothing changes, otherwise a copy without it.
 */
export function withoutServerError<M extends ServerErrorMeta>(meta: M): M {
	return meta.errorMap.onServer === undefined
		? meta
		: { ...meta, errorMap: { ...meta.errorMap, onServer: undefined } };
}
