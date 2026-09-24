# @locastack/cli-&lt;target&gt;

The prebuilt [LocaStack](https://github.com/dylanngph/locastack) binary for one platform. Do not install this package directly. Install [`locastack`](https://www.npmjs.com/package/locastack) instead; it depends on every platform package as an optional dependency, and npm keeps only the one whose `os`, `cpu` and `libc` match your machine.

## For maintainers: how the release fills this template

`npm/platform/package.json` is a template. The release workflow turns it into one package per target and does not use a script for this: each step is a few lines of shell and `jq` in the workflow YAML.

Targets (Bun `--target` without the `bun-` prefix): `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `linux-x64-musl`, `linux-arm64-musl`.

For each target, with the compiled binary at `dist/bun-$TARGET/locastack` and `VERSION` equal to the tag without its `v` (for example `0.1.0-rc.0`):

```yaml
- name: Prepare @locastack/cli-${{ matrix.target }}
  env:
    TARGET: ${{ matrix.target }}
    VERSION: ${{ needs.meta.outputs.version }}
  run: |
    os=${TARGET%%-*}; rest=${TARGET#*-}; cpu=${rest%%-*}
    case "$TARGET" in *-musl) libc=musl ;; linux-*) libc=glibc ;; *) libc= ;; esac
    dir="npm-out/cli-$TARGET"
    mkdir -p "$dir/bin"
    install -m 755 "dist/bun-$TARGET/locastack" "$dir/bin/locastack"
    cp npm/platform/README.md LICENSE "$dir/"
    jq --arg t "$TARGET" --arg v "$VERSION" --arg os "$os" --arg cpu "$cpu" --arg libc "$libc" \
      '.name = "@locastack/cli-\($t)" | .version = $v | .description |= gsub("TARGET"; $t)
       | .os = [$os] | .cpu = [$cpu] | if $libc == "" then del(.libc) else .libc = [$libc] end' \
      npm/platform/package.json > "$dir/package.json"
```

The launcher package gets the same version, and its optional dependencies are pinned to it:

```yaml
- name: Prepare locastack launcher
  run: |
    mkdir -p npm-out/locastack
    cp -R npm/locastack/bin npm/locastack/README.md LICENSE npm-out/locastack/
    jq --arg v "$VERSION" '.version = $v | .optionalDependencies |= map_values($v)' \
      npm/locastack/package.json > npm-out/locastack/package.json
```

Publish the six platform packages first, then the launcher, so the launcher never points at a version that does not exist. Prereleases go to the `next` dist-tag:

```sh
tag=latest; case "$VERSION" in *-*) tag=next ;; esac
npm publish "npm-out/cli-$TARGET" --access public --provenance --tag "$tag"
```

Rules the launcher relies on:

- Keep `files: ["bin/locastack"]`. Do not add `bin` (the launcher spawns the file) or `exports` (the launcher resolves `@locastack/cli-<target>/bin/locastack`, which an `exports` map would block).
- Darwin packages have no `libc` field. Linux packages set `libc` to `glibc` or `musl`. npm versions that ignore `libc` install both Linux variants, and the launcher still picks the right one at run time.
- The binary must keep mode 755 in the tarball. The launcher restores the bit if a package manager drops it, but not every install directory is writable.
