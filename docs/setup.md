# Docker setup (`locastack setup`)

LocaStack needs a working Docker Engine and the Compose v2 plugin. When they
are missing or stopped, LocaStack can install or start them, but only after it
has shown the user the exact commands and the user said yes.

## Where the flow appears

| Entry point | Behaviour |
|---|---|
| `locastack setup [-y\|--yes] [--dry-run] [--runtime colima\|docker-desktop\|orbstack] [--start-at-login] [--json]` | Runs doctor, plans from that report, shows the commands, asks, runs, waits for the daemon, re-runs doctor. Exit 0 when Docker works afterwards (or after a docker-group change that needs a new login), 1 otherwise, 2 for an unknown `--runtime`. |
| bare `locastack` | Runs doctor. When a check fails in a terminal (not `--json`), it prints the plan and offers the same flow. After a successful setup it starts the dashboard with the fresh report. Otherwise it exits 1 and never starts the server, with one closing line that matches the outcome: declined → "Nothing else was run. Run `locastack setup` when you are ready."; docker-group change → "Log out and back in (or run `newgrp docker`), then run `locastack`."; still failing → the checks that still fail, then the fix; no offer (no terminal, nothing automatable) → "Fix the failing checks above, then run `locastack` again." |
| `locastack doctor` | Prints the report. When checks fail it offers the flow and only installs if the user says yes. `doctor --json` is unchanged: it never prompts. |
| Dashboard | Shows a Docker-unavailable screen with the reason instead of empty pages (while doctor reports a failing check). It has a **Start Docker** button when a runtime is installed but stopped and the start needs no sudo, and otherwise the copyable `locastack setup` command with the plan's steps read-only. It re-checks on button press and after the start op finishes. Nothing polls. Because bare `locastack` does not start the server while Docker is down, the screen shows up when Docker stops (or is quit) while the dashboard is already running. |

## Detection (doctor)

The checks run in this order (`DOCTOR_CHECK` in `packages/core/src/ops/doctor/doctor.model.ts`):
`docker.cli`, `docker.socket`, `docker.daemon`, `docker.api`,
`compose.plugin`, `compose.version`, `docker.group` (Linux only) and `homebrew`
(macOS only, informational). The report also carries `platform`, taken from
the `PlatformInspector` port. That covers the OS and arch, Homebrew, systemd,
the installed runtimes, the running runtime and docker group membership. A
derived `setupNeeded` is `none`, `start`, `install` or `unsupported`.

Each failure has a distinct remedy, cheapest first:

| Situation | Remedy (`SetupPlan.kind`) |
|---|---|
| Everything ok (warnings allowed) | `none` |
| Runtime installed, daemon stopped | `start`: `colima start` / `open -a Docker` / `open -a OrbStack` / `sudo systemctl start docker` (`sudo service docker start` without systemd) / `systemctl --user start docker-desktop` (Docker Desktop for Linux). With several installed, the one the active docker context names starts (`desktop-linux` → Docker Desktop, `colima`, `orbstack`, Linux `default` → Docker Engine), else Docker Desktop, OrbStack, Colima on macOS (Docker Engine, Docker Desktop on Linux). The others are the plan's `alternatives`, which the CLI offers. Starting Colima from another context carries a note that `colima start` switches the docker context |
| `DOCKER_HOST` set and not answering | `unsupported`: "DOCKER_HOST=… does not answer; start that daemon or unset DOCKER_HOST." Nothing is started or installed, because LocaStack only talks to that host. Exception: a unix socket that belongs to an installed runtime (`~/.colima/…`, `~/.orbstack/…`, `~/.docker/run/docker.sock`, Linux `/var/run/docker.sock`) plans a start of that runtime only |
| Runtime running but its socket is unreachable from LocaStack | `unsupported`: the note names the context switch, e.g. `docker context use colima` or `DOCKER_HOST=unix://<home>/.colima/default/docker.sock` |
| Engine API older than the minimum | `unsupported`: update the runtime |
| Compose plugin missing or older than the minimum, daemon fine | macOS with Colima (Homebrew): `install`, compose only (`brew install docker-compose` or `brew upgrade docker-compose`, plus the plugin link). Docker Desktop / OrbStack with too old a Compose: `unsupported`, "Update … to the latest version". Linux: `unsupported`, and the note names the `docker-compose-plugin` package from Docker's repository |
| Linux: user not in `docker` group | `install`: `sudo usermod -aG docker <user>`, `requiresRelogin`. A socket that refuses the user with `EACCES` counts as a running Docker Engine (`runningRuntime: docker-engine`), so the plan is the `usermod` step only (no `systemctl start`). `docker.group` is only a warning when membership is unknown, when the daemon answers anyway, or when only Docker Desktop for Linux is installed; a daemon error with `EACCES`/"permission denied" gives the `usermod` fix |
| macOS: nothing installed | `install`: Colima (default), Docker Desktop or OrbStack; Homebrew first if missing |
| Linux: nothing installed | `install`: Docker's official convenience script. `--runtime colima\|orbstack` on Linux, `--runtime docker-engine` on macOS and installing Docker Desktop for Linux are `unsupported` |
| Windows, other OS, no automatable path | `unsupported`: `reason` and `postNotes` hold manual instructions |

