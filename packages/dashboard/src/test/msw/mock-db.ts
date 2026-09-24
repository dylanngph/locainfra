import type {
	CatalogListing,
	ConnectionInfo,
	EnvPreview,
	PersistMode,
	Progress,
	ProjectStatus,
	ProjectSummary,
	ServerMessage,
	ServiceDefinition,
	ServiceDetail,
	ServiceProblem,
	ServiceState,
	ServiceStatus,
	Stack,
	StatsBatch,
} from "@locastack/server";
import type { Snapshot } from "@/features/snapshots/api/snapshots.api";
import { MOCK_CATALOG } from "./catalog.fixture";
import type { MockPortOwners } from "./mock-import";

/** Placeholder of masked secrets (mirrors core's MASKED_SECRET). */
export const MASKED = "••••••••";
/** Host ports "taken by another process" in the mock world. */
export const EXTERNAL_BUSY_PORTS: readonly number[] = [5432];

/** One service instance in the mock world. */
export interface MockService {
	name: string;
	type: string;
	version: string;
	hostPort: number;
	persist: PersistMode;
	state: ServiceState;
	startedAt?: string;
	problem?: ServiceProblem;
	config: Record<string, string>;
	secrets: Record<string, string>;
	/** Seed file relative to the project root (stack entry `seed`). */
	seed?: string;
	cpu: number;
	memMb: number;
}

/** One project in the mock world. */
export interface MockProject {
	name: string;
	root: string;
	envFile?: string;
	services: MockService[];
}

type Listener = (message: ServerMessage) => void;

const hoursAgo = (h: number) =>
	new Date(Date.now() - h * 3_600_000).toISOString();

const secret = (seed: string) =>
	`${seed}-${Math.random().toString(36).slice(2, 10)}`;

const seedProjects = (): MockProject[] => [
	{
		name: "shop-api",
		root: "/Users/dev/Developer/shop-api",
		services: [
			{
				name: "main-db",
				type: "postgres",
				version: "17",
				hostPort: 5433,
				persist: "volume",
				state: "running",
				startedAt: hoursAgo(3),
				config: { POSTGRES_DB: "shop" },
				secrets: { POSTGRES_PASSWORD: secret("pg") },
				seed: "db/seed.sql",
				cpu: 1.8,
				memMb: 64,
			},
			{
				name: "events",
				type: "postgres",
				version: "16",
				hostPort: 5432,
				persist: "volume",
				state: "port-conflict",
				problem: {
					code: "PORT_CONFLICT",
					message:
						"Port 5432 is already in use by another process on this machine, so the container could not bind.",
					suggestedPort: 5434,
				},
				config: {},
				secrets: { POSTGRES_PASSWORD: secret("pg") },
				cpu: 0,
				memMb: 0,
			},
			{
				name: "cache",
				type: "redis",
				version: "7",
				hostPort: 6380,
				persist: "volume",
				state: "running",
				startedAt: hoursAgo(26),
				config: {},
				secrets: { REDIS_PASSWORD: secret("rd") },
				cpu: 0.4,
				memMb: 9,
			},
			{
				name: "rest",
				type: "upstash-redis",
				version: "latest",
				hostPort: 8080,
				persist: "ephemeral",
				state: "stopped",
				config: {},
				secrets: { SRH_TOKEN: secret("tok") },
				cpu: 0,
				memMb: 0,
			},
		],
	},
	{
		name: "blog",
		root: "/Users/dev/Developer/blog",
		envFile: ".env.local",
		services: [
			{
				name: "db",
				type: "mysql",
				version: "8.4",
				hostPort: 3307,
				persist: "volume",
				state: "stopped",
				config: {},
				secrets: { MYSQL_PASSWORD: secret("my") },
				cpu: 0,
				memMb: 0,
			},
		],
	},
	{ name: "scratch", root: "/Users/dev/Developer/scratch", services: [] },
];

const seedSnapshots = (): Map<string, Snapshot[]> =>
	new Map([
		[
			"shop-api/main-db",
			[
				{
					id: "s2",
					service: "main-db",
					name: "before-migration",
					sizeBytes: 48 * 1024 * 1024,
					createdAt: hoursAgo(2),
				},
				{
					id: "s1",
					service: "main-db",
					name: "clean-seed",
					sizeBytes: 12 * 1024 * 1024,
					createdAt: hoursAgo(27),
				},
			],
		],
	]);

