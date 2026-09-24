# Security policy

## Threat model

LocaStack runs on a developer's machine and talks to the local Docker daemon.

- The dashboard, its API and every managed service bind to `127.0.0.1` only.
- The API and WebSocket require a per-run session token. The dashboard rejects requests whose `Host` or `Origin` is not the local dashboard, which blocks DNS-rebinding attacks from other pages.
- Generated secrets are stored with mode `0600` under `~/.locastack/secrets/` and are never written to `locastack.yaml`.
- Access to the Docker socket is equivalent to root on the host. LocaStack does not add a sandbox around Docker; treat anyone who can run it as an administrator of that machine.
- Catalog definitions are data, not code, and are validated before use. Remote registry entries (future) will be checksummed.

## Reporting a vulnerability

Please report security issues privately through GitHub Security Advisories: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue.

You will get an acknowledgement within a few days. Fixes ship as a patch release with a changelog entry once available.

## Supported versions

Only the latest 0.x release receives security fixes.
