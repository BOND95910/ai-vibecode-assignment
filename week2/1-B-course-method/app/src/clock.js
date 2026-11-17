'use strict';
/**
 * นาฬิกาของระบบ (B01) — ทุกกฎธุรกิจต้องอ่านเวลาจากไฟล์นี้เท่านั้น ห้ามเรียก Date.now() / new Date() ตรง ๆ
 *
 * - TEST_MODE=1 : นาฬิกาแช่แข็ง (frozen) เริ่มที่ 2026-12-01T09:00:00+07:00 · เปลี่ยนได้ด้วย PUT /api/test/clock
 * - ไม่ตั้ง TEST_MODE : ใช้เวลาจริงของเครื่อง (แต่ทุกการคำนวณยังเป็น Asia/Bangkok +07:00)
 *
 * เวลาทั้งหมดในระบบ (DB / API) เป็นสตริง ISO รูปแบบเดียว: "YYYY-MM-DDTHH:MM:SS+07:00"
 * → เปรียบเทียบด้วยการเทียบสตริงได้ (offset คงที่ +07:00 · ประเทศไทยไม่มี DST)
 */

const OFFSET_MS = 7 * 3600 * 1000;
const INITIAL_ISO = '2026-12-01T09:00:00+07:00';
const DAY_MS = 86400000;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/;

const TEST_MODE = process.env.TEST_MODE === '1';

let frozenMs = TEST_MODE ? Date.parse(INITIAL_ISO) : null;

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** แปลง Date | number(ms) | ISO string → ms epoch · คืน NaN ถ้าแปลงไม่ได้ */
function toMs(t) {
  if (t instanceof Date) return t.getTime();
  if (typeof t === 'number') return t;
  if (typeof t === 'string') {
    const d = parseIso(t);
    return d ? d.getTime() : NaN;
  }
  return NaN;
}

/** เวลาปัจจุบันเป็น ms epoch (อ่านจากนาฬิกาทดสอบถ้าแช่แข็ง) */
function nowMs() {
  // eslint-disable-next-line no-restricted-properties
  return frozenMs !== null ? frozenMs : Date.now();
}

/** เวลาปัจจุบันเป็น Date */
function now() {
  return new Date(nowMs());
}

/** เวลาปัจจุบันเป็น ISO +07:00 เช่น "2026-12-01T09:00:00+07:00" */
function nowIso() {
  return toIso(nowMs());
}

/** Date | ms | ISO → "YYYY-MM-DDTHH:MM:SS+07:00" (ตัดมิลลิวินาทีทิ้ง) */
function toIso(t) {
  const ms = toMs(t);
  if (!Number.isFinite(ms)) throw new Error('clock.toIso: invalid time ' + t);
  const b = new Date(Math.floor(ms / 1000) * 1000 + OFFSET_MS);
  return `${b.getUTCFullYear()}-${pad(b.getUTCMonth() + 1)}-${pad(b.getUTCDate())}T${pad(b.getUTCHours())}:${pad(b.getUTCMinutes())}:${pad(b.getUTCSeconds())}+07:00`;
}

/**
 * แปลงสตริง ISO ที่ "ต้องมี offset" (Z หรือ ±HH:MM) → Date · ไม่ถูกต้อง → null
 * ตรวจค่าทุกช่องจริง (เดือน 13 / วันที่ 31 ก.พ. / ชั่วโมง 24 → null)
 */
