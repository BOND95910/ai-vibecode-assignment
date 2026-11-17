'use strict';
/**
 * เขียน Audit Trail (B01) — ทุกบล็อกเรียก logAudit() · อ่าน/กรอง/ส่งออกเป็นของ B08 (modules/admin-audit.js)
 *
 *   const { logAudit } = require('../audit');
 *   logAudit(req.user, 'RETURN', { caseNo, from: 'IN_REVIEW', to: 'NEED_FIX', detail: reason });
 *
 * - user = req.user (ใช้ username + role จาก session) หรือ {username, role}
 * - เวลา = clock.nowIso() เสมอ · detail ตาม CONTRACT §6.8
 * - บั๊ก B11 (ไม่บันทึก UNMASK) ให้ผู้เรียก (B05) ข้ามการเรียกเอง — ฟังก์ชันนี้ไม่รู้จักบั๊ก
 */

const { db } = require('./db');
const clock = require('./clock');
const { AUDIT_EVENTS } = require('./constants');

const stmt = db.prepare(
  'INSERT INTO audit(time, username, role, event, case_no, from_status, to_status, detail) VALUES (?,?,?,?,?,?,?,?)'
);

/**
 * @param {{username:string, role:string}} user
 * @param {string} event หนึ่งใน AUDIT_EVENTS
 * @param {{caseNo?:string|null, from?:string|null, to?:string|null, detail?:string}} [opts]
 * @returns {number} id ของแถวใหม่
 */
function logAudit(user, event, opts = {}) {
  if (!AUDIT_EVENTS.includes(event)) throw new Error('logAudit: unknown event ' + event);
  if (!user || !user.username) throw new Error('logAudit: user.username required');
  const info = stmt.run(
    clock.nowIso(),
    user.username,
    user.role,
    event,
    opts.caseNo || null,
    opts.from || null,
    opts.to || null,
    opts.detail === undefined || opts.detail === null ? '' : String(opts.detail)
  );
  return Number(info.lastInsertRowid);
}

module.exports = { logAudit };
