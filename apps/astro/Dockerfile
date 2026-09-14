# Monorepo: der Connector wird mitgebaut, deshalb ist der Build-Kontext die
# Repo-Wurzel (siehe railway.json -> dockerfilePath + der Build-Kontext ".").
FROM node:22-alpine AS build
WORKDIR /repo

COPY packages/connector-node/package.json packages/connector-node/tsconfig.json ./packages/connector-node/
COPY packages/connector-node/src ./packages/connector-node/src
RUN cd packages/connector-node && npm install --no-audit --no-fund && npm run build

COPY apps/astro/package.json ./apps/astro/
RUN cd apps/astro && npm install --no-audit --no-fund
COPY apps/astro ./apps/astro
RUN cd apps/astro && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# Das Content-Verzeichnis MUSS auf einem Railway-Volume liegen, sonst sind die
# Artikel nach dem naechsten Deploy weg.
ENV CONTENT_DIR=/data/content
COPY --from=build /repo/apps/astro/dist ./dist
COPY --from=build /repo/apps/astro/node_modules ./node_modules
COPY --from=build /repo/apps/astro/package.json ./package.json
EXPOSE 8080
CMD ["sh", "-c", "HOST=0.0.0.0 PORT=${PORT:-8080} node ./dist/server/entry.mjs"]
