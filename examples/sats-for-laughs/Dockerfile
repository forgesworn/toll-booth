# Stage 1: Build toll-booth from source
FROM node:22-slim AS toll-booth-build
# better-sqlite3 13 no longer ships prebuilt binaries — it compiles from source.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /toll-booth
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
# Scoped package: npm pack produces forgesworn-toll-booth-<version>.tgz
RUN npm run build && npm pack && mv forgesworn-toll-booth-*.tgz toll-booth.tgz

# Stage 2: Build the joke server
FROM node:22-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=toll-booth-build /toll-booth/toll-booth.tgz ./
COPY examples/sats-for-laughs/package.json ./
RUN sed -i 's|file:../../|file:./toll-booth.tgz|' package.json
ARG CACHEBUST
RUN npm install

FROM node:22-slim
RUN addgroup --system app && adduser --system --ingroup app app
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/toll-booth.tgz ./
COPY examples/sats-for-laughs/package.json ./
RUN sed -i 's|file:../../|file:./toll-booth.tgz|' package.json
COPY examples/sats-for-laughs/server.ts ./
COPY examples/sats-for-laughs/jokes.json ./
COPY examples/sats-for-laughs/public/ ./public/
RUN mkdir -p /data && chown -R app:app /app /data
USER app
EXPOSE 3000
CMD ["node", "--import", "tsx", "server.ts"]
