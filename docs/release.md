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
gh attestation verify locastack-<version>-darwin-arm64.tar.gz --repo dylanngph/locastack
curl -fsSL https://raw.githubusercontent.com/dylanngph/locastack/main/install.sh | VERSION=<version> sh
```

The plain `curl … | sh` form installs the latest *stable* release; pre-releases are never "latest", so pass `VERSION=`.

## One-time setup (owner)

- **Protected `release` environment**: the release, Homebrew and npm jobs run in the GitHub environment `release`. Create it under *Settings → Environments*, add yourself as a required reviewer, and store `HOMEBREW_TAP_TOKEN` (and the Apple secrets) as *environment* secrets rather than repository secrets. Then a leaked token with push rights can tag but cannot publish without your approval. Also add a tag ruleset restricting who may create `v*` tags.

- **Homebrew tap**: create the public repo `dylanngph/homebrew-locastack` (an empty repo is enough). Create a fine-grained personal access token limited to that repository with *Contents: read and write*, and add it to this repository as the secret `HOMEBREW_TAP_TOKEN`. Without it the tap job logs a notice and skips. Users then run `brew install dylanngph/locastack/locastack`.
- **npm** (primary channel): create the organisation `locastack` on npmjs.com (it owns the `@locastack` scope for the platform packages). A granular token cannot create a package it was not scoped to when it was made, so the unscoped `locastack` launcher was published once by hand (`npm publish --tag next --access public` from a prepared `npm/locastack` copy, in a real terminal because the passkey/2FA prompt is interactive); the six `@locastack/*` packages are created through the org scope. Create a *granular access token* with **read and write** on packages, scoped to the `locastack` package and the `@locastack` organisation, with *bypass 2FA* for automation, and store it as the **environment secret** `NPM_TOKEN` in the `release` environment. Set the repository variable `NPM_PUBLISH=true`. The job publishes all seven packages with `--provenance` (pre-releases under the `next` dist-tag, stable releases under `latest`) and is idempotent, so a failed run can be re-dispatched. Later you can switch to trusted publishing: add a trusted publisher (repository `dylanngph/locastack`, workflow `release.yml`, environment `release`) on each existing package and delete `NPM_TOKEN`; npm 11.5+ then authenticates through GitHub OIDC automatically. Users install with `npm i -g locastack` (or `locastack@next` for a release candidate).
- **Apple signing (optional)**: add the secrets `APPLE_CERTIFICATE_P12` (base64 of the Developer ID Application .p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` (e.g. `Developer ID Application: Name (TEAMID)`), and an App Store Connect API key as `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`. The signing step runs only when the certificate secret exists. Bare Mach-O binaries cannot be stapled, so Gatekeeper checks the notarisation online.

## Rollback

Delete the GitHub Release and tag (`gh release delete vX --yes --cleanup-tag`), fix, bump with a new changeset, and release again. Published npm versions cannot be replaced; publish a patch instead.