const slug = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const upperName = (name: string) => name.toUpperCase().replace(/-/g, "_");

/** Mutable in-memory backend shared by the HTTP and WebSocket mock handlers. */
export class MockDb {
	projects: MockProject[] = seedProjects();
	readonly catalog: ServiceDefinition[] = MOCK_CATALOG;
	readonly ops = new Map<string, Progress[]>();
	/** Snapshots by `project/service`, newest first. */
	snapshots: Map<string, Snapshot[]> = seedSnapshots();
	readonly #listeners = new Set<Listener>();
	readonly #timers = new Set<ReturnType<typeof setTimeout>>();
	#opSeq = 0;

	/** Restores the seed data and cancels pending timers. */
	reset(): void {
		for (const t of this.#timers) clearTimeout(t);
		this.#timers.clear();
		this.projects = seedProjects();
		this.snapshots = seedSnapshots();
		this.ops.clear();
		this.#opSeq = 0;
	}

	/** Registers a WebSocket forwarder. */
	listen(listener: Listener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Sends a message to every connected mock socket. */
	emit(message: ServerMessage): void {
		for (const l of this.#listeners) l(message);
	}

	later(ms: number, fn: () => void): void {
		const t = setTimeout(() => {
			this.#timers.delete(t);
			fn();
		}, ms);
		this.#timers.add(t);
	}

	definition(type: string): ServiceDefinition | undefined {
		return this.catalog.find((d) => d.id === type);
	}

	project(name: string): MockProject | undefined {
		return this.projects.find((p) => p.name === name);
	}

	catalogListing(): CatalogListing {
		const categories = new Map<string, CatalogListing["categories"][number]>();
		for (const d of this.catalog) {
			const label =
				d.categoryLabel ?? d.category[0]?.toUpperCase() + d.category.slice(1);
			const id = slug(label);
			const current = categories.get(id);
			if (current) categories.set(id, { ...current, count: current.count + 1 });
			else categories.set(id, { id, label, category: d.category, count: 1 });
		}
		return { definitions: this.catalog, categories: [...categories.values()] };
	}

	containerId(project: string, service: string): string {
		return `c-${project}-${service}`;
	}

	/**
	 * A status row. Like the real server, CPU/MEM are only present when a
	 * fresh stats sample exists, i.e. while Live streams (`usage`); REST reads
	 * with Live off leave them out.
	 */
	status(p: MockProject, s: MockService, usage = true): ServiceStatus {
		const def = this.definition(s.type);
		const running = s.state === "running";
		return {
			name: s.name,
			type: s.type,
			version: s.version,
			image: (def?.image ?? `${s.type}:{{version}}`).replace(
				"{{version}}",
				s.version,
			),
			hostPort: s.hostPort,
			containerPort: def?.port.container ?? s.hostPort,
			containerName: `ls-${p.name}-${s.name}`,
			containerId: this.containerId(p.name, s.name),
			persist: s.persist,
			state: s.state,
			health: running
				? "healthy"
				: s.state === "starting"
					? "starting"
					: "none",
			...(running && s.startedAt ? { startedAt: s.startedAt } : {}),
			...(s.problem ? { problem: s.problem } : {}),
			...(running && usage
				? {
						cpuPercent: Math.max(0, s.cpu + (Math.random() - 0.5) * 0.6),
						memBytes: Math.round((s.memMb + Math.random() * 2) * 1024 * 1024),
					}
				: {}),
		};
	}

	projectStatus(p: MockProject, usage = true): ProjectStatus {
		return {
			project: p.name,
			network: `ls-${p.name}`,
			services: p.services.map((s) => this.status(p, s, usage)),
		};
	}

	summary(p: MockProject): ProjectSummary {
		// `GET /api/projects` carries no usage while nobody watches the project.
		const rows = p.services.map((s) => this.status(p, s, false));
		return {
			name: p.name,
			root: p.root,
			...(p.envFile ? { envFile: p.envFile } : {}),
			serviceCount: rows.length,
			running: rows.filter((r) => r.state === "running").length,
			errors: rows.filter(
				(r) => r.state === "port-conflict" || r.state === "error",
			).length,
			types: rows.map((r) => r.type),
		};
	}

	stack(p: MockProject): Stack {
		return {
			name: p.name,
			root: p.root,
			filePath: `${p.root}/locastack.yaml`,
			file: {
				version: 1,
				name: p.name,
				services: Object.fromEntries(
					p.services.map((s) => [
						s.name,
						{
							type: s.type,
							version: s.version,
							port: s.hostPort,
							persist: s.persist,
							...(Object.keys(s.config).length ? { config: s.config } : {}),
							...(s.seed ? { seed: s.seed } : {}),
						},
					]),
				),
				...(p.envFile ? { link: { file: p.envFile } } : {}),
			},
		};
	}

	effectiveConfig(p: MockProject, s: MockService): Record<string, string> {
		const def = this.definition(s.type);
		const out: Record<string, string> = {};
		for (const [key, value] of Object.entries(def?.config ?? {})) {
			out[key] =
				s.config[key] ??
				value.default
					.replace("{{stack.name}}", p.name)
					.replace("{{name}}", s.name);
		}
		return out;
	}

	detail(p: MockProject, s: MockService): ServiceDetail {
		const def = this.definition(s.type);
		return {
			...this.status(p, s, false),
			network: `ls-${p.name}`,
			config: this.effectiveConfig(p, s),
			secretNames: def?.secrets ?? [],
			volumes:
				s.persist === "volume"
					? (def?.volumes ?? []).map((v) => ({
							name: `ls-${p.name}-${s.name}-${v.name}`,
							source: v.name,
							path: v.path,
						}))
					: [],
		};
	}

	#render(
		p: MockProject,
		s: MockService,
		template: string,
		reveal: boolean,
	): string {
		const config = this.effectiveConfig(p, s);
		return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, path: string) => {
			if (path === "port") return String(s.hostPort);
			if (path === "version") return s.version;
			if (path === "name") return s.name;
			if (path === "stack.name") return p.name;
			if (path.startsWith("config.")) return config[path.slice(7)] ?? "";
			if (path.startsWith("secrets."))
				return reveal ? (s.secrets[path.slice(8)] ?? "") : MASKED;
			return "";
		});
	}

