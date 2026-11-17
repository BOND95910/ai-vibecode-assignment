// B04 · session + RBAC กลาง (บล็อกอื่น require เพื่อตรวจสิทธิ์ที่ฝั่ง API/หน้า)
// ค่าใน util.sessions: sid -> { sid, userId, username|null, role, dept, name, idNo?, registered, createdAt }
// session เป็น snapshot ตอนล็อกอิน: admin เปลี่ยนบทบาทผู้ใช้ → มีผลกับล็อกอินครั้งถัดไป (DECISIONS ข้อ 1)
const { sessions, parseCookies, sendError } = require('./util');

const ROLE_LABELS = {
  citizen: 'ประชาชน', officer: 'เจ้าหน้าที่', head: 'หัวหน้าฝ่าย',
  executive: 'ผู้บริหาร', auditor: 'ผู้ตรวจสอบภายใน', admin: 'ผู้ดูแลระบบ',
};

// CONTRACT ข้อ 1: หน้าตั้งต้นหลังล็อกอิน (citizen ที่ยังไม่ลงทะเบียน → /register)
function landingFor(role, registered) {
  switch (role) {
    case 'citizen': return registered ? '/citizen' : '/register';
    case 'officer': return '/officer/queue';
    case 'head': return '/head/approvals';
    case 'executive': return '/dashboard';
    case 'auditor': return '/audit';
    case 'admin': return '/admin/services';
    default: return '/login';
  }
}

// session ของคำขอนี้ หรือ null · ประชาชนที่ยังไม่ลงทะเบียนก็มี session (registered=false) แต่ requireRole/pageGuard ไม่ให้ใช้
function getSession(req) {
  const sid = (req.cookies && req.cookies.sid) || parseCookies(req).sid;
  return (sid && sessions.get(sid)) || null;
}

// middleware สำหรับ API: 401 ไม่ล็อกอิน · 403 บทบาทไม่ตรง (หรือ citizen ที่ยังไม่ลงทะเบียน) · ไม่ส่ง roles = ล็อกอินแล้วใช้ได้ทุกบทบาท
// ผ่านแล้วได้ req.user = session
function requireRole(...roles) {
  return (req, res, next) => {
    const s = getSession(req);
    if (!s) return sendError(res, 401, 'UNAUTHENTICATED', 'กรุณาเข้าสู่ระบบ');
    if ((roles.length && !roles.includes(s.role)) || (s.role === 'citizen' && !s.registered)) {
      return sendError(res, 403, 'FORBIDDEN', 'ไม่มีสิทธิ์ทำรายการนี้');
    }
    req.user = s;
    next();
  };
}

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function forbiddenPage(s) {
  return `<!doctype html>
<html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ไม่มีสิทธิ์เข้าถึงหน้านี้</title></head>
<body>
<header data-testid="app-header">
  <span data-testid="user-name">${esc(s.name)}</span>
  <span data-testid="user-role" data-role="${esc(s.role)}"${s.role === 'officer' ? ` data-dept="${esc(s.dept)}"` : ''}>${esc(ROLE_LABELS[s.role] || s.role)}</span>
  <button type="button" data-testid="logout-btn" onclick="fetch('/api/auth/logout',{method:'POST'}).finally(function(){location.href='/login'})">ออกจากระบบ</button>
</header>
<main><h1 data-testid="forbidden-msg">ไม่มีสิทธิ์เข้าถึงหน้านี้</h1></main>
</body></html>`;
}

// middleware สำหรับหน้า: ไม่ล็อกอิน → redirect /login · citizen ยังไม่ลงทะเบียน → redirect /register
// · บทบาทไม่ตรง → 403 + HTML (forbidden-msg) · ผ่านแล้วได้ req.user = session
function pageGuard(...roles) {
  return (req, res, next) => {
    const s = getSession(req);
    if (!s) return res.redirect('/login');
    if (s.role === 'citizen' && !s.registered) return res.redirect('/register');
    if (roles.length && !roles.includes(s.role)) return res.status(403).type('html').send(forbiddenPage(s));
    req.user = s;
    next();
  };
}

module.exports = { getSession, requireRole, pageGuard, landingFor, ROLE_LABELS };
