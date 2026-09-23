import type { DoctorCheckStatus, DoctorReport } from "@locainfra/core";
import { formatTable } from "../../ui/table";
import { glyph, theme } from "../../ui/theme";

/**
 * Colored glyph for a check status.
 *
 * @param status - Check outcome.
 * @returns `✓`, `▲` or `✗` in green, yellow or red.
 */
export function statusGlyph(status: DoctorCheckStatus): string {
	switch (status) {
		case "ok":
			return theme.ok(glyph.ok);
		case "warn":
			return theme.warn(glyph.warn);
		case "fail":
			return theme.fail(glyph.fail);
	}
}

/** Number of checks per status. */
export type DoctorCounts = Record<DoctorCheckStatus, number>;

/**
 * @param report - Doctor report.
 * @returns How many checks ended ok, warn and fail.
 */
export function countDoctorChecks(report: DoctorReport): DoctorCounts {
	const counts: DoctorCounts = { ok: 0, warn: 0, fail: 0 };
	for (const check of report.checks) counts[check.status] += 1;
	return counts;
}

/**
 * One-line summary, e.g. `✓ Doctor: 3 ok · 1 warn · 0 fail`.
 *
 * @param report - Doctor report.
 * @returns The summary line (colored).
 */
export function formatDoctorSummary(report: DoctorReport): string {
	const c = countDoctorChecks(report);
	const head = report.ok
		? c.warn > 0
			? statusGlyph("warn")
			: statusGlyph("ok")
		: statusGlyph("fail");
	return `${head} Doctor: ${c.ok} ok · ${c.warn} warn · ${c.fail} fail`;
}

/**
 * Full human-readable report: one aligned row per check (glyph, label, detail)
 * with a `fix:` hint under every non-ok check that has one.
 *
 * @param report - Doctor report.
 * @returns Multi-line text without a trailing newline.
 */
export function formatDoctorReport(report: DoctorReport): string {
	const rows = report.checks.map((check) => [
		statusGlyph(check.status),
		check.label,
		theme.muted(check.detail ?? ""),
	]);
	const lines = formatTable(rows, { indent: 2 }).split("\n");
	const out: string[] = [];
	report.checks.forEach((check, i) => {
		out.push(lines[i] ?? "");
		if (check.status !== "ok" && check.fix) {
			out.push(`     ${theme.muted("fix:")} ${check.fix}`);
		}
	});
	out.push("", formatDoctorSummary(report));
	return out.join("\n");
}
