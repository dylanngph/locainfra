# LocaStack

Dashboard-first tool for local Docker dev services. Bun workspaces monorepo: `packages/{core,engines,server,dashboard,cli}`. Architecture: `docs/architecture.md`; decisions: `docs/adr/`.

## Commands
- `bun run dev` — Bun's workspace runner (`bun run --filter '*' dev`) starts the server via the CLI (`bun --watch`, port 4488) and Vite (5173, HMR) together. Dev-only env comes from `.env.development` (fixed session token, allowed Vite hosts; Vite reads `VITE_LOCASTACK_TOKEN` via `envDir` = repo root, so no `?t=` is needed on 5173). `bun run dev:ui` runs the dashboard alone against MSW mocks.
- `bun run cli -- <args>` runs the CLI from source; `bun run build` compiles `dist/locastack`; `bun run build:targets` the six release targets; `bun run e2e` runs the Playwright smokes (`LOCASTACK_E2E=1 LOCASTACK_E2E_CHANNEL=chrome`); `bun test npm` covers install.sh and the npm launcher.
- Releases: `bun run release:version` (changesets) → commit → `bun run release:tag` → push the tag; see docs/release.md. CI: `.github/workflows/ci.yml` (lint/typecheck/tests + binary size and startup budgets), `release.yml` on `v*` tags, `e2e.yml` nightly.

- `bun install` — only at the repo root.
- `bun add <dep>` / `bun add -d <dep>` — only inside the target package directory. Never hand-edit dependencies in `package.json`.
- `bun run test` — all packages (`bun test` per package; Vitest in `dashboard`).
- `bun run typecheck` — `tsc --noEmit` in every package.
- `bun run lint` — `biome check .` (`bun run format` to write).
- Single package: `cd packages/<pkg> && bun test && bunx tsc --noEmit`.

## Rules

- **Core never imports engines.** Ops depend on `packages/core/src/ports/*`; concrete engines are wired only in `packages/cli/src/composition.ts` and `packages/server/src/app.ts`.
- **One op per file** in `packages/core/src/ops/` (`<name>.op.ts`), typed by `ops.contract.ts`. Long ops return `AsyncIterable<Progress>`, others `Result<T, OpError>`.
- **Server MVC**: `modules/<feature>/{index.ts, <feature>.service.ts, <feature>.model.ts, __tests__/}`. Controllers route only; services are classes with no Elysia import; models are TypeBox + custom errors. Plugins have a `name`.
- **TypeBox only** (`@sinclair/typebox`, or Elysia's `t` in server). No zod.
- **No default exports** (unless a framework requires it). **No `any`.** **TSDoc on every exported symbol.**
- Feature-scoped folders; tests in `__tests__/` next to the code.
- **Tests per runner**: `bun test` for core/engines/server/cli; Vitest + Testing Library + happy-dom + MSW for dashboard.
- **Bind `127.0.0.1` only.** Never log secrets.
- **Deps allowlist**: core/cli `commander`, `@commander-js/extra-typings`, `@clack/prompts`, `ansis`, `yaml`, `@sinclair/typebox`; server `elysia`, `@elysiajs/eden`. Anything else needs an ADR.
- Every user-visible change needs a changeset (`bunx changeset`).
- Subagents and workflows always run on Opus.
