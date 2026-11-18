FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json server.ts ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY docs ./docs

RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/docs ./docs
COPY --from=builder /app/scripts ./scripts

EXPOSE 8080

CMD ["node", "dist/server.mjs"]
