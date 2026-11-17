// B09 · ดู/กรอง/ส่งออก Audit Trail (BR-27 · FR-24 · CONTRACT 6.4, 7) · อ่านอย่างเดียว: ไม่มี route แก้/ลบ (405)
const { db } = require('../db');
const audit = require('../audit');
const { sendError } = require('../util');
const { requireRole } = require('../rbac');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COLS = ['time', 'username', 'role', 'event', 'caseNo', 'fromStatus', 'toStatus', 'detail'];

// กรอง actor/event/from/to · from/to รวมวันเริ่มและวันจบ ตามเวลาไทย
// audit.time เก็บเป็น ISO +07:00 เสมอ (audit.js ใช้ clock.nowISO) → 10 ตัวแรก = วันที่ไทย ไม่ต้องแปลง timezone
// คืน rows (ใหม่ → เก่า; เวลาเท่ากันเรียง id มาก → น้อย) หรือส่ง 400 แล้วคืน null
function query(req, res) {
  const { actor, event, from, to } = req.query;
  for (const d of [from, to]) {
    if (d && !DATE_RE.test(String(d))) { sendError(res, 400, 'INVALID_DATE', 'วันที่ไม่ถูกต้อง'); return null; }
  }
  const where = [], args = [];
  if (actor) { where.push('username = ?'); args.push(String(actor)); }
  if (event) { where.push('event = ?'); args.push(String(event)); }
  if (from) { where.push('substr(time,1,10) >= ?'); args.push(String(from)); }
  if (to) { where.push('substr(time,1,10) <= ?'); args.push(String(to)); }
  return db.prepare(
    `SELECT id, time, username, role, event, case_no, from_status, to_status, detail FROM audit
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY time DESC, id DESC`
  ).all(...args).map((r) => ({
    id: Number(r.id), time: r.time, username: r.username, role: r.role, event: r.event,
    caseNo: r.case_no, fromStatus: r.from_status, toStatus: r.to_status, detail: r.detail,
  }));
}

// RFC 4180: ครอบด้วย " เมื่อมี , " หรือขึ้นบรรทัดใหม่ แล้วซ้ำ " เป็น ""
const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

module.exports = function (app) {
  // ไม่มี API แก้/ลบ แม้ admin · 405 ทุกบทบาท (รวมยังไม่ล็อกอิน) แม้ :id ไม่มีจริง · GET ผ่านไปที่ route ด้านล่าง
  app.all(['/api/audit', '/api/audit/:id'], (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    res.set('Allow', 'GET');
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method Not Allowed');
  });

  app.get('/api/audit', requireRole('auditor'), (req, res) => {
    const items = query(req, res); if (!items) return;
    res.json({ count: items.length, items });
  });

  app.get('/api/audit/export.csv', requireRole('auditor'), (req, res) => {
    const items = query(req, res); if (!items) return;
    // เนื้อไฟล์เท่าจอ (ก่อนบันทึก EXPORT ของการส่งออกนี้) · \n ปิดท้ายไม่มี
    const csv = [COLS.join(','), ...items.map((r) => COLS.map((c) => csvCell(r[c])).join(','))].join('\n');
    audit({ actor: req.user.username, role: req.user.role, event: 'EXPORT', detail: 'audit-csv' });
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="audit.csv"' });
    res.send(csv);
  });
};
