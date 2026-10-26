FROM node:22-bookworm-slim AS ui
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY index.html vite.config.ts tsconfig.json ./
COPY src ./src
RUN npm run build:ui

FROM oven/bun:1.4.4 AS gateway
WORKDIR /src
COPY backend ./backend
COPY vendor/bridge ./vendor/bridge
COPY vendor/protocols ./vendor/protocols
COPY relays ./relays
RUN bun build backend/main.ts --target bun --outfile /out/gateway.js && bun build backend/manage.ts --target bun --outfile /out/manage.js

FROM oven/bun:1.4.4
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=gateway /out /app/build
COPY --from=ui /src/dist /app/dist
COPY relays /app/relays
COPY THIRD_PARTY_NOTICES.md /app/
COPY vendor/bridge/LICENSE /app/vendor/bridge/LICENSE
COPY vendor/protocols/LICENSE /app/vendor/protocols/LICENSE
COPY vendor/licenses /app/vendor/licenses
RUN mkdir /data && chown bun:bun /data && chmod 0700 /data
ENV POLYGATE_APP_DIR=/app POLYGATE_HOST=0.0.0.0 POLYGATE_PORT=4317 POLYGATE_STATE=/data POLYGATE_UI_DIST=/app/dist POLYGATE_ALLOWED_HOSTS=*
USER bun
VOLUME ["/data"]
EXPOSE 4317 80 443
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s CMD /usr/local/bin/bun /app/build/manage.js request /healthz </dev/null >/dev/null || exit 1
CMD ["bun", "build/gateway.js"]
