---
status: accepted
date: 2026-09-24
---

# Distribution: native Bun binaries, GitHub Releases, Homebrew, installer, gated npm

## Context

LocaStack must install in one command on macOS and Linux and stay a single self-contained binary. The project is open source under MIT and has no code-signing identity yet.

## Decision

- **Build**: `bun build --compile --asset` from `package.json` scripts, no build scripts. Six targets: darwin arm64/x64, linux x64/arm64 for glibc and musl. Windows is not shipped in 0.1 because the Docker transport speaks unix sockets only.
- **Versioning**: changesets with all workspace packages fixed together; `packages/cli/package.json` is the single version source and is bundled into the binary. Release CI refuses a tag that does not match it.
- **Release pipeline** (`release.yml`, on `v*` tags): cross-compile on one macOS runner, package `locastack-<version>-<os>-<arch>[-musl].tar.gz`, write `SHA256SUMS`, attach GitHub artifact attestations, publish a GitHub Release (pre-release when the tag has a `-` suffix).
- **Homebrew**: a formula in the tap `dylanngph/homebrew-locastack`, rewritten by the pipeline on stable releases.
- **Installer**: `install.sh` detects OS, architecture, musl and Rosetta, verifies the checksum, installs to `~/.locastack/bin`.
- **npm**: a `locastack` launcher with `@locastack/cli-<target>` platform packages as optional dependencies, published with provenance through npm trusted publishing. The job is gated on the repository variable `NPM_PUBLISH=true` until the npm scope exists.
- **Signing**: macOS binaries ship unsigned for now. The signing and notarisation step runs only when the Apple secrets are configured.

## Consequences

- Browser downloads of the macOS binary need a one-time right-click Open; `curl` and `brew` installs are not quarantined.
- Binaries are 60 to 85 MB because they embed the Bun runtime.
- A first pre-release tag exercises the whole pipeline before `v0.1.0`.
