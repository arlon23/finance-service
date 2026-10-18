FROM oven/bun:1.4.3-alpine AS deps

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.4.3-alpine AS builder

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN bun run build

FROM oven/bun:1.4.3-alpine AS runner

ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

COPY --chown=bun:bun package.json bun.lock ./
RUN chown bun:bun /app
USER bun
RUN bun install --frozen-lockfile --production

COPY --from=builder --chown=bun:bun /app/dist ./dist

EXPOSE 3000
CMD ["bun", "run", "start:prod"]
