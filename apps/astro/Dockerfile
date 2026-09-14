# Monorepo: der Connector wird mitgebaut, Build-Kontext ist die Repo-Wurzel.
FROM node:22-alpine AS build
WORKDIR /repo

COPY packages/ai-automation-connector/package.json packages/ai-automation-connector/tsconfig.json ./packages/ai-automation-connector/
COPY packages/ai-automation-connector/src ./packages/ai-automation-connector/src
RUN cd packages/ai-automation-connector && npm install --no-audit --no-fund && npm run build

COPY apps/astro/package.json ./apps/astro/
RUN cd apps/astro && npm install --no-audit --no-fund
COPY apps/astro ./apps/astro
RUN cd apps/astro && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /repo/apps/astro/dist ./dist
COPY --from=build /repo/apps/astro/node_modules ./node_modules
COPY --from=build /repo/apps/astro/package.json ./package.json
# Die Vorlage liest Beitraege aus public/data/posts relativ zum Arbeits-
# verzeichnis. Die Ausgangsdaten kommen mit ins Image, damit die Seite auch
# ohne Volume etwas zeigt.
COPY --from=build /repo/apps/astro/public ./public

EXPOSE 8080
# POSTS_DIR zeigt auf das Railway-Volume: ohne das waeren gelieferte Artikel
# beim naechsten Deploy weg. Die Beispielbeitraege der Vorlage wandern beim
# ersten Start hinein, damit die Seite von Anfang an etwas zeigt.
ENV POSTS_DIR=/data/posts
CMD ["sh", "-c", "  mkdir -p \"$POSTS_DIR\";   cp -rn ./public/data/posts/. \"$POSTS_DIR\"/ 2>/dev/null || true;   HOST=0.0.0.0 PORT=${PORT:-8080} node ./dist/server/entry.mjs"]