## Providers and exact commands

Every step is an argv array. It is run without a shell and shown to the user
exactly as it will run. The planner resolves `~`, `$(brew --prefix)` and
`$USER` up front from `PlatformFacts`, using `homeDir`, `brewPrefix`,
`username` and `tmpDir`. Brew is called by absolute path (`<prefix>/bin/brew`),
so it also works in the same run that installed Homebrew. The prefix is
`/opt/homebrew` on arm64 and `/usr/local` on x64.

### macOS: Homebrew (only when missing)

1. `curl -fsSL --create-dirs -o <tmp>/brew-install.sh https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh`
   (a download step with `remoteScript`; the user is offered `less <tmp>/brew-install.sh` before it runs)
2. `/bin/bash <tmp>/brew-install.sh` (attached: the installer asks for the password and confirmation itself)
3. Post note: add `eval "$(<prefix>/bin/brew shellenv)"` to the shell profile (`shell` fact).

### macOS: Colima (default)

1. `brew install colima docker docker-compose`
2. `mkdir -p ~/.docker/cli-plugins`
3. `ln -sfn <prefix>/opt/docker-compose/bin/docker-compose ~/.docker/cli-plugins/docker-compose`
4. `colima start`, or `brew services start colima` when the user chose "start at login" (`startAtLogin`, `--start-at-login`)

When the same plan installs Homebrew, or Homebrew is installed but not on PATH
(`brewOnPath: false`: found only at its default prefix), the start step calls
`<prefix>/bin/colima` with `PATH=<prefix>/bin:<prefix>/sbin:…` in its env
(shown in the command line), and the plan carries `pathAdditions:
[<prefix>/bin, <prefix>/sbin]`. After the last step `runSetupPlan` prepends
them to LocaStack's own PATH (`ProcessRunner.prependPath`), so the daemon
wait (`docker context inspect`) and the final doctor (`which docker`,
`docker compose`) find the new CLI. The `brew shellenv` note is added in both
cases, and a `DOCKER_START_TIMEOUT` or a check still failing carries the
plan's notes in its fix. As a fallback the socket locator also tries
`~/.colima/default/docker.sock` and `~/.orbstack/run/docker.sock` on macOS.

When a `docker` CLI is already on PATH (for example Docker Desktop's, when
Colima is requested next to it), the `docker` formula is left out and a note
says so. `docker-compose` and the plugin link are then planned only when the
compose check fails. The link step's note says it replaces any existing
`~/.docker/cli-plugins/docker-compose`. When Docker Desktop or OrbStack is
installed without a CLI on PATH, a note warns that Homebrew's `docker` may
clash with its links (`brew link --overwrite docker`, run by hand).

### macOS: Apple Silicon with Intel Homebrew

