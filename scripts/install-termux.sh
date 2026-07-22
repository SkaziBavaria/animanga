#!/data/data/com.termux/files/usr/bin/sh
set -eu

REPO_URL="${ANIMANGA_REPO_URL:-${ANI_WEB_REPO_URL:-https://github.com/SkaziBavaria/ani-web.git}}"
BRANCH="${ANIMANGA_BRANCH:-${ANI_WEB_BRANCH:-${BRANCH:-main}}}"
DEFAULT_INSTALL_DIR="$HOME/animanga"
if [ -z "${ANIMANGA_INSTALL_DIR:-}${ANI_WEB_INSTALL_DIR:-}" ] && [ -d "$HOME/ani-web/.git" ] && [ ! -e "$DEFAULT_INSTALL_DIR" ]; then
  DEFAULT_INSTALL_DIR="$HOME/ani-web"
fi
INSTALL_DIR="${ANIMANGA_INSTALL_DIR:-${ANI_WEB_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}}"
ANI_CLI_STABLE_URL="https://raw.githubusercontent.com/pystardust/ani-cli/cc45a5530af350fb0e1a759e1d962814df5876fe/ani-cli"

fail() {
  printf 'AniManga installer: %s\n' "$1" >&2
  exit 1
}

command -v pkg >/dev/null 2>&1 || fail 'This installer must be run inside Termux.'
case "$BRANCH" in
  ''|-*) fail 'BRANCH must be a valid Git branch name.' ;;
esac

printf '\n[1/5] Installing Termux packages...\n'
pkg update -y
pkg install -y git nodejs curl grep sed fzf openssl-tool termux-am aria2 ffmpeg patch

printf '\n[2/5] Installing AniManga in %s...\n' "$INSTALL_DIR"
printf 'Using branch: %s\n' "$BRANCH"
if [ -d "$INSTALL_DIR/.git" ]; then
  if [ -n "$(git -C "$INSTALL_DIR" status --porcelain)" ]; then
    printf 'Local changes found; leaving the existing checkout unchanged.\n'
  else
    git -C "$INSTALL_DIR" fetch origin "$BRANCH:refs/remotes/origin/$BRANCH"
    if git -C "$INSTALL_DIR" show-ref --verify --quiet "refs/heads/$BRANCH"; then
      git -C "$INSTALL_DIR" checkout "$BRANCH"
    else
      git -C "$INSTALL_DIR" checkout -b "$BRANCH" --track "origin/$BRANCH"
    fi
    git -C "$INSTALL_DIR" merge --ff-only "origin/$BRANCH"
  fi
elif [ -e "$INSTALL_DIR" ]; then
  fail "$INSTALL_DIR already exists but is not an AniManga Git checkout. Move it or set ANIMANGA_INSTALL_DIR."
else
  git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$INSTALL_DIR"
fi

printf '\n[3/5] Checking Node and SQLite...\n'
node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 16)) {
    throw new Error(`Node 22.16 or newer is required; installed: ${process.versions.node}`);
  }
  require("node:sqlite");
  console.log(`Node ${process.versions.node} · SQLite OK`);
'

printf '\n[4/5] Installing the pinned and patched ani-cli build...\n'
PATCH_DIR="$(mktemp -d)"
trap 'rm -rf "$PATCH_DIR"' EXIT HUP INT TERM
curl -fsSL "$ANI_CLI_STABLE_URL" -o "$PATCH_DIR/ani-cli"
node "$INSTALL_DIR/scripts/patch-ani-cli-crypto.js" "$PATCH_DIR/ani-cli"
sh -n "$PATCH_DIR/ani-cli"
chmod +x "$PATCH_DIR/ani-cli"
mv "$PATCH_DIR/ani-cli" "$PREFIX/bin/ani-cli"
rm -rf "$PATCH_DIR"
trap - EXIT HUP INT TERM

chmod +x "$INSTALL_DIR/start.sh"
ln -sf "$INSTALL_DIR/start.sh" "$PREFIX/bin/animanga"
ln -sf "$INSTALL_DIR/start.sh" "$PREFIX/bin/ani-web"

printf '\n[5/5] Installation complete.\n\n'
printf 'ani-cli: %s\n' "$(ani-cli --version 2>/dev/null | head -n 1 || printf 'installed')"
printf 'Start AniManga with:\n\n  animanga\n\n'
printf 'Then open http://127.0.0.1:7831 in Chrome.\n'
printf 'Optional storage access for downloads:\n\n  termux-setup-storage\n\n'
printf 'For reliable background use, disable Android battery optimization for Termux.\n'
