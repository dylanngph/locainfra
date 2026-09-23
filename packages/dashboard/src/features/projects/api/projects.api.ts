import type { CreateProjectBody } from "@locainfra/server";
import { api, unwrap } from "@/shared/lib/api";

/**
 * Creates (or registers) a project folder.
 *
 * @param body - Name and absolute root folder.
 * @returns The new project summary.
 */
export const createProject = (body: CreateProjectBody) =>
	unwrap(api.api.projects.post(body));

/**
 * Opens the native folder picker on the server machine.
 *
 * @param name - Project name, for the dialog title.
 * @returns The chosen folder, or `null` when cancelled.
 */
export const pickFolder = async (name: string | undefined) =>
	(await unwrap(api.api.projects["pick-folder"].post({ name }))).root;

/**
 * Starts every service of a project.
 *
 * @param project - Project name.
 * @returns The op id.
 */
export const projectUp = async (project: string) =>
	(await unwrap(api.api.projects({ project }).up.post())).opId;

/**
 * Stops every service of a project (volumes kept).
 *
 * @param project - Project name.
 * @returns The op id.
 */
export const projectDown = async (project: string) =>
	(await unwrap(api.api.projects({ project }).down.post())).opId;
