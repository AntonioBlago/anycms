FROM node:22-alpine AS build
WORKDIR /repo

COPY packages/connector-node/package.json packages/connector-node/tsconfig.json ./packages/connector-node/
COPY packages/connector-node/src ./packages/connector-node/src
RUN cd packages/connector-node && npm install --no-audit --no-fund && npm run build

COPY apps/nextjs/package.json ./apps/nextjs/
RUN cd apps/nextjs && npm install --no-audit --no-fund
COPY apps/nextjs ./apps/nextjs
RUN cd apps/nextjs && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV CONTENT_DIR=/data/content
# `output: standalone` legt einen fertigen Server samt noetiger Module ab.
COPY --from=build /repo/apps/nextjs/.next/standalone ./
COPY --from=build /repo/apps/nextjs/.next/static ./apps/nextjs/.next/static
EXPOSE 8080
CMD ["sh", "-c", "HOSTNAME=0.0.0.0 PORT=${PORT:-8080} node apps/nextjs/server.js"]