A Homebrew at `/usr/local` on an arm64 Mac is the Intel build, installed
under Rosetta. Colima and Lima installed from it are x86_64, and `colima
start` fails with "limactl is running under rosetta, please reinstall lima
with native arch". The platform inspector reports this as `brewNative:
false`: the prefix is `/usr/local`, or `file` says `bin/brew` is an
x86_64-only binary. It also reports `nativeBrewPrefix: /opt/homebrew` when
a native Homebrew sits next to the Intel one, and `intelBrewFormulae`, the
colima/lima/docker/docker-compose kegs under `/usr/local/Cellar`.

The Colima plan then never uses the Intel `brew`. Its reason says "Homebrew
at /usr/local is the Intel build running under Rosetta; Colima needs the
native one at /opt/homebrew." The steps are:

1. `/usr/local/bin/brew uninstall <colima lima docker docker-compose>`, listing only the formulae that are installed (skipped when none is)
2. The Homebrew download step, then `arch -arm64 /bin/bash <tmp>/brew-install.sh`
   (attached, so it installs to `/opt/homebrew`). Both are skipped when `/opt/homebrew/bin/brew` already exists.
3. `/opt/homebrew/bin/brew install colima docker docker-compose`
4. The plugin link from `/opt/homebrew/opt/docker-compose/bin/docker-compose`
5. `PATH=/opt/homebrew/bin:/opt/homebrew/sbin:… /opt/homebrew/bin/colima start` (or `brew services start colima` with `--start-at-login`)

The plan carries `pathAdditions: [/opt/homebrew/bin, /opt/homebrew/sbin]`
and a note to add `eval "$(/opt/homebrew/bin/brew shellenv)"` to the shell
profile, so that `/opt/homebrew/bin` comes before `/usr/local/bin`. A Colima
installed natively next to the Intel Homebrew (no Intel colima or lima keg)
is started as usual. Docker Desktop and OrbStack plans are unchanged.

The Colima start step sets `tee`, so its output is captured even when it
runs attached (it is still echoed live, but the child writes to pipes
instead of a TTY). When the start fails and the output contains "running
under rosetta" (case-insensitive), the fix says that Colima came from the
Intel Homebrew, and that running `locastack setup` again installs the native
Homebrew (or use `--runtime docker-desktop`).

When the npm launcher runs under an Intel Node on an Apple Silicon Mac
(`process.arch` is `x64` and `sysctl.proc_translated` is `1`), it runs
`@locastack/cli-darwin-arm64` if that package resolves. Otherwise it runs
the x64 binary and prints one line on stderr telling the user to install an
Apple Silicon Node.

### macOS: Docker Desktop (alternative)

1. `brew install --cask docker` (attached, so a password prompt is visible)
2. `open -a Docker`. Note: the app finishes setup in its own window (license, permissions); LocaStack waits for the daemon.

### macOS: OrbStack (alternative)

1. `brew install --cask orbstack` (attached)
2. `open -a OrbStack`

### Linux: Docker Engine

1. `curl -fsSL --create-dirs -o <tmp>/get-docker.sh https://get.docker.com` (download step; the inspect hint is offered)
2. `sudo sh <tmp>/get-docker.sh`
3. `sudo systemctl enable --now docker` when systemd is PID 1, else `sudo service docker start` (with a note that Docker will not start at boot)
4. `sudo usermod -aG docker <user>`. `requiresRelogin`: log out and back in (or run `newgrp docker`) before `docker` works without sudo.

`sudo` is left out when running as root (`isRoot`). Rootless Docker and
distro packages (`apt install docker.io`, `dnf install moby-engine`, …) are
out of scope: users who want them install them by hand, and `locastack
doctor` then verifies the result.

## Consent rules

- The full plan is always printed before the first question: the reason,
  every command, the other runtimes and notes. The user must then give an
  explicit yes: a clack `confirm`, or one `select` when there is a choice.
- The select's first option runs the commands just shown ("Install with
  Colima" / "Start Docker Desktop"). The other options are the other
  runtimes, "Install with Colima, start it at login" (`brew services start
  colima`) and "Not now". Any option other than the first is re-planned, its
  plan printed, and confirmed on its own. Cancelling any prompt (Ctrl+C)
  counts as "no", and nothing runs.
- Remote scripts are never piped into a shell. They are downloaded to a temp
  file first as their own step, the URL is shown, and before the file runs
  the CLI offers the inspect command (`RunSetupPlanInput.beforeStep`).
- `sudo` steps and attached steps run with inherited stdio, so the password
  prompt and installer questions are visible. The dashboard never runs them
  (`needsTerminal`).
- `--yes` skips every prompt (for scripts). Everything else still applies: the
  commands are printed and run in order.
- `--dry-run` prints the numbered plan and runs nothing. It exits 0 when the
  plan is `none` (Docker works) and 1 otherwise, so scripts can test it.
- `--json` prints `{ ok, plan, doctor }` and never runs anything, even with
  `--yes` (child processes would write into the same stdout). Exit as for
  `--dry-run`.
