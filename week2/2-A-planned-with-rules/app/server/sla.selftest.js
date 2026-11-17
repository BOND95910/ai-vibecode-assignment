// รัน: node server/sla.selftest.js · ลองบั๊ก: BUG_MODE=B03 / BUG_MODE=B04 node server/sla.selftest.js
// ตัวเลขทุกแถวมาจาก TEST-PLAN TC-SLA-01/02/03 และ BR-12/13/14 · ล้ม = แสดงแถวที่ล้มแล้ว exit 1
process.env.DB_PATH = ':memory:';
const { db, initSchema } = require('./db');
const sla = require('./sla');
const { bug } = require('./bugs');

initSchema();
for (const [d, n] of [['2026-12-07', 'ชดเชย'], ['2026-12-10', 'รัฐธรรมนูญ'], ['2026-12-31', 'สิ้นปี'], ['2027-01-01', 'ปีใหม่']]) {
  db.prepare('INSERT INTO holidays (date, name) VALUES (?, ?)').run(d, n);
}

const fails = [];
let total = 0;
function eq(name, actual, expected) {
  total += 1;
  if (actual !== expected) { fails.push(name); console.log(`FAIL ${name}\n     expected ${expected}\n     received ${actual}`); }
}
const T = (d, hm) => `${d}T${hm}:00+07:00`;
const due = (d) => `${d}T16:30:00+07:00`;

// ---- วันทำการ ----
const hs = new Set(['2026-12-07']);
eq('isBusinessDay อ.1 ธ.ค.', sla.isBusinessDay('2026-12-01', hs), true);
eq('isBusinessDay ส.5 ธ.ค.', sla.isBusinessDay('2026-12-05', hs), false);
eq('isBusinessDay อา.6 ธ.ค.', sla.isBusinessDay('2026-12-06', hs), false);
eq('isBusinessDay จ.7 ธ.ค. (หยุด)', sla.isBusinessDay('2026-12-07', hs), false);
eq('isBusinessDay จ.7 ธ.ค. (ไม่อยู่ในชุดที่ส่ง)', sla.isBusinessDay('2026-12-07', new Set()), true);
eq('loadHolidays อ่านจาก DB', sla.loadHolidays().size, bug('B03') ? 0 : 4);

// ---- TC-SLA-01 · computeDue ----
const sla01 = [
  ['a', '2026-12-01T09:00:00', 3, '2026-12-04'],
  ['b', '2026-12-01T16:29:00', 3, '2026-12-04'],
  ['b2 (16:29:59)', '2026-12-01T16:29:59', 3, '2026-12-04'],
  ['c', '2026-12-01T16:30:00', 3, '2026-12-08'],
  ['c2 (16:30:01)', '2026-12-01T16:30:01', 3, '2026-12-08'],
  ['d', '2026-12-04T10:00:00', 3, '2026-12-11'],
  ['e', '2026-12-05T10:00:00', 3, '2026-12-14'],
  ['f SV-02', '2026-12-01T09:00:00', 10, '2026-12-17'],
  ['g SV-03', '2026-12-01T09:00:00', 15, '2026-12-24'],
  ['h', '2026-12-29T10:00:00', 3, '2027-01-05'],
  ['i', '2026-12-31T23:59:00', 3, '2027-01-07'],
  ['อา.6 ธ.ค. -> D0 อ.8', '2026-12-06T12:00:00', 3, '2026-12-14'],
  ['จ.7 ธ.ค. (หยุด) -> D0 อ.8', '2026-12-07T09:00:00', 3, '2026-12-14'],
  ['ศ.4 16:30 -> D0 อ.8', '2026-12-04T16:30:00', 3, '2026-12-14'],
];
for (const [n, paid, N, want] of sla01) eq(`TC-SLA-01 ${n}`, sla.computeDue(`${paid}+07:00`, N), due(want));
// ISO ต่าง offset ต้องเทียบเป็นเวลาไทย: 09:29:59Z = 16:29:59 ไทย
eq('TC-SLA-01 UTC 09:29:59Z = 16:29:59 ไทย', sla.computeDue('2026-12-01T09:29:59Z', 3), due('2026-12-04'));
eq('TC-SLA-01 UTC 09:30:00Z = 16:30:00 ไทย', sla.computeDue('2026-12-01T09:30:00Z', 3), due('2026-12-08'));

