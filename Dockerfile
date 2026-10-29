# syntax=docker/dockerfile:1

# ---- build: compile TypeScript and install production dependencies ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 falls back to a source build when no prebuilt binary matches (e.g. some arm boards).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime: no compilers, non-root ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    MAIL_ME_CONFIG=/app/config.json
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]
ENTRYPOINT ["node", "dist/index.js"]
CMD ["start"]
