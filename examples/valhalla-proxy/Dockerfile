FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server.ts ./
EXPOSE 3000
CMD ["node", "--loader", "tsx", "server.ts"]
