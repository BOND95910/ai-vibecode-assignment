// B03 · วันทำการ / กำหนดเสร็จ (SLA) / ระดับเตือน · BR-12 BR-13 BR-14
// ไม่อ่านเวลาเครื่อง: ทุกอย่างคำนวณจากสตริง ISO ที่ส่งเข้ามา (แปลงเป็นเวลาไทยด้วยคณิตศาสตร์วันที่เอง)
const { db } = require('./db');
const clock = require('./clock');
const { bug } = require('./bugs');

const CUTOFF_SEC = 16 * 3600 + 30 * 60; // 16:30:00 · ยื่นตั้งแต่ 16:30:00 = วันถัดไป (A-03)
const DAY_MS = 86400000;
const pad = (n) => String(n).padStart(2, '0');

// 'YYYY-MM-DD' <-> เลขวัน (นับจาก 1970-01-01) · ใช้ Date.UTC เป็นเครื่องคิดเลขวันที่ ไม่เกี่ยวกับ timezone เครื่อง
const dayNum = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / DAY_MS); };
const dayStr = (n) => { const t = new Date(n * DAY_MS); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; };
const dowOf = (n) => new Date(n * DAY_MS).getUTCDay(); // 0 = อาทิตย์

// ISO (offset อะไรก็ได้) -> { day: เลขวันตามเวลาไทย, sec: วินาทีของวัน, ms: instant }
function split(iso) {
  const t = clock.parseISO(iso);
  if (!t) throw Object.assign(new Error('INVALID_TIME'), { code: 'INVALID_TIME' });
  const b = clock.toBangkokISO(t);
  const [h, mi, s] = b.slice(11, 19).split(':').map(Number);
  return { day: dayNum(b.slice(0, 10)), sec: h * 3600 + mi * 60 + s, ms: t.getTime(), time: b.slice(11, 19) };
}
const toISO = (day, time) => `${dayStr(day)}T${time}+07:00`;

// อ่านวันหยุดสดจาก DB ทุกครั้ง (admin เพิ่ม/ลบได้) · B03: ทำเหมือนไม่มีตารางวันหยุด (ข้ามแค่ ส-อา)
function loadHolidays() {
  if (bug('B03')) return new Set();
  return new Set(db.prepare('SELECT date FROM holidays').all().map((r) => r.date));
}

// จ.–ศ. ที่ไม่อยู่ในตารางวันหยุด · holidaySet ไม่ส่ง = อ่านจาก DB
function isBusinessDay(dateStr, holidaySet) {
  const n = dayNum(String(dateStr).slice(0, 10));
  const dow = dowOf(n);
  return dow !== 0 && dow !== 6 && !(holidaySet || loadHolidays()).has(dayStr(n));
}
const biz = (n, hs) => isBusinessDay(dayStr(n), hs);

// วันทำการแรกที่ >= n
function onOrAfter(n, hs) { while (!biz(n, hs)) n += 1; return n; }
// วันทำการที่ k หลังวัน n (k >= 0; n เองไม่นับ)
function addBiz(n, k, hs) { while (k > 0) { n += 1; if (biz(n, hs)) k -= 1; } return n; }
// จำนวนวันทำการใน (a, b]
function countBiz(a, b, hs) { let c = 0; for (let n = a + 1; n <= b; n += 1) if (biz(n, hs)) c += 1; return c; }

// BR-12 · คำนวณครั้งเดียวตอนชำระ
function computeDue(paidAtISO, slaDays) {
  const hs = loadHolidays();
  const p = split(paidAtISO);
  const d0 = p.sec < CUTOFF_SEC ? onOrAfter(p.day, hs) : onOrAfter(p.day + 1, hs);
  return toISO(addBiz(d0, slaDays, hs), '16:30:00');
}

// BR-13 · กำหนดใหม่ = กำหนดเดิม + วันทำการใน (วันตีกลับ, วันส่งแก้] · ใช้ตารางวันหยุด ณ ตอนเรียก
function extendForFix(dueISO, returnedAtISO, resubmittedAtISO) {
  if (bug('B04')) return dueISO; // บั๊ก: ไม่หยุดนับ
  const hs = loadHolidays();
  const due = split(dueISO);
  const paused = countBiz(split(returnedAtISO).day, split(resubmittedAtISO).day, hs);
  return paused === 0 ? dueISO : toISO(addBiz(due.day, paused, hs), due.time);
}

// BR-14 · วันคงเหลือ = จำนวนวันทำการหลังวันนี้ถึงวันกำหนด (รวมวันกำหนด) · เลยกำหนดแล้ว = 0
function workingDaysLeft(nowISO, dueISO) {
  return countBiz(split(nowISO).day, split(dueISO).day, loadHolidays());
}

// caseLike: { status, dueAt | due_at } → normal | near | overdue | paused | closed
function level(caseLike, nowISO) {
  const status = caseLike.status;
  if (status === 'NEED_FIX') return 'paused';
  if (status === 'COMPLETED' || status === 'REJECTED' || status === 'CANCELLED') return 'closed';
  const dueISO = caseLike.dueAt || caseLike.due_at;
  if (split(nowISO).ms > split(dueISO).ms) return 'overdue';
  return workingDaysLeft(nowISO, dueISO) <= 1 ? 'near' : 'normal';
}

module.exports = { isBusinessDay, loadHolidays, computeDue, extendForFix, workingDaysLeft, level };
