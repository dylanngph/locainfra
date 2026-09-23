import { DoctorCheck, DoctorReport } from "@locainfra/core";

export { DoctorCheck, DoctorReport };

/**
 * Reference models of the doctor controller, registered under the `Doctor.`
 * prefix. The schemas are core's TypeBox models, so the API, the CLI's
 * `--json` output and the op share one definition.
 */
export const DoctorModel = { report: DoctorReport, check: DoctorCheck };
