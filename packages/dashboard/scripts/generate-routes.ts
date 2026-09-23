/**
 * Generates `src/routeTree.gen.ts` without starting Vite.
 *
 * The TanStack Router Vite plugin writes the route tree in its
 * `configResolved` hook, so resolving the Vite config is enough. `typecheck`
 * runs this first because `src/main.tsx` imports the generated file, which is
 * git-ignored. `dev`, `build` and `test` generate it on their own.
 */
import { resolveConfig } from "vite";

await resolveConfig(
	{ configFile: "vite.config.ts", logLevel: "warn" },
	"build",
);
