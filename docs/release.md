# Releasing LocaStack

## Cutting a release

1. Every user-facing change lands with a changeset (`bunx changeset`).
2. On `main`: `bun run release:version` consumes the changesets, bumps every workspace package together and writes the CHANGELOGs. Review, commit (`chore(release): 0.1.0`), push.
3. `bun run release:tag` creates `v<version>` from `packages/cli/package.json`; `git push origin v<version>`.
4. The **Release** workflow runs: it refuses a tag that does not match the CLI package version, cross-compiles the six targets on a macOS runner, checks the host binary prints the version, packages `locastack-<version>-<os>-<arch>[-musl].tar.gz` with `SHA256SUMS`, attaches build provenance attestations, and creates the GitHub Release. A tag with a `-` (for example `v0.1.0-rc.0`) becomes a pre-release and skips the Homebrew and npm jobs.

## Release candidates

Enter pre mode once: `bunx changeset pre enter rc`, then `bun run release:version` produces `0.1.0-rc.0`. Tag and push it to exercise the whole pipeline. To finish: `bunx changeset pre exit && bun run release:version` produces `0.1.0`; commit, tag, push. Delete superseded rc releases with `gh release delete v0.1.0-rc.0 --yes --cleanup-tag`.

## Verifying a release

```sh
gh attestation verify locastack-0.1.0-darwin-arm64.tar.gz --repo dylanngph/locastack
VERSION=0.1.0 sh install.sh            # installs to ~/.locastack/bin after checking SHA256SUMS
```

## One-time setup (owner)

- **Homebrew tap**: create the public repo `dylanngph/homebrew-locastack` (an empty repo is enough). Create a fine-grained personal access token limited to that repository with *Contents: read and write*, and add it to this repository as the secret `HOMEBREW_TAP_TOKEN`. Without it the tap job logs a notice and skips. Users then run `brew install dylanngph/locastack/locastack`.
- **npm**: create the npm account, the organisation `locastack` (owner of the `@locastack` scope), and configure *trusted publishing* on npmjs.com for the packages `locastack` and `@locastack/cli-*` pointing at repository `dylanngph/locastack`, workflow `release.yml`. Then set the repository variable `NPM_PUBLISH=true`. The job publishes with `--provenance`; no token is stored anywhere. Until the variable is set the job is skipped.
- **Apple signing (optional)**: add the secrets `APPLE_CERTIFICATE_P12` (base64 of the Developer ID Application .p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` (e.g. `Developer ID Application: Name (TEAMID)`), and an App Store Connect API key as `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`. The signing step runs only when the certificate secret exists. Bare Mach-O binaries cannot be stapled, so Gatekeeper checks the notarisation online.

## Rollback

Delete the GitHub Release and tag (`gh release delete vX --yes --cleanup-tag`), fix, bump with a new changeset, and release again. Published npm versions cannot be replaced; publish a patch instead.
