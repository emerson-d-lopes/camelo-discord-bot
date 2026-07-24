# syntax=docker/dockerfile:1

# ---------- build stage: install deps, compile native modules, build TS ----------
# better-sqlite3 and @discordjs/opus are native; ffmpeg-static and
# youtube-dl-exec download binaries in their install scripts. All of that needs
# a toolchain, so it happens here. TypeScript is compiled to dist/, then dev
# dependencies are pruned so only the production tree is carried forward.
# Base image pinned by digest for reproducible, tamper-resistant builds; the
# `docker` Dependabot ecosystem keeps the digest current.
FROM node:26-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS build
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

COPY package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# Compile TypeScript -> dist/, then drop dev deps (tsx, typescript, biome,
# @types) so the runtime image ships only what production needs.
COPY src ./src
RUN pnpm run build \
    && pnpm prune --prod

# ---------- runtime stage: slim, no toolchain, plain `node` on compiled JS ----------
FROM node:26-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Runtime system deps:
#  - python3       : the yt-dlp zipapp youtube-dl-exec downloads needs it
#  - chromium + fonts : price-watcher screenshots (puppeteer-core)
#  - ffmpeg is NOT installed — @discordjs/voice uses the bundled ffmpeg-static
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      chromium \
      fonts-liberation fonts-noto-color-emoji \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Production tree only: pruned node_modules, compiled JS, and package.json
# (needed for ESM "type": "module" resolution). No source, no tsx, no dev deps.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# SQLite lives here; mounted as a Docker-managed volume (see docker-compose.yml).
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]

# Drop root — the whole point of containerizing is to shrink the blast radius.
USER node

# Plain Node on the compiled entrypoint — no tsx at runtime.
CMD ["node", "dist/index.js"]