	/** Every exported variable of the project with final (collision-prefixed) keys. */
	exports(p: MockProject, reveal: boolean) {
		const seen = new Set<string>();
		const out: { key: string; value: string; service: string; type: string }[] =
			[];
		for (const s of p.services) {
			const def = this.definition(s.type);
			const keys = Object.keys(def?.exports ?? {});
			const collides = keys.some((k) => seen.has(k));
			for (const k of keys) {
				const key = collides ? `${upperName(s.name)}_${k}` : k;
				seen.add(key);
				out.push({
					key,
					value: this.#render(p, s, def?.exports[k] ?? "", reveal),
					service: s.name,
					type: s.type,
				});
			}
		}
		return out;
	}

	connection(p: MockProject, s: MockService, reveal: boolean): ConnectionInfo {
		const def = this.definition(s.type);
		const mine = this.exports(p, reveal).filter((e) => e.service === s.name);
		const primaryKey = def?.primaryExport ?? mine[0]?.key ?? "URL";
		const primary =
			mine.find(
				(e) => e.key === primaryKey || e.key.endsWith(`_${primaryKey}`),
			) ?? mine[0];
		const config = this.effectiveConfig(p, s);
		const details = [
			{ k: "Host", v: "127.0.0.1" },
			{ k: "Port", v: String(s.hostPort) },
			...Object.entries(config)
				.filter(([k]) => /USER|DB|DATABASE/.test(k))
				.map(([k, v]) => ({
					k: /USER/.test(k) ? "User" : "Database",
					v,
				})),
			...(def?.secrets ?? []).map((name) => ({
				k: "Secret",
				v: reveal ? (s.secrets[name] ?? "") : MASKED,
			})),
			{ k: "Container", v: `ls-${p.name}-${s.name}` },
		];
		const key = primary?.key ?? primaryKey;
		const snippets = def?.snippets ?? {};
		return {
			primary: { key, value: primary?.value ?? "" },
			exports: mine.map(({ key: k, value }) => ({ key: k, value })),
			details,
			snippets: {
				env: mine.map((e) => `${e.key}=${e.value}`).join("\n"),
				...(snippets.node
					? { node: snippets.node.replaceAll("KEY", key) }
					: {}),
				...(snippets.python
					? { python: snippets.python.replaceAll("KEY", key) }
					: {}),
				...(snippets.go ? { go: snippets.go.replaceAll("KEY", key) } : {}),
			},
		};
	}

