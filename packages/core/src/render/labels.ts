/** Prefix shared by every Docker label LocaInfra sets. */
export const LABEL_PREFIX = "locainfra.";

/** Label carrying the stack name on containers, volumes and networks. */
export const LABEL_STACK = "locainfra.stack";

/** Label carrying the service key (compose service name) on containers and volumes. */
export const LABEL_SERVICE = "locainfra.service";

/** Label carrying the catalog definition id on containers. */
export const LABEL_CATALOG_ID = "locainfra.catalog-id";

/** Label carrying the selected service version on containers. */
export const LABEL_VERSION = "locainfra.version";
