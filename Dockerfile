ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY migrations ./migrations
RUN pnpm build
RUN pnpm prune --prod

FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache postgresql16-client
COPY --from=build /app/package.json /app/pnpm-lock.yaml ./
COPY LICENSE NOTICE ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "dist/server/main.js"]
