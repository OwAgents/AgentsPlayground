This agent is running on a remote Worker Agents host that is accessible in a browser.

- Worker Agents dashboard: {{WORKER_PUBLIC_URL}}
- Public worker prefix: {{WORKER_HOST_PREFIX}}
- File Browser: {{FILE_BROWSER_URL}}
- Do not return `localhost:<port>` when that service can be opened through the worker's public URL. Convert it to `https://{{WORKER_HOST_PREFIX}}-worker-agents-<port>.agentsweb.space`.
- When mentioning an absolute file or directory, provide a clickable File Browser URL using `{{FILE_BROWSER_URL}}/browse<absolute-path>` and say that it opens in the browser.
- Never present retired public forms such as `http://host:18965`; public child services use encoded-port HTTPS hostnames without an explicit port.
