'use strict';
/**
 * โครงหน้า HTML ร่วม (B01) — หัวหน้า/เมนูตามบทบาท (CONTRACT §2.1) · หน้า 403/404 · WCAG พื้นฐาน
 * ไม่ใช่โมดูล route (ไม่มี register) · views/citizen.js (B09) และ views/staff.js (B10) เรียกใช้
 *
 *   const layout = require('./layout');
 *   layout.sendPage(req, res, { title: 'คิวงาน', body: '<h1>…</h1>', scripts: ['/static/staff.js'] });
 *   layout.forbiddenPage(req, res);   // 403 + forbidden-msg
 *   layout.notFoundPage(req, res);    // 404 + not-found-msg "ไม่พบคำขอ"
 */

const { db } = require('../db');
const { esc } = require('../format');
const { ROLE_LABEL } = require('../constants');
const { FORBIDDEN_PAGE_MSG } = require('../http');

const ORG_NAME = 'เทศบาลนครตัวอย่าง'; // หน่วยงานสมมติ ห้ามใช้ชื่อ/ตราหน่วยงานจริง
const APP_NAME = 'e-Service กลาง';

/** เมนูตามบทบาท (CONTRACT §2.1 · TC-RBAC-03 ส่วน D) */
const NAV = {
  citizen: [['nav-my-cases', '/citizen', 'คำขอของฉัน']],
  officer: [['nav-queue', '/officer/queue', 'คิวงาน']],
  head: [
    ['nav-queue', '/officer/queue', 'คิวงาน'],
    ['nav-approvals', '/head/approvals', 'รออนุมัติ'],
  ],
  executive: [['nav-dashboard', '/dashboard', 'Dashboard']],
  auditor: [['nav-audit', '/audit', 'Audit Trail']],
  admin: [
    ['nav-admin-services', '/admin/services', 'บริการ'],
    ['nav-admin-holidays', '/admin/holidays', 'วันหยุด'],
    ['nav-admin-users', '/admin/users', 'ผู้ใช้'],
  ],
};

const stmtBell = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE username = ?');

/** จำนวนแจ้งเตือนทั้งหมดของผู้ใช้ (bell-count) */
function bellCount(username) {
  if (!username) return 0;
  return stmtBell.get(username).n;
}

function navHtml(user, currentPath) {
  const items = (NAV[user.role] || []).map(([testid, href, label]) => {
    const cur = currentPath === href || (href !== '/' && currentPath.startsWith(href + '/'));
    return `<li><a data-testid="${testid}" href="${href}"${cur ? ' aria-current="page"' : ''}>${esc(label)}</a></li>`;
  });
  if (user.role === 'officer' || user.role === 'head') {
    const n = bellCount(user.username);
    const cur = currentPath === '/notifications';
    items.push(
      `<li><a data-testid="nav-bell" href="/notifications" class="bell"${cur ? ' aria-current="page"' : ''}>` +
        `<span aria-hidden="true">🔔</span> แจ้งเตือน <span class="badge" data-testid="bell-count" aria-label="จำนวนแจ้งเตือน ${n} รายการ">${n}</span></a></li>`
    );
  }
  return items.length ? `<nav aria-label="เมนูหลัก"><ul class="nav">${items.join('')}</ul></nav>` : '';
}

