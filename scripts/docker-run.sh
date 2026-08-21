#!/usr/bin/env bash
set -euo pipefail

project_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
repo_dir=$(cd "$project_dir/.." && pwd)
image=${WORKER_AGENTS_IMAGE:-worker-agents:local}
container=${WORKER_AGENTS_CONTAINER:-worker-agents}
port=${WORKER_AGENTS_PORT:-1456}
public_name=${1:-${WORKER_AGENTS_PUBLIC_NAME:-}}
domain=agentsweb.space

if [[ -z "$public_name" ]]; then
  echo "usage: docker-run.sh <public-name|public-name.$domain>" >&2
  exit 2
fi
public_name=${public_name%.${domain}}
if [[ ! "$public_name" =~ ^[a-z0-9][a-z0-9-]{0,38}$ ]]; then
  echo "Invalid Worker Agents public name: $public_name" >&2
  exit 2
fi
public_host="$public_name.$domain"
public_url="https://$public_host"
proxy_name="$public_name-worker-agents-1456"
tunnel_script="$repo_dir/scripts/frp-tunnel.sh"
tunnel_session="worker-agents-frp-$(printf '%s' "$container" | tr -c 'a-zA-Z0-9-' '-')"

stop_previous_tunnel() {
  tmux kill-session -t "$tunnel_session" 2>/dev/null || true
}

[[ -x "$tunnel_script" ]] || { echo "Missing FRP launcher: $tunnel_script" >&2; exit 1; }
command -v tmux >/dev/null 2>&1 || { echo "tmux is required to own the Docker FRP client" >&2; exit 1; }

docker build --tag "$image" "$project_dir"

stop_previous_tunnel
if docker container inspect "$container" >/dev/null 2>&1; then
  docker rm --force "$container" >/dev/null
fi

docker run --detach \
  --name "$container" \
  --publish "$port:1456" \
  --tmpfs /data:rw,nosuid,nodev \
  --env "AGENT_CONSOLE_PUBLIC_URL=$public_url" \
  "$image" >/dev/null

for attempt in $(seq 1 30); do
  status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")
  if [[ "$status" == "healthy" ]]; then
    break
  fi
  if [[ "$status" == "exited" || "$status" == "dead" ]]; then
    docker logs "$container"
    exit 1
  fi
  sleep 1
done

if [[ "$status" != "healthy" ]]; then
  docker logs "$container"
  printf 'Container did not become healthy (last status: %s)\n' "$status" >&2
  exit 1
fi

tmux new-session -d -s "$tunnel_session" \
  "$tunnel_script" "127.0.0.1:$port" "$proxy_name" "$public_host"
tmux set-option -t "$tunnel_session" remain-on-exit on >/dev/null

for _ in $(seq 1 45); do
  if ! tmux has-session -t "$tunnel_session" 2>/dev/null; then
    echo "Docker FRP tmux session exited before public readiness" >&2
    exit 1
  fi
  pane_dead=$(tmux display-message -p -t "$tunnel_session" '#{pane_dead}')
  if [[ "$pane_dead" == "1" ]]; then
    tmux capture-pane -p -t "$tunnel_session" -S -100 >&2 || true
    stop_previous_tunnel
    exit 1
  fi
  if curl -fsS --max-time 5 "$public_url/api/status" >/dev/null 2>&1; then
    printf 'Worker Agents is healthy: %s\n' "$public_url"
    exit 0
  fi
  sleep 1
done

tmux capture-pane -p -t "$tunnel_session" -S -100 >&2 || true
stop_previous_tunnel
printf 'Public Worker Agents did not become ready: %s\n' "$public_url" >&2
exit 1
