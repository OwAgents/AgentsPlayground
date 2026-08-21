FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl dbus-x11 fluxbox git libfuse-dev libfuse2 lsof \
      novnc openssh-client pkg-config procps python3 python3-venv websockify x11vnc xterm xvfb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY filebrowser/package.json filebrowser/package-lock.json ./filebrowser/
COPY scripts/prepare-owned-9router.mjs scripts/node-file-polyfill.cjs ./scripts/
COPY src/config.js src/9router.js ./src/
RUN npm ci --omit=dev && npm --prefix filebrowser ci --omit=dev

COPY . .

ENV AGENT_CONSOLE_HOST=0.0.0.0 \
    AGENT_CONSOLE_PORT=1456 \
    WORKER_AGENTS_STATE_DIR=/data/state

EXPOSE 1456

HEALTHCHECK --interval=10s --timeout=10s --start-period=15s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:1456/api/status').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "start"]
