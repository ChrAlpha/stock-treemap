# Self-hosted image: Node, the server bundle and the client build; no node_modules.
#
#   docker build -t stock-treemap .
#   docker run -p 127.0.0.1:3000:3000 -v stock-treemap:/data stock-treemap
#
# The build stage runs on the builder's own platform and emits plain JavaScript,
# and the runtime stage runs no commands, so multi-platform builds need no emulation.

FROM --platform=$BUILDPLATFORM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build:server && mkdir /data

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/data
COPY --from=build /app/dist/server dist/server
COPY --from=build /app/dist/client dist/client
COPY --from=build --chown=node:node /data /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q --spider "http://127.0.0.1:${PORT}/" || exit 1
CMD ["node", "dist/server/index.mjs"]
