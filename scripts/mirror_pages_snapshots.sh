#!/usr/bin/env bash
set -euo pipefail

source_dir="$(cd "$1" && pwd)"
branch=snapshots-v1
python - "$source_dir" "$GITHUB_SHA" <<'PY'
import hashlib
import json
from pathlib import Path
import re
import sys

root = Path(sys.argv[1])
manifest = json.loads((root / "manifest.json").read_bytes())
if manifest["schema_version"] != 1 or manifest["commit_sha"] != sys.argv[2]:
    raise SystemExit("Snapshot artifact does not match the deployed revision")
expected = {"manifest.json"}
for item in manifest["instruments"]:
    symbol = item["symbol"]
    if not re.fullmatch(r"(?:sh|sz)[0-9]{6}", symbol):
        raise SystemExit("Invalid symbol in snapshot manifest")
    for key in ("latest", "history"):
        relative = f"{symbol}/{key}.json"
        if item[key] != relative or hashlib.sha256((root / relative).read_bytes()).hexdigest() != item["sha256"][relative]:
            raise SystemExit(f"Snapshot checksum or path mismatch: {relative}")
        expected.add(relative)
if {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()} != expected:
    raise SystemExit("Unexpected files in snapshot artifact")
PY

mirror="$(mktemp -d)"
trap 'git worktree remove --force "$mirror" 2>/dev/null || rmdir "$mirror"' EXIT
if git ls-remote --exit-code origin "refs/heads/$branch" >/dev/null; then
  git fetch --no-tags origin "refs/heads/$branch"
  git worktree add --detach "$mirror" FETCH_HEAD
else
  result=$?
  if [[ $result != 2 ]]; then exit "$result"; fi
  git worktree add --detach "$mirror" HEAD
  git -C "$mirror" switch --orphan "$branch"
fi
git -C "$mirror" rm -r --ignore-unmatch data/v1
mkdir -p "$mirror/data/v1"
cp -R "$source_dir/." "$mirror/data/v1/"
git -C "$mirror" add --force --all -- data/v1
if git -C "$mirror" diff --cached --quiet; then exit 0; fi
git -C "$mirror" -c user.name='github-actions[bot]' \
  -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
  commit -m "Refresh daily snapshot JSON from $GITHUB_SHA"
git -C "$mirror" push origin "HEAD:refs/heads/$branch"
