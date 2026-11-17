'use strict';
/**
 * SLA (B03) — วันทำการ · กำหนดเสร็จ · หยุดนับ · วันคงเหลือ · ระดับเตือน · แจ้งเตือนในกระดิ่ง
 *
 * ที่มา: DECISIONS §0 §8 §18 · REQUIREMENTS BR-12 BR-13 BR-14 BR-15 · A-02 A-03 A-17 A-30 A-31 A-42 · CONTRACT §4.2
 *
 * กฎ (เวลาไทย +07:00 ทั้งหมด · อ่านเวลาจาก clock เท่านั้น):
 * - วันทำการ = จันทร์–ศุกร์ ที่ไม่อยู่ในตาราง holidays (อ่าน DB ทุกครั้งที่เรียก → admin เพิ่ม/ลบวันหยุดมีผลทันทีกับการคำนวณใหม่)
 * - D0 = วันที่ชำระ ถ้าเป็นวันทำการและเวลา < 16:30:00 · ไม่งั้นวันทำการถัดไป (16:29:59 = วันเดิม · 16:30:00 = วันถัดไป)
 * - กำหนดเสร็จ = วันทำการที่ N หลัง D0 เวลา 16:30:00 (N = sla_days ของบริการ) · คำนวณครั้งเดียวตอนชำระ (A-42)
 * - หยุดนับ (ส่งแก้หลัง NEED_FIX) = กำหนดเดิม + จำนวนวันทำการใน (วันที่ตีกลับ, วันที่ส่งแก้] (นับตามวันที่ ไม่สนเวลา)
 * - วันคงเหลือ = จำนวนวันทำการใน (วันนี้, วันกำหนดเสร็จ] · เลยกำหนดแล้ว = 0
 * - ระดับ: overdue ⇔ ตอนนี้ > กำหนดเสร็จ · near ⇔ วันคงเหลือ ≤ 1 (และยังไม่เลย) · normal ⇔ ≥ 2
 *          paused = NEED_FIX · closed = COMPLETED/REJECTED/CANCELLED · null = DRAFT/PENDING_PAYMENT (ยังไม่มีเลขคำขอ)
 * - แจ้งเตือน (tick ก่อนทุก request): ประเมินเฉพาะระดับปัจจุบัน (A-30 ไม่ย้อนแจ้ง near ที่ข้ามไป) ของคำขอ
 *   SUBMITTED/IN_REVIEW/PENDING_APPROVAL/APPROVED · ผู้รับตาม A-31 · 1 รายการต่อ (ผู้ใช้, คำขอ, ระดับ) — UNIQUE + INSERT OR IGNORE
 *
 * BUG_MODE (BUGS.md):
 * - B03: ฟังก์ชันวันทำการตัวเดียว (businessDay ด้านล่าง = isBusinessDay) ไม่สนตารางวันหยุด → กระทบทั้งกำหนดเสร็จ หยุดนับ และวันคงเหลือ
 * - B04: extendDueAt คืนกำหนดเดิม (ไม่หยุดนับ)
 */

const clock = require('./clock');
const { db } = require('./db');
const { isBug } = require('./bugs');
const { LIMITS, SERVICES, FINAL_STATUSES, SLA_LEVEL_LABEL } = require('./constants');

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
/** กันวนไม่รู้จบตอนหา "วันทำการถัดไป" (ถ้ามีวันหยุดติดกันผิดปกติ) */
const MAX_SEARCH_DAYS = 3660;

const pad = (n) => String(n).padStart(2, '0');
const hmToSec = (hm) => {
  const [h = 0, m = 0, s = 0] = String(hm).split(':').map(Number);
  return h * 3600 + m * 60 + s;
};
/** ตัดรอบ 16:30:00 (A-03) */
const CUTOFF_SEC = hmToSec(LIMITS.CUTOFF_HM);
/** เวลาของกำหนดเสร็จ 16:30 */
const DUE_HM = LIMITS.DUE_HM;
/** วันคงเหลือ ≤ ค่านี้ = ใกล้ครบกำหนด (A-17) */
const NEAR_DAYS = LIMITS.NEAR_DAYS;

