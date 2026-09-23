/** Pattern of a snapshot display name (mirrors core's `SNAPSHOT_NAME_PATTERN`). */
export const SNAPSHOT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

/**
 * Validates the optional snapshot name (empty lets the server pick `snap-<n>`).
 *
 * @param name - What the user typed.
 * @returns An error message, or `undefined` when valid.
 */
export function validateSnapshotName(name: string): string | undefined {
	const trimmed = name.trim();
	if (!trimmed) return undefined;
	return SNAPSHOT_NAME_PATTERN.test(trimmed)
		? undefined
		: "Start with a letter or digit; then letters, digits, spaces, dots, dashes or underscores (64 max).";
}

/**
 * Archive size: `820 KB`, `48 MB`, `1.2 GB`.
 *
 * @param bytes - Size in bytes.
 * @returns The label.
 */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${Math.max(1, Math.round(kb))} KB`;
	const mb = kb / 1024;
	if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
	return `${(mb / 1024).toFixed(1)} GB`;
}

/**
 * Relative creation time like the prototype: `just now`, `5 min ago`,
 * `3 h ago`, `yesterday`, `4 days ago`.
 *
 * @param iso - ISO-8601 instant.
 * @param now - Current time in ms.
 * @returns The label.
 */
export function formatAgo(iso: string, now: number = Date.now()): string {
	const at = Date.parse(iso);
	if (Number.isNaN(at)) return "at an unknown time";
	const minutes = Math.floor(Math.max(0, now - at) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.floor(hours / 24);
	if (days === 1) return "yesterday";
	return `${days} days ago`;
}
