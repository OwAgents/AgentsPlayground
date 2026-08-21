# Worker Agents

## The machine that launches other machines

Worker Agents is a Node.js control plane for running local AI agents, web tools, routers, file browsers, VNC sessions, and assorted other things that seemed like a good idea at 2 a.m.

It gives you one dashboard, one set of controls, and several independently running agents that may or may not be installing dependencies while claiming to be “ready.”

The default dashboard lives at:

```text
http://127.0.0.1:1456
```

If `PORT` or `AGENT_CONSOLE_PORT` is set, it will use that instead.

## The dashboard, observed in its natural habitat

![Worker Agents dashboard showing agent controls and runtime states](docs/images/dashboard.jpg)

Most “agent dashboard” garbage is either:

- some overengineered Electron abomination;
- a half-dead Electron wrapper that eats 2GB of RAM to show you a terminal; or
- pure vaporware that only works if you sacrifice a goat to Anthropic’s API.

This one is different.

Worker Agents on GitHub is a dead-simple Node control plane that just starts and supervises your local agent UIs.

One web dashboard. You click start. It shows PID, port, logs, and status. You can restart things without copy-pasting 40-character commands like a caveman.

Built-in presets for:

- OpenClaw
- OpenCode
- Codex Web Local
- 9Router
- Hermes WebUI

You can throw any random worker in via `workers.json` and it just works. Port allocation is automatic. Ready-patterns let it know when the thing is up instead of guessing.

```bash
npm install && npm start
```

Dashboard at `http://127.0.0.1:1456`.

That’s it.

No cloud. No telemetry. No “sign up for our beta.” Just a local process manager that doesn’t insult your intelligence.

If you’re already running multiple agent frontends and you’re tired of `kill -9`, remembering ports, and staring at terminal tabs like a sleep-deprived sysadmin, this is one of the least painful solutions available.

## What is this?

Most “AI agent platforms” are a landing page, three buttons, and a promise that the rest of the system is “coming soon.”

Worker Agents is the part where the processes actually get started.

It can:

- install and launch supported agent runtimes;
- assign them private ports;
- monitor their state;
- expose their logs;
- stop, restart, reinstall, and reconnect them;
- route HTTP and WebSocket traffic by hostname;
- provide a shared 9Router model gateway;
- inject shared rules into agent workspaces;
- install skills from the Worker Agents Skills Hub;
- expose a browser-based file manager;
- expose a Web VNC session;
- forward public worker URLs through encoded ports when deployed behind `agentsweb.space`.

In other words, it is a small process supervisor wearing a dashboard costume.

## Included agents

The exact available agents depend on the platform, installed dependencies, and the current alignment of the planets.

The built-in catalog currently includes:

| Agent | Default port | Description |
|---|---:|---|
| 9Router | `20128` | Shared OpenAI-compatible model router |
| DeepSeek Harness | `3080` | DeepSeek web interface |
| Codex Web Local | `18923` | Browser-accessible Codex-style workspace |
| OpenCode | `18924` | OpenCode web interface |
| Hermes WebUI | `18935` | Hermes agent interface |
| Agent Zero | `18955` | Agent Zero web interface |
| OpenClaw Gateway | `18789` | OpenClaw gateway |
| File Browser | `18965` | Browser-based file access |
| Web VNC | `18975` | Remote desktop access through the browser |

Ports are starting points, not sacred scripture. If one is already occupied, Worker Agents searches nearby ports and tells you what happened.

## Requirements

- Node.js `>= 22`
- npm
- A Unix-like environment for the full experience
- Internet access when an agent needs to install itself
- Linux packages and privileges for Web VNC on Linux

Windows support exists through PowerShell launchers. It is not forbidden. It is simply a different path through the forest.

## Install

```bash
npm install
```

The install process prepares the owned 9Router dependency used by Worker Agents.

Then run the control plane:

```bash
npm start
```

Open the dashboard:

```text
http://127.0.0.1:1456
```

## Development mode

For development with automatic restart:

```bash
npm run dev
```

The server watches the source tree and restarts when files change, because manually restarting a process is apparently beneath us now.

## Verify the installation

Syntax checks:

```bash
npm run check
```

Self-check:

```bash
npm run self-check
```

Tests:

```bash
npm test
```

The useful minimum before reporting a successful installation is:

```bash
npm run check
npm test
npm run self-check
```

A dashboard loading in a browser is nice. A dashboard loading while the underlying agents, router, proxy, and WebSocket paths work is better.

## Starting agents

Agents can be launched from the dashboard.

The API also exposes agent lifecycle operations:

```text
POST /api/agents/:id/start
POST /api/agents/:id/stop
POST /api/agents/:id/restart
POST /api/agents/:id/reinstall
```

For example:

```bash
curl -X POST http://127.0.0.1:1456/api/agents/opencode/start
```

The status endpoint is:

```text
GET /api/status
```

Example:

```bash
curl http://127.0.0.1:1456/api/status
```

The server reports the router, installed agents, current state, ports, URLs, and recent logs.

“Installed” means installed.

“Running” means running.

“Working” means somebody actually opened it and received a response.

These are three different things.

## 9Router

Worker Agents owns a local 9Router instance on port `20128`.

The router exposes an OpenAI-compatible API, including:

```text
GET  /v1/models
POST /v1/chat/completions
```

Check the model catalog:

```bash
curl http://127.0.0.1:20128/v1/models
```