/** สถานะที่ยังไม่มีเลขคำขอ → ไม่มี SLA */
const NO_SLA_STATUSES = ['DRAFT', 'PENDING_PAYMENT'];
/** สถานะที่ประเมินแจ้งเตือน (ยังไม่ปิด · ไม่ NEED_FIX · มีเลขแล้ว) */
const NOTIFY_STATUSES = ['SUBMITTED', 'IN_REVIEW', 'PENDING_APPROVAL', 'APPROVED'];
const NOTIFY_LEVELS = ['near', 'overdue'];

// ---------------------------------------------------------------------------
// แปลงค่าเข้า
// ---------------------------------------------------------------------------

/** ISO(+offset) | Date | ms → ms · ไม่ถูกต้อง → throw */
function toMsStrict(t) {
  const ms = clock.toMs(t);
  if (!Number.isFinite(ms)) throw new Error(`sla: invalid time ${t}`);
  return ms;
}

/** 'YYYY-MM-DD' | ISO(+offset) | Date | ms → 'YYYY-MM-DD' (วันที่ตามเวลาไทย) · ไม่ถูกต้อง → throw */
function toYmd(t) {
  if (typeof t === 'string' && YMD_RE.test(t.trim())) {
    const ymd = t.trim();
    if (clock.addDaysYmd(ymd, 0) !== ymd) throw new Error(`sla: invalid date ${t}`);
    return ymd;
  }
  return clock.bkkDate(toMsStrict(t));
}

/** จำนวนวันทำการต้องเป็นจำนวนเต็ม ≥ 0 */
function toDayCount(n) {
  const k = Number(n);
  if (!Number.isInteger(k) || k < 0) throw new Error(`sla: invalid business-day count ${n}`);
  return k;
}

/** อ่านค่าจากแถว DB (snake_case) หรืออ็อบเจ็กต์ API (camelCase) */
function pick(row, snake, camel) {
  return row[snake] !== undefined ? row[snake] : row[camel];
}

// ---------------------------------------------------------------------------
// วันทำการ (ฟังก์ชันเดียวที่ทุกการคำนวณใช้)
// ---------------------------------------------------------------------------

