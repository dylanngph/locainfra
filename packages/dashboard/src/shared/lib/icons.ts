import {
	siMinio,
	siMongodb,
	siMysql,
	siPostgresql,
	siRabbitmq,
	siRedis,
	siUpstash,
} from "simple-icons";

/** A bundled brand mark: 24×24 SVG path plus the brand color from the design brief. */
export interface BrandMark {
	/** SVG path data in a `0 0 24 24` viewBox, or `null` for the generic fallback. */
	readonly path: string | null;
	/** Brand color (`#rrggbb`). */
	readonly color: string;
	/** Accessible title. */
	readonly title: string;
}

const mark = (
	icon: { path: string; title: string },
	color: string,
): BrandMark => ({ path: icon.path, color, title: icon.title });

const POSTGRES = mark(siPostgresql, "#4169E1");
const MYSQL = mark(siMysql, "#0B7FA8");
const MONGODB = mark(siMongodb, "#47A248");
const MINIO = mark(siMinio, "#E0A800");
const REDIS = mark(siRedis, "#DC382D");
const UPSTASH = mark(siUpstash, "#00C98D");
const RABBITMQ = mark(siRabbitmq, "#FF6600");

/** Neutral mark for services without a bundled brand icon. */
export const FALLBACK_MARK: BrandMark = {
	path: null,
	color: "#737373",
	title: "Service",
};

const MARKS: Readonly<Record<string, BrandMark>> = {
	postgres: POSTGRES,
	postgresql: POSTGRES,
	mysql: MYSQL,
	mariadb: MYSQL,
	mongodb: MONGODB,
	mongo: MONGODB,
	minio: MINIO,
	s3: MINIO,
	redis: REDIS,
	upstash: UPSTASH,
	"upstash-redis": UPSTASH,
	rabbitmq: RABBITMQ,
};

/**
 * Brand mark of a service: the catalog `icon` wins, then the catalog id.
 * Icons are bundled from simple-icons; nothing is fetched at runtime.
 *
 * @param type - Catalog id (e.g. `postgres`, `upstash-redis`).
 * @param icon - Catalog `icon` field, when known.
 * @returns The mark (the neutral fallback for unknown services).
 */
export function brandMark(type: string, icon?: string): BrandMark {
	return (icon && MARKS[icon]) || MARKS[type] || FALLBACK_MARK;
}
