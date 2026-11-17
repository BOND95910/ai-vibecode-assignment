// B04 · ล็อกอิน ThaiD จำลอง (ประชาชน) + SSO จำลอง (เจ้าหน้าที่) + ลงทะเบียน + ออกจากระบบ (CONTRACT 6.1 · BR-01..03)
const crypto = require('crypto');
const { db } = require('../db');
const clock = require('../clock');
const audit = require('../audit');
const { sendError, sessions, hashId, encrypt, verifyPassword } = require('../util');
const { getSession, landingFor } = require('../rbac');

const TEST_OTP = '123456';
const MAX_FAILS = 3;
const LOCK_MS = 15 * 60 * 1000;

// BR-01: 13 หลักตัวเลขล้วน + หลักที่ 13 = (11 − (Σ dᵢ×(13−i), i=1..12) mod 11) mod 10
function validId(idNo) {
  if (typeof idNo !== 'string' || !/^[0-9]{13}$/.test(idNo)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(idNo[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(idNo[12]);
}

const lockRow = (h) => db.prepare('SELECT fail_count, locked_until FROM otp_attempts WHERE id_hash=?').get(h);
const setRow = (h, fails, until) => db.prepare(
  `INSERT INTO otp_attempts (id_hash, fail_count, locked_until, updated_at) VALUES (?,?,?,?)
   ON CONFLICT(id_hash) DO UPDATE SET fail_count=excluded.fail_count, locked_until=excluded.locked_until, updated_at=excluded.updated_at`
).run(h, fails, until, clock.nowISO());
// ยังล็อกอยู่เมื่อ now < lockedUntil (ตรงขอบ +15:00 = ปลดล็อก)
const stillLocked = (row) => !!(row && row.locked_until && clock.now().getTime() < clock.parseISO(row.locked_until).getTime());

function locked(res, until) {
  return sendError(res, 423, 'LOCKED', 'ผิดเกินกำหนด เลขบัตรนี้ถูกล็อก 15 นาที', { lockedUntil: until });
}

// ออก session ใหม่ + คุกกี้ sid (HttpOnly) · ทิ้ง session เดิมของคำขอนี้ (ถ้ามี)
// ponytail: ไม่มีอายุ session (นาฬิกาแช่แข็ง/ห้องเรียน) · ของจริงต้องมี TTL
function startSession(req, res, data) {
  const old = getSession(req);
  if (old) sessions.delete(old.sid);
  const sid = crypto.randomBytes(24).toString('hex');
  const s = { sid, ...data, createdAt: clock.nowISO() };
  sessions.set(sid, s);
  res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax', path: '/' });
  return s;
}

module.exports = function (app) {
  app.post('/api/auth/thaid/start', (req, res) => {
    const { idNo } = req.body || {};
    if (!validId(idNo)) return sendError(res, 400, 'INVALID_ID', 'เลขบัตรประชาชนไม่ถูกต้อง');
    const row = lockRow(hashId(idNo));
    if (stillLocked(row)) return locked(res, row.locked_until);
    res.json({ status: 'OTP_SENT' });
  });

  app.post('/api/auth/thaid/verify', (req, res) => {
    const { idNo, otp } = req.body || {};
    if (!validId(idNo)) return sendError(res, 400, 'INVALID_ID', 'เลขบัตรประชาชนไม่ถูกต้อง');
    const h = hashId(idNo);
    let row = lockRow(h);
    if (stillLocked(row)) return locked(res, row.locked_until); // ล็อกอยู่: ไม่ตรวจ OTP แม้ถูก (BR-02 +14:59)
    if (row && row.locked_until) { setRow(h, 0, null); row = null; } // ครบ 15:00 → ปลดล็อก ตัวนับเริ่มที่ 0

    if (String(otp) !== TEST_OTP) {
      const fails = (row ? row.fail_count : 0) + 1;
      if (fails >= MAX_FAILS) {
        const until = clock.toBangkokISO(new Date(clock.now().getTime() + LOCK_MS)); // นับจากครั้งที่ 3
        setRow(h, fails, until);
        return locked(res, until);
      }
      setRow(h, fails, null);
      return sendError(res, 401, 'OTP_INVALID', 'รหัส OTP ไม่ถูกต้อง', { attemptsLeft: MAX_FAILS - fails });
    }

    setRow(h, 0, null); // OTP ถูก → รีเซ็ตตัวนับเป็น 0
    const u = db.prepare("SELECT * FROM users WHERE id_hash=? AND role='citizen'").get(h);
    // เลข checksum ถูกแต่ไม่มีใน ThaiD จำลอง: ไม่มีชื่อให้ลงทะเบียน → ปฏิเสธโดยไม่นับเป็น OTP ผิด (ดู QUESTIONS.md)
    if (!u) return sendError(res, 401, 'INVALID_CREDENTIALS', 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
    const registered = !!u.registered;
    // ยังไม่ลงทะเบียน: session registered=false → requireRole/pageGuard ไม่ให้ใช้ ยกเว้น /register กับ /api/me
    startSession(req, res, { userId: u.id, username: null, role: 'citizen', dept: '', name: u.display_name, idNo, registered });
    res.json({ registered });
  });

  app.post('/api/auth/register', (req, res) => {
    const s = getSession(req);
    if (!s) return sendError(res, 401, 'UNAUTHENTICATED', 'กรุณาเข้าสู่ระบบ');
    if (s.role !== 'citizen') return sendError(res, 403, 'FORBIDDEN', 'ไม่มีสิทธิ์ทำรายการนี้');
    if (s.registered) return sendError(res, 409, 'ALREADY_REGISTERED', 'ลงทะเบียนแล้ว');
    const { mobile, email, consent } = req.body || {};
    // ชื่อ-สกุลมาจาก ThaiD (users.display_name) เท่านั้น: ไม่อ่านชื่อจาก body
    if (typeof mobile !== 'string' || !/^0[0-9]{9}$/.test(mobile)) {
      return sendError(res, 400, 'INVALID_MOBILE', 'เบอร์มือถือต้องเป็นตัวเลข 10 หลักขึ้นต้นด้วย 0');
    }
    if (consent !== true) return sendError(res, 400, 'CONSENT_REQUIRED', 'กรุณายินยอมการประมวลผลข้อมูลส่วนบุคคล (PDPA)');
    db.prepare('UPDATE users SET mobile_enc=?, email=?, registered=1, consent_at=? WHERE id=?')
      .run(encrypt(mobile), typeof email === 'string' ? email.trim() : '', clock.nowISO(), s.userId);
    s.registered = true; // session เดิมใช้ต่อได้เลย (ไป /citizen)
    res.status(201).json({ registered: true });
  });

  app.post('/api/auth/staff/login', (req, res) => {
    const { username, password } = req.body || {};
    // อ่าน role/dept สดจากตาราง users ทุกครั้ง (admin เปลี่ยนบทบาท → มีผลล็อกอินครั้งถัดไป)
    const u = typeof username === 'string' && username
      ? db.prepare('SELECT * FROM users WHERE username=?').get(username) : null;
    if (!u || typeof password !== 'string' || !verifyPassword(password, u.password_hash)) {
      return sendError(res, 401, 'INVALID_CREDENTIALS', 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
    }
    startSession(req, res, { userId: u.id, username: u.username, role: u.role, dept: u.dept, name: u.display_name, registered: true });
    audit({ actor: u.username, role: u.role, event: 'STAFF_LOGIN' }); // A-36: เฉพาะล็อกอินสำเร็จ
    res.json({ role: u.role, dept: u.dept, landing: landingFor(u.role, true) });
  });

  app.post('/api/auth/logout', (req, res) => {
    const s = getSession(req);
    if (s) sessions.delete(s.sid);
    res.clearCookie('sid', { path: '/' });
    res.status(204).end();
  });

  // ประชาชนที่ยังไม่ลงทะเบียนเรียกได้ (หน้า /register ใช้ name) · เพิ่ม registered ให้หน้าเลือกปลายทาง
  app.get('/api/me', (req, res) => {
    const s = getSession(req);
    if (!s) return sendError(res, 401, 'UNAUTHENTICATED', 'กรุณาเข้าสู่ระบบ');
    res.json({ username: s.username, name: s.name, role: s.role, dept: s.dept, registered: s.registered });
  });
};
