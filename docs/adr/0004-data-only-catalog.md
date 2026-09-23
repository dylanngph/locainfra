# 4. Data-only service catalog

- Status: accepted
- Date: 2026-09-23

## Context and Problem Statement

Services (postgres, redis, mailpit, …) must be addable without a CLI release, including from a public registry.

## Decision Drivers

- New services without a release.
- Remote definitions must never run code on the host.

## Considered Options

- TypeScript plugins per service
- Declarative YAML definitions interpreted by a fixed schema

## Decision Outcome

Chosen option: **declarative YAML** validated by the `ServiceDefinition` TypeBox schema. Templates are plain `{{path}}` substitution (no logic, no eval). Load order: built-ins → registry cache → user overrides (later wins by `id`). The validator rejects `0.0.0.0` binds, host mounts outside the stack dir, `privileged`, and images from non-allow-listed registries. `studio.panel` selects a panel built into the SPA.

### Consequences

- Good: open/closed — adding a service is a data change.
- Good: safe to fetch definitions remotely.
- Bad: services needing logic beyond templates must wait for schema extensions.
