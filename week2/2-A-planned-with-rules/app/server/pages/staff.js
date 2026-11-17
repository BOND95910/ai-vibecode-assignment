// B11 · หน้าเจ้าหน้าที่/หัวหน้า/ผู้บริหาร/ผู้ตรวจ/ผู้ดูแล + /verify/:code (CONTRACT ข้อ 1, 2.6-2.13)
// SSR โครงหน้า + header + สถานะ HTTP (403/404) แล้วให้สคริปต์ใน public/staff/* เติมข้อมูลจาก API · /verify/:code SSR ทั้งหน้า
const { db } = require('../db');
const clock = require('../clock');
const { thaiDate, thaiDateTime } = require('../util');
const documents = require('../documents');
const { pageGuard, ROLE_LABELS } = require('../rbac');
const EG = require('../../public/common.js');

const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const json = (o) => JSON.stringify(o).replace(/</g, '\\u003c'); // ใน <script type=application/json> ห้ามมี </script>

// เมนูตามบทบาท (CONTRACT 2.1) · bell = ลิงก์แจ้งเตือน + จำนวนทั้งหมดของผู้ใช้ (SSR: hook ประเมินแจ้งเตือนก่อนถึง route แล้ว)
const NAV = {
  officer: [['nav-queue', '/officer/queue', 'คิวงาน'], 'bell'],
  head: [['nav-queue', '/officer/queue', 'คิวงาน'], ['nav-approvals', '/head/approvals', 'รออนุมัติ'], 'bell'],
  executive: [['nav-dashboard', '/dashboard', 'Dashboard']],
  auditor: [['nav-audit', '/audit', 'Audit Trail']],
  admin: [['nav-admin-services', '/admin/services', 'ค่าธรรมเนียม/SLA'], ['nav-admin-holidays', '/admin/holidays', 'วันหยุด'], ['nav-admin-users', '/admin/users', 'ผู้ใช้/บทบาท']],
};

function header(s, current) {
  const dept = s.role === 'officer' ? ` data-dept="${esc(s.dept)}"` : '';
  const items = (NAV[s.role] || []).map((n) => {
    if (n === 'bell') {
      const c = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE username=?').get(s.username).n;
      return `<a data-testid="nav-bell" href="/notifications"${current === '/notifications' ? ' aria-current="page"' : ''}>แจ้งเตือน <span class="bell" data-testid="bell-count">${Number(c)}</span></a>`;
    }
    return `<a data-testid="${n[0]}" href="${n[1]}"${current === n[1] ? ' aria-current="page"' : ''}>${esc(n[2])}</a>`;
  }).join('');
  return `<header class="app-header" data-testid="app-header"><div class="container bar">
<a class="brand" href="/">e-Service เทศบาลนครตัวอย่าง</a>
<nav aria-label="เมนูหลัก">${items}</nav>
<div class="user"><span data-testid="user-name">${esc(s.name)}</span><span class="role-chip" data-testid="user-role" data-role="${esc(s.role)}"${dept}>${esc(ROLE_LABELS[s.role] || s.role)}</span>
<button type="button" class="btn secondary" data-testid="logout-btn">ออกจากระบบ</button></div></div></header>`;
}

const servicesMap = () => Object.fromEntries(db.prepare('SELECT id, name FROM services ORDER BY id').all().map((r) => [r.id, r.name]));

// หน้า HTML · scripts = สคริปต์เฉพาะหน้า (โหลดหลัง common.js และ staff/lib.js) · boot = ข้อมูลเริ่มต้น (JSON)
function page({ title, user, current, main, scripts = [], boot = {} }) {
  const data = Object.assign({ services: servicesMap(), user: user ? { role: user.role, dept: user.dept, username: user.username } : null }, boot);
  return `<!doctype html>
<html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · e-Service เทศบาลนครตัวอย่าง</title><link rel="stylesheet" href="/common.css"><link rel="stylesheet" href="/staff/staff.css"></head>
<body><a class="skip" href="#main">ข้ามไปยังเนื้อหาหลัก</a>
${user ? header(user, current) : '<header class="app-header"><div class="container bar"><a class="brand" href="/">e-Service เทศบาลนครตัวอย่าง</a></div></header>'}
<main id="main" class="container">
${main}
</main>
<script type="application/json" id="boot">${json(data)}</script>
<script src="/common.js" defer></script>
<script src="/staff/lib.js" defer></script>
${scripts.map((s) => `<script src="${s}" defer></script>`).join('\n')}
</body></html>`;
}

// หน้าที่ข้อมูลมาจาก API ทั้งหมด: h1 + กล่องข้อความ (#msg = action-error/action-success) + พื้นที่เนื้อหา (#view)
const shell = (h1, extra = '') => `<h1>${esc(h1)}</h1>\n<div id="msg"></div>\n${extra}<div id="view" aria-busy="true"><p>กำลังโหลดข้อมูล…</p></div>`;

function simple(app, path, roles, { title, h1, script, boot, extra }) {
  app.get(path, pageGuard(...roles), (req, res) => {
    res.type('html').send(page({
      title, user: req.user, current: path, main: shell(h1, extra), scripts: [script], boot: boot ? boot() : {},
    }));
  });
}

