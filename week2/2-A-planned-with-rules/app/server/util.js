// ฟังก์ชันกลาง: error JSON, จัดรูปแบบไทย, เข้ารหัส at rest (NFR-04), session store, hook ต่อ request
// ห้าม require('./db') ที่นี่ (db.js require util → วนกัน)
const crypto = require('crypto');
const clock = require('./clock');

// ---- error ----
// sendError(res, 409, 'ALREADY_CLAIMED', 'มีเจ้าหน้าที่รับเรื่องนี้แล้ว', { extra: 1 }) -> {code,message,...extra}
function sendError(res, status, code, message, extra) {
  return res.status(status).json({ code, message, ...(extra || {}) });
}

// ---- รูปแบบแสดงผล (A-04) ----
const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const pad = (n, len = 2) => String(n).padStart(len, '0');

// '2026-12-04T16:30:00+07:00' | Date -> '4 ธ.ค. 2569 16:30'
function thaiDateTime(iso) {
  const d = iso instanceof Date ? iso : new Date(iso);
  const b = new Date(d.getTime() + 7 * 3600 * 1000); // อ่านค่าแบบ UTC ของเวลาที่บวก 7 ชม. = เวลาไทย
  return `${b.getUTCDate()} ${TH_MONTHS[b.getUTCMonth()]} ${b.getUTCFullYear() + 543} ${pad(b.getUTCHours())}:${pad(b.getUTCMinutes())}`;
}
// 'YYYY-MM-DD' | ISO -> '2 ก.พ. 2570' (ไม่มีเวลา)
function thaiDate(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return `${d} ${TH_MONTHS[m - 1]} ${y + 543}`;
}
const baht = (n) => '฿' + Number(n).toLocaleString('en-US');
const digits = (idNo) => String(idNo).replace(/\D/g, '');
// 1101700123456 -> 1-1017-00123-45-6
const formatId = (idNo) => digits(idNo).replace(/^(\d)(\d{4})(\d{5})(\d{2})(\d)$/, '$1-$2-$3-$4-$5');
// 3100600987659 -> X-XXXX-XXXXX-65-9
const maskId = (idNo) => 'X-XXXX-XXXXX-' + digits(idNo).slice(-3, -1) + '-' + digits(idNo).slice(-1);
// ('EG', 2569, 31) -> EG-2569-000031 · ('DR', null, 3, 4) -> DR-0003
const formatNo = (prefix, year, n, len = 6) => (year ? `${prefix}-${year}-${pad(n, len)}` : `${prefix}-${pad(n, len)}`);
// ปี พ.ศ. ของเวลา (เขตเวลาไทย) ใช้กับ nextNumber
const buddhistYear = (iso) => Number(thaiDateKey(iso).slice(0, 4)) + 543;
// 'YYYY-MM-DD' ตามเวลาไทย
const thaiDateKey = (iso) => clock.toBangkokISO(iso instanceof Date ? iso : new Date(iso)).slice(0, 10);

// ---- เข้ารหัส at rest ----
// ponytail: คีย์ตั้งต้นสำหรับ dev/ห้องเรียน · ตั้ง DATA_KEY ตอน deploy จริง
const SECRET = process.env.DATA_KEY || 'egov-eservice-dev-only-key';
const ENC_KEY = crypto.createHash('sha256').update('enc|' + SECRET).digest();
const HMAC_KEY = crypto.createHash('sha256').update('hmac|' + SECRET).digest();

// AES-256-GCM · ผลลัพธ์ base64(iv12 | tag16 | ciphertext) · IV สุ่มทุกครั้ง → ค้นหาด้วย hashId แทน
function encrypt(text) {
  if (text === null || text === undefined || text === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function decrypt(blob) {
  if (!blob) return null;
  const b = Buffer.from(blob, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}
// HMAC-SHA256 ของเลขบัตร (hex) ไว้ค้นหา/ล็อก OTP โดยไม่เก็บเลขตรง ๆ
const hashId = (idNo) => crypto.createHmac('sha256', HMAC_KEY).update(digits(idNo)).digest('hex');

// รหัสผ่านเจ้าหน้าที่: scrypt · ponytail: N=4096 เพื่อให้ reset+seed เร็ว (บัญชีจำลอง) · ของจริงใช้ N≥16384
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 32, { N: 4096 }).toString('hex');
}
function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [salt, h] = stored.split(':');
  const x = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 32, { N: 4096 });
  return crypto.timingSafeEqual(x, Buffer.from(h, 'hex'));
}

// ---- session ----
// sid -> ข้อมูลที่ B04 กำหนดเอง (เช่น { username, role, dept, idNo, registered, createdAt })
// reset ล้างด้วย sessions.clear() · B04 ออก/อ่าน sid ผ่าน getSession(req) ใน rbac.js
const sessions = new Map();

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ---- hook ต่อทุก request (CONTRACT 0.7: ประเมินแจ้งเตือน SLA + ยกเลิกอัตโนมัติ) ----
// บล็อกอื่น push ฟังก์ชัน (req) => void ตอนโหลดไฟล์ · index.js เรียกก่อน route ทุกตัว ยกเว้น /api/test/*
const requestHooks = [];

module.exports = {
  sendError, thaiDateTime, thaiDate, baht, maskId, formatId, formatNo, pad, buddhistYear, thaiDateKey,
  encrypt, decrypt, hashId, hashPassword, verifyPassword,
  sessions, parseCookies, requestHooks,
};
