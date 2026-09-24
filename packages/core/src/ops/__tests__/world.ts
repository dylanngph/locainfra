import type {
	ContainerDetails,
	ContainerSummary,
} from "../../ports/docker.port";
import type { StateFile } from "../../ports/state.port";
import { builtinTestDefinitions } from "../../testing/catalog-fixtures";
import {
	FakeSnapshotIndex,
	FakeVolumeArchiver,
} from "../../testing/data-fakes";
import {
	createTestPaths,
	FakeComposeInfo,
	FakeContainerInspector,
	FakeContainerReader,
	FakeDockerInfo,
	FakeLifecycleRunner,
	FakePortProbe,
	FixedClock,
	InMemoryFileStore,
	InMemorySecretStore,
	InMemoryStateStore,
	SequentialSecretGenerator,
	StaticCatalogSource,
} from "../../testing/fakes";

/** Folder of the test project. */
export const SHOP_ROOT = "/work/shop";
/** Its stack file. */
export const SHOP_FILE = `${SHOP_ROOT}/locastack.yaml`;
/** Rendered compose file of the test project. */
export const SHOP_COMPOSE =
	"/home/test/.locastack/stacks/shop/docker-compose.yml";

/** A commented stack with two postgres instances, a redis and an Upstash proxy. */
export const SHOP_YAML = `# shop services
version: 1
name: shop
services:
  main-db: { type: postgres, config: { POSTGRES_DB: shop } } # primary
  events: { type: postgres, persist: ephemeral }
  cache: { type: redis }
  rest: { type: upstash-redis, uses: { redis: cache } }
link:
  names: { cache: REDIS_URL }
`;

/** Pinned ports of every service of {@link SHOP_YAML}. */
export const SHOP_PORTS = {
	"main-db": 5433,
	events: 5434,
	cache: 6380,
	rest: 8080,
};

/** Stored secrets of every service of {@link SHOP_YAML}. */
export const SHOP_SECRETS = {
	MAIN_DB__POSTGRES_PASSWORD: "main-db-password-0001",
	EVENTS__POSTGRES_PASSWORD: "events-password-00002",
	CACHE__REDIS_PASSWORD: "cache-password-000003",
	REST__SRH_TOKEN: "rest-token-0000000004",
};

/** Options of {@link createWorld}. */
export interface WorldOptions {
	/** Stack file text (default {@link SHOP_YAML}); `null` = no file. */
	readonly yaml?: string | null;
	/** Pin ports and store secrets as if the project had been started. */
	readonly provisioned?: boolean;
	/** Also write the rendered compose file. */
	readonly rendered?: boolean;
	/** Ports reported busy. */
	readonly busy?: readonly number[];
}

/**
 * Every fake port wired for the registered project `shop` at {@link SHOP_ROOT}.
 *
 * @param options - Stack text and provisioning.
 * @returns The fakes (pass as op deps).
 */
export function createWorld(options: WorldOptions = {}) {
	const yaml = options.yaml === undefined ? SHOP_YAML : options.yaml;
	const files = new InMemoryFileStore(
		yaml === null ? {} : { [SHOP_FILE]: yaml },
	);
	if (options.rendered) files.files.set(SHOP_COMPOSE, "# compose\n");
	const initial: StateFile = {
		projects: [{ name: "shop", root: SHOP_ROOT }],
		stacks: options.provisioned
			? {
					shop: { ports: { ...SHOP_PORTS }, createdAt: "2026-01-01T00:00:00Z" },
				}
			: {},
	};
	return {
		files,
		state: new InMemoryStateStore(initial),
		secrets: new InMemorySecretStore(
			options.provisioned ? { shop: { ...SHOP_SECRETS } } : {},
		),
		probe: new FakePortProbe(options.busy ?? []),
		gen: new SequentialSecretGenerator(),
		clock: new FixedClock("2026-09-23T08:00:00.000Z"),
		paths: createTestPaths(),
		catalog: new StaticCatalogSource([...builtinTestDefinitions]),
		lifecycle: new FakeLifecycleRunner(),
		compose: new FakeComposeInfo("2.40.0"),
		containers: new FakeContainerReader(),
		inspector: new FakeContainerInspector(),
		docker: new FakeDockerInfo(),
		archiver: new FakeVolumeArchiver(),
		snapshots: new FakeSnapshotIndex(),
	};
}

/** A test world. */
export type World = ReturnType<typeof createWorld>;

/**
 * Adds a container of a shop service to the fake reader and inspector.
 *
 * @param world - The world.
 * @param service - Instance name.
 * @param details - Inspect fields to override (state, health, exitCode, error…).
 * @returns The container summary.
 */
export function addContainer(
	world: World,
	service: string,
	details: Partial<ContainerDetails> = {},
): ContainerSummary {
	const labels = {
		"locastack.stack": "shop",
		"locastack.service": service,
		"locastack.instance": service,
	};
	const summary: ContainerSummary = {
		id: `id-${service}`,
		name: `ls-shop-${service}`,
		image: "img",
		state: details.state ?? "running",
		...(details.health !== undefined && { health: details.health }),
		labels,
		ports: [],
	};
	world.containers.containers.push(summary);
	world.inspector.containers.push({
		id: summary.id,
		name: summary.name,
		image: "img",
		state: summary.state,
		labels,
		ports: [],
		...details,
	});
	return summary;
}
