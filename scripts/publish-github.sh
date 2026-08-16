#!/usr/bin/env bash
set -euo pipefail

project_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
git_dir="$project_dir/.git2"
owner=${GITHUB_OWNER:-replypaldevs}
repo=${GITHUB_REPO:-workerAgents}
visibility=${GITHUB_VISIBILITY:-public}
message=${1:-"Publish Worker Agents"}
remote="https://github.com/$owner/$repo.git"

command -v git >/dev/null
command -v gh >/dev/null
gh auth status >/dev/null

wagit() {
  git --git-dir="$git_dir" --work-tree="$project_dir" "$@"
}

if [[ ! -d "$git_dir" ]]; then
  mkdir -p "$git_dir"
  wagit init --initial-branch=main
fi

wagit add --all
if ! wagit diff --cached --quiet; then
  wagit commit -m "$message"
fi

if ! gh repo view "$owner/$repo" >/dev/null 2>&1; then
  gh repo create "$owner/$repo" "--$visibility" \
    --description "🤖 One dashboard, many AI agents, zero terminal tab archaeology." \
    --disable-issues=false
fi

if wagit remote get-url origin >/dev/null 2>&1; then
  wagit remote set-url origin "$remote"
else
  wagit remote add origin "$remote"
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