The configured model catalog is shared with supported agents so that every interface does not invent its own model list and then quietly fail later.

## Routing

Locally, agent interfaces are available through stable hostnames such as:

```text
http://opencode.localhost:1456
http://hermes.localhost:1456
http://filebrowser.localhost:1456
```

The dashboard routes requests based on the hostname and forwards them to the agent’s current private port.

This means an agent can move from one private port to another without requiring a new public URL every time it sneezes.

When deployed behind the Worker Agents public broker, child ports are represented in the hostname:

```text
https://worker-name-18924.agentsweb.space
```

The port is decoded by Worker Agents and proxied to the corresponding local listener.

The public URL is not magic. It requires:

1. the agent to be installed;
2. the agent to be running;
3. the target port to be listening;
4. the Worker Agents server to be reachable;
5. the tunnel or broker registration to exist;
6. the public hostname to resolve;
7. the browser to receive an actual response.

If one of those steps is missing, you get a page that looks like infrastructure.

## Custom workers

Custom workers can be declared in an untracked `workers.json` file at the repository root.

Example:

```json
[
  {
    "id": "my-worker",
    "name": "My Worker",
    "basePort": 19000,
    "command": "node ./workers/my-worker.js --port {port}",
    "readyPatterns": [
      "listening",
      "ready"
    ]
  }
]
```

Supported fields include:

- `id`
- `name`
- `basePort`
- `path`
- `command`
- `readyPatterns`

Use `{port}` in the command when the worker needs to receive its assigned port.

The file is intentionally untracked. Your local collection of questionable processes belongs to you.

## Shared rules

Worker Agents can reconcile shared rules into supported agent workspaces.

The template is:

```text
Rules.template.md
```

Rules are meant to establish common behavior across agents instead of requiring every runtime to rediscover the same instructions independently.

This is especially useful when several agent frontends share:

- the same model router;
- the same worker;
- the same project directory;
- the same public deployment;
- the same expectations about tool usage and responses.

A rule file is not a force field. An agent can still ignore it. At least now you can determine whether it was installed.

## Skills Hub

Worker Agents includes a local Skills Hub for discovering and managing agent skills.

The skill system supports:

- listing available skills;
- searching for skills;
- installing skills;
- reading installed skill metadata;
- removing skills;
- checking the current baseline.

The bundled baseline skill sources are published in the
[agents-dev/skills](https://github.com/agents-dev/skills) repository. Skills are
installed into the configured Worker Agents environment and can then be
reconciled into supported agents. Worker Agents discovers every
`skills/<name>/SKILL.md` in that repository at runtime, so adding a skill there
does not require updating a second manifest.

## File Browser

The File Browser agent provides browser-based access to the worker’s files.

It is useful for:

- downloading generated artifacts;
- inspecting logs;
- uploading files;
- checking screenshots;
- navigating work directories;
- confirming that a process really created the thing it claimed to create.

The File Browser is not a security boundary. Do not expose it publicly and then act surprised when the public discovers your files.

## Web VNC

Web VNC provides browser access to a graphical desktop session.

On Linux, Worker Agents may install required desktop and VNC dependencies directly when running with sufficient privileges. On non-root systems, passwordless `sudo` may be required.

A successful HTTP response from the VNC page is not proof that the desktop connection works. The browser must establish the actual VNC/WebSocket session.

The final test is not “the HTML loaded.”

The final test is “the desktop is visible and the session stays connected.”

## Docker

The Docker launcher publishes the Worker Agents dashboard on port `1456`.

```bash
./scripts/docker-run.sh
```

Local agent routing continues through stable hostnames, allowing the dashboard to forward requests to the current private agent ports without requiring a separate Docker port mapping for every agent.

Because mapping every port manually is how people end up maintaining a spreadsheet called `final-final-ports.xlsx`.

## Windows

PowerShell launchers are provided:

```powershell
npm run start:windows
```

Clean 9Router state:

```powershell
npm run start:windows:clean-9router
```

Clean OpenCode state:

```powershell
npm run start:windows:clean-opencode
```

Clean everything:

```powershell
npm run start:windows:clean-all
```

## Configuration

Useful environment variables include:

```text
PORT
AGENT_CONSOLE_PORT
AGENT_CONSOLE_HOST
AGENT_LAUNCH
AGENT_AUTO_START
AGENT_PORT_SCAN_RANGE
WORKER_AGENTS_SOURCE
WORKER_AGENTS_9ROUTER_NPM_PACKAGE
OPENWORK_PUBLIC_HOST
VITE_ALLOWED_HOSTS
OPENCLAW_CONFIG_PATH
HERMES_AGENT_DIR
WEB_VNC_PASSWORD_FILE
```

The defaults are designed for local workers. Public deployments should configure their advertised hostname, proxy headers, authentication, and tunnel separately.

Do not confuse a local working URL with a public working URL. They are related, but they are not the same animal.

## Repository layout

```text
src/
  server.js       HTTP server, dashboard, routing, and public API
  agents.js       agent definitions, installation, supervision, and lifecycle
  9router.js      9Router startup and model gateway integration
  rules.js        shared rule reconciliation
  skill-hub.js    skill discovery and installation
  setup.js        host setup and SSH support
  auth.js         authentication helpers
  config.js       environment and runtime configuration

public/
  dashboard frontend

scripts/
  self-check and launch utilities

test/
  unit and integration tests

wiki/
  operational notes and deeper documentation
```

## License

MIT. See [LICENSE](LICENSE).
