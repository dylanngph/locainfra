# 3. TypeBox as the only schema library

- Status: accepted
- Date: 2026-09-23

## Context and Problem Statement

Schemas are needed for API models, `locainfra.yaml`, catalog YAML and state. An earlier draft used zod for files and TypeBox for Elysia.

## Decision Drivers

- One schema library, fewer dependencies.
- Elysia reference models and OpenAPI need TypeBox natively.
- Published JSON Schemas (`schema/stack.v1.json`, `schema/service.v1.json`).

## Considered Options

- zod for files + TypeBox for the API
- TypeBox everywhere

## Decision Outcome

Chosen option: **TypeBox everywhere** (`@sinclair/typebox`, the same version Elysia resolves). Files are parsed with `Value.Parse`; JSON Schemas are produced by `JSON.stringify(schema)`.

### Consequences

- Good: single source of type and runtime validation across core, server and CLI.
- Good: no schema converter.
- Bad: terser error messages; core wraps `Value.Errors` into friendly messages with file context.
- zod must not be added.
