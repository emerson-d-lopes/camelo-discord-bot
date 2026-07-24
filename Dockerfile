# syntax=docker/dockerfile:1

# ---------- build stage: install deps + compile native modules ----------
# better-sqlite3 and @discordjs/opus are native; ffmpeg-static and
# youtube-dl-exec download binaries in their install scripts. All of that needs
# a toolchain, so it happens here and only node_modules is carried forward.
FROM node:24-bookworm-slim AS build
WORKDIR /app

# Toolchain for node-gyp native builds (better-sqlite3, @discordjs/opus).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# pnpm via corepack, pinned by the packageManager field.
RUN corepack enable

# Install with the lockfile first for layer caching. Build scripts are allowed
# so the native + downloaded binaries are produced (see pnpm.onlyBuiltDependencies).
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .

# ---------- runtime stage: slim image, no toolchain ----------
FROM node:24-bookworm-slim AS runtime
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

# Point the screenshot module at the distro Chromium.
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Bring over the already-built dependency tree and the source.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app ./

# SQLite lives here; declared so it can be a mounted volume.
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]

# Drop root — the whole point of containerizing is to shrink the blast radius.
USER node

# tsx runs the TypeScript entrypoint directly (no separate build step).
CMD ["node", "--import", "tsx", "src/index.ts"]
