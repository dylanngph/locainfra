# 1. Dashboard-first product shape

- Status: accepted
- Date: 2026-09-23

## Context and Problem Statement

Setting up local services for a project (pick images and ports, generate passwords, write compose, copy connection strings) is a repeated ritual. Should LocaStack primarily be a CLI or an interface?

## Decision Drivers

- Everything should be doable from one interface.
- Live status, logs and metrics are awkward in a terminal.
- Scripts and CI still need a non-interactive entry point.

## Considered Options

- CLI-first with many subcommands
- Dashboard-first with a minimal CLI
- Desktop app

## Decision Outcome

Chosen option: **dashboard-first with a minimal CLI**. `locastack` opens a localhost dashboard; the CLI keeps only `up`, `down`, `env`, `doctor` (plus `--version`/`--help`), all with `--json`.

### Consequences

- Good: rich UX (catalog browsing, logs, connection strings with copy).
- Good: CLI surface stays tiny and stable.
- Bad: a local HTTP server must be secured (127.0.0.1, session token, Host/Origin checks).
- Both clients call the same Operations layer; nothing is UI-only or CLI-only at the logic level.
