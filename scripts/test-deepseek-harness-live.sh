#!/usr/bin/env bash
set -euo pipefail

: "${WORKER_SSH:?Set WORKER_SSH to the live worker SSH command}"
: "${WORKER_AGENTS_URL:?Set WORKER_AGENTS_URL to the public Worker Agents URL}"

public_url=${WORKER_AGENTS_URL%/}
public_host=${public_url#http://}
public_host=${public_host#https://}
public_host=${public_host%%/*}
harness_dir=${DEEPSEEK_HARNESS_DIR:-/tmp/deepseek-harness}
harness_port=${DEEPSEEK_HARNESS_PORT:-3080}

remote_script=$(cat <<EOF
set -euo pipefail
command -v node >/dev/null
command -v git >/dev/null
command -v pnpm >/dev/null || npm install -g pnpm@11.7.0
rm -rf "$harness_dir"
git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git "$harness_dir"
cd "$harness_dir"
pnpm install --frozen-lockfile
python3 - <<'PY'
from pathlib import Path
for name in ('packages/client/connection/src/index.ts',):
    path = Path(name)
    text = path.read_text()
    old = '!isTrustedApiRequest(request, [])'
    new = '!isTrustedApiRequest(request, trustedHosts)'
    if old not in text:
        raise SystemExit(f'expected privileged trust guard not found in {path}')
    path.write_text(text.replace(old, new))
PY
pnpm build
pkill -f '[a]pps/cli/src/bin.ts web' 2>/dev/null || true
nohup pnpm dsh web --host 127.0.0.1 --port "$harness_port" --trusted-host "$public_host" > "\$HOME/deepseek-harness.log" 2>&1 &
for _ in \$(seq 1 30); do
  curl -fsS "http://127.0.0.1:$harness_port/" >/dev/null && break
  sleep 2
done
curl -fsS "http://127.0.0.1:$harness_port/" >/dev/null
curl -fsS "http://127.0.0.1:20128/v1/models" | grep -q 'oc/deepseek-v4-flash-free'
echo deepseek_harness_local=ok
EOF
)

printf '%s\n' "$remote_script" | eval "$WORKER_SSH bash -s"

rpc_body=$(curl -fsS -X POST "$public_url/api/settings.describe" \
  -H 'content-type: application/json' \
  -H "origin: $public_url" \
  -H 'sec-fetch-site: same-origin' \
  --data '{"type":"client-request","rpcId":"live-test","method":"settings.describe","payload":{}}')
grep -q '"ok":true' <<<"$rpc_body"
printf 'deepseek_harness_public_settings=ok\n'
printf 'deepseek_harness_public_url=%s\n' "$public_url"