	envPreview(
		p: MockProject,
		format: EnvPreview["format"],
		reveal: boolean,
	): EnvPreview {
		const lines = this.exports(p, reveal);
		let text: string;
		if (format === "json") {
			text = JSON.stringify(
				Object.fromEntries(lines.map((l) => [l.key, l.value])),
				null,
				2,
			);
		} else {
			const groups: string[] = [];
			for (const s of p.services) {
				const mine = lines.filter((l) => l.service === s.name);
				if (!mine.length) continue;
				groups.push(
					[
						`# ${s.name} (${s.type})`,
						...mine.map((l) =>
							format === "shell"
								? `export ${l.key}="${l.value}"`
								: `${l.key}=${l.value}`,
						),
					].join("\n"),
				);
			}
			text = groups.join("\n\n");
		}
		return {
			format,
			lines,
			text,
			serviceCount: p.services.length,
			file: p.envFile ?? ".env",
		};
	}

	/**
	 * The snapshot list of a service (created on first use).
	 *
	 * @param p - Project.
	 * @param s - Service.
	 * @returns The mutable list, newest first.
	 */
	snapshotsOf(p: MockProject, s: MockService): Snapshot[] {
		const key = `${p.name}/${s.name}`;
		const list = this.snapshots.get(key) ?? [];
		this.snapshots.set(key, list);
		return list;
	}

	/** Ports pinned by registered projects and bound by other processes. */
	portOwners(): MockPortOwners {
		return {
			pinned: new Map(
				this.projects.flatMap((p) =>
					p.services.map((s) => [s.hostPort, `${p.name}/${s.name}`] as const),
				),
			),
			busy: EXTERNAL_BUSY_PORTS,
		};
	}

	/** Mirrors the server's free-port rule: range start, never the default port. */
	freePortFor(definition: ServiceDefinition): number {
		const taken = new Set([
			definition.port.default,
			...EXTERNAL_BUSY_PORTS,
			...this.projects.flatMap((x) => x.services.map((s) => s.hostPort)),
		]);
		let port = definition.port.range[0];
		while (taken.has(port)) port += 1;
		return port;
	}

	nextFreePort(p: MockProject, from: number, skip?: MockService): number {
		const taken = new Set([
			...EXTERNAL_BUSY_PORTS,
			...this.projects.flatMap((x) =>
				x.services.filter((s) => s !== skip).map((s) => s.hostPort),
			),
		]);
		let port = from;
		while (taken.has(port)) port += 1;
		void p;
		return port;
	}

