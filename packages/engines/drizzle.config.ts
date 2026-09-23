import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit config for the machine-local state database (ADR 0008).
 * `bunx drizzle-kit generate` (from `packages/engines`) writes migrations to
 * `./drizzle`, which is committed and embedded in the compiled binary.
 */
export default defineConfig({
	dialect: "sqlite",
	schema: "./src/state/sqlite/schema.ts",
	out: "./drizzle",
});
