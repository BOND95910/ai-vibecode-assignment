FROM node:24-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=3000 DB_PATH=/data/app.db
RUN mkdir -p /data
VOLUME /data
EXPOSE 3000
CMD ["node", "server/index.js"]
