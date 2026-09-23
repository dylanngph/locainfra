/** Prefix shared by every Docker label LocaInfra sets. */
export const LABEL_PREFIX = "locainfra.";

/** Label carrying the project (stack) name on containers, volumes and networks. */
export const LABEL_STACK = "locainfra.stack";

/**
 * Label carrying the service instance name (the compose service key) on
 * containers and volumes. Kept next to {@link LABEL_INSTANCE} for containers
 * created before named instances existed.
 */
export const LABEL_SERVICE = "locainfra.service";

/** Label carrying the service instance name (e.g. `main-db`) on containers and volumes. */
export const LABEL_INSTANCE = "locainfra.instance";

/** Label carrying the catalog definition id (e.g. `postgres`) on containers and volumes. */
export const LABEL_TYPE = "locainfra.type";

/** Label carrying the catalog definition id on containers (same value as {@link LABEL_TYPE}). */
export const LABEL_CATALOG_ID = "locainfra.catalog-id";

/** Label carrying the selected service version on containers. */
export const LABEL_VERSION = "locainfra.version";
