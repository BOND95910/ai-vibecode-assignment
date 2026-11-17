// B09 · ผู้ดูแลระบบ: ค่าธรรมเนียม/SLA · วันหยุด · ผู้ใช้/บทบาท (BR-28 · FR-25..27 · CONTRACT 6.5, 6.8)
// admin เท่านั้น (requireRole) · ทุกการแก้สำเร็จบันทึก Audit ADMIN_CHANGE ต่อค่าที่เปลี่ยนจริง · คำขอที่ถูกปฏิเสธไม่บันทึก
// ผลกระทบทางธุรกิจ (A-42): ยอดที่ล็อกในร่าง/dueAt ที่เก็บแล้วไม่ถูกแตะที่นี่ — แก้ตารางแล้วบล็อกอื่นอ่านสดตอนสร้าง/ชำระใหม่
const { db, tx } = require('../db');
const audit = require('../audit');
const { sendError } = require('../util');
const { requireRole } = require('../rbac');

const ROLES = ['citizen', 'officer', 'head', 'executive', 'auditor', 'admin'];
const DEPTS = ['', 'registry', 'works'];

// จำนวนเต็มในช่วง · รับตัวเลขหรือสตริงตัวเลขล้วน (ฟอร์ม input number ส่งเป็นสตริงได้) · อื่น ๆ (ทศนิยม ว่าง ข้อความ) ✗
function intIn(v, lo, hi) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : NaN);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
}
const has = (o, k) => o[k] !== undefined && o[k] !== null;
const isRealDate = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

const svcItem = (r) => ({
  id: r.id, name: r.name,
  fee: r.id === 'SV-03' ? r.fee_base : r.fee, // SV-03: fee = ฐาน (svc-fee-SV-03)
  feeBase: r.id === 'SV-03' ? r.fee_base : undefined,
  feePerSqm: r.fee_per_sqm, sla: r.sla,
});

