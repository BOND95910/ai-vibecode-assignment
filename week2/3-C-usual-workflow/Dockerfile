# e-Service web (plain Node, no framework). TEST_MODE / BUG_MODE / DB_PATH come from docker-compose.yml
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY app ./app
ENV PORT=3000 DB_PATH=/data/app.db.json
EXPOSE 3000
HEALTHCHECK --interval=2s --timeout=2s --retries=30 CMD wget -qO- http://localhost:3000/api/health || exit 1
CMD ["node", "app/server.js"]
