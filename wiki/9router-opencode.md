# 9Router and OpenCode notes

Worker Agents can supervise 9Router as a local provider dashboard, OpenCode as an agent UI, and OpenWork as a headless web app backed by 9Router through managed OpenCode, and Agent Zero as a native Python UI backed by 9Router.

Default local ports:

- 9Router provider dashboard: `http://127.0.0.1:20128/dashboard/providers`
- 9Router OpenAI-compatible API: `http://127.0.0.1:20128/v1`

## Worker Agents launch notes

- Worker Agents uses the published `9router-vibefin` npm package. Bootstrap installs it when absent, resolves its exact `package.json`, and pins that package's `app/server.js` before changing the launch `PATH`; do not rediscover it later with `command -v 9router` or `npm root -g` because persistent workers can have `/usr`, `/usr/local`, `/opt/node20`, and `/opt/node22` npm prefixes at the same time.
- If npm installation fails, startup fails clearly; there is no Git/source-build fallback.
- For a manual package diagnostic, run the packaged server with the same modern Node runtime Worker Agents selects:

```bash
/opt/node22/bin/node /opt/node22/lib/node_modules/9router-vibefin/app/server.js
```

- Treat `/api/health` as process readiness only. The integration gate is a successful `GET /v1/models`, followed by a non-streaming `POST /v1/chat/completions`; an incompatible or damaged package can briefly return health before crashing when the database is first used.
- On macOS, 9Router listener detection needs an `lsof`/`netstat` fallback; Linux-only `ss` checks can incorrectly report “not running”.
- OpenCode worker preset: starts near port `18924`
- OpenCode is configured with an explicit `9router` OpenAI-compatible provider from the live `GET /v1/models` response; the built-in `openai` provider is disabled so the worker does not expose or fall back to OpenAI.
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
