/** Breadcrumb kind a route contributes after the project switcher. */
export type CrumbKind = "catalog" | "config" | "service" | "env";

/** `handle` of LocaInfra route objects. */
export interface RouteHandle {
	readonly crumb?: CrumbKind;
}

/**
 * Narrows an unknown route `handle` to {@link RouteHandle}.
 *
 * @param handle - `match.handle`.
 * @returns The crumb kind, if any.
 */
export function crumbOf(handle: unknown): CrumbKind | undefined {
	if (typeof handle !== "object" || handle === null || !("crumb" in handle)) {
		return undefined;
	}
	const crumb = handle.crumb;
	return crumb === "catalog" ||
		crumb === "config" ||
		crumb === "service" ||
		crumb === "env"
		? crumb
		: undefined;
}
