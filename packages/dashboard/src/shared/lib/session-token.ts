/** sessionStorage key holding the dashboard session token. */
export const TOKEN_STORAGE_KEY = "locastack.token";

/** Query parameter the CLI appends when it opens the dashboard (`?t=<token>`). */
export const TOKEN_QUERY_PARAM = "t";

let cached: string | null | undefined;

/** Browser pieces {@link initSessionToken} touches, injectable for tests. */
export interface TokenEnvironment {
	readonly location: Pick<Location, "href">;
	readonly storage: Pick<Storage, "getItem" | "setItem">;
	readonly history: Pick<History, "replaceState" | "state">;
}

const browserEnvironment = (): TokenEnvironment => ({
	location: window.location,
	storage: window.sessionStorage,
	history: window.history,
});

/**
 * Reads the session token from `?t=` (then persists it in sessionStorage and
 * removes it from the address bar so it is not shared by copy-pasting the URL),
 * falling back to the token stored earlier in this tab.
 *
 * @param env - Browser location, storage and history (defaults to `window`).
 * @returns The token, or `null` when the page was opened without one.
 */
export function initSessionToken(
	env: TokenEnvironment = browserEnvironment(),
): string | null {
	const url = new URL(env.location.href);
	const fromUrl = url.searchParams.get(TOKEN_QUERY_PARAM);
	if (fromUrl) {
		try {
			env.storage.setItem(TOKEN_STORAGE_KEY, fromUrl);
		} catch {
			// Storage can be unavailable (private mode); the in-memory copy still works.
		}
		url.searchParams.delete(TOKEN_QUERY_PARAM);
		env.history.replaceState(
			env.history.state,
			"",
			`${url.pathname}${url.search}${url.hash}`,
		);
		cached = fromUrl;
		return fromUrl;
	}
	let stored: string | null = null;
	try {
		stored = env.storage.getItem(TOKEN_STORAGE_KEY);
	} catch {
		stored = null;
	}
	cached = stored ?? devToken();
	return cached;
}

/**
 * Development fallback: `bun run dev` fixes the token in `.env.development`
 * and Vite exposes it as `VITE_LOCASTACK_TOKEN`, so the HMR dashboard on
 * :5173 needs no `?t=`. Never defined in production builds.
 */
const devToken = (): string | null =>
	import.meta.env.DEV ? (import.meta.env.VITE_LOCASTACK_TOKEN ?? null) : null;

/**
 * The current session token (initialised lazily from the browser).
 *
 * @returns The token, or `null` when none is known.
 */
export function getSessionToken(): string | null {
	if (cached === undefined) {
		cached = typeof window === "undefined" ? null : initSessionToken();
	}
	return cached;
}
