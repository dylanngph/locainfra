import type {
	AddServiceBody,
	CreateProjectBody,
	EnvPreview,
	Progress,
	ServicePatch,
} from "@locastack/server";
import { HttpResponse, http } from "msw";
import { SEED_PATH_PATTERN } from "@/features/config/lib/seed-path";
import type { ImportRequest } from "@/features/import/api/import.api";
import { MOCK_TABLES, runMockQuery } from "./mock-data";
import {
	type MockDb,
	type MockProject,
	type MockService,
	mockDb,
} from "./mock-db";
import { mockPreviewImport } from "./mock-import";
import { mockSystemInfo, mockSystemSetup } from "./mock-system";

const NAME = /^[a-z][a-z0-9-]*$/;

const fail = (
	status: number,
	code: string,
	message: string,
	details?: object,
) =>
	HttpResponse.json(
		{ code, message, ...(details ? { details } : {}) },
		{ status },
	);

const accepted = (opId: string) => HttpResponse.json({ opId }, { status: 202 });

const findProject = (db: MockDb, name: unknown) =>
	typeof name === "string" ? db.project(name) : undefined;

const notFoundProject = (name: unknown) =>
	fail(
		404,
		"PROJECT_NOT_FOUND",
		`Project "${String(name)}" is not registered.`,
	);

const withService = (
	db: MockDb,
	params: Record<string, unknown>,
	fn: (p: MockProject, s: MockService) => Response | Promise<Response>,
) => {
	const p = findProject(db, params.project);
	if (!p) return notFoundProject(params.project);
	const s = p.services.find((x) => x.name === params.name);
	if (!s)
		return fail(
			404,
			"SERVICE_NOT_FOUND",
			`Service "${String(params.name)}" is not in ${p.name}.`,
		);
	return fn(p, s);
};

const bool = (value: string | null) => value === "true";

const SECRET_VALUE = /^[A-Za-z0-9._~-]{16,256}$/;
const SNAPSHOT_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const SEED_PATH = new RegExp(SEED_PATH_PATTERN);
const IMPORT_MAX_BYTES = 512 * 1024;

const notRunning = (s: MockService) =>
	fail(
		409,
		"SERVICE_NOT_RUNNING",
		`${s.name} is not running. Start it to run queries.`,
	);

const randomSecret = () =>
	Array.from({ length: 3 }, () => Math.random().toString(36).slice(2, 10)).join(
		"",
	);

/**
 * HTTP handlers mirroring docs/api.md over the in-memory {@link MockDb}.
 *
 * @param db - Backend state (defaults to the shared instance).
 * @returns MSW request handlers.
 */
