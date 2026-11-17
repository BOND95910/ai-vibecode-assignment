'use strict';
// Business rules, clock, crypto and seed for the e-Service demo.
// All dates are Asia/Bangkok (+07:00, no DST), stored as epoch ms.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TEST_MODE = process.env.TEST_MODE === '1';
const BUGS = new Set((process.env.BUG_MODE || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean));
const bug = id => BUGS.has(id);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db.json');

// ---------------------------------------------------------------- clock
const TZ = 7 * 3600e3;
const MIN = 60e3, HOUR = 3600e3;
const DEFAULT_NOW = Date.parse('2026-12-01T09:00:00+07:00');
let frozen = DEFAULT_NOW;
const now = () => (TEST_MODE ? frozen : Date.now());
const setNow = ms => { frozen = ms; };

const pad = (n, w = 2) => String(n).padStart(w, '0');
function iso(ms) {
  if (ms == null) return null;
  const d = new Date(ms + TZ);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+07:00`;
}
const dateKey = ms => iso(ms).slice(0, 10);
const at = (dk, hms = '00:00:00') => Date.parse(`${dk}T${hms}+07:00`);
const addDays = (dk, n) => new Date(Date.parse(dk + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const weekday = dk => new Date(dk + 'T00:00:00Z').getUTCDay();
const beYear = ms => Number(iso(ms).slice(0, 4)) + 543;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = s => DATE_RE.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

// ---------------------------------------------------------------- working days / SLA
const holidaySet = () => new Set(state.holidays.map(h => h.date));
// B03: due-date arithmetic ignores the holiday table (weekends still skipped)
const slaHolidays = () => (bug('B03') ? new Set() : holidaySet());
const isWorkday = (dk, hol) => { const w = weekday(dk); return w !== 0 && w !== 6 && !hol.has(dk); };
function nextWorkday(dk, hol) { do dk = addDays(dk, 1); while (!isWorkday(dk, hol)); return dk; }
function addWorkdays(dk, n, hol) { for (let i = 0; i < n; i++) dk = nextWorkday(dk, hol); return dk; }
function countWorkdays(fromDk, toDk, hol, cap = Infinity) { // working days in (from, to]; stops once the count exceeds cap
  let n = 0;
  for (let d = addDays(fromDk, 1); d <= toDk && n <= cap; d = addDays(d, 1)) if (isWorkday(d, hol)) n++;
  return n;
}
function computeDue(paidMs, slaDays) {
  const hol = slaHolidays();
  const dk = dateKey(paidMs);
  const d0 = isWorkday(dk, hol) && paidMs < at(dk, '16:30:00') ? dk : nextWorkday(dk, hol);
  return at(addWorkdays(d0, slaDays, hol), '16:30:00');
}
function extendDue(dueMs, returnedMs, resubmitMs) {
  if (bug('B04')) return dueMs; // B04: SLA keeps running during NEED_FIX
  const hol = slaHolidays();
  const paused = countWorkdays(dateKey(returnedMs), dateKey(resubmitMs), hol);
  return at(addWorkdays(dateKey(dueMs), paused, hol), '16:30:00');
}
const CLOSED = ['COMPLETED', 'REJECTED', 'CANCELLED'];
function slaLevel(c, t = now()) {
  if (CLOSED.includes(c.status)) return 'closed';
  if (c.status === 'NEED_FIX') return 'paused';
  if (t > c.dueAt) return 'overdue';
  return countWorkdays(dateKey(t), dateKey(c.dueAt), holidaySet(), 1) <= 1 ? 'near' : 'normal'; // only "≤ 1 or not" matters
}

// ---------------------------------------------------------------- fees
const toInt = v => (typeof v === 'number' ? (Number.isInteger(v) ? v : null) : /^-?\d+$/.test(String(v ?? '').trim()) ? Number(String(v).trim()) : null);
function calcFee(serviceId, input) {
  const s = state.services[serviceId];
  if (serviceId === 'SV-01') {
    const q = toInt(input.qty);
    if (q == null || q < 1 || q > 5) return { code: 'INVALID_QTY' };
    return { fee: s.fee * q, qty: q };
  }
  if (serviceId === 'SV-03') {
    const a = toInt(input.areaSqm);
    if (a == null || a < 1) return { code: 'INVALID_AREA' };
    if (a > 500) return { code: 'AREA_TOO_LARGE' };
    const extra = bug('B01') ? a > 101 : a >= 101; // B01: 101 m² charged base fee
    return { fee: extra ? s.fee + s.feePerSqm * (a - 100) : s.fee, areaSqm: a };
  }
  return { fee: s.fee };
}

// ---------------------------------------------------------------- uploads
const MAX_FILE = 5 * 1024 * 1024;
function sniff(buf) {
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  return null;
}
const MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', png: 'image/png' };
function checkFile(buf, docKey) { // returns error code or null
  const tooBig = bug('B02') ? buf.length >= MAX_FILE : buf.length > MAX_FILE; // B02: off-by-one at 5 MB
  if (tooBig) return 'FILE_TOO_LARGE';
  const t = sniff(buf);
  if (!t) return 'FILE_TYPE';
  if (docKey === 'plan' && t !== 'pdf') return 'PLAN_NOT_PDF';
  return null;
}

// ---------------------------------------------------------------- PII crypto (AES-256-GCM) and signatures
const PII_KEY = crypto.createHash('sha256').update(process.env.PII_KEY || 'eservice-demo-pii-key').digest();
const SIGN_KEY = process.env.SIGN_KEY || 'eservice-demo-signing-key';
function enc(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', PII_KEY, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function dec(b64) {
  const b = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', PII_KEY, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}
const idHash = id => crypto.createHmac('sha256', PII_KEY).update(id).digest('base64url');
function validId(s) {
  if (!/^\d{13}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(s[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(s[12]);
}
const fmtId = s => `${s[0]}-${s.slice(1, 5)}-${s.slice(5, 10)}-${s.slice(10, 12)}-${s[12]}`;
const maskId = s => `X-XXXX-XXXXX-${s.slice(10, 12)}-${s[12]}`;
function maskName(full) {
  const [first, ...rest] = full.trim().split(/\s+/);
  return rest.length ? `${first} ${[...rest.join(' ')][0]}***` : `${first} ***`;
}
const sigFields = d => [d.docNo, d.caseNo, d.applicant, d.serviceId, d.issuedAt, d.validUntil, d.signer].join('|');
const sign = d => crypto.createHmac('sha256', SIGN_KEY).update(sigFields(d)).digest('hex');
function validUntil(serviceId, issuedDk) {
  if (serviceId === 'SV-01') return addDays(issuedDk, 89);
  let [y, m, d] = issuedDk.split('-').map(Number);
  if (m === 2 && d === 29) d = 28;
  return addDays(`${y + 1}-${pad(m)}-${pad(d)}`, -1);
}
function verifyResult(doc) {
  if (sign(doc) !== doc.sig) return 'TAMPERED';
  return dateKey(now()) > doc.validUntil ? 'EXPIRED' : 'VALID';
}
const pwHash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const SEED_SALT = 'seed-salt';
const SEED_PW = pwHash('Test@1234', SEED_SALT);
const scrypt = require('node:util').promisify(crypto.scrypt);
const checkPw = async (u, pw) => crypto.timingSafeEqual(await scrypt(String(pw ?? ''), u.salt, 32), Buffer.from(u.pwHash, 'hex')); // off the event loop

// ---------------------------------------------------------------- reference data
const SERVICES = {
  'SV-01': { name: 'ขอหนังสือรับรอง', docs: [['id-card', 'บัตรประชาชน', true]] },
  'SV-02': { name: 'ขออนุญาตประกอบกิจการ', docs: [['id-card', 'บัตรประชาชน', true], ['map', 'แผนที่ตั้ง', true], ['site-photo', 'ภาพสถานที่', false]] },
  'SV-03': { name: 'ขออนุญาตก่อสร้าง/ต่อเติมอาคาร', docs: [['id-card', 'บัตรประชาชน', true], ['plan', 'แบบแปลน', true], ['deed', 'โฉนด', true]] },
};
const DOC_LABEL = { 'id-card': 'บัตรประชาชน', map: 'แผนที่ตั้ง', 'site-photo': 'ภาพสถานที่', plan: 'แบบแปลน', deed: 'โฉนด', extra: 'เอกสารเพิ่มเติม' };
const STATUS_TH = { DRAFT: 'ร่าง', PENDING_PAYMENT: 'รอชำระเงิน', SUBMITTED: 'ส่งคำขอแล้ว', IN_REVIEW: 'กำลังตรวจสอบ', NEED_FIX: 'รอแก้ไขเอกสาร', PENDING_APPROVAL: 'รออนุมัติ', APPROVED: 'อนุมัติ', COMPLETED: 'เสร็จสิ้น', REJECTED: 'ไม่อนุมัติ', CANCELLED: 'ยกเลิก' };
const LEVEL_TH = { normal: 'ปกติ', near: 'ใกล้ครบกำหนด', overdue: 'เกินกำหนด', paused: 'หยุดนับ', closed: 'ปิดแล้ว' };
const ROLE_TH = { citizen: 'ประชาชน', officer: 'เจ้าหน้าที่', head: 'หัวหน้าฝ่าย', executive: 'ผู้บริหาร', auditor: 'ผู้ตรวจสอบภายใน', admin: 'ผู้ดูแลระบบ' };
const LANDING = { citizen: '/citizen', officer: '/officer/queue', head: '/head/approvals', executive: '/dashboard', auditor: '/audit', admin: '/admin/services' };
const MSG = {
  INVALID_ID: 'เลขบัตรประชาชนไม่ถูกต้อง', OTP_INVALID: 'รหัส OTP ไม่ถูกต้อง', LOCKED: 'ผิดเกินกำหนด เลขบัตรนี้ถูกล็อก 15 นาที',
  INVALID_CREDENTIALS: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง', INVALID_MOBILE: 'เบอร์มือถือต้องเป็นตัวเลข 10 หลักขึ้นต้นด้วย 0',
  CONSENT_REQUIRED: 'กรุณายินยอมการประมวลผลข้อมูลส่วนบุคคล (PDPA)', INVALID_QTY: 'จำนวนฉบับต้อง 1–5 ฉบับ',
  INVALID_AREA: 'กรุณาระบุพื้นที่ 1–500 ตร.ม.', AREA_TOO_LARGE: 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน',
  FILE_TOO_LARGE: 'ไฟล์ใหญ่เกิน 5 MB', FILE_TYPE: 'รองรับเฉพาะไฟล์ PDF, JPG, PNG', FILE_COUNT: 'แนบได้สูงสุด 5 ไฟล์ต่อคำขอ',
  PLAN_NOT_PDF: 'แบบแปลนต้องเป็นไฟล์ PDF เท่านั้น', MISSING_DOCS: 'ยังขาดเอกสาร', QR_EXPIRED: 'QR หมดอายุ กรุณาสร้าง QR ใหม่',
  AMOUNT_MISMATCH: 'ยอดเงินไม่ตรงกับค่าธรรมเนียม', NOT_FOUND: 'ไม่พบคำขอ', CANNOT_CANCEL: 'ยกเลิกไม่ได้ คำขอมีเจ้าหน้าที่รับเรื่องแล้ว',
  FIX_WINDOW_EXPIRED: 'หมดเวลาแก้ไขแล้ว คำขอถูกยกเลิก', ALREADY_CLAIMED: 'มีเจ้าหน้าที่รับเรื่องนี้แล้ว', WORKLOAD_LIMIT: 'รับงานได้สูงสุด 10 เรื่อง',
  RETURN_LIMIT: 'ตีกลับได้สูงสุด 2 ครั้ง', REASON_TOO_SHORT: 'กรุณากรอกเหตุผลอย่างน้อย 10 ตัวอักษร', REASON_REQUIRED: 'กรุณากรอกเหตุผล',
  INVALID_STATE: 'สถานะคำขอไม่ถูกต้องสำหรับรายการนี้', FORBIDDEN: 'ไม่มีสิทธิ์ทำรายการนี้', UNAUTHENTICATED: 'กรุณาเข้าสู่ระบบ',
  INVALID_FEE: 'ค่าธรรมเนียมต้องเป็นจำนวนเต็ม 0–100,000 บาท', INVALID_SLA: 'SLA ต้องเป็นจำนวนเต็ม 1–60 วันทำการ',
  DUPLICATE_HOLIDAY: 'มีวันหยุดนี้อยู่แล้ว', SELF_ROLE_CHANGE: 'ไม่สามารถเปลี่ยนบทบาทของตัวเองได้', METHOD_NOT_ALLOWED: 'Method Not Allowed',
  INVALID_TIME: 'รูปแบบเวลาไม่ถูกต้อง (ต้องเป็น ISO พร้อม offset)', INVALID_INPUT: 'ข้อมูลไม่ถูกต้อง',
};

// ---------------------------------------------------------------- state + seed
let state;
const files = new Map(); // fileId -> {fileId,name,docKey,size,type,data,owner:{caseNo|draftId}}  (blobs are not persisted)

function tinyPdf(label) { return makePdf([`Seed attachment: ${label}`]); }
function makePdf(lines) {
  const esc = s => String(s).replace(/[\\()]/g, m => '\\' + m).replace(/[^\x20-\x7e]/g, '?');
  const stream = `BT /F1 11 Tf 50 790 Td 16 TL ${lines.map(l => `(${esc(l)}) Tj T*`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offs = objs.map((o, i) => { const off = Buffer.byteLength(out); out += `${i + 1} 0 obj\n${o}\nendobj\n`; return off; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function addFile(name, docKey, data, owner) {
  const fileId = 'F-' + pad(++state.seq.file, 6);
  files.set(fileId, { fileId, name, docKey, size: data.length, type: sniff(data), data, owner });
  return fileId;
}

const t = s => Date.parse(s.replace(' ', 'T') + ':00+07:00'); // 'YYYY-MM-DD HH:MM' Bangkok
const PEOPLE = {
  somchai: { idNo: '1101700123456', name: 'สมชาย ใจดี', mobile: '0812345678', registered: true },
  somying: { idNo: '3100600987659', name: 'สมหญิง รักไทย', mobile: '0823456789', registered: true },
  mana: { idNo: '5500400111221', name: 'มานะ ตั้งใจ', mobile: null, registered: false },
  piti: { idNo: '1909900555015', name: 'ปิติ มีสุข', mobile: '0834567890', registered: true },
};
// no, label, service, input, fee, applicant, status, paidAt, due, extra
const SEED_CASES = [
  [1, 'H01', 'SV-01', { qty: 1 }, 20, 'somying', 'COMPLETED', '2026-10-14 10:00', '2026-10-19 16:30', { closedAt: '2026-10-16 14:00', approvedBy: 'off.reg1' }],
  [2, 'H05', 'SV-03', { areaSqm: 120 }, 1200, 'piti', 'COMPLETED', '2026-11-02 09:00', '2026-11-23 16:30', { closedAt: '2026-11-20 11:00', step: 3, approvedBy: 'head1', visited: ['registry', 'works'] }],
  [3, 'H02', 'SV-01', { qty: 2 }, 40, 'piti', 'COMPLETED', '2026-11-02 09:30', '2026-11-05 16:30', { closedAt: '2026-11-04 15:00', approvedBy: 'off.reg1' }],
  [4, 'H06', 'SV-02', {}, 500, 'somchai', 'COMPLETED', '2026-11-02 14:00', '2026-11-16 16:30', { closedAt: '2026-11-13 15:00', approvedBy: 'head1' }],
  [5, 'H03', 'SV-01', { qty: 1 }, 20, 'somchai', 'COMPLETED', '2026-11-03 11:00', '2026-11-06 16:30', { closedAt: '2026-11-05 10:00', approvedBy: 'off.reg1', issuer: 'off.reg1', docNo: 'DOC-2569-000001' }],
  [6, 'H08', 'SV-02', {}, 500, 'piti', 'COMPLETED', '2026-11-03 15:00', '2026-11-17 16:30', { closedAt: '2026-11-19 10:00', approvedBy: 'head1' }],
  [7, 'H07', 'SV-02', {}, 500, 'somying', 'COMPLETED', '2026-11-04 10:00', '2026-11-18 16:30', { closedAt: '2026-11-18 16:00', approvedBy: 'head1' }],
  [8, 'H04', 'SV-01', { qty: 1 }, 20, 'somying', 'REJECTED', '2026-11-09 10:00', '2026-11-12 16:30', { closedAt: '2026-11-11 09:00' }],
  [9, 'X01', 'SV-01', { qty: 1 }, 20, 'somchai', 'CANCELLED', '2026-11-09 14:30', '2026-11-12 16:30', { cancelledAt: '2026-11-09 15:00' }],
  [10, 'W01', 'SV-03', { areaSqm: 80 }, 1000, 'somying', 'IN_REVIEW', '2026-11-12 10:00', '2026-12-03 16:30', { step: 2, issuer: 'off.reg1', visited: ['registry', 'works'] }],
  [11, 'P02', 'SV-03', { areaSqm: 150 }, 1500, 'somchai', 'PENDING_APPROVAL', '2026-11-16 10:00', '2026-12-08 16:30', { step: 3, issuer: 'off.reg1', visited: ['registry', 'works'] }],
  [12, 'R09', 'SV-03', { areaSqm: 101 }, 1010, 'piti', 'IN_REVIEW', '2026-11-18 10:00', '2026-12-11 16:30', { step: 1, owner: 'off.reg2' }],
  [13, 'R01', 'SV-02', {}, 500, 'somchai', 'IN_REVIEW', '2026-11-20 10:00', '2026-12-04 16:30', { owner: 'off.reg2' }],
  [14, 'P01', 'SV-02', {}, 500, 'piti', 'PENDING_APPROVAL', '2026-11-20 11:00', '2026-12-04 16:30', { issuer: 'off.reg1' }],
  [15, 'R02', 'SV-02', {}, 500, 'somying', 'IN_REVIEW', '2026-11-20 15:00', '2026-12-04 16:30', { owner: 'off.reg2' }],
  [16, 'R03', 'SV-02', {}, 500, 'piti', 'IN_REVIEW', '2026-11-23 09:00', '2026-12-08 16:30', { owner: 'off.reg2' }],
  [17, 'F01', 'SV-01', { qty: 1 }, 20, 'somchai', 'NEED_FIX', '2026-11-23 10:00', '2026-11-27 16:30', {
    owner: 'off.reg1', returns: [['2026-11-24 11:00', 'ภาพบัตรประชาชนไม่ชัด กรุณาถ่ายใหม่', '2026-11-25 10:00'], ['2026-11-27 14:00', 'ชื่อในเอกสารไม่ตรงกับบัตร กรุณาแก้ไข', null]] }],
  [18, 'R04', 'SV-02', {}, 500, 'somchai', 'IN_REVIEW', '2026-11-24 10:00', '2026-12-09 16:30', { owner: 'off.reg2' }],
  [19, 'A01', 'SV-02', {}, 500, 'somying', 'APPROVED', '2026-11-24 14:00', '2026-12-09 16:30', { issuer: 'off.reg1', approvedBy: 'head1', approvedAt: '2026-11-30 15:00' }],
  [20, 'O01', 'SV-01', { qty: 1 }, 20, 'somchai', 'IN_REVIEW', '2026-11-25 10:00', '2026-11-30 16:30', { owner: 'off.reg1' }],
  [21, 'R08', 'SV-02', {}, 500, 'somying', 'IN_REVIEW', '2026-11-25 12:00', '2026-12-11 16:30', { owner: 'off.reg2' }],
  [22, 'N02', 'SV-01', { qty: 2 }, 40, 'somying', 'IN_REVIEW', '2026-11-26 10:00', '2026-12-01 16:30', { owner: 'off.reg1' }],
  [23, 'F02', 'SV-01', { qty: 1 }, 20, 'somying', 'IN_REVIEW', '2026-11-26 10:30', '2026-12-03 16:30', {
    owner: 'off.reg1', returns: [['2026-11-27 10:00', 'ภาพเอกสารเบลอ อ่านเลขไม่ได้', '2026-11-30 10:00'], ['2026-11-30 14:00', 'ข้อมูลในแบบฟอร์มไม่ครบถ้วน', '2026-12-01 08:30']] }],
  [24, 'N01', 'SV-01', { qty: 1 }, 20, 'piti', 'SUBMITTED', '2026-11-27 11:00', '2026-12-02 16:30', {}],
  [25, 'R05', 'SV-01', { qty: 3 }, 60, 'somying', 'IN_REVIEW', '2026-11-30 10:00', '2026-12-03 16:30', { owner: 'off.reg2' }],
  [26, 'R07', 'SV-01', { qty: 5 }, 100, 'somchai', 'IN_REVIEW', '2026-11-30 16:29', '2026-12-03 16:30', { owner: 'off.reg2' }],
  [27, 'R06', 'SV-01', { qty: 1 }, 20, 'piti', 'IN_REVIEW', '2026-11-30 16:30', '2026-12-04 16:30', { owner: 'off.reg2' }],
  [28, 'S01', 'SV-01', { qty: 1 }, 20, 'somying', 'SUBMITTED', '2026-12-01 08:10', '2026-12-04 16:30', {}],
  [29, 'S02', 'SV-01', { qty: 1 }, 20, 'piti', 'SUBMITTED', '2026-12-01 08:20', '2026-12-04 16:30', {}],
  [30, 'S03', 'SV-01', { qty: 1 }, 20, 'somchai', 'SUBMITTED', '2026-12-01 08:30', '2026-12-04 16:30', {}],
];

function seed() {
  files.clear();
  frozen = DEFAULT_NOW;
  state = {
    seq: { draft: 2, pp: 1, file: 0, audit: 0, noti: 0 },
    services: { 'SV-01': { fee: 20, sla: 3 }, 'SV-02': { fee: 500, sla: 10 }, 'SV-03': { fee: 1000, feePerSqm: 10, sla: 15 } },
    holidays: [
      { date: '2026-12-07', name: 'ชดเชยวันหยุดทดสอบ (สมมติ)' }, { date: '2026-12-10', name: 'วันรัฐธรรมนูญทดสอบ (สมมติ)' },
      { date: '2026-12-31', name: 'วันสิ้นปีทดสอบ (สมมติ)' }, { date: '2027-01-01', name: 'วันขึ้นปีใหม่ทดสอบ (สมมติ)' }],
    staff: [
      ['off.reg1', 'เจ้าหน้าที่ทะเบียน 1', 'officer', 'registry'], ['off.reg2', 'เจ้าหน้าที่ทะเบียน 2', 'officer', 'registry'],
      ['off.works1', 'เจ้าหน้าที่โยธา 1', 'officer', 'works'], ['head1', 'หัวหน้าฝ่าย', 'head', ''],
      ['exec1', 'ผู้บริหาร', 'executive', ''], ['audit1', 'ผู้ตรวจสอบภายใน', 'auditor', ''], ['admin1', 'ผู้ดูแลระบบ', 'admin', ''],
    ].map(([username, name, role, dept]) => ({ username, name, role, dept, salt: SEED_SALT, pwHash: SEED_PW })),
    citizens: Object.entries(PEOPLE).map(([key, p]) => ({
      id: key, idHash: idHash(p.idNo), idEnc: enc(p.idNo), name: p.name,
      mobileEnc: p.mobile ? enc(p.mobile) : null, emailEnc: null, registered: p.registered })),
    otp: {}, drafts: [], payments: [], cases: [], docs: [], audit: [], notifications: [],
  };
  for (const [no, , svc, input, fee, who, status, paid, due, x] of SEED_CASES) {
    const caseNo = 'EG-2569-' + pad(no, 6);
    const c = {
      caseNo, serviceId: svc, qty: input.qty ?? null, areaSqm: input.areaSqm ?? null, fee, applicantId: who, status,
      step: svc === 'SV-03' ? (x.step || 1) : null, owner: x.owner || null, issuer: x.issuer || (svc === 'SV-01' ? x.owner || null : null),
      approvedBy: x.approvedBy || null, returnCount: 0, returns: [], fixDeadline: null,
      paidAt: t(paid), receiptNo: 'RC-2569-' + pad(no, 6), dueAt: t(due), closedAt: x.closedAt ? t(x.closedAt) : null,
      cancelledAt: x.cancelledAt ? t(x.cancelledAt) : null, cancelReason: x.cancelledAt ? 'CITIZEN' : null,
      visited: x.visited || ['registry'], fileIds: [], docNo: x.docNo || null,
      timeline: [{ at: t(paid), text: 'ชำระเงินสำเร็จ ส่งคำขอแล้ว' }],
    };
    for (const [rAt, reason, fixedAt] of x.returns || []) {
      c.returns.push({ at: t(rAt), reason, resubmittedAt: fixedAt ? t(fixedAt) : null });
      c.timeline.push({ at: t(rAt), text: `ตีกลับให้แก้ไข: ${reason}` });
      if (fixedAt) c.timeline.push({ at: t(fixedAt), text: 'ประชาชนส่งแก้ไขแล้ว' });
    }
    c.returnCount = c.returns.length;
    if (status === 'NEED_FIX') c.fixDeadline = c.returns.at(-1).at + 168 * HOUR;
    if (x.approvedAt) c.timeline.push({ at: t(x.approvedAt), text: 'หัวหน้าฝ่ายอนุมัติ' });
    if (c.closedAt) c.timeline.push({ at: c.closedAt, text: status === 'COMPLETED' ? 'ออกเอกสาร เสร็จสิ้น' : 'ไม่อนุมัติ' });
    if (c.cancelledAt) c.timeline.push({ at: c.cancelledAt, text: 'ผู้ยื่นยกเลิกคำขอ' });
    for (const [key, , req] of SERVICES[svc].docs) if (req) c.fileIds.push(addFile(`${key}.pdf`, key, tinyPdf(`${key} ${caseNo}`), { caseNo }));
    state.cases.push(c);
  }
  const seedDoc = { docNo: 'DOC-2569-000001', caseNo: 'EG-2569-000005', applicant: 'สมชาย ใจดี', serviceId: 'SV-01',
    issuedAt: '2026-11-05T10:00:00+07:00', validUntil: '2027-02-02', signer: 'เจ้าหน้าที่ทะเบียน 1', verifyCode: 'K7M2Q9XA' };
  state.docs.push({ ...seedDoc, sig: sign(seedDoc) });
  state.drafts.push({ draftId: 'DR-0001', ownerId: 'somchai', serviceId: 'SV-01', qty: 2, areaSqm: null, status: 'DRAFT', lockedFee: null, fileIds: [], caseNo: null });
  const d2 = { draftId: 'DR-0002', ownerId: 'somchai', serviceId: 'SV-02', qty: null, areaSqm: null, status: 'PENDING_PAYMENT', lockedFee: 500, fileIds: [], caseNo: null };
  d2.fileIds.push(addFile('id-card.pdf', 'id-card', tinyPdf('id-card DR-0002'), { draftId: 'DR-0002' }));
  d2.fileIds.push(addFile('map.pdf', 'map', tinyPdf('map DR-0002'), { draftId: 'DR-0002' }));
  state.drafts.push(d2);
  state.payments.push({ ref: 'PP-0001', draftId: 'DR-0002', amount: 500, createdAt: t('2026-12-01 08:55'), paidAt: null, caseNo: null, receiptNo: null, deleted: false });
  persist();
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
function persist() { // inspection snapshot for DB_PATH (PII columns are AES-256-GCM ciphertext; file blobs stay in memory)
  const meta = [...files.values()].map(({ data, ...m }) => m);
  fs.writeFileSync(DB_PATH, JSON.stringify({ ...state, files: meta }));
}

module.exports = {
  TEST_MODE, BUGS, bug, DB_PATH, MIN, HOUR, now, setNow, iso, dateKey, beYear, ISO_RE, validDate, pad,
  computeDue, extendDue, slaLevel, toInt, calcFee, MIME, checkFile, enc, dec, idHash, validId, fmtId, maskId,
  maskName, sign, validUntil, verifyResult, checkPw, SERVICES, DOC_LABEL, STATUS_TH, LEVEL_TH, ROLE_TH, LANDING, MSG,
  makePdf, addFile, files, seed, persist, get state() { return state; },
};
