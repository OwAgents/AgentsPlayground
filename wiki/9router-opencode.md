# 9Router and OpenCode notes

Worker Agents can supervise 9Router as a local provider dashboard, OpenCode as an agent UI, and OpenWork as a headless web app backed by 9Router through managed OpenCode, and Agent Zero as a native Python UI backed by 9Router.

Default local ports:

- 9Router provider dashboard: `http://127.0.0.1:20128/dashboard/providers`
- 9Router OpenAI-compatible API: `http://127.0.0.1:20128/v1`

## Worker Agents launch notes

- Worker Agents prefers the published npm CLI: `npm i -g 9router@latest --prefer-online`. The bootstrap installs it on first start and launches `$(npm root -g)/9router/app/server.js` (Next.js standalone bundled in the package), so no `git clone` or `npm run build` is needed on the worker.
- If the npm install fails, the bootstrap falls back to cloning `https://github.com/decolua/9router.git` into `~/9router` and building it with `npm install && npm run build`.
- Start the standalone server directly with:

```bash
node .next/standalone/server.js
```

- The standalone server path is resolved at bootstrap runtime; `buildLaunchCommand` also checks `~/.local/lib/node_modules/9router`, `/usr/local/lib/node_modules/9router`, and `/usr/lib/node_modules/9router` before the source checkout.
- On macOS, 9Router listener detection needs an `lsof`/`netstat` fallback; Linux-only `ss` checks can incorrectly report “not running”.
- OpenCode worker preset: starts near port `18924`
- OpenWork worker preset: starts near port `18945` for the web UI and uses the next port for its server. It passes `OPENAI_BASE_URL=http://127.0.0.1:20128/v1`, `OPENAI_API_KEY`, and `OPENCODE_MODEL=opencode/big-pickle` through to managed OpenCode, plus the current public host in `VITE_ALLOWED_HOSTS` for agentsweb access.
- Agent Zero worker preset: starts near port `18955`, clones `agent0ai/agent-zero` to `~/agent-zero`, creates `.venv`, installs `requirements.txt`, and runs `python run_ui.py` directly on the worker. It writes `~/agent-zero-usr/plugins/_model_config/presets.yaml` so chat and utility use 9Router at `http://127.0.0.1:20128/v1`; do not run this preset in Docker on workers.

Quick probe:

```sh
curl -sS http://127.0.0.1:20128/v1/models
```

After health checks, Worker Agents applies open-access settings directly to the 9Router database: `settings.requireLogin=false` and `settings.requireApiKey=false` (9Router 0.5.50 added `requireApiKey` as a separate gate, so disabling only `requireLogin` leaves chat and `/v1` returning `401` without a key). It no longer seeds any provider record, so a worker starts with an empty provider list; add providers with a real key in the dashboard before chat works.

If your 9Router binary uses a different command, override it when starting Worker Agents:

```sh
AGENT_CMD_OPENCLAW='openclaw gateway run --port {port}' npm start
AGENT_CMD_OPENWORK='cd ~/openwork && OPENWORK_REMOTE_ACCESS=1 OPENWORK_WEB_PORT={port} OPENWORK_PORT=18946 pnpm dev:headless-web' npm start
AGENT_CMD_AGENT_ZERO='cd ~/agent-zero && WEB_UI_HOST=127.0.0.1 WEB_UI_PORT={port} .venv/bin/python run_ui.py --host=127.0.0.1 --port={port}' npm start
```
