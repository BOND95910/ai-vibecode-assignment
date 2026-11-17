'use strict';
/**
 * Test hook (B01) — CONTRACT §8 · DECISIONS §15
 * mount ที่ /api/test เฉพาะ TEST_MODE=1 (server.js) · ไม่ตั้ง → /api/test/* ตอบ 404
 *
 *   POST /api/test/reset   → 200 {"ok":true,"now":"2026-12-01T09:00:00+07:00"} · ล้างทุกตาราง (session OTP แจ้งเตือน audit ไฟล์) + seed() ใหม่ + นาฬิกากลับค่าเริ่มต้น
 *   GET  /api/test/clock   → 200 {"now":"…+07:00"}
 *   PUT  /api/test/clock   {"now":"2026-12-01T16:30:00+07:00"} → 200 {"now"} แช่แข็ง · ISO ผิด/ไม่มี offset → 400 INVALID_TIME
 *
 * hook อื่นใน /api/test ลงทะเบียนโดยโมดูลเจ้าของผ่าน ctx.testRouter:
 *   POST /api/test/payments/:ref/pay       → modules/citizen.js (B04)
 *   POST /api/test/documents/:docNo/tamper → modules/workflow.js (B06)
 */

const clock = require('../clock');
const dbm = require('../db');
const { fail } = require('../http');

function register(app, ctx) {
  const r = ctx.testRouter;

  r.post('/reset', (req, res) => {
    clock.reset();
    dbm.resetAll();
    res.status(200).json({ ok: true, now: clock.nowIso() });
  });

  r.get('/clock', (req, res) => {
    res.json({ now: clock.nowIso() });
  });

  r.put('/clock', (req, res) => {
    const v = req.body && req.body.now;
    const set = typeof v === 'string' ? clock.set(v) : null;
    if (!set) fail('INVALID_TIME');
    res.json({ now: set });
  });
}

// โหลดก่อนโมดูลอื่น (route ใน testRouter ของโมดูลอื่นต่อท้ายได้ตามปกติ)
module.exports = { register, order: 10 };
