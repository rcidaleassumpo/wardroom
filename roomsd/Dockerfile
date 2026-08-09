FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    ROOMS_TRANSPORT=tcp \
    ROOMS_HOST=0.0.0.0 \
    ROOMS_PORT=43170 \
    ROOMS_DB_PATH=/data/rooms.sqlite

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY docker/healthcheck.mjs ./docker/healthcheck.mjs

RUN groupadd --system roomsd && useradd --system --gid roomsd --home-dir /app --no-create-home roomsd \
    && mkdir -p /data \
    && chown -R roomsd:roomsd /app /data
USER roomsd

EXPOSE 43170
VOLUME ["/data"]
CMD ["node", "dist/src/runtime/native/main.js"]