let stmts = null;
/** prepared statements (สร้างครั้งแรกที่ใช้ · ตารางมีแล้วตั้งแต่ require('./db')) */
function S() {
  if (!stmts) {
    stmts = {
      holidays: db.prepare('SELECT date FROM holidays'),
      openCases: db.prepare(
        `SELECT id, case_no, service_id, status, step, dept, owner, issuer, due_at FROM cases
          WHERE case_no IS NOT NULL AND due_at IS NOT NULL
            AND status IN (${NOTIFY_STATUSES.map(() => '?').join(', ')})
          ORDER BY due_at, case_no`
      ),
      heads: db.prepare("SELECT username FROM users WHERE role = 'head' AND username IS NOT NULL ORDER BY username"),
      deptOfficers: db.prepare(
        "SELECT username FROM users WHERE role = 'officer' AND dept = ? AND username IS NOT NULL ORDER BY username"
      ),
      exists: db.prepare('SELECT 1 FROM notifications WHERE username = ? AND case_id = ? AND level = ?'),
      insert: db.prepare(
        'INSERT OR IGNORE INTO notifications (username, case_id, case_no, level, text, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ),
    };
  }
  return stmts;
}

/** ชุดวันหยุดจากตาราง holidays ณ ตอนเรียก */
function holidaySet() {
  return new Set(S().holidays.all().map((r) => String(r.date).trim()));
}

/**
 * วันทำการหรือไม่ ('YYYY-MM-DD' ที่ตรวจแล้ว + ชุดวันหยุด)
 * BUG B03: ไม่สนตารางวันหยุด (ข้ามแค่เสาร์-อาทิตย์) — ทุกฟังก์ชันในไฟล์นี้ใช้ตัวนี้ตัวเดียว
 */
function businessDay(ymd, hol) {
  const dow = clock.dowYmd(ymd);
  if (dow === 0 || dow === 6) return false;
  if (isBug('B03')) return true;
  return !hol.has(ymd);
}

/** วันทำการถัดไปหลัง ymd (ไม่รวม ymd) */
function nextBD(ymd, hol) {
  let d = ymd;
  for (let i = 0; i < MAX_SEARCH_DAYS; i++) {
    d = clock.addDaysYmd(d, 1);
    if (businessDay(d, hol)) return d;
  }
  throw new Error(`sla: no business day within ${MAX_SEARCH_DAYS} days after ${ymd}`);
}

/** วันทำการที่ n หลัง ymd (n = 0 → ymd) */
function addBD(ymd, n, hol) {
  let d = ymd;
  for (let i = 0; i < n; i++) d = nextBD(d, hol);
  return d;
}

/** จำนวนวันทำการใน (fromYmd, toYmd] · stopAfter = หยุดนับเมื่อเกินค่านี้ (ใช้ตอนต้องการรู้แค่ "≤ k หรือไม่") */
function countBD(fromYmd, toYmd_, hol, stopAfter = Infinity) {
  if (toYmd_ <= fromYmd) return 0;
  let n = 0;
  for (let d = clock.addDaysYmd(fromYmd, 1); d <= toYmd_; d = clock.addDaysYmd(d, 1)) {
    if (businessDay(d, hol) && ++n > stopAfter) break;
  }
  return n;
}

/** D0 ของเวลาชำระ */
function startDayWith(paidAtIso, hol) {
  const p = clock.bkkParts(toMsStrict(paidAtIso));
  const sec = p.hh * 3600 + p.mm * 60 + p.ss;
  if (businessDay(p.ymd, hol) && sec < CUTOFF_SEC) return p.ymd;
  return nextBD(p.ymd, hol);
}

/** ระดับเตือน (ใช้ชุดวันหยุดที่โหลดไว้ ถ้าให้มา) */
function levelWith(row, nowIso, hol) {
  if (!row) return null;
  const status = row.status;
  if (NO_SLA_STATUSES.includes(status)) return null;
  if (FINAL_STATUSES.includes(status)) return 'closed';
  if (status === 'NEED_FIX') return 'paused';
  const due = pick(row, 'due_at', 'dueAt');
  if (!due) return null;
  const dueMs = toMsStrict(due);
  const nowMs = toMsStrict(nowIso);
  if (nowMs > dueMs) return 'overdue';
  const left = countBD(clock.bkkDate(nowMs), clock.bkkDate(dueMs), hol || holidaySet(), NEAR_DAYS);
  return left <= NEAR_DAYS ? 'near' : 'normal';
}

// ---------------------------------------------------------------------------
// API ของโมดูล (INTERFACES §6.2)
// ---------------------------------------------------------------------------

/** จ.–ศ. ที่ไม่อยู่ในตารางวันหยุด (อ่าน DB ตอนเรียก) · รับ 'YYYY-MM-DD' หรือ ISO · B03: ไม่สนวันหยุด */
function isBusinessDay(ymd) {
  return businessDay(toYmd(ymd), holidaySet());
}

/** วันทำการถัดไปหลัง ymd → 'YYYY-MM-DD' */
function nextBusinessDay(ymd) {
  return nextBD(toYmd(ymd), holidaySet());
}

/** วันทำการที่ n หลัง ymd → 'YYYY-MM-DD' (n = 0 → ymd เดิม) */
function addBusinessDays(ymd, n) {
  return addBD(toYmd(ymd), toDayCount(n), holidaySet());
}

/** D0: วันที่ชำระถ้าเป็นวันทำการและ < 16:30:00 ไม่งั้นวันทำการถัดไป → 'YYYY-MM-DD' */
function startDay(paidAtIso) {
  return startDayWith(paidAtIso, holidaySet());
}

/** กำหนดเสร็จ = วันทำการที่ slaDays หลัง D0 เวลา 16:30:00 → 'YYYY-MM-DDT16:30:00+07:00' */
function computeDueAt(paidAtIso, slaDays) {
  const hol = holidaySet();
  const d0 = startDayWith(paidAtIso, hol);
  return clock.fromBkk(addBD(d0, toDayCount(slaDays), hol), DUE_HM);
}

/** จำนวนวันทำการใน (วันที่ของ from, วันที่ของ to] (นับตามวันที่ ไม่สนเวลา · to ≤ from → 0) */
function businessDaysBetween(fromIso, toIso) {
  return countBD(toYmd(fromIso), toYmd(toIso), holidaySet());
}

/**
 * หยุดนับ SLA ตอนประชาชนส่งแก้: กำหนดเดิม + businessDaysBetween(ตีกลับ, ส่งแก้) วันทำการ (เวลาเดิม 16:30)
 * ใช้ตารางวันหยุด ณ ตอนเรียก (= ตอนส่งแก้ · A-42) · หยุด 0 วัน → คืนค่าเดิม
 * BUG B04: คืน dueAtIso เดิมเสมอ (ไม่หยุดนับ)
 */
function extendDueAt(dueAtIso, returnedAtIso, resubmittedAtIso) {
  if (isBug('B04')) return dueAtIso;
  if (!dueAtIso || !returnedAtIso || !resubmittedAtIso) return dueAtIso;
  const hol = holidaySet();
  const paused = countBD(toYmd(returnedAtIso), toYmd(resubmittedAtIso), hol);
  if (paused <= 0) return dueAtIso;
  const due = clock.bkkParts(toMsStrict(dueAtIso));
  return clock.fromBkk(addBD(due.ymd, paused, hol), `${pad(due.hh)}:${pad(due.mm)}:${pad(due.ss)}`);
}

/** วันคงเหลือ = จำนวนวันทำการหลังวันนี้ถึงวันกำหนด (รวมวันกำหนด) · ตอนนี้ > กำหนด → 0 */
function remainingDays(dueAtIso, nowIso) {
  const dueMs = toMsStrict(dueAtIso);
  const nowMs = toMsStrict(nowIso || clock.nowIso());
  if (nowMs > dueMs) return 0;
  return countBD(clock.bkkDate(nowMs), clock.bkkDate(dueMs), holidaySet());
}

/**
 * ระดับเตือนของคำขอ ณ nowIso (ค่าเริ่มต้น = นาฬิกาตอนนี้)
 * → 'normal' | 'near' | 'overdue' | 'paused' | 'closed' | null (DRAFT/PENDING_PAYMENT)
 * caseRow = แถว cases (status, due_at) หรืออ็อบเจ็กต์ที่มี status, dueAt
 */
function slaLevel(caseRow, nowIso) {
  return levelWith(caseRow, nowIso || clock.nowIso(), null);
}

/** แผนกของคิวที่คำขออยู่ (ใช้เมื่อไม่มีผู้ถือ) · dept ว่าง → เดาจากเส้นทางบริการ + ขั้น */
function queueDept(row) {
  if (row.dept) return row.dept;
  const svc = SERVICES[row.service_id];
  const stage = svc && svc.route[(Number(row.step) || 1) - 1];
  return (stage && stage.dept) || 'registry';
}

function makeLookup() {
  let heads = null;
  const officers = new Map();
  return {
    heads: () => heads || (heads = S().heads.all().map((r) => r.username)),
    officers: (dept) => {
      if (!officers.has(dept)) officers.set(dept, S().deptOfficers.all(dept).map((r) => r.username));
      return officers.get(dept);
    },
  };
}

/**
 * ผู้รับแจ้งเตือนของคำขอที่ระดับนี้ (DECISIONS §18 · A-31) เรียงไม่ซ้ำ:
 * PENDING_APPROVAL → head ทุกคน · APPROVED → ผู้ออกเอกสาร (issuer) · มีผู้ถือ → ผู้ถือ · ไม่มีผู้ถือ → officer ทุกคนของแผนกนั้น
 * ระดับ overdue → เพิ่ม head ทุกคน (ไม่ซ้ำ)
 */
function recipientsFor(row, level, lookup) {
  const out = [];
  const add = (u) => {
    if (u && !out.includes(u)) out.push(u);
  };
  if (row.status === 'PENDING_APPROVAL') lookup.heads().forEach(add);
  else if (row.status === 'APPROVED' && row.issuer) add(row.issuer);
  else if (row.owner) add(row.owner);
  else lookup.officers(queueDept(row)).forEach(add);
  if (level === 'overdue') lookup.heads().forEach(add);
  return out;
}

/** ผู้รับแจ้งเตือน (สำหรับแสดง/ตรวจ) · caseRow = แถว cases */
function notificationRecipients(caseRow, level) {
  return recipientsFor(caseRow, level, makeLookup());
}

/** ข้อความแจ้งเตือน `คำขอ EG-2569-000024 ใกล้ครบกำหนด` / `คำขอ EG-2569-000020 เกินกำหนด` */
function notificationText(caseNo, level) {
  return `คำขอ ${caseNo} ${SLA_LEVEL_LABEL[level]}`;
}

/**
 * tick (server.js เรียกก่อนทุก request ยกเว้น /api/test/* /api/health /static/*):
 * สร้างแจ้งเตือนของระดับปัจจุบัน (near/overdue) ให้ผู้รับที่ยังไม่เคยได้ (ผู้ใช้, คำขอ, ระดับ) นี้ · คืนจำนวนที่เพิ่ม
 * ลำดับที่เพิ่ม = กำหนดเสร็จเร็วก่อน เลขน้อยก่อน (BR-16) · created_at = nowIso
 */
function evaluateNotifications(nowIso) {
  try {
    const now = clock.toIso(nowIso || clock.nowIso());
    const st = S();
    const rows = st.openCases.all(...NOTIFY_STATUSES);
    if (!rows.length) return 0;
    const hol = holidaySet();
    const lookup = makeLookup();
    const todo = [];
    for (const row of rows) {
      const level = levelWith(row, now, hol);
      if (!NOTIFY_LEVELS.includes(level)) continue;
      const text = notificationText(row.case_no, level);
      for (const username of recipientsFor(row, level, lookup)) {
        if (!st.exists.get(username, row.id, level)) todo.push([username, row.id, row.case_no, level, text, now]);
      }
    }
    if (!todo.length) return 0; // ไม่มีอะไรใหม่ → ไม่เปิด write transaction
    let added = 0;
    db.transaction(() => {
      for (const r of todo) added += st.insert.run(...r).changes;
    })();
    return added;
  } catch (err) {
    // ไม่ให้ทุก request ล่มเพราะแจ้งเตือน — บันทึกไว้แล้วไปต่อ
    console.error('[sla] evaluateNotifications failed:', err && err.stack ? err.stack : err);
    return 0;
  }
}

/** ทันกำหนด ⇔ closed_at ≤ กำหนดเสร็จ (รวมวินาทีที่ 16:30:00 · DECISIONS §18) */
function isOnTime(closedAtIso, dueAtIso) {
  if (!closedAtIso || !dueAtIso) return false;
  return toMsStrict(closedAtIso) <= toMsStrict(dueAtIso);
}

module.exports = {
  isBusinessDay,
  nextBusinessDay,
  addBusinessDays,
  startDay,
  computeDueAt,
  businessDaysBetween,
  extendDueAt,
  remainingDays,
  slaLevel,
  evaluateNotifications,
  // ตัวช่วยเพิ่มเติม (ไม่บังคับใช้)
  notificationRecipients,
  notificationText,
  isOnTime,
  NOTIFY_STATUSES,
};
