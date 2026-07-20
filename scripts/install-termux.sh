#!/data/data/com.termux/files/usr/bin/sh
set -eu

REPO_URL="${ANI_WEB_REPO_URL:-https://github.com/SkaziBavaria/ani-web.git}"
BRANCH="${ANI_WEB_BRANCH:-ani-web-docker}"
INSTALL_DIR="${ANI_WEB_INSTALL_DIR:-$HOME/ani-web}"

fail() {
  printf 'ani-web installer: %s\n' "$1" >&2
  exit 1
}

command -v pkg >/dev/null 2>&1 || fail 'This installer must be run inside Termux.'

printf '\n[1/4] Installing Termux packages...\n'
pkg update -y
pkg install -y git nodejs ani-cli openssl-tool termux-am aria2 ffmpeg

printf '\n[2/4] Installing ani-web in %s...\n' "$INSTALL_DIR"
if [ -d "$INSTALL_DIR/.git" ]; then
  if [ -n "$(git -C "$INSTALL_DIR" status --porcelain)" ]; then
    printf 'Local changes found; leaving the existing checkout unchanged.\n'
  else
    git -C "$INSTALL_DIR" fetch origin "$BRANCH"
    git -C "$INSTALL_DIR" checkout "$BRANCH"
    git -C "$INSTALL_DIR" merge --ff-only "origin/$BRANCH"
  fi
elif [ -e "$INSTALL_DIR" ]; then
  fail "$INSTALL_DIR already exists but is not an ani-web Git checkout. Move it or set ANI_WEB_INSTALL_DIR."
else
  git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$INSTALL_DIR"
fi

printf '\n[3/4] Checking Node and SQLite...\n'
node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 16)) {
    throw new Error(`Node 22.16 or newer is required; installed: ${process.versions.node}`);
  }
  require("node:sqlite");
  console.log(`Node ${process.versions.node} · SQLite OK`);
'

chmod +x "$INSTALL_DIR/start.sh"
ln -sf "$INSTALL_DIR/start.sh" "$PREFIX/bin/ani-web"

printf '\n[4/4] Installation complete.\n\n'
printf 'Start ani-web with:\n\n  ani-web\n\n'
printf 'Then open http://127.0.0.1:7831 in Chrome.\n'
printf 'Optional storage access for downloads:\n\n  termux-setup-storage\n\n'
printf 'For reliable background use, disable Android battery optimization for Termux.\n'
