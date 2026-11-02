# TradeChainX API + indexer image. Build from the repo root:
#   docker build -f apps/api/Dockerfile -t tradechainx-api .
# Requires pnpm-lock.yaml at the repo root (run `pnpm install` once and commit it).
FROM node:22-bookworm-slim AS deps
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @tradechainx/api...

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY package.json pnpm-workspace.yaml ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
WORKDIR /app/apps/api
RUN groupadd -r app && useradd -r -g app app && mkdir -p storage && chown app:app storage
USER app
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:4000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# The indexer uses the same image: command ["node","--import","tsx","src/indexer/run.ts"]
CMD ["node", "--import", "tsx", "src/server.ts"]
