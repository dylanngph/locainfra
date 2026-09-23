# 7. No feature barrels; shared primitives live in `core/src/shared`

- Status: accepted
- Date: 2026-09-23

## Context and Problem Statement

Plan §8.2 asks for `noExplicitAny`, `useImportType` and `noBarrelFile`. Core had one `index.ts` barrel per feature, and the op-boundary primitives (`Result`, `OpError`, `Progress`, version and YAML helpers) lived in `ops/`, so every feature (and even `ports/`) depended on the use-case layer.

## Decision Outcome

- Biome enforces `performance.noBarrelFile`, `performance.noReExportAll`, `style.useImportType` and `suspicious.noExplicitAny` as errors.
- Allowed barrels (override in `biome.json`): each package entry `packages/*/src/index.ts`, the `@locainfra/core/testing` entry, and the shadcn-mandated `dashboard/src/lib/utils.ts` alias.
- Inside a package, modules import each other by path. Core's public API is listed explicitly in `packages/core/src/index.ts`.
- `core/src/shared/` holds the primitives every feature may use: `result.ts`, `op-error.ts`, `progress.model.ts` + `progress.ts`, `version.ts`, `yaml-schema.ts`, `json-schema.ts`. `ops/` holds only `*.op.ts`, `ops.contract.ts` and doctor's model. `EnvFormat` belongs to `env/formats/env-formatter.ts`.

### Consequences

- Good: dependencies point from use cases to features to shared, never back.
- Good: no accidental module-graph fan-out through barrels.
- Bad: `packages/core/src/index.ts` must be updated when a public symbol is added.
