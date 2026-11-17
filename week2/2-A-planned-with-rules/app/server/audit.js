// Audit Trail: เพิ่มได้อย่างเดียว (ไม่มีฟังก์ชันแก้/ลบ) · เวลา = นาฬิกากลาง
const { db } = require('./db');
const clock = require('./clock');

// audit({ actor, role, event, caseNo, fromStatus, toStatus, detail }) -> id ของแถวที่เพิ่ม
module.exports = function audit({ actor = '', role = '', event, caseNo = null, fromStatus = null, toStatus = null, detail = '' }) {
  const r = db.prepare(
    `INSERT INTO audit (time, username, role, event, case_no, from_status, to_status, detail)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(clock.nowISO(), actor, role, event, caseNo, fromStatus, toStatus, detail || '');
  return Number(r.lastInsertRowid);
};