// ตัวเลือกช่วงเวลาของ Dashboard: เดือนของนาฬิกา (ค่าเริ่มต้น) + 2026-12 2026-11 2026-10 + ปีของนาฬิกา + 2026 (CONTRACT 2.9)
function periodOptions() {
  const now = clock.nowISO();
  const months = [...new Set([now.slice(0, 7), '2026-12', '2026-11', '2026-10'])];
  const years = [...new Set([now.slice(0, 4), '2026'])];
  const label = (v) => (v.length === 4 ? `ทั้งปี ${Number(v) + 543}` : `${EG.MONTHS[Number(v.slice(5)) - 1]} ${Number(v.slice(0, 4)) + 543}`);
  return { def: now.slice(0, 7), options: [...months, ...years].map((v) => ({ value: v, label: label(v) })) };
}

const RESULT_TH = { VALID: 'เอกสารถูกต้อง', EXPIRED: 'เอกสารหมดอายุ', TAMPERED: 'ลายเซ็นไม่ถูกต้อง', NOT_FOUND: 'ไม่พบเอกสาร' };
const RESULT_CLASS = { VALID: 'msg-ok', EXPIRED: 'msg-warn', TAMPERED: 'msg-error', NOT_FOUND: 'msg-error' };

module.exports = function (app) {
  simple(app, '/officer/queue', ['officer', 'head'], { title: 'คิวงาน', h1: 'คิวงาน', script: '/staff/queue.js' });
  simple(app, '/head/approvals', ['head'], { title: 'รออนุมัติ', h1: 'รายการรออนุมัติ', script: '/staff/approvals.js' });
  simple(app, '/notifications', ['officer', 'head'], { title: 'แจ้งเตือน', h1: 'แจ้งเตือน', script: '/staff/notifications.js' });
  simple(app, '/audit', ['auditor'], { title: 'Audit Trail', h1: 'Audit Trail', script: '/staff/audit.js' });
  simple(app, '/admin/services', ['admin'], { title: 'ค่าธรรมเนียม/SLA', h1: 'ค่าธรรมเนียมและ SLA', script: '/staff/admin-services.js' });
  simple(app, '/admin/holidays', ['admin'], { title: 'วันหยุด', h1: 'วันหยุดราชการ', script: '/staff/admin-holidays.js' });
  simple(app, '/admin/users', ['admin'], { title: 'ผู้ใช้/บทบาท', h1: 'ผู้ใช้และบทบาท', script: '/staff/admin-users.js' });
  simple(app, '/dashboard', ['executive'], { title: 'Dashboard', h1: 'Dashboard ผู้บริหาร', script: '/staff/dashboard.js', boot: () => ({ period: periodOptions() }) });

  // ---------------------------------------------------------------- /officer/cases/:caseNo (404 เมื่อไม่มีเลข)
  app.get('/officer/cases/:caseNo', pageGuard('officer', 'head'), (req, res) => {
    const c = db.prepare('SELECT case_no FROM cases WHERE case_no=?').get(req.params.caseNo);
    if (!c) {
      return res.status(404).type('html').send(page({
        title: 'ไม่พบคำขอ', user: req.user, current: '/officer/queue',
        main: '<h1 data-testid="not-found-msg">ไม่พบคำขอ</h1><p><a href="/officer/queue">กลับไปหน้าคิวงาน</a></p>',
      }));
    }
    const main = `<h1>คำขอเลขที่ <span data-testid="case-no">${esc(c.case_no)}</span></h1>
<div id="msg"></div>
<div id="view" aria-busy="true"><p>กำลังโหลดข้อมูลคำขอ…</p></div>`;
    res.type('html').send(page({ title: `คำขอ ${c.case_no}`, user: req.user, current: '/officer/queue', main, scripts: ['/staff/case.js'], boot: { caseNo: c.case_no } }));
  });

  // ---------------------------------------------------------------- /verify/:code (สาธารณะ ห้ามใช้ pageGuard)
  app.get('/verify/:code', (req, res) => {
    const r = documents.verify(req.params.code);
    let body = '';
    if (r.result === 'VALID' || r.result === 'EXPIRED') {
      const svc = db.prepare('SELECT name FROM services WHERE id=?').get(r.serviceId);
      body = `<dl class="kv card">
<dt>เลขเอกสาร</dt><dd data-testid="verify-doc-no">${esc(r.docNo)}</dd>
<dt>ผู้ยื่น</dt><dd data-testid="verify-applicant">${esc(r.applicantMasked)}</dd>
<dt>บริการ</dt><dd data-testid="verify-service">${esc(`${r.serviceId} ${svc ? svc.name : ''}`.trim())}</dd>
<dt>วันที่ออก</dt><dd><time data-testid="verify-issued" data-iso="${esc(r.issuedAt)}" datetime="${esc(r.issuedAt)}">${esc(thaiDateTime(r.issuedAt))}</time></dd>
<dt>ผู้ลงนาม</dt><dd data-testid="verify-signer">${esc(r.signer)}</dd>
<dt>ใช้ได้ถึง</dt><dd><time data-testid="verify-expires" data-iso="${esc(r.validUntil)}" datetime="${esc(r.validUntil)}">${esc(thaiDate(r.validUntil))}</time></dd>
</dl>`;
    }
    const main = `<h1>ตรวจสอบเอกสารดิจิทัล</h1>
<p class="${RESULT_CLASS[r.result]}" data-testid="verify-result" data-result="${r.result}" role="status">${RESULT_TH[r.result]}</p>
${body}`;
    res.status(r.result === 'NOT_FOUND' ? 404 : 200).type('html').send(page({ title: 'ตรวจสอบเอกสาร', user: null, main }));
  });
};
