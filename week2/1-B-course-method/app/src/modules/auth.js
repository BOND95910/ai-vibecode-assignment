'use strict';
/**
 * B05 · ยืนยันตัวตน + RBAC + PDPA
 *
 * API (CONTRACT §6.1 · §6.3 unmask):
 *   POST /api/auth/thaid/start    {"idNo"}          → 200 {"status":"OTP_SENT"} · 400 INVALID_ID · 423 LOCKED {lockedUntil}
 *   POST /api/auth/thaid/verify   {"idNo","otp"}    → 200 {"registered":true|false, landing} + cookie
 *                                                      (ยังไม่ลงทะเบียน → session แบบ 'register' ใช้ได้แค่ /register)
 *                                                    · 401 OTP_INVALID {attemptsLeft} · 423 LOCKED {lockedUntil}
 *   POST /api/auth/register       {"mobile","email","consent"} → 201 · 400 INVALID_MOBILE · 400 CONSENT_REQUIRED
 *   POST /api/auth/staff/login    {"username","password"} → 200 {"role","dept","landing"} + Audit STAFF_LOGIN · 401 INVALID_CREDENTIALS
 *   POST /api/auth/logout         → 204
 *   GET  /api/me                  → 200 {"username","name","role","dept"} · 401
 *   POST /api/officer/cases/:caseNo/unmask {"reason"} → 200 {"idNo"} + Audit UNMASK (BUG_MODE B11: ไม่บันทึก)
 *                                                    · 400 REASON_REQUIRED · 403 (บทบาทอื่น) · 404 NOT_FOUND
 *
 * กฎ (DECISIONS §2 · §11 · A-05 A-06 A-07 A-24 A-32):
 *   - เลขบัตร = ตัวเลข 13 หลักพอดี + checksum: หลักที่ 13 = (11 − (Σ dᵢ × (14 − i), i = 1..12) mod 11) mod 10
 *   - OTP จำลอง = '123456' เสมอ · ผิดติดกัน 3 ครั้ง → ล็อกเลขบัตรนั้น 15 นาทีนับจากครั้งที่ 3 (ยังล็อกถ้า now < lockedUntil)
 *     · OTP ถูก → ตัวนับเป็น 0 · ล็อกหมดอายุ → ตัวนับเริ่มใหม่
 *   - เวลาทั้งหมดอ่านจาก clock (นาฬิกาทดสอบ) เท่านั้น
 *
 * RBAC (TC-RBAC-03): โมดูลนี้โหลดก่อนโมดูลอื่น (order 20) และติดตัวกันสิทธิ์ระดับ route ตามตาราง PAGE_RULES / API_RULES
 *   ด้วย requirePage / requireApi ของ session.js — ผ่านแล้ว next() ไปยัง route ของเจ้าของ (ไม่ตอบเองถ้ามีสิทธิ์ · ไม่ใช่ catch-all)
 *   เป็นชั้นป้องกันซ้อน: เจ้าของ route ยังต้องกันสิทธิ์เองและตรวจกฎละเอียด (เจ้าของคำขอ/แผนก/ขั้น) ตามเดิม
 */

const { db } = require('../db');
const clock = require('../clock');
const crypto = require('../crypto');
const { fail } = require('../http');
const { createSession, destroySession, upgradeSession, landingFor, requireApi, requirePage } = require('../session');
const { logAudit } = require('../audit');
const { isBug } = require('../bugs');
const { LIMITS } = require('../constants');

const OTP_CODE = LIMITS.TEST_OTP || '123456';
const OTP_MAX_FAIL = LIMITS.OTP_MAX_FAIL || 3;
const OTP_LOCK_MS = LIMITS.OTP_LOCK_MS || 15 * 60 * 1000;
const MAX_REASON_LEN = 500;
const MAX_EMAIL_LEN = 254;

// ---------------------------------------------------------------------------
// เลขบัตรประชาชน
// ---------------------------------------------------------------------------

/** ค่าจาก body → สตริง (ตัดช่องว่างหัวท้าย) · ชนิดอื่นที่ไม่ใช่ string/number → '' */
function normIdNo(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return '';
  return v.trim();
}

