'use strict';
/**
 * B08 · Audit Trail (อ่านอย่างเดียว · กรอง · CSV · 405) + แจ้งเตือน + API ผู้ดูแลระบบ
 *
 * CONTRACT §6.3 (/api/notifications) §6.4 (/api/audit*) §6.5 (/api/admin/*) §6.8 (detail) §7 (CSV) · DECISIONS §13 §18 · BR-27 BR-28
 *
 *   GET    /api/audit?actor=&event=&from=YYYY-MM-DD&to=YYYY-MM-DD    auditor → {count, items}
 *   GET    /api/audit/export.csv?...                                 auditor → text/csv + Audit EXPORT (detail 'audit-csv')
 *   PUT|PATCH|DELETE|POST /api/audit · /api/audit/:id                 ทุกบทบาท (แม้ไม่ล็อกอิน) → 405 METHOD_NOT_ALLOWED
 *   GET    /api/notifications                                        officer · head → {items}
 *   GET    /api/admin/services                                       admin → {items:[{id,name,fee,feeBase?,feePerSqm,sla}]}
 *   PUT    /api/admin/services/:id   {"fee":25,"sla":3} · SV-03 {"feeBase":1000,"feePerSqm":10,"sla":15}
 *   GET    /api/admin/holidays · POST {"date","name"} · DELETE /api/admin/holidays/:date
 *   GET    /api/admin/users · PUT /api/admin/users/:username {"role","dept"}
 *
 * กติกา Audit ของการแก้ไข (ADMIN_CHANGE): 1 แถวต่อ 1 ค่าที่เปลี่ยนจริง (ค่าเดิม = ไม่บันทึก · คำขอที่ถูกปฏิเสธไม่บันทึก)
 *   `SV-01 fee 20 → 25` · `SV-01 sla 3 → 5` · `SV-03 feePerSqm 10 → 12` · `holiday add 2026-12-02` · `holiday delete 2026-12-02`
 *   `exec1 role executive → auditor` · `off.reg1 dept registry → works`
 */

