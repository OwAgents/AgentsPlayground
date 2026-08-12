FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git openssh-client procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY filebrowser/package.json filebrowser/package-lock.json ./filebrowser/
RUN npm ci --omit=dev && npm --prefix filebrowser ci --omit=dev

COPY . .

ENV AGENT_CONSOLE_HOST=0.0.0.0 \
    AGENT_CONSOLE_PORT=1456 \
    WORKER_AGENTS_STATE_DIR=/data/state \
    WORKER_AGENTS_SKILLS_DIR=/data/skills

EXPOSE 1456
VOLUME ["/data"]

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:1456/api/status').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "start"]
