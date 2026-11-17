'use strict';
/**
 * รูปแบบแสดงผล (B01) — วันที่ไทย พ.ศ. ย่อ · เงิน ฿ · ปิดบังเลขบัตร/ชื่อ · HTML escape
 * (CONTRACT §0.2–0.3 · DECISIONS §0 §11 · A-04 A-24 A-54)
 * ฝั่งเบราว์เซอร์มีฟังก์ชันชุดเดียวกันใน public/common.js (window.Egov)
 */

const clock = require('./clock');

const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const pad = (n) => String(n).padStart(2, '0');

/** ISO → "4 ธ.ค. 2569 16:30" (เวลาไทย) · null/'' → '' */
function thaiDateTime(iso) {
  if (!iso) return '';
  const p = clock.bkkParts(iso);
  return `${p.d} ${TH_MONTHS[p.m - 1]} ${p.be} ${pad(p.hh)}:${pad(p.mm)}`;
}

/** "YYYY-MM-DD" หรือ ISO → "2 ก.พ. 2570" */
function thaiDate(v) {
  if (!v) return '';
  let y, m, d;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    [y, m, d] = v.split('-').map(Number);
  } else {
    const p = clock.bkkParts(v);
    y = p.y; m = p.m; d = p.d;
  }
  return `${d} ${TH_MONTHS[m - 1]} ${y + 543}`;
}

/** 1010 → "฿1,010" (จำนวนเต็มบาท) · null/NaN → "–" */
function baht(n) {
  if (n === null || n === undefined || n === '' || !Number.isFinite(Number(n))) return '–';
  return '฿' + Math.round(Number(n)).toLocaleString('en-US');
}

/** จำนวนเต็มมีจุลภาค 100000 → "100,000" */
function num(n) {
  return Number(n).toLocaleString('en-US');
}

/** "3100600987659" → "3-1006-00987-65-9" */
function formatId(idNo) {
  const s = String(idNo || '').replace(/\D/g, '');
  if (s.length !== 13) return String(idNo || '');
  return `${s[0]}-${s.slice(1, 5)}-${s.slice(5, 10)}-${s.slice(10, 12)}-${s[12]}`;
}

/** "3100600987659" → "X-XXXX-XXXXX-65-9" (เห็น 3 หลักท้าย · A-24) */
function maskId(idNo) {
  const s = String(idNo || '').replace(/\D/g, '');
  if (s.length !== 13) return 'X-XXXX-XXXXX-XX-X';
  return `X-XXXX-XXXXX-${s.slice(10, 12)}-${s[12]}`;
}

/** "สมชาย ใจดี" → "สมชาย ใ***" (ชื่อเต็ม + อักษรแรกของนามสกุล + *** · A-54) */
function maskName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  if (parts.length < 2) return parts[0] ? parts[0] + ' ***' : '';
  const first = parts[0];
  const last = Array.from(parts[parts.length - 1]); // กันตัดกลางอักขระ
  return `${first} ${last[0]}***`;
}

/** ทันกำหนด %: (6, 7) → "85.7%" · ตัวหาร 0 → "–" (ปัดครึ่งขึ้น ทศนิยม 1 ตำแหน่ง) */
function pct(numerator, denominator) {
  if (!denominator) return '–';
  return pctValue(numerator, denominator).toFixed(1) + '%';
}
/** ค่าตัวเลขของ % (ปัดครึ่งขึ้น 1 ตำแหน่ง) · ตัวหาร 0 → null */
function pctValue(numerator, denominator) {
  if (!denominator) return null;
  // ปัดครึ่งขึ้นด้วยจำนวนเต็ม (ไม่โดน floating error): x = round_half_up(n × 1000 ÷ d) → x ÷ 10
  const x = Math.floor((numerator * 2000 + denominator) / (2 * denominator));
  return x / 10;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** HTML escape (ใช้กับทุกค่าที่มาจากผู้ใช้/ฐานข้อมูล) */
function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, (c) => ESC[c]);
}

/** แท็กเวลาพร้อม data-iso: timeTag('sla-due', iso) → <time data-testid="sla-due" data-iso="…" datetime="…">4 ธ.ค. 2569 16:30</time> */
function timeTag(testid, iso, text) {
  if (!iso) return `<span data-testid="${esc(testid)}">–</span>`;
  return `<time data-testid="${esc(testid)}" data-iso="${esc(iso)}" datetime="${esc(iso)}">${esc(text === undefined ? thaiDateTime(iso) : text)}</time>`;
}

module.exports = {
  TH_MONTHS,
  thaiDateTime,
  thaiDate,
  baht,
  num,
  formatId,
  maskId,
  maskName,
  pct,
  pctValue,
  esc,
  timeTag,
};
