# Worker Agents workflow

## Verify

```bash
npm run check
```

## Local run

```bash
npm start
```

The default console URL is `http://127.0.0.1:1456` unless `PORT` is set.

Web VNC installs Linux desktop packages directly with `apt-get` when Worker Agents runs as root, including in Docker. On non-root Linux hosts it uses passwordless `sudo -n`. The static server must serve SVG icons as `image/svg+xml` so browsers render them as images.

The Docker launcher publishes only the Worker Agents dashboard (`1456`). Local Open actions use `<agent-id>.localhost:1456`; host-based HTTP and WebSocket routing forwards each stable hostname to its current private port. This also supports root-relative frontend assets without adding one Docker port mapping per agent.

## Custom workers

Add untracked `workers.json` at the repo root with an array of worker definitions. Each definition can include `id`, `name`, `basePort`, `path`, `command`, and `readyPatterns`; use `{port}` inside commands to receive the assigned port.
