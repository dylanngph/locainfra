---
"@locastack/cli": patch
"@locastack/core": patch
"@locastack/engines": patch
"@locastack/server": patch
"@locastack/dashboard": patch
---

Guided Docker setup. When Docker is missing or stopped, `locastack` and `locastack doctor` now explain what is wrong and offer to fix it after showing the exact commands and asking for approval: start an installed runtime (Docker Desktop, OrbStack, Colima, or Docker Engine), or install one. On macOS the default is Colima through Homebrew, with Docker Desktop and OrbStack as alternatives and Homebrew itself offered when missing; on Linux, Docker's official install script plus the `docker` group. New `locastack setup [--dry-run] [--yes] [--runtime …]` runs the same flow on demand; `--json` and non-interactive runs only print the plan. The dashboard shows a "Docker is not running" screen with a Start button if Docker stops while it is open.
