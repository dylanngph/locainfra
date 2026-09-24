# Contributing to LocaStack

Thanks for helping. This page is the short version; `docs/architecture.md` and `docs/adr/` hold the reasoning.

## Setup

- Bun 1.4.2 (see `.bun-version`) and Docker Desktop or Docker Engine 24+ with Compose 2.24+.
- `bun install` once at the repo root. Add dependencies with `bun add` inside the package that needs them, never by editing `package.json` by hand.
- `bun run dev` starts the server (watch mode, port 4488) and the Vite dashboard (port 5173) together.
- `bun run test && bun run typecheck && bun run lint` must pass before you open a pull request. `bun test npm` covers the installer and the npm launcher.
- `LOCASTACK_E2E=1 LOCASTACK_E2E_CHANNEL=chrome bun run e2e` runs the browser smokes against real Docker.

## How the code is organised

- Five workspace packages: `core` (pure logic and the port interfaces), `engines` (Docker, Compose, SQLite adapters), `server` (Elysia API and WebSocket observer), `dashboard` (React + Vite), `cli`.
- Feature folders, no barrel files except a package's `index.ts` (ADR 0007).
- Server modules follow Elysia's MVC guidance: the controller is the Elysia instance, services are plain classes, models are TypeBox schemas (ADR 0003).
- `core` never imports `engines`; adapters are wired in two composition roots (`cli/src/composition.ts` and the server's `createApp`).
- `bun test` in Bun packages, Vitest in the dashboard (ADR 0005). Tests live next to the code in `__tests__/`.
- Everything binds to `127.0.0.1`. Tests never touch the developer's own projects or ports.

## Making a change

1. Branch from `main`, use Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`).
2. Add a changeset for any user-facing change: `bunx changeset`. Bug fixes with a regression test are always welcome.
3. Update docs when behaviour changes (`docs/api.md`, `docs/architecture.md`, a new ADR for a design decision).
4. Open a pull request; the template has the checklist. CI runs lint, typecheck, tests, a binary build and the size and startup budgets.

## Adding a service to the catalog

Catalog entries are YAML files under `catalog/`, validated against `schema/service.v1.json`. Copy an existing one, keep host ports on `127.0.0.1`, and open a pull request. The public registry for community services arrives in a later milestone.
