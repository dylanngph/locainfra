# 2. Hybrid Docker engine: Compose for lifecycle, Engine API for observability

- Status: accepted
- Date: 2026-09-23

## Context and Problem Statement

LocaStack must start/stop multi-service stacks and show live stats, logs and events. Which Docker interface should it use?

## Decision Drivers

- Correct ordering, health waits, volumes and networks.
- Real-time streams for the dashboard.
- No heavy client libraries.

## Considered Options

- `docker compose` only (poll `ps`)
- Engine API only (reimplement orchestration)
- Hybrid

## Decision Outcome

Chosen option: **hybrid**. Lifecycle writes go through `docker compose` (`Bun.spawn`), with rendered compose files kept inspectable under `~/.locastack/stacks/<stack>/`. Read/observe (list, inspect, logs, stats, events, exec) uses the Engine API over the Docker socket with Bun's `fetch({ unix })`; no dockerode.

### Consequences

- Good: Compose handles orchestration it already does well; users can inspect the files.
- Good: Streaming stats/logs/events with zero dependencies.
- Bad: two integration surfaces to test (recorded fixtures + live tests skipped without Docker).
- Requires Compose ≥ 2.24 (warn below 2.30).
