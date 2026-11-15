# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS base
WORKDIR /app
ENV npm_config_update_notifier=false

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.server.json tsconfig.client.json vite.config.ts index.html ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production
RUN apk add --no-cache tini \
  && addgroup -S places \
  && adduser -S places -G places
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
RUN mkdir -p /app/data/exports \
  && chown -R places:places /app
USER places
EXPOSE 3001
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server/index.js"]
