// จุดเริ่มต้นเว็บ: โหลด routes/*.js แล้ว pages/*.js ตามลำดับชื่อไฟล์ (โฟลเดอร์ว่าง/ไม่มี = ข้าม)
const fs = require('fs');
const path = require('path');
const express = require('express');
const { initSchema, db, resetAll } = require('./db');
const { sendError, parseCookies, requestHooks } = require('./util');

const TEST_MODE = process.env.TEST_MODE === '1';
const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY = '8mb'; // CONTRACT 0.10: ต้องรับ body >= 6 MB (ไฟล์ 5,242,881 ไบต์ต้องได้ 400 FILE_TOO_LARGE ไม่ใช่ 413)

initSchema();
// ครั้งแรก (ฐานข้อมูลว่าง): seed ให้เลย เพื่อให้ docker compose up ใช้งานได้ทันที
if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) resetAll();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: MAX_BODY }));
app.use(express.urlencoded({ extended: false, limit: MAX_BODY }));
app.use((req, res, next) => { req.cookies = parseCookies(req); next(); });

// test hook: เปิดเฉพาะ TEST_MODE=1 · ปิด = ตอบ 404 · ไม่ผ่าน requestHooks (ข้อ 0.7)
if (TEST_MODE) require('./testhook')(app);
else app.all('/api/test/*', (req, res) => sendError(res, 404, 'NOT_FOUND', 'ไม่พบหน้านี้'));

app.get('/api/health', (req, res) => res.json({ status: 'ok' })); // ตรงตัว ไม่มีฟิลด์อื่น

// ทุกคำขอ (ยกเว้น /api/test/*) ผ่าน requestHooks ที่บล็อกอื่นลงทะเบียนไว้ (ประเมิน SLA/ยกเลิกอัตโนมัติ)
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/test/')) for (const h of requestHooks) h(req);
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));

// โหลด server/routes/*.js แล้ว server/pages/*.js ตามลำดับชื่อไฟล์ · ไฟล์ที่ไม่ได้ export function (เช่น ไลบรารี) ข้ามพร้อมเตือน
for (const dir of ['routes', 'pages']) {
  const full = path.join(__dirname, dir);
  if (!fs.existsSync(full)) continue;
  for (const f of fs.readdirSync(full).filter((n) => n.endsWith('.js')).sort()) {
    const mod = require(path.join(full, f));
    if (typeof mod === 'function') mod(app);
    else console.warn(`[index] ข้าม ${dir}/${f}: ไม่ได้ export function (app)`);
  }
}

app.use('/api', (req, res) => sendError(res, 404, 'NOT_FOUND', 'ไม่พบ API นี้'));
app.use((req, res) => res.status(404).type('text/plain; charset=utf-8').send('ไม่พบหน้านี้'));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'ข้อมูลที่ส่งมาใหญ่เกินไป');
  if (err.type === 'entity.parse.failed') return sendError(res, 400, 'BAD_JSON', 'รูปแบบ JSON ไม่ถูกต้อง');
  console.error(err);
  sendError(res, 500, 'INTERNAL', 'เกิดข้อผิดพลาดภายในระบบ');
});

if (require.main === module) {
  const server = app.listen(PORT, () => console.log(`e-Service listening on :${PORT} TEST_MODE=${TEST_MODE ? 1 : 0}`));
  process.on('SIGTERM', () => server.close(() => process.exit(0))); // docker stop เร็ว
}

module.exports = app;
