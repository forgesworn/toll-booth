# Stage 1: Build toll-booth from source
FROM node:22-slim AS toll-booth-build
WORKDIR /toll-booth
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build && npm pack && mv thecryptodonkey-toll-booth-*.tgz toll-booth.tgz

# Stage 2: Build the routing proxy
FROM node:22-slim
RUN addgroup --system app && adduser --system --ingroup app app
WORKDIR /app
COPY --from=toll-booth-build /toll-booth/toll-booth.tgz ./
COPY examples/valhalla-proxy/package.json ./
RUN sed -i 's|"file:../../"|"file:./toll-booth.tgz"|' package.json
RUN npm install
COPY examples/valhalla-proxy/server.ts ./
RUN chown -R app:app /app
USER app
EXPOSE 3000
CMD ["node", "--import", "tsx", "server.ts"]
