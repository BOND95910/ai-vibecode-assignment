// Test hook (CONTRACT ข้อ 8) · index.js เสียบเฉพาะเมื่อ TEST_MODE=1 (ไม่ตั้ง -> /api/test/* ตอบ 404)
const fs = require('fs');
const path = require('path');
const clock = require('./clock');
const { resetAll } = require('./db');
const { sendError } = require('./util');

// require แบบหลวม ณ เวลาที่ถูกเรียก (B06/B07 เขียนทีหลังก็ใช้ได้ไม่ต้องรีสตาร์ทโค้ดนี้) · ไม่มีไฟล์ -> null
function loose(rel) {
  const p = path.join(__dirname, rel);
  return fs.existsSync(p + '.js') ? require(p) : null;
}
const notReady = (res, what) => sendError(res, 501, 'NOT_IMPLEMENTED', `${what} ยังไม่พร้อมใช้งาน`);

// สัญญาข้อผิดพลาดจากฟังก์ชันของบล็อกอื่น: throw Object.assign(new Error(message), { status, code })
function fail(res, e) {
  if (e && e.status && e.code) return sendError(res, e.status, e.code, e.message);
  throw e; // error ที่ไม่คาด -> 500 จาก error handler ของ index.js
}

module.exports = function (app) {
  app.post('/api/test/reset', (req, res) => {
    resetAll();
    res.json({ ok: true, now: clock.nowISO() });
  });

  app.get('/api/test/clock', (req, res) => res.json({ now: clock.nowISO() }));

  app.put('/api/test/clock', (req, res) => {
    try {
      clock.set(req.body && req.body.now);
    } catch (e) {
      return sendError(res, 400, 'INVALID_TIME', 'เวลาไม่ถูกต้อง ต้องเป็น ISO พร้อม offset เช่น 2026-12-01T16:30:00+07:00');
    }
    res.json({ now: clock.nowISO() });
  });

  // ธนาคารจำลอง: เรียก require('./routes/payments').payByRef(ref, amount) ของ B06
  // คืน { status:'PAID', caseNo, receiptNo, duplicate } หรือ throw {status,code,message} (410 QR_EXPIRED · 422 AMOUNT_MISMATCH · 404 NOT_FOUND)
  app.post('/api/test/payments/:ref/pay', (req, res) => {
    const pay = loose('routes/payments');
    if (!pay || typeof pay.payByRef !== 'function') return notReady(res, 'ระบบชำระเงิน');
    try {
      res.json(pay.payByRef(req.params.ref, Number(req.body && req.body.amount)));
    } catch (e) { fail(res, e); }
  });

  // แก้ข้อมูลเอกสารที่เก็บโดยไม่คำนวณลายเซ็นใหม่: require('./documents').tamper(docNo) ของ B07
  // คืน true เมื่อแก้แล้ว · false/ไม่พบ -> 404 · หรือ throw {status,code,message}
  app.post('/api/test/documents/:docNo/tamper', (req, res) => {
    const docs = loose('documents');
    if (!docs || typeof docs.tamper !== 'function') return notReady(res, 'ระบบเอกสาร');
    try {
      if (!docs.tamper(req.params.docNo)) return sendError(res, 404, 'NOT_FOUND', 'ไม่พบเอกสาร');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
};
