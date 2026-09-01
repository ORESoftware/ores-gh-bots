FROM node:22.16.0-bookworm AS build
WORKDIR /app
ENV NODE_ENV=production
COPY . .
RUN npm ci --omit=dev

FROM node:22.16.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json .cli-flags.toml ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY config ./config
RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "apps/orchestrator/src/main.mjs"]
