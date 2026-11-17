# e-Service กลาง เทศบาลนครตัวอย่าง (หน่วยงานสมมติ) · Node 20 + Express + SQLite (better-sqlite3)
# build: docker compose build · run: docker compose up  (TEST_MODE=1 BUG_MODE=B03 docker compose up)

FROM node:20-bookworm-slim AS deps
WORKDIR /app
# เครื่องมือ build เผื่อไม่มี prebuilt binary ของ better-sqlite3
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && node -e "require('better-sqlite3')(':memory:').prepare('select 1').get()"

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/egov.db \
    TZ=Asia/Bangkok
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
