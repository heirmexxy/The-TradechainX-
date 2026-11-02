# TradeChainX web image. Build from the repo root:
#   docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_API_URL=https://api.tradechainx.com … .
# NEXT_PUBLIC_* values are baked into the browser bundle at build time — they are public, never secrets.
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @tradechainx/web...
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web

ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_CHAIN_ID
ARG NEXT_PUBLIC_RPC_URL
ARG NEXT_PUBLIC_WALLET_PROVIDER
ARG NEXT_PUBLIC_GAS_MODE
ARG NEXT_PUBLIC_GAS_MIN_BALANCE=0.05
ARG NEXT_PUBLIC_PRIVY_APP_ID
ARG NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID
ARG NEXT_PUBLIC_SEQUENCE_PROJECT_ACCESS_KEY
ARG NEXT_PUBLIC_SEQUENCE_WAAS_CONFIG_KEY
ARG NEXT_PUBLIC_SEQUENCE_NETWORK
ENV NEXT_TELEMETRY_DISABLED=1
RUN test -n "$NEXT_PUBLIC_API_URL" && test -n "$NEXT_PUBLIC_CHAIN_ID" && test -n "$NEXT_PUBLIC_WALLET_PROVIDER" \
  || (echo "Missing NEXT_PUBLIC_* build args" && exit 1)
RUN pnpm --filter @tradechainx/web build

FROM node:22-bookworm-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN groupadd -r app && useradd -r -g app app
COPY --from=build --chown=app:app /app/apps/web/.next/standalone ./
COPY --from=build --chown=app:app /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=app:app /app/apps/web/public ./apps/web/public
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