/** true ถ้าเป็นตัวเลข 13 หลักพอดี (ASCII) และ checksum ถูก (DECISIONS §2) */
function validateIdNo(idNo) {
  const s = normIdNo(idNo);
  if (!/^[0-9]{13}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(s[i]) * (13 - i); // หลักที่ 1 ×13 … หลักที่ 12 ×2
  return (11 - (sum % 11)) % 10 === Number(s[12]);
}

const stmtCitizenByHash = db.prepare("SELECT * FROM users WHERE id_hash = ? AND role = 'citizen'");

/** หาประชาชนจากเลขบัตร (ค้นด้วย id_hash · ไม่ถอดรหัสทั้งตาราง) → แถว users หรือ null */
function findCitizenByIdNo(idNo) {
  const s = normIdNo(idNo);
  if (!s) return null;
  return stmtCitizenByHash.get(crypto.idHash(s)) || null;
}

// ชื่อจำลองที่ "ThaiD" ส่งมาให้สำหรับเลขบัตรที่ไม่มีใน seed (กำหนดได้จากเลขบัตร → ผลซ้ำได้)
const MOCK_FIRST = ['สมศักดิ์', 'วิไลวรรณ', 'ประเสริฐ', 'สุดารัตน์', 'บุญเลิศ', 'กาญจนา', 'อำนาจ', 'มาลัย'];
const MOCK_LAST = ['ทดสอบดี', 'ใจงาม', 'สุขสันต์', 'มั่นคง', 'รุ่งเรือง', 'ศรีสุข', 'แสงทอง', 'บุญมา'];

function mockThaidName(idNo) {
  const h = crypto.idHash(idNo);
  const a = parseInt(h.slice(0, 8), 16);
  const b = parseInt(h.slice(8, 16), 16);
  return `${MOCK_FIRST[a % MOCK_FIRST.length]} ${MOCK_LAST[b % MOCK_LAST.length]}`;
}

const stmtInsertCitizen = db.prepare(
  "INSERT OR IGNORE INTO users(username, role, dept, name, password_hash, id_hash, id_enc, mobile_enc, email, registered, consent_at, created_at) " +
    "VALUES (NULL, 'citizen', NULL, ?, NULL, ?, ?, NULL, NULL, 0, NULL, ?)"
);

/** หาแถวประชาชน · ไม่มี (เลขถูกแต่ไม่อยู่ใน seed) → สร้างใหม่ registered = 0 ชื่อจาก ThaiD จำลอง */
function findOrCreateCitizen(idNo) {
  const found = findCitizenByIdNo(idNo);
  if (found) return found;
  stmtInsertCitizen.run(mockThaidName(idNo), crypto.idHash(idNo), crypto.encrypt(idNo), clock.nowIso());
  return findCitizenByIdNo(idNo);
}

// ---------------------------------------------------------------------------
// OTP ผิด / ล็อก (ตาราง otp_attempts · ต่อเลขบัตร)
// ---------------------------------------------------------------------------

const stmtOtpGet = db.prepare('SELECT * FROM otp_attempts WHERE id_hash = ?');
const stmtOtpDelete = db.prepare('DELETE FROM otp_attempts WHERE id_hash = ?');
const stmtOtpUpsert = db.prepare(
  'INSERT INTO otp_attempts(id_hash, fail_count, locked_until, last_fail_at) VALUES (?,?,?,?) ' +
    'ON CONFLICT(id_hash) DO UPDATE SET fail_count = excluded.fail_count, locked_until = excluded.locked_until, last_fail_at = excluded.last_fail_at'
);

/**
 * สถานะตัวนับของ hash ณ เวลา nowIso (ไม่เขียน DB)
 * ล็อกที่หมดอายุแล้ว (now ≥ lockedUntil) = ปลดล็อก + ตัวนับเริ่มใหม่ (0)
 */
function lockStateByHash(hash, nowIso) {
  const row = stmtOtpGet.get(hash);
  if (!row) return { locked: false, lockedUntil: null, failCount: 0 };
  if (row.locked_until) {
    if (clock.toMs(nowIso) < clock.toMs(row.locked_until)) {
      return { locked: true, lockedUntil: row.locked_until, failCount: row.fail_count };
    }
    return { locked: false, lockedUntil: null, failCount: 0 };
  }
  return { locked: false, lockedUntil: null, failCount: row.fail_count || 0 };
}

/** สำหรับหน้า /login (B09): { locked, lockedUntil, failCount } ของเลขบัตร ณ เวลานาฬิกาปัจจุบัน */
function otpLockState(idNo) {
  const s = normIdNo(idNo);
  if (!validateIdNo(s)) return { locked: false, lockedUntil: null, failCount: 0 };
  return lockStateByHash(crypto.idHash(s), clock.nowIso());
}

/** บันทึก OTP ผิด 1 ครั้ง → { locked, lockedUntil, failCount, attemptsLeft } (เรียกใน transaction) */
function recordOtpFailure(hash, nowIso) {
  const st = lockStateByHash(hash, nowIso);
  const failCount = st.failCount + 1;
  const lockedUntil = failCount >= OTP_MAX_FAIL ? clock.addMs(nowIso, OTP_LOCK_MS) : null;
  stmtOtpUpsert.run(hash, failCount, lockedUntil, nowIso);
  return {
    locked: !!lockedUntil,
    lockedUntil,
    failCount,
    attemptsLeft: Math.max(0, OTP_MAX_FAIL - failCount),
  };
}

// ---------------------------------------------------------------------------
// session helper
// ---------------------------------------------------------------------------

/** ทิ้ง session เดิมของ client นี้ (ถ้ามี) แล้วออก sid ใหม่เสมอ (กัน session fixation) */
function replaceSession(req, res, userRow, opts) {
  if (req.user && req.user.sid) db.prepare('DELETE FROM sessions WHERE sid = ?').run(req.user.sid);
  return createSession(res, userRow, opts);
}

/** ภาพผู้ใช้สำหรับ landingFor() จากแถว users + ชนิด session */
function landingOfRow(row, kind) {
  return landingFor({ role: row.role, kind, registered: !!row.registered });
}

// ---------------------------------------------------------------------------
// รหัสผ่านเจ้าหน้าที่
// ---------------------------------------------------------------------------

let dummyHash = null;
/** ใช้เวลาใกล้เคียงกันเมื่อ username ไม่มี (ไม่เผยว่าบัญชีมีอยู่จากเวลาตอบ) */
function burnPasswordCheck(pw) {
  if (!dummyHash) dummyHash = crypto.hashPassword('not-a-real-password');
  crypto.verifyPassword(String(pw || ''), dummyHash);
}

const stmtStaffByUsername = db.prepare(
  "SELECT * FROM users WHERE username = ? AND role <> 'citizen' AND password_hash IS NOT NULL"
);

// ---------------------------------------------------------------------------
// ค่าจากฟอร์ม
// ---------------------------------------------------------------------------

/** checkbox/JSON → bool (true · 'true' · 'on' · '1' · 1 · 'yes') */
function truthy(v) {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') return ['true', 'on', '1', 'yes'].includes(v.trim().toLowerCase());
  return false;
}

const MOBILE_RE = /^0[0-9]{9}$/;
const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

// ---------------------------------------------------------------------------
// ตารางสิทธิ์ (TC-RBAC-03 · CONTRACT §1 §6)
// ---------------------------------------------------------------------------

/** หน้า HTML: [path, roles] — ไม่ล็อกอิน → /login · ยังไม่ลงทะเบียน → /register · บทบาทผิด → 403 forbidden-msg */
const PAGE_RULES = [
  ['/citizen', ['citizen']],
  ['/citizen/new/:service', ['citizen']],
  ['/citizen/cases/:caseNo', ['citizen']],
  ['/officer/queue', ['officer', 'head']],
  ['/officer/cases/:caseNo', ['officer', 'head']],
  ['/head/approvals', ['head']],
  ['/dashboard', ['executive']],
  ['/audit', ['auditor']],
  ['/admin/services', ['admin']],
  ['/admin/holidays', ['admin']],
  ['/admin/users', ['admin']],
  ['/notifications', ['officer', 'head']],
];

/**
 * API: [method, path, roles] — ไม่ล็อกอิน → 401 UNAUTHENTICATED · บทบาทผิด → 403 FORBIDDEN
 * ใส่เฉพาะ route ที่ CONTRACT กำหนดบทบาทไว้ชัด · /api/audit ใส่เฉพาะ GET (PUT/PATCH/DELETE ต้องได้ 405 ก่อนตรวจสิทธิ์ · B08)
 * /api/officer/cases/:caseNo/unmask กันใน route ของตัวเองด้านล่าง
 */
const API_RULES = [
  ['get', '/api/officer/queue', ['officer', 'head']],
  ['post', '/api/officer/cases/:caseNo/claim', ['officer']],
  ['post', '/api/officer/cases/:caseNo/return', ['officer']],
  ['post', '/api/officer/cases/:caseNo/forward', ['officer']],
  ['post', '/api/officer/cases/:caseNo/issue', ['officer']],
  ['post', '/api/cases/:caseNo/approve', ['officer', 'head']],
  ['post', '/api/cases/:caseNo/reject', ['officer', 'head']],
  ['get', '/api/head/approvals', ['head']],
  ['get', '/api/cases/:caseNo/files', ['citizen', 'officer', 'head']],
  ['get', '/api/files/:fileId', ['citizen', 'officer', 'head']],
  ['get', '/api/notifications', ['officer', 'head']],
  ['get', '/api/dashboard', ['executive']],
  ['get', '/api/dashboard/export', ['executive']],
  ['get', '/api/audit', ['auditor']],
  ['get', '/api/audit/export.csv', ['auditor']],
  ['all', '/api/admin/*', ['admin']],
  ['all', '/api/drafts', ['citizen']],
  ['all', '/api/drafts/*', ['citizen']],
  ['get', '/api/payments/:ref', ['citizen']],
  ['get', '/api/cases', ['citizen']],
  ['get', '/api/cases/:caseNo', ['citizen', 'officer', 'head']],
  ['post', '/api/cases/:caseNo/cancel', ['citizen']],
  ['post', '/api/cases/:caseNo/resubmit', ['citizen']],
];

function installRbacGuards(app) {
  for (const [path, roles] of PAGE_RULES) app.get(path, requirePage(...roles));
  for (const [method, path, roles] of API_RULES) app[method](path, requireApi(...roles));
}

// ---------------------------------------------------------------------------
// route
// ---------------------------------------------------------------------------

const stmtCaseApplicant = db.prepare(
  'SELECT c.case_no, c.status, u.id_enc FROM cases c JOIN users u ON u.id = c.applicant_id WHERE c.case_no = ?'
);
const stmtRegister = db.prepare(
  'UPDATE users SET mobile_enc = ?, email = ?, registered = 1, consent_at = ? WHERE id = ? AND registered = 0'
);
const stmtUserById = db.prepare('SELECT * FROM users WHERE id = ?');

function register(app) {
  installRbacGuards(app);

  // ---- ThaiD จำลอง: ขั้น 1 กรอกเลขบัตร ----
  app.post('/api/auth/thaid/start', (req, res) => {
    const body = req.body || {};
    const idNo = normIdNo(body.idNo);
    if (!validateIdNo(idNo)) fail('INVALID_ID');
    const st = lockStateByHash(crypto.idHash(idNo), clock.nowIso());
    if (st.locked) fail('LOCKED', { lockedUntil: st.lockedUntil });
    // ระบบจำลอง: "ส่ง" OTP แล้ว (โหมดทดสอบ OTP = 123456 เสมอ · A-05)
    res.status(200).json({ status: 'OTP_SENT' });
  });

  // ---- ThaiD จำลอง: ขั้น 2 ยืนยัน OTP ----
  app.post('/api/auth/thaid/verify', (req, res) => {
    const body = req.body || {};
    const idNo = normIdNo(body.idNo);
    if (!validateIdNo(idNo)) fail('INVALID_ID');
    const otp = typeof body.otp === 'number' ? String(body.otp) : typeof body.otp === 'string' ? body.otp.trim() : '';
    const hash = crypto.idHash(idNo);

    // อ่าน-ตัดสิน-เขียนใน transaction เดียว (ไม่มี await คั่น) → ตัวนับไม่หายเมื่อยิงพร้อมกัน
    const outcome = db.transaction(() => {
      const now = clock.nowIso();
      const st = lockStateByHash(hash, now);
      if (st.locked) return { error: 'LOCKED', extra: { lockedUntil: st.lockedUntil } };
      if (otp !== OTP_CODE) {
        const f = recordOtpFailure(hash, now);
        if (f.locked) return { error: 'LOCKED', extra: { lockedUntil: f.lockedUntil } };
        return { error: 'OTP_INVALID', extra: { attemptsLeft: f.attemptsLeft } };
      }
      stmtOtpDelete.run(hash); // OTP ถูก → ตัวนับผิดเป็น 0
      const user = findOrCreateCitizen(idNo);
      const kind = user.registered ? 'full' : 'register';
      replaceSession(req, res, user, { kind });
      return { user, kind };
    })();

    if (outcome.error) fail(outcome.error, outcome.extra);
    const registered = !!outcome.user.registered;
    res.status(200).json({ registered, landing: landingOfRow(outcome.user, outcome.kind) });
  });

  // ---- ลงทะเบียนครั้งแรก (session แบบ register หรือ full ของ citizen) ----
  app.post('/api/auth/register', requireApi.register, (req, res) => {
    const body = req.body || {};
    const mobile = typeof body.mobile === 'string' ? body.mobile.trim() : typeof body.mobile === 'number' ? String(body.mobile) : '';
    const consent = truthy(body.consent);
    const email = typeof body.email === 'string' ? body.email.trim() : '';

    const invalid = [];
    if (!MOBILE_RE.test(mobile)) invalid.push('mobile');
    if (!consent) invalid.push('consent');
    if (invalid.includes('mobile')) fail('INVALID_MOBILE', { invalid });
    if (invalid.includes('consent')) fail('CONSENT_REQUIRED', { invalid });
    if (email && (email.length > MAX_EMAIL_LEN || !EMAIL_RE.test(email))) {
      fail('BAD_REQUEST', { invalid: ['email'] }, 'รูปแบบอีเมลไม่ถูกต้อง');
    }

    const now = clock.nowIso();
    const done = db.transaction(() => {
      const info = stmtRegister.run(crypto.encrypt(mobile), email || null, now, req.user.id);
      return info.changes === 1;
    })();
    if (!done) fail('INVALID_STATE'); // ลงทะเบียนไปแล้ว → 409

    upgradeSession(req);
    const row = stmtUserById.get(req.user.id);
    res.status(201).json({ registered: true, name: row.name, landing: landingOfRow(row, 'full') });
  });

  // ---- SSO ภาครัฐ จำลอง: เจ้าหน้าที่ทุกบทบาท ----
  app.post('/api/auth/staff/login', (req, res) => {
    const body = req.body || {};
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const row = username ? stmtStaffByUsername.get(username) : null;
    if (!row) {
      burnPasswordCheck(password);
      fail('INVALID_CREDENTIALS');
    }
    if (!crypto.verifyPassword(password, row.password_hash)) fail('INVALID_CREDENTIALS');

    db.transaction(() => {
      replaceSession(req, res, row, { kind: 'full' });
      logAudit({ username: row.username, role: row.role }, 'STAFF_LOGIN', { detail: '' });
    })();

    res.status(200).json({
      role: row.role,
      dept: row.dept || null,
      landing: landingOfRow(row, 'full'),
      username: row.username,
      name: row.name,
    });
  });

  // ---- ออกจากระบบ (ไม่ได้ล็อกอินก็ได้ 204 · idempotent) ----
  app.post('/api/auth/logout', (req, res) => {
    destroySession(req, res);
    res.status(204).end();
  });

  // ---- ผู้ใช้ปัจจุบัน (session แบบ register ก็อ่านชื่อตัวเองได้ เพื่อหน้า /register) ----
  app.get('/api/me', (req, res) => {
    if (!req.user) fail('UNAUTHENTICATED');
    const u = req.user;
    res.status(200).json({
      username: u.username || null,
      name: u.name,
      role: u.role,
      dept: u.dept || null,
      registered: u.role === 'citizen' ? u.kind !== 'register' && !!u.registered : true,
      landing: landingFor(u),
    });
  });

  // ---- PDPA: แสดงเลขบัตรเต็ม (officer/head) ต้องมีเหตุผล + Audit UNMASK ----
  app.post('/api/officer/cases/:caseNo/unmask', requireApi('officer', 'head'), (req, res) => {
    const body = req.body || {};
    const raw = typeof body.reason === 'string' ? body.reason : typeof body.reason === 'number' ? String(body.reason) : '';
    const reason = raw.trim();
    if (!reason) fail('REASON_REQUIRED'); // ว่าง/เว้นวรรคล้วน → ไม่แสดง ไม่บันทึก

    const row = stmtCaseApplicant.get(String(req.params.caseNo || ''));
    if (!row || !row.id_enc) fail('NOT_FOUND');

    const idNo = crypto.decrypt(row.id_enc);
    // บันทึก Audit ก่อนส่งเลขเต็มออกไป (ถ้าเขียน Audit ไม่ได้ → error ไม่เผยเลข)
    if (!isBug('B11')) {
      logAudit(req.user, 'UNMASK', { caseNo: row.case_no, detail: reason.slice(0, MAX_REASON_LEN) });
    }
    res.status(200).json({ idNo });
  });
}

module.exports = {
  register,
  order: 20, // หลัง testhooks (10) ก่อนโมดูลอื่น (50) → ตัวกันสิทธิ์ตาม PAGE_RULES/API_RULES ทำงานก่อน route ของเจ้าของ
  validateIdNo,
  findCitizenByIdNo,
  otpLockState,
  PAGE_RULES,
  API_RULES,
};
