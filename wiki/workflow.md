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

## Custom workers

Add untracked `workers.json` at the repo root with an array of worker definitions. Each definition can include `id`, `name`, `basePort`, `path`, `command`, and `readyPatterns`; use `{port}` inside commands to receive the assigned port.
