# Stage 1: Build toll-booth from source
FROM node:22-slim AS toll-booth-build
WORKDIR /toll-booth
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
# Scoped package: npm pack produces thecryptodonkey-toll-booth-<version>.tgz
RUN npm run build && npm pack && mv thecryptodonkey-toll-booth-*.tgz toll-booth.tgz

# Stage 2: Build the joke server
FROM node:22-slim
RUN addgroup --system app && adduser --system --ingroup app app
WORKDIR /app
COPY --from=toll-booth-build /toll-booth/toll-booth.tgz ./
COPY examples/sats-for-laughs/package.json ./
RUN sed -i 's|file:../../|file:./toll-booth.tgz|' package.json
ARG CACHEBUST
RUN npm install
COPY examples/sats-for-laughs/server.ts ./
COPY examples/sats-for-laughs/jokes.json ./
COPY examples/sats-for-laughs/public/ ./public/
RUN mkdir -p /data && chown -R app:app /app /data
USER app
EXPOSE 3000
CMD ["node", "--import", "tsx", "server.ts"]
