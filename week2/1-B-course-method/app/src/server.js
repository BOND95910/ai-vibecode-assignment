'use strict';
/**
 * จุดเริ่มเว็บ (B01) — Express + โหลดโมดูลอัตโนมัติ
 *
 * ลำดับ middleware:
 *   1. body parser (JSON/form ≤ 10 MB · multipart ใช้ http.upload ในแต่ละ route ≤ 20 MB) → รับ body ≥ 6 MB ได้
 *   2. /static (public/)
 *   3. sessionMiddleware → req.user
 *   4. tick: ทุก request (ยกเว้น /api/test/* /api/health /static/*) → workflow.autoCancelExpired() แล้ว sla.evaluateNotifications()
 *   5. route หลักของ B01: GET /api/health · GET / · POST /logout
 *   6. /api/test/* (เฉพาะ TEST_MODE=1 · ไม่ตั้ง → 404)
 *   7. src/modules/*.js แล้ว src/views/*.js (เรียงชื่อไฟล์ · ไฟล์ที่ export register(app, ctx) เท่านั้น)
 *   8. 404 + error handler (ApiError → {code,message} · multer → FILE_TOO_LARGE/FILE_COUNT · อื่น ๆ 500)
 */

require('express-async-errors'); // ให้ async handler ที่ throw ไปถึง error handler (Express 4)

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');

const clock = require('./clock');
const bugs = require('./bugs');
const dbm = require('./db');
const http = require('./http');
const session = require('./session');

const TEST_MODE = process.env.TEST_MODE === '1';
const PORT = Number(process.env.PORT) || 3000;

/** require แบบทนไฟล์ที่ยังไม่มี (บล็อกอื่นยังเขียนไม่เสร็จ) — error อื่นโยนต่อ */
function optionalRequire(rel) {
  try {
    return require(rel);
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(`'${rel}'`)) return null;
    throw e;
  }
}

/** path ที่ไม่ประเมิน SLA/ยกเลิกอัตโนมัติ (CONTRACT §0.7 ยกเว้น /api/test/* · health/static ไม่ใช่การใช้งานจริง และกันแจ้งเตือนเกิดก่อนตั้งนาฬิกา) */
function skipTick(p) {
  return p.startsWith('/api/test/') || p === '/api/test' || p === '/api/health' || p.startsWith('/static/') || p === '/favicon.ico';
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.set('etag', false);

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: false, limit: '10mb' }));

  // ไม่ให้เบราว์เซอร์ cache หน้า/API (นาฬิกาแช่แข็งเปลี่ยนผลได้ตลอด)
  app.use((req, res, next) => {
    if (!req.path.startsWith('/static/')) res.set('Cache-Control', 'no-store');
    next();
  });

  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: 0 }));
  app.get('/favicon.ico', (req, res) => res.status(204).end());

  app.use(session.sessionMiddleware);

  // ---- tick: ประเมินก่อนทุก request (A-30 A-46) ----
  const tickFns = [];
  app.use((req, res, next) => {
    if (skipTick(req.path)) return next();
    const now = clock.nowIso();
    for (const fn of tickFns) fn(now);
    next();
  });

  // ---- route พื้นฐาน ----
  app.get('/api/health', (req, res) => res.status(200).json({ status: 'ok' }));

  app.get('/', (req, res) => res.redirect(302, session.landingFor(req.user)));

  app.post('/logout', (req, res) => {
    session.destroySession(req, res);
    res.redirect(303, '/login');
  });

  // ---- test hook router (/api/test/*) ----
  const testRouter = express.Router();
  if (TEST_MODE) {
    app.use('/api/test', testRouter);
  } else {
    app.use('/api/test', (req, res) => http.sendError(res, 'NOT_FOUND'));
  }

  const ctx = { app, testRouter, TEST_MODE, tickFns, clock, bugs, db: dbm.db };

  // ---- โหลดโมดูล ----
  const loaded = [];
  for (const dir of ['modules', 'views']) {
    const abs = path.join(__dirname, dir);
    if (!fs.existsSync(abs)) continue;
    const files = fs.readdirSync(abs).filter((f) => f.endsWith('.js')).sort();
    const mods = files.map((f) => ({ f, mod: require(path.join(abs, f)) }))
      .filter(({ mod }) => mod && typeof mod.register === 'function')
      .sort((a, b) => (a.mod.order || 50) - (b.mod.order || 50) || a.f.localeCompare(b.f));
    for (const { f, mod } of mods) {
      mod.register(app, ctx);
      loaded.push(`${dir}/${f}`);
    }
  }

  // tick ตามลำดับที่กำหนด: ยกเลิกอัตโนมัติก่อน แล้วค่อยประเมินแจ้งเตือน
  const workflow = optionalRequire('./modules/workflow');
  const sla = optionalRequire('./sla');
  if (workflow && typeof workflow.autoCancelExpired === 'function') tickFns.push((now) => workflow.autoCancelExpired(now));
  if (sla && typeof sla.evaluateNotifications === 'function') tickFns.push((now) => sla.evaluateNotifications(now));

  // ---- 404 ----
  app.use((req, res) => {
    if (http.isApi(req)) return http.sendError(res, 'NOT_FOUND');
    const layout = require('./views/layout');
    return layout.notFoundPage(req, res, 'ไม่พบหน้านี้');
  });

  // ---- error handler ----
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let e = err;
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') e = http.apiError('FILE_TOO_LARGE');
      else if (err.code === 'LIMIT_FILE_COUNT') e = http.apiError('FILE_COUNT');
      else e = http.apiError('BAD_REQUEST', {}, err.message);
    } else if (err && err.type === 'entity.too.large') {
      e = http.apiError('FILE_TOO_LARGE');
    } else if (err && err.type === 'entity.parse.failed') {
      e = http.apiError('BAD_REQUEST', {}, 'รูปแบบ JSON ไม่ถูกต้อง');
    }
    if (!(e instanceof http.ApiError)) {
      console.error('[error]', req.method, req.originalUrl, err && err.stack ? err.stack : err);
      e = http.apiError('INTERNAL');
    }
    if (res.headersSent) return;
    if (http.isApi(req) || !req.accepts('html')) return res.status(e.status).json(e.toJSON());
    const layout = require('./views/layout');
    if (e.status === 403) return layout.forbiddenPage(req, res);
    if (e.status === 404) return layout.notFoundPage(req, res);
    return layout.errorPage(req, res, e.status, e.message);
  });

  app.locals.loadedModules = loaded;
  return app;
}

/** เตรียมฐานข้อมูลตอนเริ่ม: TEST_MODE → reset+seed ทุกครั้ง (ผลซ้ำได้) · ปกติ → seed เฉพาะ DB ว่าง */
function prepareData() {
  if (TEST_MODE) {
    clock.reset();
    dbm.resetAll();
  } else if (dbm.isEmpty()) {
    dbm.resetAll();
  }
}

function start() {
  prepareData();
  const app = createApp();
  const server = app.listen(PORT, () => {
    console.log(
      `[egov] listening on :${PORT} · TEST_MODE=${TEST_MODE ? 1 : 0} · BUG_MODE=${bugs.activeBugs().join(',') || '-'} · DB_PATH=${dbm.DB_PATH} · clock=${clock.nowIso()}`
    );
    console.log('[egov] modules:', app.locals.loadedModules.join(' ') || '(none)');
  });
  server.requestTimeout = 120000;
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return server;
}

if (require.main === module) start();

module.exports = { createApp, start, prepareData };