	#pushDelta(p: MockProject, s: MockService): void {
		this.emit({
			channel: `status:${p.name}`,
			type: "delta",
			payload: { services: [this.status(p, s)], removed: [] },
		});
	}

	/** Moves a service to a state and broadcasts the change. */
	setState(p: MockProject, s: MockService, state: ServiceState): void {
		s.state = state;
		if (state === "running") {
			s.startedAt = new Date().toISOString();
			const def = this.definition(s.type);
			s.cpu = def?.category === "database" ? 1.5 : 0.3;
			s.memMb = def?.category === "database" ? 58 : 8;
			s.problem = undefined;
		}
		if (state === "stopped") s.startedAt = undefined;
		if (state === "port-conflict") {
			s.problem = {
				code: "PORT_CONFLICT",
				message: `Port ${s.hostPort} is already in use by another process on this machine, so the container could not bind.`,
				suggestedPort: this.nextFreePort(p, s.hostPort + 1, s),
			};
		}
		this.#pushDelta(p, s);
	}

	/**
	 * Runs a scripted op: emits its steps on `op:<id>` (buffered for replay).
	 *
	 * @param steps - Messages, delays and side effects.
	 * @returns The op id.
	 */
	runOp(
		steps: {
			message: string;
			delay: number;
			percent?: number;
			service?: string;
			run?: () => Progress["error"] | undefined;
		}[],
		doneMessage: string,
		beforeDone?: () => void,
	): string {
		this.#opSeq += 1;
		const opId = `op${this.#opSeq}${Math.random().toString(36).slice(2, 6)}`;
		this.ops.set(opId, []);
		const push = (event: Progress) => {
			const withMeta = { ...event, opId, at: new Date().toISOString() };
			this.ops.get(opId)?.push(withMeta);
			this.emit({ channel: `op:${opId}`, type: "progress", payload: withMeta });
		};
		let elapsed = 0;
		let failed = false;
		for (const step of steps) {
			elapsed += step.delay;
			this.later(elapsed, () => {
				if (failed) return;
				const error = step.run?.();
				if (error) {
					failed = true;
					push({
						kind: "error",
						message: error.message,
						error,
						service: step.service,
					});
					return;
				}
				push({
					kind: "step",
					message: step.message,
					service: step.service,
					...(step.percent === undefined ? {} : { percent: step.percent }),
				});
			});
		}
		this.later(elapsed + 250, () => {
			if (failed) return;
			beforeDone?.();
			push({ kind: "done", message: doneMessage });
		});
		return opId;
	}

	/** Start script for one service (conflicts when its port is externally busy). */
	startSteps(p: MockProject, s: MockService) {
		return [
			{
				message: `Creating container ls-${p.name}-${s.name}`,
				delay: 150,
				percent: 20,
				service: s.name,
				run: () => {
					this.setState(p, s, "starting");
					return undefined;
				},
			},
			{
				message: "Waiting for the healthcheck",
				delay: 700,
				percent: 70,
				service: s.name,
				run: () => {
					if (EXTERNAL_BUSY_PORTS.includes(s.hostPort)) {
						this.setState(p, s, "port-conflict");
						return {
							code: "PORT_CONFLICT",
							message: s.problem?.message ?? "Port in use",
							details: {
								port: s.hostPort,
								suggestedPort: s.problem?.suggestedPort,
							},
						};
					}
					return undefined;
				},
			},
			{
				message: `${s.name} is healthy`,
				delay: 700,
				percent: 100,
				service: s.name,
				run: () => {
					this.setState(p, s, "running");
					return undefined;
				},
			},
		];
	}

	stopSteps(p: MockProject, s: MockService) {
		return [
			{
				message: `Stopping ls-${p.name}-${s.name}`,
				delay: 400,
				service: s.name,
				run: () => {
					this.setState(p, s, "stopped");
					return undefined;
				},
			},
		];
	}

	/**
	 * One plausible stats sample of a running service.
	 *
	 * @param s - Service.
	 * @returns The sample, or `undefined` when it is not running.
	 */
	statsSample(s: MockService): StatsBatch["samples"][number] | undefined {
		if (s.state !== "running") return undefined;
		return {
			cpuPercent: Math.max(0.05, s.cpu + (Math.random() - 0.5) * 1.2),
			memBytes: Math.round((s.memMb + Math.random() * 3) * 1024 * 1024),
			memLimitBytes: 1024 * 1024 * 1024,
			netRx: Math.round(Math.random() * 1e6),
			netTx: Math.round(Math.random() * 1e6),
			at: new Date().toISOString(),
		};
	}

	/** Deterministic-looking log lines for a container. */
	logLines(
		type: string,
		count: number,
	): { stream: "stdout" | "stderr"; text: string; at: string }[] {
		const pg = [
			"LOG:  starting PostgreSQL 17.2 on aarch64-unknown-linux-musl",
			'LOG:  listening on IPv4 address "0.0.0.0", port 5432',
			"LOG:  database system was shut down at 2026-09-23 09:12:01 UTC",
			"LOG:  database system is ready to accept connections",
			"WARNING:  checkpoints are occurring too frequently (24 seconds apart)",
			"LOG:  checkpoint complete: wrote 42 buffers (0.3%)",
		];
		const redis = [
			"1:C * Redis version=7.4.1, bits=64, commit=00000000",
			"1:M * Server initialized",
			"1:M * \u001b[32mReady to accept connections tcp\u001b[0m",
			"1:M # WARNING Memory overcommit must be enabled!",
			"1:M * 1 changes in 3600 seconds. Saving...",
			"1:M * Background saving terminated with success",
		];
		const source =
			type === "postgres"
				? pg
				: type === "redis"
					? redis
					: [
							"INFO  server starting",
							"INFO  listening on :80",
							"WARN  slow request 820ms GET /health",
							"INFO  request handled",
						];
		const now = Date.now();
		return Array.from({ length: count }, (_, i) => ({
			stream: (source[i % source.length] ?? "").includes("WARN")
				? "stderr"
				: "stdout",
			text: source[i % source.length] ?? "",
			at: new Date(now - (count - i) * 1500).toISOString(),
		}));
	}
}

/** The shared mock backend. */
export const mockDb = new MockDb();