// อ่านวันหยุดสดทุกครั้ง: เพิ่มวันหยุด 2 ธ.ค. -> กำหนดเลื่อน (ตรวจเอง · TC-RBAC-04 ใช้หลักเดียวกัน) แล้วลบ -> กลับ
db.prepare("INSERT INTO holidays (date, name) VALUES ('2026-12-02', 'ทดสอบ')").run();
eq('live-read เพิ่มวันหยุด 2 ธ.ค.', sla.computeDue(T('2026-12-01', '09:00'), 3), due('2026-12-08'));
db.prepare("DELETE FROM holidays WHERE date = '2026-12-02'").run();
eq('live-read ลบวันหยุด 2 ธ.ค.', sla.computeDue(T('2026-12-01', '09:00'), 3), due('2026-12-04'));

// ---- TC-SLA-02 · extendForFix ----
const d4 = due('2026-12-04');
eq('TC-SLA-02 ส่วน1 / BR-13 ตัวอย่าง', sla.extendForFix(d4, T('2026-12-02', '11:00'), T('2026-12-03', '10:00')), due('2026-12-08'));
eq('TC-SLA-02 ส่วน2 seed 17', sla.extendForFix(due('2026-11-27'), T('2026-11-27', '14:00'), T('2026-12-01', '09:00')), due('2026-12-01'));
eq('TC-SLA-02 ส่วน3 seed 17 ส่งแก้ 4 ธ.ค.', sla.extendForFix(due('2026-11-27'), T('2026-11-27', '14:00'), T('2026-12-04', '10:00')), due('2026-12-04'));
eq('TC-SLA-02 ส่วน4 วันเดียวกัน', sla.extendForFix(d4, T('2026-12-02', '09:00'), T('2026-12-02', '15:00')), d4);
eq('TC-SLA-02 ส่วน5 คร่อมสุดสัปดาห์+วันหยุด+หลัง 16:30', sla.extendForFix(d4, T('2026-12-04', '10:00'), T('2026-12-08', '17:00')), due('2026-12-08'));
// ส่งแก้ก่อนวันตีกลับ (ข้อมูลผิดปกติ) -> 0 วัน ไม่ถอยหลัง
eq('extendForFix ส่งแก้ก่อนตีกลับ = 0 วัน', sla.extendForFix(d4, T('2026-12-03', '10:00'), T('2026-12-02', '10:00')), d4);