const { db, tx } = require('../db');
const clock = require('../clock');
const { fail, sendError } = require('../http');
const { requireApi } = require('../session');
const { logAudit } = require('../audit');
const { AUDIT_EVENTS, ROLES, DEPTS, LIMITS } = require('../constants');

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 'YYYY-MM-DD' ที่เป็นวันจริงในปฏิทิน */
function isValidYmd(s) {
  if (typeof s !== 'string') return false;
  const m = YMD_RE.exec(s);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/** ค่าจาก query → สตริงที่ตัดช่องว่างแล้ว ('' ถ้าไม่มี) */
function q(v) {
  if (Array.isArray(v)) v = v[0];
  return v === undefined || v === null ? '' : String(v).trim();
}

function auditItem(r) {
  return {
    id: r.id,
    time: r.time,
    username: r.username,
    role: r.role,
    event: r.event,
    caseNo: r.case_no || null,
    fromStatus: r.from_status || null,
    toStatus: r.to_status || null,
    detail: r.detail || '',
  };
}

/**
 * ค้น Audit · ใหม่ → เก่า (time DESC, id DESC)
 * actor = username ตรงตัว · event = 1 ใน AUDIT_EVENTS · from/to = 'YYYY-MM-DD' รวมทั้งวันตามเวลาไทย (+07:00)
 * ค่าว่าง = ไม่กรอง · ค่าผิดรูปแบบ → throw 400 BAD_REQUEST
 */
function queryAudit({ actor, event, from, to } = {}) {
  actor = q(actor);
  event = q(event).toUpperCase();
  from = q(from);
  to = q(to);

  const where = [];
  const params = [];
  if (actor) {
    where.push('username = ?');
    params.push(actor);
  }
  if (event) {
    if (!AUDIT_EVENTS.includes(event)) fail('BAD_REQUEST', {}, 'เหตุการณ์ไม่ถูกต้อง');
    where.push('event = ?');
    params.push(event);
  }
  if (from) {
    if (!isValidYmd(from)) fail('BAD_REQUEST', {}, 'วันที่เริ่มต้องเป็นรูปแบบ YYYY-MM-DD');
    // เวลาเก็บเป็น 'YYYY-MM-DDTHH:MM:SS+07:00' เสมอ → เทียบสตริงได้ตรงตามเวลาไทย
    where.push('time >= ?');
    params.push(`${from}T00:00:00+07:00`);
  }
  if (to) {
    if (!isValidYmd(to)) fail('BAD_REQUEST', {}, 'วันที่สิ้นสุดต้องเป็นรูปแบบ YYYY-MM-DD');
    where.push('time < ?');
    params.push(`${clock.addDaysYmd(to, 1)}T00:00:00+07:00`);
  }
  const sql =
    'SELECT * FROM audit' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY time DESC, id DESC';
  const items = db.prepare(sql).all(...params).map(auditItem);
  return { count: items.length, items };
}

const CSV_HEADER = ['time', 'username', 'role', 'event', 'caseNo', 'fromStatus', 'toStatus', 'detail'];

/** เซลล์ CSV (RFC 4180) + กันสูตรใน Excel (=, +, -, @ นำหน้า → ใส่ ' ) */
function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** CSV ของรายการ Audit (UTF-8 · แถวแรก = หัวตาราง · ตามลำดับเดียวกับบนจอ) */
function auditCsv(items) {
  const lines = [CSV_HEADER.join(',')];
  for (const it of items) lines.push(CSV_HEADER.map((k) => csvCell(it[k])).join(','));
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// แจ้งเตือน
// ---------------------------------------------------------------------------

/** แจ้งเตือนของผู้ใช้ (ใหม่ → เก่า) */
function listNotifications(username) {
  return db
    .prepare('SELECT * FROM notifications WHERE username = ? ORDER BY created_at DESC, id DESC')
    .all(username)
    .map((r) => ({
      id: r.id,
      caseNo: r.case_no,
      level: r.level,
      text: r.text,
      createdAt: r.created_at,
      readAt: r.read_at || null,
    }));
}

// ---------------------------------------------------------------------------
// ผู้ดูแลระบบ
// ---------------------------------------------------------------------------

function serviceItem(r) {
  const it = { id: r.id, name: r.name, fee: r.fee, feePerSqm: r.fee_per_sqm === undefined ? null : r.fee_per_sqm, sla: r.sla_days };
  if (r.fee_per_sqm !== null && r.fee_per_sqm !== undefined) it.feeBase = r.fee; // SV-03: fee = ค่าฐาน
  return it;
}

function listServices() {
  return db.prepare('SELECT * FROM services ORDER BY sort, id').all().map(serviceItem);
}

function listHolidays() {
  return db.prepare('SELECT date, name FROM holidays ORDER BY date').all();
}

/** เฉพาะเจ้าหน้าที่ (username ไม่ว่าง) */
function listUsers() {
  return db
    .prepare('SELECT username, name, role, dept FROM users WHERE username IS NOT NULL ORDER BY id')
    .all()
    .map((r) => ({ username: r.username, name: r.name, role: r.role, dept: r.dept || null }));
}

/**
 * แปลงค่าจาก body เป็นจำนวนเต็ม · undefined = ไม่ส่งมา (คงค่าเดิม)
 * รับ number ที่เป็นจำนวนเต็ม หรือสตริงตัวเลขล้วน (จากฟอร์ม) · อื่น ๆ (ทศนิยม, '', null, true) = ไม่ถูกต้อง → NaN
 */
function parseIntField(v) {
  if (v === undefined) return undefined;
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
  if (typeof v === 'string' && /^\s*-?\d+\s*$/.test(v)) return parseInt(v, 10);
  return NaN;
}

function checkFee(n) {
  if (n === undefined) return;
  if (!Number.isSafeInteger(n) || n < LIMITS.ADMIN_FEE_MIN || n > LIMITS.ADMIN_FEE_MAX) fail('INVALID_FEE');
}

function checkSla(n) {
  if (n === undefined) return;
  if (!Number.isSafeInteger(n) || n < LIMITS.ADMIN_SLA_MIN || n > LIMITS.ADMIN_SLA_MAX) fail('INVALID_SLA');
}

const showVal = (v) => (v === null || v === undefined || v === '' ? '-' : String(v));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function register(app) {
  // ---- Audit: เพิ่มได้อย่างเดียว → แก้/ลบ/เพิ่มผ่าน API = 405 (ก่อนตรวจสิทธิ์ · แม้ :id ไม่มีจริง) ----
  const notAllowed = (req, res) => {
    res.set('Allow', 'GET, HEAD');
    return sendError(res, 'METHOD_NOT_ALLOWED');
  };
  for (const p of ['/api/audit', '/api/audit/:id']) {
    app.put(p, notAllowed);
    app.patch(p, notAllowed);
    app.delete(p, notAllowed);
    app.post(p, notAllowed);
  }

  app.get('/api/audit', requireApi('auditor'), (req, res) => {
    res.json(queryAudit(req.query));
  });

  app.get('/api/audit/export.csv', requireApi('auditor'), (req, res) => {
    const { items } = queryAudit(req.query); // ตัวกรองเดียวกับบนจอ · ไม่รวมแถว EXPORT ของครั้งนี้
    const body = auditCsv(items);
    logAudit(req.user, 'EXPORT', { detail: 'audit-csv' });
    const stamp = clock.bkkDate(clock.nowIso());
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="audit-${stamp}.csv"`);
    res.status(200).send(Buffer.from(body, 'utf8'));
  });

  // ---- แจ้งเตือน (tick ใน server.js ประเมิน SLA ให้ก่อนถึง handler นี้แล้ว) ----
  app.get('/api/notifications', requireApi('officer', 'head'), (req, res) => {
    res.json({ items: listNotifications(req.user.username) });
  });

  // ---- ผู้ดูแลระบบ: บริการ ----
  const admin = requireApi('admin');

  app.get('/api/admin/services', admin, (req, res) => {
    res.json({ items: listServices() });
  });

  app.put('/api/admin/services/:id', admin, (req, res) => {
    const id = String(req.params.id || '').toUpperCase();
    const row = db.prepare('SELECT * FROM services WHERE id = ?').get(id);
    if (!row) fail('NOT_FOUND', {}, 'ไม่พบบริการ');
    const b = req.body || {};
    const hasPerSqm = row.fee_per_sqm !== null && row.fee_per_sqm !== undefined;

    // SV-03: feeBase (หรือ fee) = ค่าฐาน · บริการอื่น: fee
    const feeRaw = hasPerSqm && b.feeBase !== undefined ? b.feeBase : b.fee;
    const fee = parseIntField(feeRaw);
    const perSqm = hasPerSqm ? parseIntField(b.feePerSqm) : undefined;
    const sla = parseIntField(b.sla !== undefined ? b.sla : b.slaDays);

    // ตรวจทั้งหมดก่อนเขียน (ผิดข้อใด = ไม่เปลี่ยนอะไรเลย)
    checkFee(fee);
    checkFee(perSqm);
    checkSla(sla);

    const changes = [];
    if (fee !== undefined && fee !== row.fee) changes.push(['fee', 'fee', row.fee, fee]);
    if (perSqm !== undefined && perSqm !== row.fee_per_sqm) changes.push(['fee_per_sqm', 'feePerSqm', row.fee_per_sqm, perSqm]);
    if (sla !== undefined && sla !== row.sla_days) changes.push(['sla_days', 'sla', row.sla_days, sla]);

    tx(() => {
      for (const [col, label, before, after] of changes) {
        db.prepare(`UPDATE services SET ${col} = ? WHERE id = ?`).run(after, id);
        logAudit(req.user, 'ADMIN_CHANGE', { detail: `${id} ${label} ${before} → ${after}` });
      }
    })();

    const updated = serviceItem(db.prepare('SELECT * FROM services WHERE id = ?').get(id));
    res.status(200).json({ ...updated, changed: changes.length });
  });

  // ---- ผู้ดูแลระบบ: วันหยุด ----
  app.get('/api/admin/holidays', admin, (req, res) => {
    res.json({ items: listHolidays() });
  });

  app.post('/api/admin/holidays', admin, (req, res) => {
    const b = req.body || {};
    const date = typeof b.date === 'string' ? b.date.trim() : '';
    if (!isValidYmd(date)) fail('BAD_REQUEST', {}, 'วันที่ต้องเป็นรูปแบบ YYYY-MM-DD');
    const name = (typeof b.name === 'string' ? b.name.trim() : '') || 'วันหยุด';
    tx(() => {
      if (db.prepare('SELECT 1 FROM holidays WHERE date = ?').get(date)) fail('DUPLICATE_HOLIDAY');
      db.prepare('INSERT INTO holidays(date, name) VALUES (?, ?)').run(date, name);
      logAudit(req.user, 'ADMIN_CHANGE', { detail: `holiday add ${date}` });
    })();
    res.status(201).json({ date, name });
  });

  app.delete('/api/admin/holidays/:date', admin, (req, res) => {
    const date = String(req.params.date || '').trim();
    tx(() => {
      const info = db.prepare('DELETE FROM holidays WHERE date = ?').run(date);
      if (!info.changes) fail('NOT_FOUND', {}, 'ไม่พบวันหยุดนี้');
      logAudit(req.user, 'ADMIN_CHANGE', { detail: `holiday delete ${date}` });
    })();
    res.status(200).json({ ok: true, date });
  });

  // ---- ผู้ดูแลระบบ: ผู้ใช้/บทบาท (มีผลกับการล็อกอินครั้งถัดไป: session เก็บภาพบทบาทตอนล็อกอิน) ----
  app.get('/api/admin/users', admin, (req, res) => {
    res.json({ items: listUsers() });
  });

  app.put('/api/admin/users/:username', admin, (req, res) => {
    const username = String(req.params.username || '').trim();
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!row) fail('NOT_FOUND', {}, 'ไม่พบผู้ใช้');
    if (row.id === req.user.id || username === req.user.username) fail('SELF_ROLE_CHANGE');

    const b = req.body || {};
    const role = b.role === undefined || b.role === null || b.role === '' ? row.role : String(b.role).trim();
    if (!ROLES.includes(role)) fail('BAD_REQUEST', {}, 'บทบาทไม่ถูกต้อง');

    let dept;
    if (role === 'officer') {
      const want = b.dept === undefined || b.dept === null ? '' : String(b.dept).trim();
      dept = want || row.dept || '';
      if (!DEPTS.includes(dept)) fail('BAD_REQUEST', {}, 'เจ้าหน้าที่ต้องระบุแผนก registry หรือ works');
    } else {
      const want = b.dept === undefined || b.dept === null ? '' : String(b.dept).trim();
      if (want && !DEPTS.includes(want)) fail('BAD_REQUEST', {}, 'แผนกไม่ถูกต้อง');
      dept = null; // แผนกใช้เฉพาะเจ้าหน้าที่ (officer)
    }
    const deptBefore = row.dept || null;
    const deptAfter = dept || null;

    const changes = [];
    if (role !== row.role) changes.push(`${username} role ${row.role} → ${role}`);
    if (deptAfter !== deptBefore) changes.push(`${username} dept ${showVal(deptBefore)} → ${showVal(deptAfter)}`);

    tx(() => {
      if (changes.length) db.prepare('UPDATE users SET role = ?, dept = ? WHERE id = ?').run(role, deptAfter, row.id);
      for (const detail of changes) logAudit(req.user, 'ADMIN_CHANGE', { detail });
    })();

    res.status(200).json({ username, name: row.name, role, dept: deptAfter, changed: changes.length });
  });
}

module.exports = {
  register,
  queryAudit,
  auditCsv,
  listNotifications,
  listServices,
  listHolidays,
  listUsers,
  CSV_HEADER,
};
