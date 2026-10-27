# syntax=docker/dockerfile:1
FROM node:26.12.1-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY static ./static
RUN npm run build

# The bundle has no runtime dependencies, so the final image is just Node + dist.
FROM node:26.12.1-alpine
ENV NODE_ENV=production \
    PORT=8740 \
    SPRITELOOM_DATA_DIR=/app/data
WORKDIR /app
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 8740
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8740/healthz >/dev/null || exit 1
CMD ["node", "--enable-source-maps", "dist/server.js"]
