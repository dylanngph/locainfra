# Architecture

LocaInfra is a dashboard-first tool for local Docker dev services. Running `locainfra` starts a localhost dashboard; a tiny CLI (`up`, `down`, `env`, `doctor`) serves scripts and CI. Both are clients of the same **Operations** layer.

## Layers

```
┌───────────────────────────────────────────────────────────────────┐
│  Dashboard SPA (React + Vite, Eden client)        Minimal CLI      │
├───────────────────────────────────────────────────────────────────┤
│  Server: Elysia on Bun.serve — REST + WebSocket, embedded SPA      │
├───────────────────────────────────────────────────────────────────┤
│  Operations (use-cases): upStack, downStack, envForStack, doctor … │
├───────────────────────────────────────────────────────────────────┤
│  Core (pure TS, no I/O): catalog, stack, resolve, render, env,     │
│  ports (interfaces)                                                │
├───────────────────────────────────────────────────────────────────┤
│  Engines (adapters implementing ports): state, compose, docker,    │
│  registry, port probe, files, secrets                              │
└───────────────────────────────────────────────────────────────────┘
```

Data flow: `Catalog (YAML) → Stack (locainfra.yaml / global.yaml) → ResolvedStack → docker-compose.yml → containers`.

## Packages

| Package | Path | Role | Test runner |
|---|---|---|---|
| `@locainfra/core` | `packages/core` | Models (TypeBox), ports, ops (use-cases), pure logic. No engine imports. | `bun test` |
| `@locainfra/engines` | `packages/engines` | Adapters implementing core ports: StateStore, ComposeRunner, DockerClient (Engine API over the socket), registry fetcher, port probe. | `bun test` |
| `@locainfra/server` | `packages/server` | Elysia app: feature modules (MVC), WebSocket observer, auth guard, embedded SPA. Exports `App` for Eden. | `bun test` |
| `@locainfra/dashboard` | `packages/dashboard` | React + Vite SPA (TanStack Router/Query, shadcn). Build-time deps only. | Vitest |
| `@locainfra/cli` | `packages/cli` | commander entry + `composition.ts`; default command starts the server and opens the browser. | `bun test` |

## Ports (hexagonal interfaces)

Defined in `packages/core/src/ports/`, each narrow (ISP). Ops declare only the slices they need.

| Port | File | Purpose |
|---|---|---|
| `DockerInfoPort`, `ContainerReader`, `SocketLocator` | `docker.port.ts` | Engine API read side and socket discovery |
| `ComposeInfoPort`, `LifecycleRunner` | `compose.port.ts` | `docker compose` version and up/down/ps |
| `StateReader`, `StateWriter` | `state.port.ts` | `~/.locainfra/state.json` |
| `SecretStore` | `secrets.port.ts` | `~/.locainfra/secrets/<stack>.env` (0600) |
| `FileStore` (with an optional `mode` for secret files), `DirectoryLister`, `PortProbe`, `Clock`, `SecretGenerator` | `files.port.ts` | Small I/O and determinism seams |
| `Paths` | `paths.port.ts` | Resolved directory layout |
| `CatalogSource` | `catalog/catalog.source.ts` | Merged catalog (built-ins → registry → overrides) |

Op signatures live in `packages/core/src/ops/ops.contract.ts`. Long-running ops return `AsyncIterable<Progress>` (an `error` event carries a serializable `ProgressError`: code, message, details such as a `fix` hint); others return `Result<T, OpError>`.

## Rules

1. **Core never imports engines.** Ops depend on ports; concrete engines are wired only in composition roots (`packages/cli/src/composition.ts`, `packages/server/src/app.ts`).
2. **One op per file** in `packages/core/src/ops/` (`up-stack.op.ts`, …). Server routes and CLI commands are thin wrappers over ops, so every feature exists once.
3. **Feature-scoped folders** in every package, tests in `__tests__/` next to the code.
4. **Server MVC** per feature: `modules/<feature>/{index.ts (controller), <feature>.service.ts, <feature>.model.ts}`. Controllers route only; services are plain classes without Elysia imports; models are TypeBox schemas plus custom errors. Named plugins for cross-cutting concerns.
5. **TypeBox everywhere** (API models, stack files, catalog YAML, state). No zod.
6. **Result-style returns** at op boundaries; typed error classes live in the owning model file (`OpError`, `CatalogError`, `StackError`).
7. **No default exports** (except where a framework requires one), **no `any`**, **TSDoc on every exported symbol**.
8. **Safety:** all ports and the dashboard bind `127.0.0.1`; the dashboard requires a per-session token and validates `Host`/`Origin`; secrets are 0600 and never logged; destructive actions need explicit confirmation.
9. **Weight:** runtime deps allowlist (core/CLI: `commander`, `@clack/prompts`, `ansis`, `yaml`, `@sinclair/typebox`; server: `elysia`). Plain CLI commands never load Elysia or the SPA.
10. **SOLID** in practice: single-purpose files; new services are YAML (open/closed); fakes are substitutable behind ports (shared contract tests); narrow ports; dependency inversion via composition roots.

## Decisions

See [`adr/`](./adr) for the recorded decisions.
