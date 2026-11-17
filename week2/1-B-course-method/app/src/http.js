'use strict';
/**
 * HTTP helpers (B01): รูปแบบ error {code, message} (CONTRACT §0.6 §5) · upload multipart (รับ body ≥ 6 MB) · baseUrl
 *
 * ใช้ในโมดูล:
 *   const { fail, ApiError, upload } = require('../http');
 *   fail('INVALID_QTY');                                   // throw 400 {code:'INVALID_QTY', message:'จำนวนฉบับต้อง 1–5 ฉบับ'}
 *   fail('OTP_INVALID', { attemptsLeft: 2 });               // ฟิลด์เพิ่มเติมถูกรวมใน JSON
 *   fail('MISSING_DOCS', { missing }, 'ยังขาดเอกสาร: ' + missing.join(', '));  // override ข้อความ
 *   router.post('/x/:id/files', upload.single('file'), (req, res) => { req.file.buffer ... })
 * error middleware ใน server.js แปลง ApiError → JSON ให้อัตโนมัติ (handler sync หรือ async ก็ได้)
 */

const multer = require('multer');

/** ตาราง error ตรงตัวอักษรตาม CONTRACT §5 */
const ERRORS = {
  INVALID_ID: [400, 'เลขบัตรประชาชนไม่ถูกต้อง'],
  OTP_INVALID: [401, 'รหัส OTP ไม่ถูกต้อง'],
  LOCKED: [423, 'ผิดเกินกำหนด เลขบัตรนี้ถูกล็อก 15 นาที'],
  INVALID_CREDENTIALS: [401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'],
  INVALID_MOBILE: [400, 'เบอร์มือถือต้องเป็นตัวเลข 10 หลักขึ้นต้นด้วย 0'],
  CONSENT_REQUIRED: [400, 'กรุณายินยอมการประมวลผลข้อมูลส่วนบุคคล (PDPA)'],
  INVALID_QTY: [400, 'จำนวนฉบับต้อง 1–5 ฉบับ'],
  INVALID_AREA: [400, 'กรุณาระบุพื้นที่ 1–500 ตร.ม.'],
  AREA_TOO_LARGE: [400, 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน'],
  FILE_TOO_LARGE: [400, 'ไฟล์ใหญ่เกิน 5 MB'],
  FILE_TYPE: [400, 'รองรับเฉพาะไฟล์ PDF, JPG, PNG'],
  FILE_COUNT: [400, 'แนบได้สูงสุด 5 ไฟล์ต่อคำขอ'],
  PLAN_NOT_PDF: [400, 'แบบแปลนต้องเป็นไฟล์ PDF เท่านั้น'],
  MISSING_DOCS: [409, 'ยังขาดเอกสาร'], // ใช้ fail('MISSING_DOCS', {missing}, 'ยังขาดเอกสาร: แบบแปลน, โฉนด')
  QR_EXPIRED: [410, 'QR หมดอายุ กรุณาสร้าง QR ใหม่'],
  AMOUNT_MISMATCH: [422, 'ยอดเงินไม่ตรงกับค่าธรรมเนียม'],
  NOT_FOUND: [404, 'ไม่พบคำขอ'],
  CANNOT_CANCEL: [409, 'ยกเลิกไม่ได้ คำขอมีเจ้าหน้าที่รับเรื่องแล้ว'],
  FIX_WINDOW_EXPIRED: [409, 'หมดเวลาแก้ไขแล้ว คำขอถูกยกเลิก'],
  ALREADY_CLAIMED: [409, 'มีเจ้าหน้าที่รับเรื่องนี้แล้ว'],
  WORKLOAD_LIMIT: [409, 'รับงานได้สูงสุด 10 เรื่อง'],
  RETURN_LIMIT: [409, 'ตีกลับได้สูงสุด 2 ครั้ง'],
  REASON_TOO_SHORT: [400, 'กรุณากรอกเหตุผลอย่างน้อย 10 ตัวอักษร'],
  REASON_REQUIRED: [400, 'กรุณากรอกเหตุผล'],
  INVALID_STATE: [409, 'สถานะคำขอไม่ถูกต้องสำหรับรายการนี้'],
  FORBIDDEN: [403, 'ไม่มีสิทธิ์ทำรายการนี้'],
  UNAUTHENTICATED: [401, 'กรุณาเข้าสู่ระบบ'],
  INVALID_FEE: [400, 'ค่าธรรมเนียมต้องเป็นจำนวนเต็ม 0–100,000 บาท'],
  INVALID_SLA: [400, 'SLA ต้องเป็นจำนวนเต็ม 1–60 วันทำการ'],
  DUPLICATE_HOLIDAY: [409, 'มีวันหยุดนี้อยู่แล้ว'],
  SELF_ROLE_CHANGE: [409, 'ไม่สามารถเปลี่ยนบทบาทของตัวเองได้'],
  METHOD_NOT_ALLOWED: [405, 'Method Not Allowed'],
  // ไม่ได้กำหนดข้อความใน CONTRACT (test ตรวจเฉพาะ code)
  INVALID_TIME: [400, 'รูปแบบเวลาไม่ถูกต้อง ต้องเป็น ISO 8601 พร้อม offset เช่น 2026-12-01T09:00:00+07:00'],
  BAD_REQUEST: [400, 'ข้อมูลไม่ถูกต้อง'],
  INTERNAL: [500, 'เกิดข้อผิดพลาดภายในระบบ'],
};

/** ข้อความหน้า 403 (forbidden-msg) — ต่างจาก FORBIDDEN ของ API */
const FORBIDDEN_PAGE_MSG = 'ไม่มีสิทธิ์เข้าถึงหน้านี้';

class ApiError extends Error {
  /**
   * @param {string} code รหัสในตาราง ERRORS (ถ้าไม่มีในตาราง ให้ส่ง status เองผ่าน extra.__status)
   * @param {object} [extra] ฟิลด์เพิ่มใน JSON เช่น {attemptsLeft:2} {lockedUntil} {missing:[...]}
   * @param {string} [message] override ข้อความ
   */
  constructor(code, extra = {}, message) {
    const def = ERRORS[code] || [extra.__status || 400, code];
    super(message || def[1]);
    this.name = 'ApiError';
    this.code = code;
    this.status = def[0];
    const { __status, ...rest } = extra || {};
    this.extra = rest;
  }

  toJSON() {
    return { code: this.code, message: this.message, ...this.extra };
  }
}

/** สร้าง ApiError (ไม่ throw) */
function apiError(code, extra, message) {
  return new ApiError(code, extra, message);
}

/** throw ApiError — ใช้ใน handler ได้ทั้ง sync/async */
function fail(code, extra, message) {
  throw new ApiError(code, extra, message);
}

/** ส่ง error JSON ทันที (ไม่ throw) */
function sendError(res, code, extra, message) {
  const e = new ApiError(code, extra, message);
  return res.status(e.status).json(e.toJSON());
}

/** ห่อ async handler (เผื่อใช้กับ router ที่ไม่ได้ผ่าน express-async-errors) */
function wrap(fn) {
  return (req, res, next) => {
    try {
      const r = fn(req, res, next);
      if (r && typeof r.catch === 'function') r.catch(next);
    } catch (e) {
      next(e);
    }
  };
}

/** true ถ้า request เป็น API (/api/*) */
function isApi(req) {
  return req.path === '/api' || req.path.startsWith('/api/');
}

/**
 * ที่อยู่ฐานของเว็บสำหรับลิงก์สัมบูรณ์ (doc-qr data-url = <BASE_URL>/verify/<code>)
 * ใช้ env BASE_URL ถ้าตั้ง ไม่งั้นคิดจาก request (protocol + Host)
 */
function baseUrl(req) {
  const env = (process.env.BASE_URL || '').trim().replace(/\/+$/, '');
  if (env) return env;
  if (!req) return 'http://localhost:' + (process.env.PORT || 3000);
  return `${req.protocol}://${req.get('host')}`;
}

/**
 * multer สำหรับ multipart (เก็บในหน่วยความจำ → req.file.buffer)
 * เพดานของ multer ตั้งสูงกว่า 5 MB มาก (20 MB) เพื่อให้ handler เป็นผู้ตัดสิน FILE_TOO_LARGE เอง (BR-07 · บั๊ก B02)
 * ถ้าเกินเพดาน multer → server.js แปลงเป็น 400 FILE_TOO_LARGE (ไม่ใช่ 413)
 */
const UPLOAD_HARD_LIMIT = 20 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_HARD_LIMIT, files: 20, fields: 50, fieldSize: 1024 * 1024 },
});

/** ชนิดไฟล์จาก magic bytes (CONTRACT §6.2) → {mime, ext} หรือ null */
function sniffFileType(buf) {
  if (!buf || buf.length < 3) return null;
  if (buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
    return { mime: 'application/pdf', ext: 'pdf', kind: 'PDF' }; // %PDF
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg', kind: 'JPG' };
  }
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { mime: 'image/png', ext: 'png', kind: 'PNG' };
  }
  return null;
}

module.exports = {
  ERRORS,
  FORBIDDEN_PAGE_MSG,
  ApiError,
  apiError,
  fail,
  sendError,
  wrap,
  isApi,
  baseUrl,
  upload,
  UPLOAD_HARD_LIMIT,
  sniffFileType,
};
