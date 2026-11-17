'use strict';
/**
 * BUG_MODE (B01) — เปิดบั๊กตาม BUGS.md ด้วยตัวแปรสภาพแวดล้อม BUG_MODE=B03,B07
 * ไม่ตั้ง/ว่าง = เว็บถูกต้อง 100%
 *
 * ใช้:  const { isBug } = require('../bugs');  if (isBug('B03')) { ...พฤติกรรมผิดตาม BUGS.md... }
 * กติกา: บั๊กเปลี่ยนพฤติกรรมเฉพาะจุดที่ระบุ ไม่เปลี่ยนข้อความ ไม่เปลี่ยน seed (BUGS.md §1)
 */

const KNOWN = ['B01', 'B02', 'B03', 'B04', 'B05', 'B06', 'B07', 'B08', 'B09', 'B10', 'B11', 'B12'];

function parse(str) {
  return new Set(
    String(str || '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
  );
}

let active = parse(process.env.BUG_MODE);

/** true ถ้าบั๊กรหัสนี้เปิดอยู่ เช่น isBug('B03') */
function isBug(code) {
  return active.has(String(code).toUpperCase());
}

/** รายการบั๊กที่เปิดอยู่ (เรียง) */
function activeBugs() {
  return [...active].sort();
}

/** สำหรับ unit test ภายในเท่านั้น: ตั้งชุดบั๊กใหม่ ("B01,B03" หรือ array) */
function setBugs(list) {
  active = parse(Array.isArray(list) ? list.join(',') : list);
}

const unknown = activeBugs().filter((c) => !KNOWN.includes(c));
if (unknown.length) {
  // ไม่ล่ม แค่เตือน
  console.warn('[bugs] unknown BUG_MODE code(s):', unknown.join(','));
}

module.exports = { isBug, activeBugs, setBugs, KNOWN };
