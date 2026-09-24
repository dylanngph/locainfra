# locastack

Dashboard-first local Docker dev services. One command starts Postgres, Redis and friends for your project and opens a dashboard to manage them.

```sh
npm install -g locastack      # or: npx locastack
locastack --help
```

Requires Docker (Docker Desktop, OrbStack, Colima or a native engine) and Node.js 20+ for this launcher. The CLI itself is a standalone binary.

## How this package works

`locastack` ships no binary. npm installs one optional dependency that matches your machine, and `bin/locastack.js` runs that dependency's binary with your arguments:

| Platform | Package |
| --- | --- |
| macOS, Apple Silicon | `@locastack/cli-darwin-arm64` |
| macOS, Intel | `@locastack/cli-darwin-x64` |
| Linux x64 (glibc) | `@locastack/cli-linux-x64` |
| Linux arm64 (glibc) | `@locastack/cli-linux-arm64` |
| Linux x64 (musl, e.g. Alpine) | `@locastack/cli-linux-x64-musl` |
| Linux arm64 (musl) | `@locastack/cli-linux-arm64-musl` |

Windows is not supported yet (planned). Use WSL2 with the Linux build.

If the launcher says the platform package is missing, optional dependencies were skipped (`--omit=optional`, `--no-optional`, or a lockfile made on another OS). Reinstall with them enabled, or use the standalone installer:

```sh
curl -fsSL https://raw.githubusercontent.com/dylanngph/locastack/main/install.sh | sh
```

## Links

- Source and issues: https://github.com/dylanngph/locastack
- License: MIT
