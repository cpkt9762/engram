#!/usr/bin/env bash
# Regenerates the patch series in this directory from the current branch.
#
# Run this after every rebase onto a newer upstream/main, so the .patch files
# on GitHub keep matching the commits they document. Commits that only touch
# docs/fork-patches/ are skipped, otherwise this directory would document
# itself and the numbering would drift on every run.
#
#   ./docs/fork-patches/regenerate.sh              # against upstream/main
#   ./docs/fork-patches/regenerate.sh v1.21.0      # against a tag instead
set -euo pipefail

BASE="${1:-upstream/main}"
OUT="$(cd "$(dirname "$0")" && pwd)"
REPO="$(git -C "$OUT" rev-parse --show-toplevel)"
cd "$REPO"

if ! git rev-parse --verify --quiet "$BASE" >/dev/null; then
    echo "base '$BASE' not found; run: git fetch upstream" >&2
    exit 1
fi

# Commits that carry actual fork changes, oldest first. Kept as a newline
# separated string rather than an array so this also runs on the bash 3.2 that
# ships with macOS.
COMMITS="$(git rev-list --reverse "$BASE..HEAD" -- . ':(exclude)docs/fork-patches')"

if [ -z "$COMMITS" ]; then
    echo "no fork commits found on top of $BASE" >&2
    exit 1
fi

rm -f "$OUT"/[0-9][0-9][0-9][0-9]-*.patch

n=1
for c in $COMMITS; do
    git format-patch -1 "$c" --start-number="$n" --output-directory="$OUT" \
        --no-signature >/dev/null
    n=$((n + 1))
done

echo "base:    $BASE ($(git rev-parse --short "$BASE"))"
echo "patches: $((n - 1)) written to ${OUT#"$REPO"/}"
ls -1 "$OUT"/[0-9][0-9][0-9][0-9]-*.patch | xargs -n1 basename | sed 's/^/  /'
