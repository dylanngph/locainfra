import {
	ConnectionInfo,
	LogLine,
	PersistMode,
	ResourceName,
	RotateSecretOptions,
	SecretValues,
	SeedPath,
	ServiceDataKind,
	ServiceDetail,
	ServicePatch,
	StatsSample,
} from "@locainfra/core";
import { t } from "elysia";

/**
 * Data tab capability of a service instance, from its catalog definition's
 * `data` block: the dashboard shows the Data tab unless `kind` is `none`.
 */
export const DataCapability = t.Object(
	{
		kind: ServiceDataKind,
		label: t.Optional(
			t.String({
				description:
					"Heading of the object list, e.g. Tables or Key patterns (absent when kind is none)",
			}),
		),
	},
	{
		description:
			"Data tab capability: kind none (no data block, or a type missing from the catalog) hides the tab",
	},
);
/** Data tab capability of a service instance. */
export type DataCapability = typeof DataCapability.static;

/** `GET …/services/:name` (and each row of `GET …/services`): the core detail plus the Data tab capability. */
export const ServiceView = t.Composite([
	ServiceDetail,
	t.Object({ data: DataCapability }),
]);
/** A service instance as the services routes return it. */
export type ServiceView = typeof ServiceView.static;

/** `POST /api/projects/:project/services` body (the Config screen's "Add & start"). */
export const AddServiceBody = t.Object({
	name: ResourceName,
	type: t.String({ description: "Catalog id, e.g. postgres" }),
	version: t.Optional(
		t.String({ description: "Default: the definition's defaultVersion" }),
	),
	port: t.Optional(
		t.Union([t.Integer({ minimum: 1, maximum: 65535 }), t.Literal("auto")], {
			description: "Host port on 127.0.0.1; auto (default) allocates one",
		}),
	),
	persist: t.Optional(PersistMode),
	config: t.Optional(
		t.Record(t.String(), t.String(), {
			description: "Overrides of the definition's config keys",
		}),
	),
	secrets: t.Optional(SecretValues),
	seed: t.Optional(SeedPath),
});
/** `POST /api/projects/:project/services` body. */
export type AddServiceBody = typeof AddServiceBody.static;

/** `DELETE /api/projects/:project/services/:name` query. */
export const RemoveServiceQuery = t.Object({
	volumes: t.Optional(
		t.Boolean({
			description:
				"Also delete the service's named volumes (destructive; the UI asks for typed confirmation)",
		}),
	),
});
/** `DELETE /api/projects/:project/services/:name` query. */
export type RemoveServiceQuery = typeof RemoveServiceQuery.static;

/** `GET /api/projects/:project/services/:name/connection` query. */
export const ConnectionQuery = t.Object({
	reveal: t.Optional(
		t.Boolean({
			default: false,
			description: "Include secret values (masked as •••••••• otherwise)",
		}),
	),
});
/** `GET …/connection` query. */
export type ConnectionQuery = typeof ConnectionQuery.static;

/** Largest `tail` accepted by the logs route (same bound as the `logs:` channel). */
export const MAX_LOG_TAIL = 5000;

/** Lines returned by the logs route when `tail` is omitted. */
export const DEFAULT_LOG_TAIL = 200;

/** `GET /api/projects/:project/services/:name/logs` query. */
export const LogTailQuery = t.Object({
	tail: t.Optional(
		t.Integer({
			minimum: 0,
			maximum: MAX_LOG_TAIL,
			default: DEFAULT_LOG_TAIL,
			description: "Trailing lines to return (default 200)",
		}),
	),
});
/** `GET …/logs` query. */
export type LogTailQuery = typeof LogTailQuery.static;

/** `GET /api/projects/:project/services/:name/logs` response: a one-shot tail, never followed. */
export const LogTail = t.Object({
	lines: t.Array(LogLine, {
		description: "Oldest first; empty when the service has no container",
	}),
});
/** `GET …/logs` response. */
export type LogTail = typeof LogTail.static;

/** `GET /api/projects/:project/services/:name/stats` response: one reading, never streamed. */
export const StatsReading = t.Object({
	samples: t.Array(StatsSample, {
		description:
			"At most one sample (the latest); empty when the service is not running",
	}),
});
/** `GET …/stats` response. */
export type StatsReading = typeof StatsReading.static;

/** Path params of `PATCH /api/projects/:project/services/:name/secrets/:key/rotate`. */
export const SecretKeyParams = t.Object({
	project: ResourceName,
	name: ResourceName,
	key: t.String({
		pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
		description: "Catalog secret name, e.g. POSTGRES_PASSWORD",
	}),
});
/** Path params naming one secret of a service instance. */
export type SecretKeyParams = typeof SecretKeyParams.static;

/** `PATCH …/secrets/:key/rotate` body (both flags needed to rotate a bakedIntoVolume secret of a volume-backed service). */
export const RotateSecretBody = RotateSecretOptions;
/** `PATCH …/secrets/:key/rotate` body. */
export type RotateSecretBody = typeof RotateSecretBody.static;

/** Reference models of the services controller, registered under `Services.`. */
export const ServicesModel = {
	list: t.Array(ServiceView),
	detail: ServiceView,
	add: AddServiceBody,
	patch: ServicePatch,
	removeQuery: RemoveServiceQuery,
	connectionQuery: ConnectionQuery,
	connection: ConnectionInfo,
	logTailQuery: LogTailQuery,
	logTail: LogTail,
	statsReading: StatsReading,
	secretKeyParams: SecretKeyParams,
	rotateSecret: RotateSecretBody,
};
