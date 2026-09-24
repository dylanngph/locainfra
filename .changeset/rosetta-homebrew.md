---
"@locastack/cli": patch
"@locastack/core": patch
"@locastack/engines": patch
---

`locastack setup` on an Apple Silicon Mac whose Homebrew is the Intel build at /usr/local no longer installs Colima with it. It removes the Intel colima/lima/docker/docker-compose, installs the native Homebrew at /opt/homebrew (`arch -arm64`), unless it is already there, and installs and starts Colima from it. A `colima start` that fails with "running under rosetta" now gets a fix that explains this. The npm launcher running under an Intel Node on Apple Silicon prefers the arm64 binary when it is installed, and otherwise prints a one-line warning.
