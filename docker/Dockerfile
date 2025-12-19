# Build stage
FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun build src/index.ts --outdir dist --target bun

# Production stage
FROM oven/bun:1-slim
WORKDIR /app
RUN addgroup --system --gid 1001 isambard && \
    adduser --system --uid 1001 isambard
COPY --from=builder --chown=isambard:isambard /app/dist ./dist
COPY --from=builder --chown=isambard:isambard /app/package.json ./
USER isambard
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://localhost:3000/health || exit 1
CMD ["bun", "run", "dist/index.js"]
