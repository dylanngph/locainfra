# 6. Bun workspaces monorepo with five packages

- Status: accepted
- Date: 2026-09-23

## Context and Problem Statement

The product has a pure core, I/O adapters, an HTTP server, a React SPA and a CLI, with shared types for Eden.

## Considered Options

- Single package
- Bun workspaces with 5 packages
- Turborepo/Nx monorepo

## Decision Outcome

Chosen option: **Bun workspaces** (`packages/*`, single `bun.lock`) with `core`, `engines`, `server`, `dashboard`, `cli`, linked via `workspace:*`. No Turborepo/Nx at this size.

### Consequences

- Good: separate toolchains per side, enforced layering (core never imports engines), shared types.
- Good: one install at the root; `bun run --filter` for scripts.
- Bad: dependencies must be added per package with `bun add` inside that package.
- The `npm/` release folder stays outside the workspace.
