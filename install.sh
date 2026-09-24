#!/bin/sh
# LocaStack installer: downloads the prebuilt binary from GitHub Releases,
# verifies it against the release's SHA256SUMS and installs it.
#
#   curl -fsSL https://raw.githubusercontent.com/dylanngph/locastack/main/install.sh | sh
#
# Environment:
#   VERSION                     release to install, e.g. 0.1.0 or v0.1.0 (default: latest)
#   LOCASTACK_INSTALL_DIR       install directory (default: ~/.locastack/bin)
#   LOCASTACK_RELEASE_BASE_URL  releases base URL; assets are fetched from
#                               <base>/download/v<version>/<asset>
#                               (default: https://github.com/dylanngph/locastack/releases)
#   LOCASTACK_RELEASE_API_URL   "latest release" JSON endpoint
#                               (default: https://api.github.com/repos/dylanngph/locastack/releases/latest)
set -eu

REPO="dylanngph/locastack"
BASE_URL="${LOCASTACK_RELEASE_BASE_URL:-https://github.com/$REPO/releases}"
API_URL="${LOCASTACK_RELEASE_API_URL:-https://api.github.com/repos/$REPO/releases/latest}"
INSTALL_DIR="${LOCASTACK_INSTALL_DIR:-$HOME/.locastack/bin}"
VERSION="${VERSION:-latest}"

say() { printf '%s\n' "$*"; }
die() { printf 'locastack install: %s\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

# fetch <url> <output-file>
fetch() {
	if has curl; then
		curl -fsSL --retry 3 -o "$2" "$1"
	elif has wget; then
		wget -q -O "$2" "$1"
	else
		die "curl or wget is required"
	fi
}

# sha256 <file> -> hex digest
sha256() {
	if has sha256sum; then
		sha256sum "$1" | cut -d ' ' -f 1
	elif has shasum; then
		shasum -a 256 "$1" | cut -d ' ' -f 1
	else
		die "sha256sum or shasum is required to verify the download"
	fi
}

detect_os() {
	case "$(uname -s)" in
		Darwin) echo darwin ;;
		Linux) echo linux ;;
		MINGW* | MSYS* | CYGWIN* | Windows_NT)
			die "Windows is not supported yet (planned). Use WSL2 with the Linux build." ;;
		*) die "unsupported operating system: $(uname -s)" ;;
	esac
}

detect_arch() {
	case "$(uname -m)" in
		arm64 | aarch64) arch=arm64 ;;
		x86_64 | amd64) arch=x64 ;;
		*) die "unsupported architecture: $(uname -m) (supported: arm64, x86_64)" ;;
	esac
	# A shell running under Rosetta reports x86_64; install the native build.
	if [ "$1" = darwin ] && [ "$arch" = x64 ] &&
		[ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
		arch=arm64
	fi
	echo "$arch"
}

is_musl() {
	if ldd --version 2>&1 | grep -qi musl; then return 0; fi
	for f in /lib/ld-musl-*; do [ -e "$f" ] && return 0; done
	return 1
}

os=$(detect_os)
arch=$(detect_arch "$os")
suffix=""
if [ "$os" = linux ] && is_musl; then suffix="-musl"; fi

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t locastack)
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$VERSION" = latest ]; then
	# Follow the /releases/latest redirect first (no API rate limit); fall back to the API.
	if command -v curl >/dev/null 2>&1; then
		final=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$BASE_URL/latest" 2>/dev/null || true)
		case "$final" in */tag/*) VERSION=${final##*/tag/} ;; esac
	fi
	if [ -z "$VERSION" ] || [ "$VERSION" = latest ]; then
		fetch "$API_URL" "$tmp/latest.json" ||
			die "could not query the latest release; set VERSION=<x.y.z> to pick one"
		VERSION=$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$tmp/latest.json" | head -n 1)
		[ -n "$VERSION" ] || die "could not read tag_name from $API_URL"
	fi
fi
VERSION=${VERSION#v}

asset="locastack-$VERSION-$os-$arch$suffix.tar.gz"
url="$BASE_URL/download/v$VERSION"

say "Installing LocaStack $VERSION ($os-$arch$suffix)"
fetch "$url/$asset" "$tmp/$asset" || die "download failed: $url/$asset"
fetch "$url/SHA256SUMS" "$tmp/SHA256SUMS" || die "download failed: $url/SHA256SUMS"

expected=$(awk -v f="$asset" '{ n = $2; sub(/^\*/, "", n) } n == f { print $1; exit }' "$tmp/SHA256SUMS")
[ -n "$expected" ] || die "$asset is not listed in SHA256SUMS"
actual=$(sha256 "$tmp/$asset")
[ "$expected" = "$actual" ] ||
	die "checksum mismatch for $asset (expected $expected, got $actual)"

tar -xzf "$tmp/$asset" -C "$tmp"
[ -f "$tmp/locastack" ] || die "$asset does not contain a locastack binary"
mkdir -p "$INSTALL_DIR"
chmod +x "$tmp/locastack"
mv -f "$tmp/locastack" "$INSTALL_DIR/locastack"
say "Installed $INSTALL_DIR/locastack"

case ":${PATH:-}:" in
	*":$INSTALL_DIR:"*) ;;
	*)
		say ""
		say "$INSTALL_DIR is not on your PATH. Add this line to your shell profile (~/.zshrc, ~/.bashrc, or run fish_add_path):"
		case "$INSTALL_DIR" in
			"$HOME"/*) say "  export PATH=\"\$HOME/${INSTALL_DIR#"$HOME"/}:\$PATH\"" ;;
			*) say "  export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
		esac
		say ""
		;;
esac

"$INSTALL_DIR/locastack" --version
