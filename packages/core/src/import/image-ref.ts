/** Registry prefixes that mean Docker Hub, removed from a repository. */
const HUB_PREFIXES = [
	"docker.io/library/",
	"docker.io/",
	"index.docker.io/library/",
	"index.docker.io/",
	"registry-1.docker.io/library/",
	"registry-1.docker.io/",
	"library/",
];

/** An image reference split into its repository and tag. */
export interface ImageRef {
	/** Repository without tag, digest or Docker Hub prefix, lower-cased (e.g. `postgis/postgis`). */
	readonly repository: string;
	/** Tag, when one is given (e.g. `16-alpine`). */
	readonly tag?: string;
}

/**
 * Splits an image reference like `docker.io/library/postgres:16-alpine@sha256:…`
 * into `{ repository: "postgres", tag: "16-alpine" }`.
 *
 * @param image - Image reference (compose `image:`).
 * @returns Normalised repository and tag.
 */
export function parseImageRef(image: string): ImageRef {
	const at = image.indexOf("@");
	const withoutDigest = (at === -1 ? image : image.slice(0, at)).trim();
	const lastSlash = withoutDigest.lastIndexOf("/");
	const colon = withoutDigest.indexOf(":", lastSlash + 1);
	let repository = (
		colon === -1 ? withoutDigest : withoutDigest.slice(0, colon)
	).toLowerCase();
	for (const prefix of HUB_PREFIXES) {
		if (repository.startsWith(prefix)) {
			repository = repository.slice(prefix.length);
			break;
		}
	}
	const tag = colon === -1 ? undefined : withoutDigest.slice(colon + 1);
	return tag === undefined || tag === "" ? { repository } : { repository, tag };
}

/**
 * Picks the catalog version an image tag asks for: the tag itself, else its
 * leading version (`16-alpine` → `16`, `7.4.2` → `7.4.2`, `7.4`, `7`),
 * whichever is first found in `versions`.
 *
 * @param tag - Image tag, if any.
 * @param versions - The definition's versions.
 * @returns The matching version, or `undefined` (use `defaultVersion`).
 */
export function versionFromTag(
	tag: string | undefined,
	versions: readonly string[],
): string | undefined {
	if (tag === undefined) return undefined;
	if (versions.includes(tag)) return tag;
	const leading = /^v?(\d+(?:\.\d+)*)/.exec(tag)?.[1];
	if (leading === undefined) return undefined;
	const parts = leading.split(".");
	for (let length = parts.length; length > 0; length--) {
		const candidate = parts.slice(0, length).join(".");
		if (versions.includes(candidate)) return candidate;
	}
	return undefined;
}