- Without `--yes`, a non-TTY session never prompts: it prints the plan, says
  nothing was run, and exits 1.
- Before the step that runs a downloaded script, the CLI asks: Run it / Show
  it first (`less <file>` with the terminal attached, then asks again) /
  Cancel setup (`SETUP_CANCELLED`, nothing else runs).
- Execution stops at the first failing step with its manual fix
  (`SETUP_STEP_FAILED`, `details`: `stepId`, `command`, `exitCode` (-1 when
  spawning failed or the step was killed), `stepTimedOut`, `fix`). After the
  last step LocaStack waits for the daemon (`DOCKER_START_TIMEOUT_MS`, 3 min)
  and re-runs doctor. When the plan `requiresRelogin` (docker group), the wait
  is skipped because this process cannot reach the socket until a new login;
  doctor still runs and the final `done` explains the re-login. `setup` then
  exits 0; bare `locastack` and `doctor` treat it as not fixed yet.
- Progress events: one `step` per command (with `percent`) followed by
  `Done: <title>`; captured output (dashboard only) becomes `log` events with
  ANSI stripped, `\r` progress lines collapsed and the last 200 lines kept.
  An unexpected throw ends the stream with one `UNKNOWN` error.

## Code map

| Piece | Where |
|---|---|
| Ports | `PlatformInspector` (`core/src/ports/platform.port.ts`), `ProcessRunner` + `CommandStep` (`core/src/ports/process.port.ts`), `DaemonWaiter` (`core/src/ports/docker.port.ts`) |
| Models | `SetupPlan`, `SetupKind`, `SetupOptions`, `SETUP_INSTALLER_URLS`, `DOCKER_START_TIMEOUT_MS`, `SETUP_STEP_TIMEOUT_MS`, `DEFAULT_MAC_RUNTIME` (`core/src/ops/ops.model.ts`); `DOCTOR_CHECK`, `DoctorCheckId`, `SetupNeeded`, `DoctorReport.platform/setupNeeded` (`core/src/ops/doctor/doctor.model.ts`); `RuntimeProvider`, `PlatformSummary`, `PlatformFacts` (`platform.port.ts`) |
| Ops (`ops.contract.ts`) | `BuildSetupPlan` (pure), `PlanSetup`, `RunSetupPlan`, `StartDockerRuntime`; `RunDoctorDeps.platform`. One op per file in `core/src/ops/setup/`; step builders and `SETUP_STEP` ids in `setup-steps.ts` |
| Command display | `formatCommandStep(step)` / `formatCommand(argv)` / `quoteShellArg` (`core/src/shared/command-format.ts`): env as `KEY=value` first, then the shell-quoted argv. The CLI and the dashboard use it |
| Engines | `HostPlatformInspector` (`engines/src/platform/`), `BunProcessRunner` (`engines/src/process/`), `PollingDaemonWaiter` (`engines/src/docker/daemon-waiter.ts`); wired by `createEngines()` as `platform`, `runner`, `waiter` |
| CLI | `commands/setup/` (`setup.command.ts`, `setup.flow.ts` with `offerSetup` used by bare `locastack` and `doctor`, `setup.view.ts`) |
| Dashboard | `features/system/components/docker-gate.tsx` and `docker-unavailable.tsx`; preview with `bun run dev:ui` and `?mockDocker=stopped` or `?mockDocker=missing` |
| Error codes | `DOCKER_NOT_INSTALLED` (`details.provider`, `fix`), `DOCKER_START_TIMEOUT`, `SETUP_UNSUPPORTED`, `SETUP_NEEDS_TERMINAL` (`details.commands[]`, `fix`), `SETUP_STEP_FAILED`, `SETUP_CANCELLED`; a doctor check still failing after the run carries `details.checkId` and `fix`. `DOCTOR_CHECK_IDS` is removed (use `DOCTOR_CHECK`) |
| Server | `GET /api/system/setup`, `POST /api/system/docker/start` (see [api.md](./api.md)) |
| Test fakes | `FakePlatformInspector`, `createPlatformFacts`, `createLinuxPlatformFacts`, `FakeProcessRunner`, `FakeDaemonWaiter` (`@locastack/core/testing`) |

Tests never run a real installer or start a daemon: every path is covered
with the fakes above, including the `--dry-run` output.
