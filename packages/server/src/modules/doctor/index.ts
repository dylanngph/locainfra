import { Elysia } from "elysia";
import { DoctorModel } from "./doctor.model";
import type { DoctorService } from "./doctor.service";

/**
 * Doctor controller (one Elysia instance = one controller; routes only).
 *
 * @param service - Report producer.
 * @returns The `GET /api/doctor` routes.
 */
export const doctorModule = (service: DoctorService) =>
	new Elysia({ name: "Doctor.Controller", prefix: "/api/doctor" })
		.model(DoctorModel)
		.prefix("model", "Doctor.")
		.get("/", () => service.report(), {
			response: "Doctor.Report",
			detail: { tags: ["Doctor"], summary: "Run environment diagnostics" },
		});
