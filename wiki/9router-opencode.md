# 9Router and OpenCode notes

Worker Agents can supervise 9Router as a local provider dashboard, OpenCode as an agent UI, and Agent Zero as a native Python UI backed by 9Router.

Default local ports:

- 9Router provider dashboard: `http://127.0.0.1:20128/dashboard/providers`
- 9Router OpenAI-compatible API: `http://127.0.0.1:20128/v1`

## Worker Agents launch notes

- Worker Agents owns `9router-vibefin` as the exact `0.5.51` dependency in `package-lock.json`. Deployment runs `npm ci`, and runtime launches only `workerAgents/node_modules/9router-vibefin/app/server.js` with the same Node executable as Worker Agents. Global npm prefixes, `command -v`, `npm root -g`, and Git/source-build fallbacks are not consulted.
- Node.js 22 or newer is required so Worker Agents and 9Router share one runtime contract and the built-in SQLite API.
- For a manual package diagnostic from the Worker Agents checkout, run:

```bash
node node_modules/9router-vibefin/app/server.js
```

- Treat 9Router `/api/health` as process liveness only. Worker Agents becomes ready only after local `GET /v1/models` returns a non-empty catalog; public deployment then requires Worker Agents `/api/ready`, public `GET /v1/models`, and a non-streaming `POST /v1/chat/completions` canary.
- On macOS, 9Router listener detection needs an `lsof`/`netstat` fallback; Linux-only `ss` checks can incorrectly report “not running”.
- OpenCode worker preset: starts near port `18924`
- OpenCode is configured with an explicit `9router` OpenAI-compatible provider from the live `GET /v1/models` response; the built-in `openai` provider is disabled so the worker does not expose or fall back to OpenAI.
- Agent Zero worker preset: starts near port `18955`, clones `agent0ai/agent-zero` to `~/agent-zero`, creates `.venv`, installs `requirements.txt`, and runs `python run_ui.py` directly on the worker. It writes `~/agent-zero-usr/plugins/_model_config/presets.yaml` so chat and utility use 9Router at `http://127.0.0.1:20128/v1`; do not run this preset in Docker on workers.

Quick probe:

```sh
curl -sS http://127.0.0.1:20128/v1/models
```

After health checks, Worker Agents applies open-access settings directly to the 9Router database: `settings.requireLogin=false` and `settings.requireApiKey=false` (9Router 0.5.50 added `requireApiKey` as a separate gate, so disabling only `requireLogin` leaves chat and `/v1` returning `401` without a key). It no longer seeds any provider record, so a worker starts with an empty provider list; add providers with a real key in the dashboard before chat works.

If your 9Router binary uses a different command, override it when starting Worker Agents:

```sh
AGENT_CMD_OPENCLAW='openclaw gateway run --port {port}' npm start
AGENT_CMD_AGENT_ZERO='cd ~/agent-zero && WEB_UI_HOST=127.0.0.1 WEB_UI_PORT={port} .venv/bin/python run_ui.py --host=127.0.0.1 --port={port}' npm start
```