module.exports = function (app) {
  const admin = requireRole('admin');
  const log = (req, detail) => audit({ actor: req.user.username, role: req.user.role, event: 'ADMIN_CHANGE', detail });

  // ---------- บริการ ----------
  app.get('/api/admin/services', admin, (req, res) => {
    res.json({ items: db.prepare('SELECT * FROM services ORDER BY id').all().map(svcItem) });
  });

  app.put('/api/admin/services/:id', admin, (req, res) => {
    const svc = db.prepare('SELECT * FROM services WHERE id=?').get(req.params.id);
    if (!svc) return sendError(res, 404, 'NOT_FOUND', 'ไม่พบบริการ');
    const b = req.body || {};
    const is3 = svc.id === 'SV-03';
    // [ฟิลด์ใน body, คอลัมน์, ป้ายใน Audit, ช่วง, code, ข้อความ]
    const FEE = ['INVALID_FEE', 'ค่าธรรมเนียมต้องเป็นจำนวนเต็ม 0–100,000 บาท'];
    const SLA = ['INVALID_SLA', 'SLA ต้องเป็นจำนวนเต็ม 1–60 วันทำการ'];
    const specs = is3
      ? [[has(b, 'feeBase') ? 'feeBase' : 'fee', 'fee_base', 'feeBase', 0, 100000, FEE],
         ['feePerSqm', 'fee_per_sqm', 'feePerSqm', 0, 100000, FEE], ['sla', 'sla', 'sla', 1, 60, SLA]]
      : [['fee', 'fee', 'fee', 0, 100000, FEE], ['sla', 'sla', 'sla', 1, 60, SLA]];
    const changes = [];
    let given = 0;
    for (const [key, col, label, lo, hi, [code, msg]] of specs) { // ตรวจครบก่อนแก้ (ทั้งหมดหรือไม่เลย)
      if (!has(b, key)) continue;
      given += 1;
      const n = intIn(b[key], lo, hi);
      if (n === null) return sendError(res, 400, code, msg);
      if (n !== svc[col]) changes.push([col, label, svc[col], n]);
    }
    if (!given) return sendError(res, 400, 'INVALID_FEE', FEE[1]);
    tx(() => {
      for (const [col, label, from, to] of changes) {
        db.prepare(`UPDATE services SET ${col}=? WHERE id=?`).run(to, svc.id); // col มาจาก specs ข้างบนเท่านั้น
        log(req, `${svc.id} ${label} ${from} → ${to}`);
      }
    });
    res.json(svcItem(db.prepare('SELECT * FROM services WHERE id=?').get(svc.id)));
  });

  // ---------- วันหยุด ----------
  app.get('/api/admin/holidays', admin, (req, res) => {
    res.json({ items: db.prepare('SELECT date, name FROM holidays ORDER BY date').all() });
  });

  app.post('/api/admin/holidays', admin, (req, res) => {
    const { date, name } = req.body || {};
    if (!isRealDate(date)) return sendError(res, 400, 'INVALID_DATE', 'วันที่ไม่ถูกต้อง');
    const nm = typeof name === 'string' ? name.trim() : '';
    if (db.prepare('SELECT 1 FROM holidays WHERE date=?').get(date)) {
      return sendError(res, 409, 'DUPLICATE_HOLIDAY', 'มีวันหยุดนี้อยู่แล้ว');
    }
    tx(() => {
      db.prepare('INSERT INTO holidays (date, name) VALUES (?,?)').run(date, nm);
      log(req, `holiday add ${date}`);
    });
    res.status(201).json({ date, name: nm });
  });

  app.delete('/api/admin/holidays/:date', admin, (req, res) => {
    const { date } = req.params;
    if (!db.prepare('SELECT 1 FROM holidays WHERE date=?').get(date)) return sendError(res, 404, 'NOT_FOUND', 'ไม่พบวันหยุด');
    tx(() => {
      db.prepare('DELETE FROM holidays WHERE date=?').run(date);
      log(req, `holiday delete ${date}`);
    });
    res.json({ ok: true });
  });

  // ---------- ผู้ใช้/บทบาท (เจ้าหน้าที่ที่มี username) ----------
  const userItem = (u) => ({ username: u.username, name: u.display_name, role: u.role, dept: u.dept });
  app.get('/api/admin/users', admin, (req, res) => {
    res.json({ items: db.prepare('SELECT username, display_name, role, dept FROM users WHERE username IS NOT NULL ORDER BY id').all().map(userItem) });
  });

  app.put('/api/admin/users/:username', admin, (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE username=?').get(req.params.username);
    if (!u) return sendError(res, 404, 'NOT_FOUND', 'ไม่พบผู้ใช้');
    const b = req.body || {};
    const role = has(b, 'role') ? b.role : u.role;
    const dept = has(b, 'dept') ? b.dept : u.dept;
    if (!ROLES.includes(role)) return sendError(res, 400, 'INVALID_ROLE', 'บทบาทไม่ถูกต้อง');
    if (!DEPTS.includes(dept)) return sendError(res, 400, 'INVALID_DEPT', 'แผนกไม่ถูกต้อง');
    // เปลี่ยนบทบาทตัวเองไม่ได้ (BR-28) · session เดิมของผู้ถูกแก้คงเดิมจนล็อกอินใหม่ (rbac: snapshot)
    if (u.username === req.user.username && role !== u.role) {
      return sendError(res, 409, 'SELF_ROLE_CHANGE', 'ไม่สามารถเปลี่ยนบทบาทของตัวเองได้');
    }
    tx(() => {
      if (role !== u.role) log(req, `${u.username} role ${u.role} → ${role}`);
      if (dept !== u.dept) log(req, `${u.username} dept ${u.dept || '-'} → ${dept || '-'}`);
      db.prepare('UPDATE users SET role=?, dept=? WHERE id=?').run(role, dept, u.id);
    });
    res.json(userItem({ ...u, role, dept }));
  });
};