function parseIso(str) {
  if (typeof str !== 'string') return null;
  const m = ISO_RE.exec(str.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s = '0', frac = '', off] = m;
  const Y = +y, M = +mo, D = +d, H = +h, MI = +mi, S = +s;
  if (M < 1 || M > 12 || D < 1 || H > 23 || MI > 59 || S > 59) return null;
  const dim = new Date(Date.UTC(Y, M, 0)).getUTCDate();
  if (D > dim) return null;
  let offMin = 0;
  if (off !== 'Z') {
    const sign = off[0] === '-' ? -1 : 1;
    const oh = +off.slice(1, 3), om = +off.slice(4, 6);
    if (oh > 14 || om > 59) return null;
    offMin = sign * (oh * 60 + om);
  }
  const ms = Date.UTC(Y, M - 1, D, H, MI, S, frac ? Math.floor(+('0.' + frac) * 1000) : 0) - offMin * 60000;
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** แยกส่วนประกอบตามเวลาไทย: {y, m(1-12), d, hh, mm, ss, dow(0=อา..6=ส), ymd:"YYYY-MM-DD", hm:"HH:MM", be(พ.ศ.)} */
function bkkParts(t) {
  const ms = toMs(t === undefined ? nowMs() : t);
  const b = new Date(ms + OFFSET_MS);
  const y = b.getUTCFullYear(), m = b.getUTCMonth() + 1, d = b.getUTCDate();
  return {
    y, m, d,
    hh: b.getUTCHours(), mm: b.getUTCMinutes(), ss: b.getUTCSeconds(),
    dow: b.getUTCDay(),
    ymd: `${y}-${pad(m)}-${pad(d)}`,
    hm: `${pad(b.getUTCHours())}:${pad(b.getUTCMinutes())}`,
    be: y + 543,
  };
}

/** วันที่ตามเวลาไทย "YYYY-MM-DD" ของเวลาที่ให้ (ค่าเริ่มต้น = ตอนนี้) */
function bkkDate(t) {
  return bkkParts(t).ymd;
}

/** ปี พ.ศ. ตามเวลาไทยของเวลาที่ให้ (ค่าเริ่มต้น = ตอนนี้) เช่น 2569 */
function beYear(t) {
  return bkkParts(t).be;
}

/** สร้างเวลาจากส่วนประกอบเวลาไทย → ISO +07:00 · fromBkk("2026-12-04", "16:30") หรือ fromBkk(2026,12,4,16,30,0) */
function fromBkk(a, b, c, hh = 0, mm = 0, ss = 0) {
  let y, mo, d;
  if (typeof a === 'string') {
    [y, mo, d] = a.split('-').map(Number);
    if (typeof b === 'string') {
      const p = b.split(':').map(Number);
      hh = p[0] || 0; mm = p[1] || 0; ss = p[2] || 0;
    }
  } else {
    y = a; mo = b; d = c;
  }
  return toIso(Date.UTC(y, mo - 1, d, hh, mm, ss) - OFFSET_MS);
}

/** บวกวันปฏิทินให้ "YYYY-MM-DD" → "YYYY-MM-DD" (ไม่สนวันทำการ) */
function addDaysYmd(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + n * DAY_MS);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** วันในสัปดาห์ของ "YYYY-MM-DD" (0=อาทิตย์ … 6=เสาร์) */
function dowYmd(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** บวกมิลลิวินาทีให้เวลา → ISO +07:00 */
function addMs(t, ms) {
  return toIso(toMs(t) + ms);
}

/** ส่วนต่างเวลา a − b เป็น ms */
function diffMs(a, b) {
  return toMs(a) - toMs(b);
}

// ---------- ควบคุมนาฬิกา (ใช้โดย test hook เท่านั้น) ----------

/** ตั้งนาฬิกาแช่แข็ง · คืน ISO +07:00 ที่ตั้งได้ หรือ null ถ้าสตริงไม่ถูกต้อง/ไม่มี offset */
function set(isoWithOffset) {
  const d = parseIso(isoWithOffset);
  if (!d) return null;
  frozenMs = Math.floor(d.getTime() / 1000) * 1000;
  return toIso(frozenMs);
}

/** กลับค่าเริ่มต้นหลัง reset: แช่แข็งที่ 2026-12-01T09:00:00+07:00 */
function reset() {
  frozenMs = Date.parse(INITIAL_ISO);
  return INITIAL_ISO;
}

function isFrozen() {
  return frozenMs !== null;
}

module.exports = {
  INITIAL_ISO,
  OFFSET_MS,
  DAY_MS,
  now,
  nowMs,
  nowIso,
  toIso,
  toMs,
  parseIso,
  bkkParts,
  bkkDate,
  beYear,
  fromBkk,
  addDaysYmd,
  dowYmd,
  addMs,
  diffMs,
  set,
  reset,
  isFrozen,
};