/** แถบหัว (app-header) — แสดงเมื่อมี session (รวมประชาชนที่กำลังลงทะเบียน) */
function headerHtml(req) {
  const user = req.user;
  const brand = `<a class="brand" href="/"><span class="brand-mark" aria-hidden="true">e</span><span>${esc(ORG_NAME)} · ${esc(APP_NAME)}</span></a>`;
  if (!user) {
    return `<header class="app-bar"><div class="wrap bar">${brand}</div></header>`;
  }
  const deptAttr = user.role === 'officer' && user.dept ? ` data-dept="${esc(user.dept)}"` : '';
  const nav = user.kind === 'register' ? '' : navHtml(user, req.path || '');
  return `<header class="app-bar" data-testid="app-header">
  <div class="wrap bar">
    ${brand}
    ${nav}
    <div class="who">
      <span data-testid="user-name" class="user-name">${esc(user.name)}</span>
      <span data-testid="user-role" class="user-role" data-role="${esc(user.role)}"${deptAttr}>${esc(ROLE_LABEL[user.role] || user.role)}</span>
      <form method="post" action="/logout" class="inline"><button type="submit" class="btn btn-ghost" data-testid="logout-btn">ออกจากระบบ</button></form>
    </div>
  </div>
</header>`;
}

/**
 * HTML ทั้งหน้า
 * @param {object} req
 * @param {{title:string, body:string, scripts?:string[], styles?:string[], head?:string, bodyClass?:string}} opts
 */
function renderPage(req, opts) {
  const title = opts.title ? `${opts.title} · ${APP_NAME} ${ORG_NAME}` : `${APP_NAME} ${ORG_NAME}`;
  const styles = ['/static/app.css', ...(opts.styles || [])]
    .map((h) => `<link rel="stylesheet" href="${esc(h)}">`).join('\n  ');
  const scripts = ['/static/common.js', ...(opts.scripts || [])]
    .map((s) => `<script src="${esc(s)}" defer></script>`).join('\n  ');
  return `<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  ${styles}
  ${scripts}
  ${opts.head || ''}
</head>
<body${opts.bodyClass ? ` class="${esc(opts.bodyClass)}"` : ''}>
<a class="skip-link" href="#main">ข้ามไปเนื้อหาหลัก</a>
${headerHtml(req)}
<main id="main" class="wrap" tabindex="-1">
${opts.body || ''}
</main>
<footer class="app-footer"><div class="wrap">ระบบสาธิต · ${esc(ORG_NAME)} (หน่วยงานสมมติ) · ThaiD / PromptPay / ลายเซ็นดิจิทัล เป็นตัวจำลอง</div></footer>
</body>
</html>`;
}

/** ส่งหน้า HTML · opts.status (ค่าเริ่มต้น 200) */
function sendPage(req, res, opts) {
  res.status(opts.status || 200).type('html').send(renderPage(req, opts));
}

/** หน้า 403 (forbidden-msg = "ไม่มีสิทธิ์เข้าถึงหน้านี้") */
function forbiddenPage(req, res) {
  return sendPage(req, res, {
    status: 403,
    title: 'ไม่มีสิทธิ์',
    body: `<h1>ไม่มีสิทธิ์</h1>\n<p class="alert alert-error" role="alert" data-testid="forbidden-msg">${esc(FORBIDDEN_PAGE_MSG)}</p>`,
  });
}

/** หน้า 404 ของคำขอ (not-found-msg = "ไม่พบคำขอ") · ใช้ข้อความเดียวไม่ว่าไม่มีจริงหรือเป็นของคนอื่น */
function notFoundPage(req, res, message = 'ไม่พบคำขอ') {
  return sendPage(req, res, {
    status: 404,
    title: 'ไม่พบ',
    body: `<h1>ไม่พบ</h1>\n<p class="alert alert-error" role="alert" data-testid="not-found-msg">${esc(message)}</p>`,
  });
}

/** หน้าข้อผิดพลาดทั่วไป */
function errorPage(req, res, status, message) {
  return sendPage(req, res, {
    status,
    title: 'เกิดข้อผิดพลาด',
    body: `<h1>เกิดข้อผิดพลาด</h1>\n<p class="alert alert-error" role="alert">${esc(message)}</p>`,
  });
}

module.exports = {
  ORG_NAME,
  APP_NAME,
  NAV,
  bellCount,
  headerHtml,
  renderPage,
  sendPage,
  forbiddenPage,
  notFoundPage,
  errorPage,
};
