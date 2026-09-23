import { extname, join, normalize, sep } from "node:path";
import { Elysia } from "elysia";

/** Options of {@link staticAssets}. */
export interface StaticAssetsOptions {
	/**
	 * Built SPA folder (Vite `dist/`): a real folder, or the compiled binary's
	 * embedded `/$bunfs/root/packages/dashboard/dist` (`--asset`).
	 */
	readonly dir: string;
	/** `host:port` values the dashboard may be reached on (DNS-rebinding guard). */
	readonly allowedHosts: readonly string[];
}

const IMMUTABLE = "public, max-age=31536000, immutable";
const NO_CACHE = "no-cache";

/**
 * Serves the built dashboard: an existing file under `dir` is returned as-is
 * (hashed `/assets/*` cached forever), any other extension-less path falls
 * back to `index.html` so client-side routes load. The folder is a real one
 * (development, tests) or the compiled binary's embedded copy. Paths that
 * resolve outside the folder are never served. `/api/*` and `/ws` never
 * fall back (unknown API paths are a plain `404`). Public (the page itself
 * reads the token from its URL) but still Host-checked.
 *
 * @param options - Folder and allowed hosts.
 * @returns The plugin.
 */
export const staticAssets = (options: StaticAssetsOptions) => {
	const { allowedHosts } = options;
	const lookup = folderLookup(options.dir);
	const serve = async (
		request: Request,
		set: { headers: Record<string, string | number> },
	) => {
		const host = request.headers.get("host") ?? "";
		if (!allowedHosts.includes(host))
			return new Response("Forbidden host", { status: 403 });
		const pathname = safeDecode(new URL(request.url).pathname);
		if (
			pathname === undefined ||
			pathname === "/api" ||
			pathname.startsWith("/api/") ||
			pathname === "/ws"
		)
			return new Response("Not Found", { status: 404 });
		const target = lookup.resolve(pathname);
		if (target !== undefined) {
			const file = Bun.file(target);
			if (await file.exists()) {
				set.headers["cache-control"] = pathname.startsWith("/assets/")
					? IMMUTABLE
					: NO_CACHE;
				return file;
			}
		}
		if (extname(pathname) !== "")
			return new Response("Not Found", { status: 404 });
		set.headers["cache-control"] = NO_CACHE;
		return Bun.file(lookup.index);
	};
	return new Elysia({ name: "Plugin.StaticAssets", seed: lookup.seed })
		.get("/", ({ request, set }) => serve(request, set), {
			detail: { hide: true },
		})
		.get("/*", ({ request, set }) => serve(request, set), {
			detail: { hide: true },
		});
};

interface AssetLookup {
	/** Plugin dedupe seed. */
	readonly seed: string;
	/** File served for client-side routes. */
	readonly index: string;
	/** @returns The file for a decoded URL path, or `undefined` (never outside the SPA). */
	resolve(pathname: string): string | undefined;
}

function folderLookup(dir: string): AssetLookup {
	const root = normalize(dir);
	return {
		seed: root,
		index: join(root, "index.html"),
		resolve(pathname) {
			const target = normalize(join(root, pathname));
			const inside = target.startsWith(root.endsWith(sep) ? root : root + sep);
			return inside ? target : undefined;
		},
	};
}

function safeDecode(pathname: string): string | undefined {
	try {
		return decodeURIComponent(pathname);
	} catch {
		return undefined;
	}
}
