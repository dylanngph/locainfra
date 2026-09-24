---
"@locastack/cli": patch
"@locastack/server": patch
---

The standalone binary is built with Bun's own `bun build --compile --asset` instead of a hand-written script.

- `bun run build` builds the dashboard, then compiles `dist/locastack` with the dashboard, the built-in catalog and the database migrations embedded. The binary never loads a `.env` or `bunfig.toml` from the folder it runs in.
- `bun run build:targets` compiles all seven release targets into `dist/<target>/locastack`.
- The binary reads its catalog directly from the embedded files. It no longer copies them to `~/.locastack/catalog-builtin/` (you can delete that folder).
- `scripts/build.ts`, the generated `.build/` entry and `setEmbeddedAssets` are gone. The server serves the dashboard only from a folder (`staticDir`); the `staticFiles` option is removed.