// ---- TC-SLA-03 · workingDaysLeft / level ----
const A = { status: 'IN_REVIEW', dueAt: d4 };
for (const [n, now, left, lv] of [
  ['A อ.1 09:00', '2026-12-01T09:00:00', 3, 'normal'],
  ['A พ.2 09:00', '2026-12-02T09:00:00', 2, 'normal'],
  ['A พฤ.3 09:00', '2026-12-03T09:00:00', 1, 'near'],
  ['A ศ.4 16:30:00', '2026-12-04T16:30:00', 0, 'near'],
  ['A ศ.4 16:30:01', '2026-12-04T16:30:01', null, 'overdue'],
  ['A ศ.4 16:31:00', '2026-12-04T16:31:00', null, 'overdue'],
  ['A ส.5 10:00', '2026-12-05T10:00:00', null, 'overdue'],
]) {
  if (left !== null) eq(`TC-SLA-03 ${n} วันคงเหลือ`, sla.workingDaysLeft(`${now}+07:00`, d4), left);
  eq(`TC-SLA-03 ${n} level`, sla.level(A, `${now}+07:00`), lv);
}
const B = { status: 'IN_REVIEW', due_at: due('2026-12-08') }; // seed 16 (ใช้ชื่อคอลัมน์ DB ด้วย)
for (const [n, now, left, lv] of [
  ['B พฤ.3 09:00', '2026-12-03T09:00:00', 2, 'normal'],
  ['B ศ.4 09:00', '2026-12-04T09:00:00', 1, 'near'],
  ['B อ.8 16:30:00', '2026-12-08T16:30:00', 0, 'near'],
  ['B อ.8 16:31:00', '2026-12-08T16:31:00', null, 'overdue'],
]) {
  if (left !== null) eq(`TC-SLA-03 ${n} วันคงเหลือ`, sla.workingDaysLeft(`${now}+07:00`, due('2026-12-08')), left);
  eq(`TC-SLA-03 ${n} level`, sla.level(B, `${now}+07:00`), lv);
}
// ส่วน C (seed ที่ 09:00 วันที่ 1 ธ.ค.)
const nowC = T('2026-12-01', '09:00');
eq('TC-SLA-03 C 000020 เกินกำหนด', sla.level({ status: 'IN_REVIEW', dueAt: due('2026-11-30') }, nowC), 'overdue');
eq('TC-SLA-03 C 000022 ใกล้ (0)', sla.level({ status: 'IN_REVIEW', dueAt: due('2026-12-01') }, nowC), 'near');
eq('TC-SLA-03 C 000024 ใกล้ (1)', sla.level({ status: 'IN_REVIEW', dueAt: due('2026-12-02') }, nowC), 'near');
eq('TC-SLA-03 C 000025 ปกติ (2)', sla.level({ status: 'IN_REVIEW', dueAt: due('2026-12-03') }, nowC), 'normal');
eq('TC-SLA-03 C 000017 NEED_FIX หยุดนับ', sla.level({ status: 'NEED_FIX', dueAt: due('2026-11-27') }, nowC), 'paused');
eq('TC-SLA-03 C 000001 COMPLETED ปิดแล้ว', sla.level({ status: 'COMPLETED', dueAt: due('2026-11-01') }, nowC), 'closed');
eq('level REJECTED ปิดแล้ว', sla.level({ status: 'REJECTED', dueAt: due('2026-11-01') }, nowC), 'closed');
eq('level CANCELLED ปิดแล้ว', sla.level({ status: 'CANCELLED', dueAt: due('2026-11-01') }, nowC), 'closed');
eq('TC-SLA-03 C 000022 @16:30:00 ใกล้', sla.level({ status: 'IN_REVIEW', dueAt: due('2026-12-01') }, T('2026-12-01', '16:30')), 'near');
eq('TC-SLA-03 C 000022 @16:31 เกินกำหนด', sla.level({ status: 'IN_REVIEW', dueAt: due('2026-12-01') }, T('2026-12-01', '16:31')), 'overdue');
// หลัง TC-SLA-02: ระดับหลังส่งแก้
eq('TC-SLA-02 ส่วน1 level หลังส่งแก้ = ปกติ (2)', sla.level({ status: 'IN_REVIEW', dueAt: due('2026-12-08') }, T('2026-12-03', '10:00')), 'normal');
eq('TC-SLA-02 ส่วน2 level หลังส่งแก้ = ใกล้ (0)', sla.level({ status: 'IN_REVIEW', dueAt: due('2026-12-01') }, T('2026-12-01', '09:00')), 'near');
eq('TC-SLA-02 ส่วน3 level หลังส่งแก้ = ใกล้', sla.level({ status: 'IN_REVIEW', dueAt: due('2026-12-04') }, T('2026-12-04', '10:00')), 'near');
eq('TC-SLA-02 ส่วน5 level = เกินกำหนด', sla.level({ status: 'IN_REVIEW', dueAt: due('2026-12-08') }, T('2026-12-08', '17:00')), 'overdue');

console.log(`${total - fails.length}/${total} passed${process.env.BUG_MODE ? ` (BUG_MODE=${process.env.BUG_MODE})` : ''}`);
if (fails.length) { console.log(`ล้ม ${fails.length} แถว`); process.exit(1); }