export const createHttpHandlers = (db: MockDb = mockDb) => [
	http.get("*/api/health", () => HttpResponse.json({ ok: true })),
	http.get("*/api/system", () => HttpResponse.json(mockSystemInfo(db.docker))),
	http.get("*/api/system/setup", () =>
		HttpResponse.json(mockSystemSetup(db.docker)),
	),
	http.post("*/api/system/docker/start", () => {
		const { plan } = mockSystemSetup(db.docker);
		if (plan.kind === "install")
			return fail(409, "DOCKER_NOT_INSTALLED", plan.reason, {
				fix: "Run `locastack setup` in a terminal",
				command: "locastack setup",
			});
		return accepted(
			db.runOp(
				plan.steps.map((step) => ({ message: step.title, delay: 50 })),
				plan.kind === "none"
					? "Docker is already running"
					: "Docker is ready: 27.1.1",
				() => {
					db.docker = "running";
				},
			),
		);
	}),
	http.get("*/api/catalog", () => HttpResponse.json(db.catalogListing())),
	http.get("*/api/catalog/:type/free-port", ({ params }) => {
		const definition = db
			.catalogListing()
			.definitions.find((d) => d.id === params.type);
		if (!definition)
			return HttpResponse.json(
				{
					code: "INVALID_INPUT",
					message: `Unknown service type ${params.type}`,
				},
				{ status: 422 },
			);
		return HttpResponse.json({ port: db.freePortFor(definition) });
	}),

	http.get("*/api/projects", () =>
		HttpResponse.json(db.projects.map((p) => db.summary(p))),
	),
	http.post("*/api/projects/pick-folder", async ({ request }) => {
		const body = (await request.json()) as { name?: string };
		return HttpResponse.json({
			root: `/Users/dev/Developer/${body.name || "untitled"}`,
		});
	}),
	http.post("*/api/projects", async ({ request }) => {
		const body = (await request.json()) as CreateProjectBody;
		if (!NAME.test(body.name))
			return fail(
				422,
				"INVALID_INPUT",
				"Use lowercase letters, numbers and dashes.",
			);
		if (db.project(body.name))
			return fail(
				409,
				"PROJECT_EXISTS",
				`A project named "${body.name}" already exists.`,
			);
		const root = body.root.replace(/^~\//, "/Users/dev/");
		const project: MockProject = { name: body.name, root, services: [] };
		db.projects.push(project);
		return HttpResponse.json(db.summary(project), { status: 201 });
	}),
	http.get("*/api/projects/:project", ({ params }) => {
		const p = findProject(db, params.project);
		if (!p) return notFoundProject(params.project);
		return HttpResponse.json({
			stack: db.stack(p),
			status: db.projectStatus(p, false),
		});
	}),
	http.delete("*/api/projects/:project", ({ params }) => {
		const p = findProject(db, params.project);
		if (!p) return notFoundProject(params.project);
		db.projects = db.projects.filter((x) => x !== p);
		return HttpResponse.json({ name: p.name, root: p.root });
	}),
	http.post("*/api/projects/:project/up", ({ params }) => {
		const p = findProject(db, params.project);
		if (!p) return notFoundProject(params.project);
		const targets = p.services.filter(
			(s) => s.state !== "running" && s.state !== "port-conflict",
		);
		return accepted(
			db.runOp(
				targets.flatMap((s) => db.startSteps(p, s)),
				`Started ${targets.length} service${targets.length === 1 ? "" : "s"}`,
			),
		);
	}),
	http.post("*/api/projects/:project/down", ({ params }) => {
		const p = findProject(db, params.project);
		if (!p) return notFoundProject(params.project);
		const targets = p.services.filter((s) => s.state !== "stopped");
		return accepted(
			db.runOp(
				targets.flatMap((s) => db.stopSteps(p, s)),
				`Stopped ${targets.length} service${targets.length === 1 ? "" : "s"}`,
			),
		);
	}),

	http.get("*/api/projects/:project/services", ({ params }) => {
		const p = findProject(db, params.project);
		if (!p) return notFoundProject(params.project);
		return HttpResponse.json(p.services.map((s) => db.detail(p, s)));
	}),
	http.post("*/api/projects/:project/services", async ({ params, request }) => {
		const p = findProject(db, params.project);
		if (!p) return notFoundProject(params.project);
		const body = (await request.json()) as AddServiceBody;
		const def = db.definition(body.type);
		if (!def)
			return fail(422, "INVALID_INPUT", `Unknown service type "${body.type}".`);
		if (!NAME.test(body.name))
			return fail(
				422,
				"INVALID_INPUT",
				"Use lowercase letters, numbers and dashes.",
			);
		for (const [key, value] of Object.entries(body.secrets ?? {})) {
			if (!def.secrets.includes(key))
				return fail(
					422,
					"INVALID_INPUT",
					`${key} is not a secret of ${def.id}.`,
				);
			if (!SECRET_VALUE.test(value))
				return fail(
					422,
					"VALIDATION",
					`secrets.${key} does not match the pattern.`,
				);
		}
		if (body.seed !== undefined && (!def.seed || !SEED_PATH.test(body.seed)))
			return fail(
				422,
				"INVALID_INPUT",
				"seed must be a path inside the project.",
			);
		if (p.services.some((s) => s.name === body.name))
			return fail(
				409,
				"SERVICE_EXISTS",
				`A service named "${body.name}" already exists in ${p.name}.`,
			);
		const port =
			body.port === undefined || body.port === "auto"
				? db.nextFreePort(p, def.port.default)
				: body.port;
		const owner = db.projects
			.flatMap((x) => x.services.map((s) => ({ x, s })))
			.find(({ s }) => s.hostPort === port);
		if (owner)
			return fail(
				409,
				"PORT_CONFLICT",
				`Port ${port} is used by ${owner.x.name}/${owner.s.name}.`,
				{
					port: db.nextFreePort(p, port),
				},
			);
		const service: MockService = {
			name: body.name,
			type: body.type,
			version: body.version ?? def.defaultVersion,
			hostPort: port,
			persist: body.persist ?? "volume",
			state: "stopped",
			config: body.config ?? {},
			secrets: Object.fromEntries(
				def.secrets.map((s) => [s, body.secrets?.[s] ?? randomSecret()]),
			),
			...(body.seed ? { seed: body.seed } : {}),
			cpu: 0,
			memMb: 0,
		};
		p.services.push(service);
		return accepted(
			db.runOp(
				[
					{
						message: `Added ${service.name} to locastack.yaml`,
						service: service.name,
						delay: 100,
						percent: 5,
					},
					{
						message: `Pulling ${def.image.replace("{{version}}", service.version)}`,
						delay: 500,
						percent: 10,
					},
					...db.startSteps(p, service),
				],
				`${service.name} is running on port ${service.hostPort}`,
			),
		);
	}),
	http.get("*/api/projects/:project/services/:name", ({ params }) =>
		withService(db, params, (p, s) => HttpResponse.json(db.detail(p, s))),
	),
	http.patch("*/api/projects/:project/services/:name", ({ params, request }) =>
		withService(db, params, async (p, s) => {
			const patch = (await request.json()) as ServicePatch;
			if (typeof patch.port === "number") s.hostPort = patch.port;
			if (patch.version) s.version = patch.version;
			if (patch.persist) s.persist = patch.persist;
			if (patch.config) s.config = patch.config;
			if (patch.seed !== undefined)
				s.seed = patch.seed === "" ? undefined : patch.seed;
			s.problem = undefined;
			return accepted(
				db.runOp(
					[
						{ message: "Updated locastack.yaml", delay: 100, service: s.name },
						...db.startSteps(p, s),
					],
					`${s.name} recreated`,
				),
			);
		}),
	),
	http.delete("*/api/projects/:project/services/:name", ({ params }) =>
		withService(db, params, (p, s) => {
			p.services = p.services.filter((x) => x !== s);
			db.emit({
				channel: `status:${p.name}`,
				type: "delta",
				payload: { services: [], removed: [s.name] },
			});
			return accepted(db.runOp([], `${s.name} removed`));
		}),
	),
	http.post("*/api/projects/:project/services/:name/start", ({ params }) =>
		withService(db, params, (p, s) =>
			accepted(db.runOp(db.startSteps(p, s), `${s.name} is running`)),
		),
	),
	http.post("*/api/projects/:project/services/:name/stop", ({ params }) =>
		withService(db, params, (p, s) =>
			accepted(db.runOp(db.stopSteps(p, s), `${s.name} stopped`)),
		),
	),
	http.post("*/api/projects/:project/services/:name/restart", ({ params }) =>
		withService(db, params, (p, s) =>
			accepted(
				db.runOp(
					[...db.stopSteps(p, s), ...db.startSteps(p, s)],
					`${s.name} restarted`,
				),
			),
		),
	),
	http.get("*/api/ops/:opId/events", ({ params }) => {
		const opId = String(params.opId);
		const buffered = db.ops.get(opId);
		if (!buffered) return fail(404, "OP_NOT_FOUND", `No operation ${opId}`);
		const encoder = new TextEncoder();
		const terminal = (e: Progress) => e.kind === "done" || e.kind === "error";
		let stop = () => {};
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				let closed = false;
				const send = (event: Progress) => {
					if (closed) return;
					controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
					if (terminal(event)) {
						closed = true;
						stop();
						controller.close();
					}
				};
				stop = db.listen((message) => {
					if (message.channel === `op:${opId}` && message.type === "progress")
						send(message.payload);
				});
				for (const event of [...buffered]) send(event);
			},
			cancel() {
				stop();
			},
		});
		return new HttpResponse(body, {
			headers: { "content-type": "application/x-ndjson" },
		});
	}),
	http.get(
		"*/api/projects/:project/services/:name/logs",
		({ params, request }) =>
			withService(db, params, (_p, s) => {
				const tail = Number(
					new URL(request.url).searchParams.get("tail") ?? 200,
				);
				if (!Number.isInteger(tail) || tail < 0 || tail > 5000)
					return fail(422, "VALIDATION", "tail must be 0–5000");
				return HttpResponse.json({
					lines: db.logLines(s.type, Math.min(tail, 40)),
				});
			}),
	),
	http.get("*/api/projects/:project/services/:name/stats", ({ params }) =>
		withService(db, params, (_p, s) => {
			const sample = db.statsSample(s);
			return HttpResponse.json({ samples: sample ? [sample] : [] });
		}),
	),
	http.get(
		"*/api/projects/:project/services/:name/connection",
		({ params, request }) =>
			withService(db, params, (p, s) =>
				HttpResponse.json(
					db.connection(
						p,
						s,
						bool(new URL(request.url).searchParams.get("reveal")),
					),
				),
			),
	),

	http.get("*/api/projects/:project/services/:name/data", ({ params }) =>
		withService(db, params, (p, s) => {
			const data = db.definition(s.type)?.data;
			if (!data || data.kind === "none")
				return fail(422, "INVALID_INPUT", `${s.name} has no Data tab.`);
			if (s.state !== "running") return notRunning(s);
			const objects =
				data.kind === "sql" ? Object.keys(MOCK_TABLES) : (data.objects ?? []);
			void p;
			return HttpResponse.json({
				kind: data.kind,
				label: data.label ?? (data.kind === "sql" ? "Tables" : "Key patterns"),
				objects: objects.map((name) => ({
					name,
					defaultQuery: (data.defaultQuery ?? "").replaceAll(
						"{{object}}",
						name,
					),
				})),
				truncated: false,
			});
		}),
	),
	http.post(
		"*/api/projects/:project/services/:name/data/query",
		({ params, request }) =>
			withService(db, params, async (_p, s) => {
				const body = (await request.json()) as {
					query: string;
					limit?: number;
				};
				const data = db.definition(s.type)?.data;
				if (!data || data.kind === "none")
					return fail(422, "INVALID_INPUT", `${s.name} has no Data tab.`);
				if (!body.query.trim())
					return fail(422, "INVALID_INPUT", "Query is empty.");
				if (s.state !== "running") return notRunning(s);
				const result = runMockQuery(data.kind, body.query, body.limit ?? 1000);
				if ("error" in result)
					return fail(422, "INVALID_INPUT", result.error, { exitCode: 1 });
				return HttpResponse.json(result);
			}),
	),
	http.get("*/api/projects/:project/services/:name/snapshots", ({ params }) =>
		withService(db, params, (p, s) => HttpResponse.json(db.snapshotsOf(p, s))),
	),
	http.post(
		"*/api/projects/:project/services/:name/snapshots",
		({ params, request }) =>
			withService(db, params, async (p, s) => {
				const body = (await request.json()) as { name?: string };
				if (s.persist !== "volume")
					return fail(
						422,
						"INVALID_INPUT",
						`${s.name} is ephemeral: it has no volume to snapshot.`,
					);
				if (body.name !== undefined && !SNAPSHOT_NAME.test(body.name))
					return fail(422, "VALIDATION", "name does not match the pattern.");
				const list = db.snapshotsOf(p, s);
				const name = body.name ?? `snap-${list.length + 1}`;
				const wasRunning = s.state === "running";
				return accepted(
					db.runOp(
						[
							...(wasRunning ? db.stopSteps(p, s) : []),
							{
								message: `Archiving ls-${p.name}-${s.name}-data`,
								delay: 300,
								service: s.name,
								run: () => {
									list.unshift({
										id: `s${Date.now().toString(36)}${list.length}`,
										service: s.name,
										name,
										sizeBytes: 31 * 1024 * 1024,
										createdAt: new Date().toISOString(),
									});
									return undefined;
								},
							},
							...(wasRunning ? db.startSteps(p, s) : []),
						],
						`Snapshot “${name}” created`,
					),
				);
			}),
	),
	http.post(
		"*/api/projects/:project/services/:name/snapshots/:id/restore",
		({ params }) =>
			withService(db, params, (p, s) => {
				const snap = db.snapshotsOf(p, s).find((x) => x.id === params.id);
				if (!snap)
					return fail(
						404,
						"SNAPSHOT_NOT_FOUND",
						`Snapshot ${String(params.id)} of ${s.name} not found.`,
					);
				return accepted(
					db.runOp(
						[
							...db.stopSteps(p, s),
							{
								message: `Restoring “${snap.name}”`,
								delay: 300,
								service: s.name,
							},
							...db.startSteps(p, s),
						],
						`Restored ${s.name} to “${snap.name}”`,
					),
				);
			}),
	),
	http.delete(
		"*/api/projects/:project/services/:name/snapshots/:id",
		({ params }) =>
			withService(db, params, (p, s) => {
				const list = db.snapshotsOf(p, s);
				const index = list.findIndex((x) => x.id === params.id);
				const [snap] = index < 0 ? [] : list.splice(index, 1);
				if (!snap)
					return fail(
						404,
						"SNAPSHOT_NOT_FOUND",
						`Snapshot ${String(params.id)} of ${s.name} not found.`,
					);
				return HttpResponse.json(snap);
			}),
	),
	http.post("*/api/projects/:project/services/:name/seed", ({ params }) =>
		withService(db, params, (_p, s) => {
			if (!s.seed)
				return fail(422, "INVALID_INPUT", `${s.name} has no seed file.`);
			if (s.state !== "running")
				return fail(
					409,
					"SERVICE_NOT_RUNNING",
					`${s.name} is not running. Start it to seed it.`,
				);
			return accepted(
				db.runOp(
					[
						{
							message: `Applying ./${s.seed}`,
							delay: 300,
							service: s.name,
						},
					],
					`Seeded ${s.name} from ./${s.seed}`,
				),
			);
		}),
	),
	http.patch(
		"*/api/projects/:project/services/:name/secrets/:key/rotate",
		({ params, request }) =>
			withService(db, params, async (p, s) => {
				const body = (await request.json()) as {
					force?: boolean;
					wipeVolume?: boolean;
				};
				const key = String(params.key);
				const def = db.definition(s.type);
				if (!def?.secrets.includes(key))
					return fail(
						422,
						"INVALID_INPUT",
						`${key} is not a secret of ${s.type}.`,
					);
				const baked =
					def.secretOptions?.[key]?.bakedIntoVolume === true &&
					s.persist === "volume";
				if (baked && !(body.force && body.wipeVolume))
					return fail(
						422,
						"INVALID_INPUT",
						`${key} is stored in ${s.name}'s data volume.`,
						{
							fix: "The password is stored in the data volume on first start; rotating it needs the volume wiped. Take a snapshot first, then rotate with Wipe volume.",
						},
					);
				return accepted(
					db.runOp(
						[
							{
								message: `Generating a new ${key}`,
								delay: 100,
								service: s.name,
								run: () => {
									s.secrets[key] = randomSecret();
									return undefined;
								},
							},
							...(baked
								? [
										{
											message: `Deleting ls-${p.name}-${s.name}-data`,
											delay: 200,
											service: s.name,
										},
									]
								: []),
							...db.startSteps(p, s),
						],
						`Rotated ${key} of ${s.name}`,
					),
				);
			}),
	),
	http.post("*/api/import/preview", async ({ request }) => {
		const body = (await request.json()) as {
			yaml: string;
			projectName?: string;
		};
		if (new TextEncoder().encode(body.yaml).length > IMPORT_MAX_BYTES)
			return fail(422, "INVALID_INPUT", "The file is larger than 512 KB.");
		const preview = mockPreviewImport(
			body.yaml,
			body.projectName,
			db.catalog,
			db.projects.map((p) => p.name),
			db.portOwners(),
		);
		if ("error" in preview) return fail(422, "INVALID_INPUT", preview.error);
		return HttpResponse.json(preview);
	}),
	http.post("*/api/import", async ({ request }) => {
		const body = (await request.json()) as ImportRequest;
		if (!NAME.test(body.name))
			return fail(
				422,
				"INVALID_INPUT",
				"Use lowercase letters, numbers and dashes.",
			);
		if (db.project(body.name))
			return fail(
				409,
				"PROJECT_EXISTS",
				`A project named "${body.name}" already exists.`,
			);
		const chosen = body.items.filter((i) => i.supported && i.include && i.type);
		if (!chosen.length)
			return fail(
				422,
				"INVALID_INPUT",
				"Choose at least one service to import.",
			);
		const root = body.root.replace(/^~\//, "/Users/dev/");
		const project: MockProject = { name: body.name, root, services: [] };
		const services: MockService[] = chosen.map((i) => {
			const def = db.definition(i.type ?? "");
			return {
				name: i.name,
				type: i.type ?? "",
				version: i.version ?? def?.defaultVersion ?? "latest",
				hostPort: i.hostPort ?? def?.port.default ?? 0,
				persist: "volume",
				state: "stopped",
				config: i.config,
				secrets: Object.fromEntries(
					(def?.secrets ?? []).map((k) => [k, i.secrets[k] ?? randomSecret()]),
				),
				cpu: 0,
				memMb: 0,
			};
		});
		const remapped = chosen.filter(
			(i) => i.wantedPort !== undefined && i.hostPort !== i.wantedPort,
		).length;
		// Like the real op: the project is readable (GET /api/projects/:name)
		// only once locastack.yaml is written, i.e. from the event after
		// "Writing locastack.yaml" on (the next step, or `done`).
		const register = () => {
			if (db.projects.includes(project)) return;
			project.services = services;
			db.projects.push(project);
		};
		const count = services.length;
		return accepted(
			db.runOp(
				[
					{ message: `Creating ${root}`, delay: 100 },
					{ message: `Registering ${body.name}`, delay: 100 },
					{ message: "Storing secrets", delay: 100 },
					{ message: "Writing locastack.yaml", delay: 100 },
					...(body.start
						? [
								{
									message: `Starting ${count} service${count === 1 ? "" : "s"}`,
									delay: 100,
									run: () => {
										register();
										return undefined;
									},
								},
								...services.flatMap((s) => db.startSteps(project, s)),
							]
						: []),
				],
				`Imported ${count} service${count === 1 ? "" : "s"} into ${body.name}${remapped ? `, ${remapped} port${remapped === 1 ? "" : "s"} remapped` : ""}`,
				register,
			),
		);
	}),

	http.get("*/api/projects/:project/env", ({ params, request }) => {
		const p = findProject(db, params.project);
		if (!p) return notFoundProject(params.project);
		const url = new URL(request.url);
		const format = (url.searchParams.get("format") ??
			"dotenv") as EnvPreview["format"];
		return HttpResponse.json(
			db.envPreview(p, format, bool(url.searchParams.get("reveal"))),
		);
	}),
	http.post("*/api/projects/:project/env/write", ({ params }) => {
		const p = findProject(db, params.project);
		if (!p) return notFoundProject(params.project);
		return HttpResponse.json({
			path: `${p.root}/${p.envFile ?? ".env"}`,
			count: db.exports(p, true).length,
		});
	}),
];
