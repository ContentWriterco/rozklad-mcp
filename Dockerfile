FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
COPY scripts ./scripts
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production ROZKLAD_CACHE_DIR=/data PORT=3000 HOST=0.0.0.0
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY feeds ./feeds
COPY package.json README.md LICENSE ./
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000
USER node
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "dist/index.js", "--http"]
