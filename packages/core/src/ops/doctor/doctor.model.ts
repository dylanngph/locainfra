import { type Static, Type } from "@sinclair/typebox";

/** Outcome of a single doctor check. */
export const DoctorCheckStatus = Type.Union([
	Type.Literal("ok"),
	Type.Literal("warn"),
	Type.Literal("fail"),
]);
/** Outcome of a single doctor check. */
export type DoctorCheckStatus = Static<typeof DoctorCheckStatus>;

/** One diagnostic check performed by `doctor`. */
export const DoctorCheck = Type.Object({
	id: Type.String({ description: "Stable identifier, e.g. docker.reachable" }),
	label: Type.String(),
	status: DoctorCheckStatus,
	detail: Type.Optional(Type.String()),
	fix: Type.Optional(
		Type.String({ description: "Human-readable remediation" }),
	),
});
/** One diagnostic check performed by `doctor`. */
export type DoctorCheck = Static<typeof DoctorCheck>;

/** Full doctor report (served by `GET /api/doctor`, printed by `locainfra doctor`). */
export const DoctorReport = Type.Object({
	ok: Type.Boolean({ description: "True when no check has status `fail`" }),
	checks: Type.Array(DoctorCheck),
	generatedAt: Type.String({ description: "ISO-8601 timestamp" }),
});
/** Full doctor report. */
export type DoctorReport = Static<typeof DoctorReport>;
