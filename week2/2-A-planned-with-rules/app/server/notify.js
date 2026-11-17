// B08 · ประเมินทุก request (CONTRACT 0.7): ยกเลิกอัตโนมัติ NEED_FIX ที่เลย 168 ชม. + แจ้งเตือน SLA (BR-15, BR-20, FR-20)
// ไม่ใช่ route (ไม่ export function(app)) · ถูก require จาก routes/cases.js ซึ่ง push ฟังก์ชันเข้า util.requestHooks ตอนโหลด
// เวลาอ่านจาก clock เท่านั้น · ระดับเตือนใช้ sla.level · error ไม่ถูกกลืน
const { db, tx } = require('./db');
const clock = require('./clock');
const sla = require('./sla');
const { requestHooks } = require('./util');

// ---- ยกเลิกอัตโนมัติ (A-46) ----
// NEED_FIX ที่ now >= fix_deadline (= ตีกลับ + 168 ชม.) → CANCELLED · เวลาที่ลงไทม์ไลน์/closed_at = fix_deadline (ไม่ใช่เวลาที่มี request มาถึง)
// 167:59 ยังส่งแก้ได้ · 168:00 ยกเลิก · ไม่เขียน audit (ไม่ใช่ 1 ใน 10 เหตุการณ์ของ BR-27)
function autoCancelExpired() {
  const now = clock.now().getTime();
  const due = db.prepare("SELECT case_no, fix_deadline FROM cases WHERE status='NEED_FIX' AND fix_deadline IS NOT NULL").all()
    .filter((c) => {
      const t = clock.parseISO(c.fix_deadline);
      return t && now >= t.getTime();
    });
  if (!due.length) return 0;
  tx(() => {
    for (const c of due) {
      const r = db.prepare(
        `UPDATE cases SET status='CANCELLED', closed_at=?, owner=NULL, dept='', updated_at=?
         WHERE case_no=? AND status='NEED_FIX'`
      ).run(c.fix_deadline, c.fix_deadline, c.case_no);
      if (!r.changes) continue;
      db.prepare(
        `INSERT INTO timeline_events (case_no,time,actor,actor_role,kind,text,from_status,to_status)
         VALUES (?,?,NULL,'system','AUTO_CANCEL',?,'NEED_FIX','CANCELLED')`
      ).run(c.case_no, c.fix_deadline, 'ระบบยกเลิกคำขออัตโนมัติ เลยเวลาแก้ไข 168 ชั่วโมง');
    }
  });
  return due.length;
}

// ---- แจ้งเตือน ----
const TEXT = { near: 'ใกล้ครบกำหนด', overdue: 'เกินกำหนด' };

// ประเมินเฉพาะระดับปัจจุบัน (A-30: ไม่ย้อนแจ้งระดับที่ข้าม) · ผู้รับตาม BR-15/A-31 · UNIQUE(username,case_no,level) กันซ้ำ
function evaluateNotifications() {
  const nowISO = clock.nowISO();
  const open = db.prepare(
    "SELECT * FROM cases WHERE status IN ('SUBMITTED','IN_REVIEW','PENDING_APPROVAL','APPROVED') AND due_at IS NOT NULL AND due_at<>''"
  ).all();
  if (!open.length) return;
  const heads = db.prepare("SELECT username FROM users WHERE role='head' AND username IS NOT NULL").all().map((r) => r.username);
  const byDept = {};
  for (const u of db.prepare("SELECT username, dept FROM users WHERE role='officer' AND username IS NOT NULL").all()) {
    (byDept[u.dept] = byDept[u.dept] || []).push(u.username);
  }
  const ins = db.prepare('INSERT OR IGNORE INTO notifications (username, case_no, level, text, created_at) VALUES (?,?,?,?,?)');
  tx(() => {
    for (const c of open) {
      let level;
      try { level = sla.level(c, nowISO); } catch (e) { if (e.code === 'INVALID_TIME') continue; throw e; }
      if (level !== 'near' && level !== 'overdue') continue;
      let to;
      if (c.status === 'PENDING_APPROVAL') to = heads;
      else if (c.status === 'APPROVED') to = c.registry_owner ? [c.registry_owner] : [];
      else to = c.owner ? [c.owner] : (byDept[c.dept] || []);
      if (level === 'overdue') to = [...to, ...heads];
      const text = `คำขอ ${c.case_no} ${TEXT[level]}`;
      for (const u of new Set(to)) ins.run(u, c.case_no, level, text, nowISO);
    }
  });
}

function evaluate() {
  autoCancelExpired();
  evaluateNotifications();
}

// ลงทะเบียนครั้งเดียวต่อโปรเซส (module cache) · index.js เรียกก่อน route ทุกตัว ยกเว้น /api/test/*
requestHooks.push(evaluate);

module.exports = { evaluate, autoCancelExpired, evaluateNotifications };
