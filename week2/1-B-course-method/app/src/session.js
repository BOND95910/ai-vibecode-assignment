'use strict';
/**
 * Session + ตัวกันสิทธิ์ (B01)
 *
 * - server.js ติดตั้ง sessionMiddleware ก่อนทุก route → req.user (หรือ null)
 *     req.user = { id, username, name, role, dept, kind, registered, sid }
 *     role/dept มาจาก "ภาพตอนล็อกอิน" ในตาราง sessions (admin แก้บทบาท → มีผลล็อกอินครั้งถัดไป)
 *     kind = 'full' | 'register' (ประชาชนที่ยังไม่ลงทะเบียน → ใช้ได้เฉพาะ /register และ API ลงทะเบียน)
 * - auth.js (B05) สร้าง/ลบ session ผ่าน createSession / destroySession
 * - ทุกโมดูลกันสิทธิ์ด้วย requireApi(...roles) / requirePage(...roles)
 */

const { db } = require('./db');
const clock = require('./clock');
const { randomToken } = require('./crypto');
const { sendError, FORBIDDEN_PAGE_MSG } = require('./http');
const { LANDING } = require('./constants');

const COOKIE = 'sid';

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

const stmtLoad = db.prepare(`
  SELECT s.sid, s.role AS s_role, s.dept AS s_dept, s.kind,
         u.id, u.username, u.name, u.registered
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.sid = ?`);

/** middleware: อ่าน cookie sid → req.user (null ถ้าไม่ได้ล็อกอิน/หลัง reset) */
function sessionMiddleware(req, res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  req.user = null;
  const sid = req.cookies[COOKIE];
  if (sid) {
    const r = stmtLoad.get(sid);
    if (r) {
      req.user = {
        id: r.id,
        username: r.username,
        name: r.name,
        role: r.s_role,
        dept: r.s_dept || null,
        kind: r.kind,
        registered: !!r.registered,
        sid: r.sid,
      };
    }
  }
  next();
}

function setCookie(res, sid, maxAgeSec) {
  const parts = [`${COOKIE}=${encodeURIComponent(sid)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAgeSec !== undefined) parts.push(`Max-Age=${maxAgeSec}`);
  res.append('Set-Cookie', parts.join('; '));
}

/**
 * สร้าง session ใหม่ + ตั้ง cookie · user = แถวจากตาราง users (ต้องมี id, role, dept)
 * opts.kind = 'full' (ค่าเริ่มต้น) | 'register'
 * คืน sid
 */
function createSession(res, user, opts = {}) {
  const sid = randomToken(24);
  db.prepare('INSERT INTO sessions(sid, user_id, role, dept, kind, created_at) VALUES (?,?,?,?,?,?)').run(
    sid, user.id, user.role, user.dept || null, opts.kind || 'full', clock.nowIso()
  );
  setCookie(res, sid);
  return sid;
}

/** เปลี่ยน session 'register' → 'full' หลังลงทะเบียนสำเร็จ */
function upgradeSession(req) {
  if (req.user && req.user.sid) {
    db.prepare("UPDATE sessions SET kind = 'full' WHERE sid = ?").run(req.user.sid);
    req.user.kind = 'full';
    req.user.registered = true;
  }
}

/** ลบ session ปัจจุบัน + ล้าง cookie */
function destroySession(req, res) {
  if (req.user && req.user.sid) db.prepare('DELETE FROM sessions WHERE sid = ?').run(req.user.sid);
  setCookie(res, '', 0);
  req.user = null;
}

/** หน้าตั้งต้นของผู้ใช้ (citizen ยังไม่ลงทะเบียน → /register) */
function landingFor(user) {
  if (!user) return '/login';
  if (user.role === 'citizen' && (user.kind === 'register' || !user.registered)) return '/register';
  return LANDING[user.role] || '/login';
}

function isFull(user) {
  return !!user && user.kind !== 'register';
}

/**
 * กันสิทธิ์ API: ไม่ล็อกอิน → 401 UNAUTHENTICATED · บทบาทไม่อยู่ใน roles → 403 FORBIDDEN
 * session แบบ 'register' ถือว่ายังไม่ล็อกอินเต็ม (401) ยกเว้นใช้ requireApi.register()
 * requireApi() (ไม่ระบุบทบาท) = ล็อกอินแล้วบทบาทใดก็ได้
 */
function requireApi(...roles) {
  const allowed = roles.flat();
  return function apiGuard(req, res, next) {
    if (!isFull(req.user)) return sendError(res, 'UNAUTHENTICATED');
    if (allowed.length && !allowed.includes(req.user.role)) return sendError(res, 'FORBIDDEN');
    next();
  };
}
/** กัน API ลงทะเบียน: ต้องมี session (full หรือ register) และเป็น citizen */
requireApi.register = function registerGuard(req, res, next) {
  if (!req.user) return sendError(res, 'UNAUTHENTICATED');
  if (req.user.role !== 'citizen') return sendError(res, 'FORBIDDEN');
  next();
};

/**
 * กันสิทธิ์หน้า HTML: ไม่ล็อกอิน → redirect /login · citizen ยังไม่ลงทะเบียน → redirect /register
 * บทบาทไม่ตรง → HTTP 403 + forbidden-msg (CONTRACT §1)
 */
function requirePage(...roles) {
  const allowed = roles.flat();
  return function pageGuard(req, res, next) {
    if (!req.user) return res.redirect(302, '/login');
    if (!isFull(req.user)) return res.redirect(302, '/register');
    if (allowed.length && !allowed.includes(req.user.role)) return sendForbiddenPage(req, res);
    next();
  };
}

/**
 * กันหน้า /register: ไม่มี session → /login · ไม่ใช่ citizen หรือ ลงทะเบียนแล้ว → redirect หน้าตั้งต้นของตัวเอง
 * (CONTRACT §1: /register เข้าได้เฉพาะ citizen ที่เข้าครั้งแรก · ไม่มีสิทธิ์ → redirect)
 */
requirePage.register = function registerPageGuard(req, res, next) {
  if (!req.user) return res.redirect(302, '/login');
  if (req.user.role !== 'citizen' || (req.user.kind !== 'register' && req.user.registered)) {
    return res.redirect(302, landingFor(req.user));
  }
  next();
};

/** ส่งหน้า 403 (ใช้ layout ถ้ามี) */
function sendForbiddenPage(req, res) {
  const layout = require('./views/layout');
  return layout.forbiddenPage(req, res);
}

/** ลบ session ทั้งหมด (reset ทำผ่าน db.resetAll อยู่แล้ว) */
function destroyAllSessions() {
  db.prepare('DELETE FROM sessions').run();
}

module.exports = {
  COOKIE,
  parseCookies,
  sessionMiddleware,
  createSession,
  upgradeSession,
  destroySession,
  destroyAllSessions,
  landingFor,
  requireApi,
  requirePage,
  sendForbiddenPage,
  FORBIDDEN_PAGE_MSG,
};
