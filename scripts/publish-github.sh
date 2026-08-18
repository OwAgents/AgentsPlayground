#!/usr/bin/env bash
set -euo pipefail

project_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
git_dir="$project_dir/.git2"
owner=${GITHUB_OWNER:-replypaldevs}
repo=${GITHUB_REPO:-workerAgents}
visibility=${GITHUB_VISIBILITY:-public}
mode=${1:-}
message=${1:-}
remote="https://github.com/$owner/$repo.git"

if [[ "$mode" == "--require-clean" ]]; then
  message=""
elif [[ -z "$message" || "$message" != *$'\n\n'* ]]; then
  echo "Usage: $0 --require-clean" >&2
  echo "   or: $0 \$'Subject\\n\\nContext, rationale, changes, verification, and caveats'" >&2
  echo "Explicit publish commits require a subject and multi-paragraph body." >&2
  exit 2
fi

command -v git >/dev/null
command -v gh >/dev/null
gh auth status >/dev/null

wagit() {
  git --git-dir="$git_dir" --work-tree="$project_dir" "$@"
}

if ! gh repo view "$owner/$repo" >/dev/null 2>&1; then
  gh repo create "$owner/$repo" "--$visibility" \
    --description "🤖 One dashboard, many AI agents, zero terminal tab archaeology." \
    --disable-issues=false
fi

if [[ ! -d "$git_dir" ]]; then
  mkdir -p "$git_dir"
  wagit init --initial-branch=main
fi

if wagit remote get-url origin >/dev/null 2>&1; then
  wagit remote set-url origin "$remote"
else
  wagit remote add origin "$remote"
fi

# A detached outer worktree may not contain the ignored .git2 metadata. Always
# seed the independent index from the current public branch before snapshotting
# this directory, so a fresh worktree produces a fast-forward commit rather
# than an unrelated root history. The filesystem remains the source of truth.
if wagit fetch --depth=1 origin main; then
  wagit reset --mixed FETCH_HEAD >/dev/null
fi

wagit add --all
if ! wagit diff --cached --quiet; then
  if [[ "$mode" == "--require-clean" ]]; then
    echo "Worker Agents has unpublished standalone changes:" >&2
    wagit diff --cached --name-status >&2
    wagit reset >/dev/null
    echo "Publish them explicitly with a detailed commit message before deployment." >&2
    exit 1
  fi
  wagit commit -m "$message"
fi

wagit push --set-upstream origin main

gh repo edit "$owner/$repo" \
  --description "🤖 One dashboard, many AI agents, zero terminal tab archaeology." \
  --add-topic ai-agents \
  --add-topic agent-orchestration \
  --add-topic nodejs \
  --add-topic docker \
  --add-topic self-hosted \
  --add-topic developer-tools \
  --add-topic opencode \
  --add-topic openclaw

printf 'Published %s with independent metadata in %s\n' "$remote" "$git_dir"
