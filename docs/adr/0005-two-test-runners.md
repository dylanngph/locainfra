# 5. Two test runners chosen by runtime

- Status: accepted
- Date: 2026-09-23

## Context and Problem Statement

Most packages use Bun-only APIs (`Bun.spawn`, `fetch({ unix })`, `Bun.serve`). The dashboard is a Vite app.

## Considered Options

- Vitest everywhere
- `bun test` everywhere
- `bun test` for Bun-runtime packages, Vitest for the dashboard

## Decision Outcome

Chosen option: **`bun test`** for `core`, `engines`, `server`, `cli`; **Vitest** + Testing Library + happy-dom + MSW for `dashboard`; Playwright for end-to-end from M3.

### Consequences

- Good: each runner executes the code in its real runtime; Vitest reuses `vite.config.ts`.
- Bad: two configurations and coverage reports (thresholds 90% core/ops, 80% elsewhere).
- Never run Vitest on Bun-runtime packages or `bun test` on the dashboard.
