#!/usr/bin/env bash
set -euo pipefail

project_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
image=${WORKER_AGENTS_IMAGE:-worker-agents:local}
container=${WORKER_AGENTS_CONTAINER:-worker-agents}
port=${WORKER_AGENTS_PORT:-1456}

docker build --tag "$image" "$project_dir"

if docker container inspect "$container" >/dev/null 2>&1; then
  docker rm --force "$container" >/dev/null
fi

docker run --detach \
  --name "$container" \
  --publish "$port:1456" \
  --volume worker-agents-data:/data \
  "$image" >/dev/null

for attempt in $(seq 1 30); do
  status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")
  if [[ "$status" == "healthy" ]]; then
    printf 'Worker Agents is healthy: http://127.0.0.1:%s\n' "$port"
    exit 0
  fi
  if [[ "$status" == "exited" || "$status" == "dead" ]]; then
    docker logs "$container"
    exit 1
  fi
  sleep 1
done

docker logs "$container"
printf 'Container did not become healthy (last status: %s)\n' "$status" >&2
exit 1
