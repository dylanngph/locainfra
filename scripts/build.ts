#!/usr/bin/env bun
/**
 * Builds the standalone `locainfra` executable for the current platform into
 * `dist/locainfra` and prints its size.
 *
 * Usage: `bun run scripts/build.ts` (works from any directory).
 *
 * Not yet done (plan §5): `vite build` of the dashboard + `--asset` embedding
 * (M2), the cross-platform target matrix, and the CI size gate.
 *
 * @packageDocumentation
 */
import { mkdir } from "node:fs/promises";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const entry = join(root, "packages/cli/src/index.ts");
const outDir = join(root, "dist");
const outfile = join(outDir, "locainfra");

await mkdir(outDir, { recursive: true });

const started = performance.now();
let result: Awaited<ReturnType<typeof Bun.build>>;
try {
	result = await Bun.build({
		entrypoints: [entry],
		compile: {
			// No `target`: build for the platform running this script.
			outfile,
			// The binary runs inside users' project folders; autoloading would read
			// (and could leak) their `.env` / `bunfig.toml`.
			autoloadDotenv: false,
			autoloadBunfig: false,
		},
		minify: { whitespace: true, syntax: true },
		define: { "process.env.NODE_ENV": JSON.stringify("production") },
	});
} catch (error) {
	// Bun.build rejects (AggregateError) on resolve/parse failures.
	console.error(error);
	console.error("build failed");
	process.exit(1);
}

if (!result.success) {
	for (const log of result.logs) console.error(log);
	console.error("build failed");
	process.exit(1);
}

const bytes = Bun.file(outfile).size;
const mib = (bytes / 1024 / 1024).toFixed(1);
const ms = Math.round(performance.now() - started);
console.log(
	`built ${relative(process.cwd(), outfile) || outfile}: ${mib} MiB (${bytes} bytes) in ${ms} ms`,
);
