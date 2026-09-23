/**
 * Writes the published JSON Schemas to the repo-root `schema/` folder and
 * formats them with Biome (the repo formatter).
 *
 * Usage: `bun packages/core/scripts/emit-schemas.ts` (add `--check` to exit 1
 * instead of writing when a committed file differs semantically, e.g. in CI).
 */
import { deepStrictEqual } from "node:assert";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { serviceJsonSchema } from "../src/catalog/catalog.schema";
import { stackJsonSchema } from "../src/stack/stack.schema";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const schemaDir = join(repoRoot, "schema");
const outputs: ReadonlyArray<readonly [string, string]> = [
	["stack.v1.json", stackJsonSchema],
	["service.v1.json", serviceJsonSchema],
];
const check = process.argv.includes("--check");

function sameJson(a: string, b: string): boolean {
	try {
		deepStrictEqual(JSON.parse(a), JSON.parse(b));
		return true;
	} catch {
		return false;
	}
}

await mkdir(schemaDir, { recursive: true });
const written: string[] = [];
let stale = 0;
for (const [name, content] of outputs) {
	const path = join(schemaDir, name);
	const file = Bun.file(path);
	const current = (await file.exists()) ? await file.text() : null;
	if (current !== null && sameJson(current, content)) continue;
	if (check) {
		console.error(
			`stale: ${path} (run bun packages/core/scripts/emit-schemas.ts)`,
		);
		stale++;
		continue;
	}
	await Bun.write(path, content);
	written.push(path);
	console.log(`wrote ${path}`);
}
if (written.length > 0) {
	const format = Bun.spawnSync(
		["bunx", "biome", "format", "--write", ...written],
		{
			cwd: repoRoot,
			stdout: "ignore",
			stderr: "inherit",
		},
	);
	if (format.exitCode !== 0) process.exit(format.exitCode ?? 1);
}
if (stale > 0) process.exit(1);
