// B10 · หน้าประชาชน: / · /login · /register · /citizen · /citizen/new/:service · /citizen/cases/:caseNo (CONTRACT ข้อ 1-2)
// SSR โครงหน้า + ส่วนที่ test ต้องเห็นทันที (header, welcome, รายการ, 403/404) แล้วให้สคริปต์ใน public/citizen/* เติมข้อมูลจาก API
const { db } = require('../db');
const { thaiDateTime, baht } = require('../util');
const { bug } = require('../bugs');
const { getSession, pageGuard, landingFor, ROLE_LABELS } = require('../rbac');
const EG = require('../../public/common.js');

const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const json = (o) => JSON.stringify(o).replace(/</g, '\\u003c'); // ใน <script type=application/json> ห้ามมี </script>
const BASE_URL = () => (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const EN = '–'; // en dash ใน "1–5" "1–500" (CONTRACT ตาราง 5)

function header(s, nav) {
  const dept = s.role === 'officer' ? ` data-dept="${esc(s.dept)}"` : '';
  return `<header class="app-header" data-testid="app-header"><div class="container bar">
<a class="brand" href="/">e-Service เทศบาลนครตัวอย่าง</a>
<nav aria-label="เมนูหลัก">${nav || ''}</nav>
<div class="user"><span data-testid="user-name">${esc(s.name)}</span><span class="role-chip" data-testid="user-role" data-role="${esc(s.role)}"${dept}>${esc(ROLE_LABELS[s.role] || s.role)}</span>
<button type="button" class="btn secondary" data-testid="logout-btn">ออกจากระบบ</button></div></div></header>`;
}
const CITIZEN_NAV = '<a data-testid="nav-my-cases" href="/citizen">คำขอของฉัน</a>';

// หน้า HTML: user = session (มี header) หรือ null (หน้า login) · scripts = สคริปต์เฉพาะหน้า · boot = ข้อมูลเริ่มต้นให้สคริปต์ (JSON)
function page({ title, user, nav, main, scripts = [], boot, narrow }) {
  return `<!doctype html>
<html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · e-Service เทศบาลนครตัวอย่าง</title><link rel="stylesheet" href="/common.css"></head>
<body><a class="skip" href="#main">ข้ามไปยังเนื้อหาหลัก</a>
${user ? header(user, nav) : ''}
<main id="main" class="container${narrow ? ' narrow' : ''}">
${main}
</main>
${boot ? `<script type="application/json" id="boot">${json(boot)}</script>` : ''}
<script src="/common.js" defer></script>
${scripts.map((s) => `<script src="${s}" defer></script>`).join('\n')}
</body></html>`;
}

function notFound(res, user, text, testid) {
  const h = testid ? ` data-testid="${testid}"` : '';
  res.status(404).type('html').send(page({
    title: text, user, nav: CITIZEN_NAV,
    main: `<h1${h}>${esc(text)}</h1><p><a href="/citizen">กลับไปหน้าคำขอของฉัน</a></p>`,
  }));
}

const svcRow = (id) => db.prepare('SELECT * FROM services WHERE id=?').get(id);
const svcLabel = (r) => `${r.id} ${r.name}`;
function feeText(r) {
  if (r.id === 'SV-01') return `${baht(r.fee)} ต่อฉบับ (1${EN}5 ฉบับ)`;
  if (r.id === 'SV-03') return `เริ่มต้น ${baht(r.fee_base)} · เกิน 100 ตร.ม. เพิ่มตร.ม.ละ ${baht(r.fee_per_sqm)}`;
  return `${baht(r.fee)} คงที่`;
}

module.exports = function (app) {
  // ---------------------------------------------------------------- /
  app.get('/', (req, res) => {
    const s = getSession(req);
    res.redirect(s ? landingFor(s.role, s.registered) : '/login');
  });

  // ---------------------------------------------------------------- /login (ห้ามใช้ pageGuard)
  app.get('/login', (req, res) => {
    const main = `<h1>เข้าสู่ระบบ e-Service เทศบาลนครตัวอย่าง</h1>
<div role="tablist" aria-label="ประเภทผู้ใช้" class="actions">
  <button type="button" role="tab" class="btn" id="tab-citizen" aria-selected="true" aria-controls="panel-citizen" data-testid="login-tab-citizen">ประชาชน</button>
  <button type="button" role="tab" class="btn secondary" id="tab-staff" aria-selected="false" aria-controls="panel-staff" tabindex="-1" data-testid="login-tab-staff">เจ้าหน้าที่</button>
</div>
<section role="tabpanel" id="panel-citizen" aria-labelledby="tab-citizen" class="card">
  <form id="thaid-form" novalidate>
    <div class="field">
      <label for="thaid-id-input">เลขบัตรประชาชน 13 หลัก</label>
      <input type="text" id="thaid-id-input" data-testid="thaid-id-input" inputmode="numeric" autocomplete="off">
      <p class="hint">ระบบจำลอง ThaiD (โหมดทดสอบ)</p>
    </div>
    <div id="thaid-msg"></div>
    <button type="submit" class="btn" data-testid="thaid-submit">เข้าสู่ระบบด้วย ThaiD (จำลอง)</button>
  </form>
  <form id="otp-form" data-testid="otp-step" hidden novalidate>
    <div class="field">
      <label for="otp-input">รหัส OTP</label>
      <input type="text" id="otp-input" data-testid="otp-input" inputmode="numeric" autocomplete="one-time-code">
    </div>
    <div id="otp-msg"></div>
    <button type="submit" class="btn" data-testid="otp-submit">ยืนยัน OTP</button>
  </form>
  <div id="lock-box"></div>
</section>
<section role="tabpanel" id="panel-staff" aria-labelledby="tab-staff" class="card" hidden>
  <form id="staff-form" novalidate>
    <div class="field"><label for="staff-username">ชื่อผู้ใช้</label>
      <input type="text" id="staff-username" data-testid="staff-username" autocomplete="username" autocapitalize="none"></div>
    <div class="field"><label for="staff-password">รหัสผ่าน</label>
      <input type="password" id="staff-password" data-testid="staff-password" autocomplete="current-password"></div>
    <div id="staff-msg"></div>
    <button type="submit" class="btn" data-testid="staff-submit">เข้าสู่ระบบเจ้าหน้าที่ (SSO ภาครัฐ จำลอง)</button>
  </form>
</section>`;
    res.type('html').send(page({ title: 'เข้าสู่ระบบ', main, narrow: true, scripts: ['/citizen-app/login.js'] }));
  });

  // ---------------------------------------------------------------- /register (ห้ามใช้ pageGuard: citizen ที่ยังไม่ลงทะเบียนต้องเข้าได้)
  app.get('/register', (req, res) => {
    const s = getSession(req);
    if (!s) return res.redirect('/login');
    if (s.role !== 'citizen' || s.registered) return res.redirect(landingFor(s.role, s.registered));
    const main = `<h1>ลงทะเบียนใช้งานครั้งแรก</h1>
<form id="reg-form" class="card" novalidate>
  <div class="field"><label for="reg-name">ชื่อ-สกุล (จาก ThaiD แก้ไขไม่ได้)</label>
    <input type="text" id="reg-name" data-testid="reg-name" value="${esc(s.name)}" readonly></div>
  <div class="field"><label for="reg-mobile">เบอร์มือถือ (10 หลัก ขึ้นต้นด้วย 0) <span class="req">จำเป็น</span></label>
    <input type="tel" id="reg-mobile" data-testid="reg-mobile" inputmode="numeric" autocomplete="tel">
    <div id="reg-mobile-msg"></div></div>
  <div class="field"><label for="reg-email">อีเมล <span class="req">ไม่บังคับ</span></label>
    <input type="email" id="reg-email" data-testid="reg-email" autocomplete="email"></div>
  <div class="field"><label class="check" for="reg-consent"><input type="checkbox" id="reg-consent" data-testid="reg-consent">
    <span>ข้าพเจ้ายินยอมให้เทศบาลเก็บและประมวลผลข้อมูลส่วนบุคคลเพื่อให้บริการ (PDPA)</span></label>
    <div id="reg-consent-msg"></div></div>
  <div id="reg-msg"></div>
  <button type="submit" class="btn" data-testid="reg-submit">ลงทะเบียน</button>
</form>`;
    res.type('html').send(page({ title: 'ลงทะเบียน', user: s, main, narrow: true, scripts: ['/citizen-app/register.js'] }));
  });

  // ---------------------------------------------------------------- /citizen
  app.get('/citizen', pageGuard('citizen'), (req, res) => {
    const s = req.user;
    const svcs = db.prepare('SELECT * FROM services ORDER BY id').all();
    const cases = db.prepare('SELECT case_no, service_id, status, due_at FROM cases WHERE user_id=? ORDER BY case_no DESC').all(s.userId);
    const drafts = db.prepare("SELECT draft_id, service_id, status FROM drafts WHERE user_id=? AND status<>'SUBMITTED' ORDER BY draft_id").all(s.userId);
    const name = new Map(svcs.map((r) => [r.id, svcLabel(r)]));
    const stText = (st) => EG.STATUS_TH[st] || st;

    const caseRows = cases.map((c) => `<li data-testid="my-case-row" data-case-no="${esc(c.case_no)}" data-status="${esc(c.status)}">
  <span><span class="lbl">เลขคำขอ</span><a data-testid="row-case-no" href="/citizen/cases/${esc(c.case_no)}">${esc(c.case_no)}</a></span>
  <span><span class="lbl">บริการ</span><span data-testid="row-service">${esc(name.get(c.service_id) || c.service_id)}</span></span>
  <span><span class="lbl">สถานะ</span><span class="badge" data-testid="row-status" data-status="${esc(c.status)}">${esc(stText(c.status))}</span></span>
  <span><span class="lbl">กำหนดเสร็จ</span><time data-testid="row-due" data-iso="${esc(c.due_at)}" datetime="${esc(c.due_at)}">${esc(thaiDateTime(c.due_at))}</time></span>
</li>`).join('\n');
    const draftRows = drafts.map((d) => `<li data-testid="my-draft-row" data-draft-id="${esc(d.draft_id)}" data-status="${esc(d.status)}">
  <span><span class="lbl">รหัสร่าง</span><span data-testid="row-draft-id">${esc(d.draft_id)}</span></span>
  <span><span class="lbl">บริการ</span><span data-testid="row-service">${esc(name.get(d.service_id) || d.service_id)}</span></span>
  <span><span class="lbl">สถานะ</span><span class="badge" data-testid="row-status" data-status="${esc(d.status)}">${esc(stText(d.status))}</span></span>
  <span><a class="btn secondary" data-testid="open-draft-btn" href="/citizen/new/${esc(d.service_id)}?draft=${esc(d.draft_id)}" aria-label="เปิดร่าง ${esc(d.draft_id)}">เปิดร่าง</a></span>
</li>`).join('\n');

    const main = `<h1 data-testid="citizen-welcome">สวัสดี ${esc(s.name)}</h1>
<h2 id="h-start">เริ่มบริการใหม่</h2>
<ul class="service-list" aria-labelledby="h-start">
${svcs.map((r) => `<li><a class="btn" data-testid="start-service-${esc(r.id)}" href="/citizen/new/${esc(r.id)}"><strong>${esc(svcLabel(r))}</strong><span>${esc(feeText(r))}</span></a></li>`).join('\n')}
</ul>
<h2 id="h-cases">คำขอของฉัน</h2>
${cases.length ? `<ul class="rows" aria-labelledby="h-cases">${caseRows}</ul>` : '<p>ยังไม่มีคำขอ</p>'}
<h2 id="h-drafts">ร่างและรอชำระเงิน</h2>
${drafts.length ? `<ul class="rows" aria-labelledby="h-drafts">${draftRows}</ul>` : '<p>ไม่มีร่างค้างอยู่</p>'}`;
    res.type('html').send(page({ title: 'หน้าหลักประชาชน', user: s, nav: CITIZEN_NAV, main }));
  });

  // ---------------------------------------------------------------- /citizen/new/:service
  app.get('/citizen/new/:service', pageGuard('citizen'), (req, res) => {
    const s = req.user;
    const svc = svcRow(req.params.service);
    if (!svc) return notFound(res, s, 'ไม่พบบริการ');
    let draft = null;
    let latestRef = null;
    if (typeof req.query.draft === 'string' && req.query.draft) {
      const d = db.prepare('SELECT * FROM drafts WHERE draft_id=? AND user_id=?').get(req.query.draft, s.userId);
      if (!d) return notFound(res, s, 'ไม่พบคำขอ', 'not-found-msg'); // ร่างของคนอื่น/ไม่มี ตอบเหมือนกัน
      if (d.service_id !== svc.id) return res.redirect(`/citizen/new/${encodeURIComponent(d.service_id)}?draft=${encodeURIComponent(d.draft_id)}`);
      draft = { draftId: d.draft_id, status: d.status, qty: d.qty, areaSqm: d.area_sqm, fee: d.fee };
      const p = db.prepare('SELECT ref FROM payments WHERE draft_id=? ORDER BY rowid DESC LIMIT 1').get(d.draft_id);
      latestRef = p ? p.ref : null;
    }
    const boot = {
      service: {
        id: svc.id, name: svc.name, fee: svc.fee, feeBase: svc.fee_base, feePerSqm: svc.fee_per_sqm,
        docs: JSON.parse(svc.docs_json).map((x) => ({ key: x.key, name: x.name, required: !!x.required, pdfOnly: !!x.pdfOnly })),
      },
      msgs: { INVALID_QTY: `จำนวนฉบับต้อง 1${EN}5 ฉบับ`, INVALID_AREA: `กรุณาระบุพื้นที่ 1${EN}500 ตร.ม.`, AREA_TOO_LARGE: 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน' },
      draft, latestRef,
    };
    const main = `<h1 data-testid="service-name">${esc(svc.name)}</h1>
<p data-testid="wizard-step" aria-live="polite">1/3 กรอกข้อมูล</p>
<div id="wizard"></div>`;
    res.type('html').send(page({ title: svc.name, user: s, nav: CITIZEN_NAV, main, boot, scripts: ['/citizen-app/new.js'] }));
  });

  // ---------------------------------------------------------------- /citizen/cases/:caseNo
  app.get('/citizen/cases/:caseNo', pageGuard('citizen'), (req, res) => {
    const s = req.user;
    const c = db.prepare('SELECT case_no, user_id, service_id FROM cases WHERE case_no=?').get(req.params.caseNo);
    // ของคนอื่น/ไม่มี = 404 ข้อความเดียวกัน (ห้ามเผยว่ามีอยู่) · B06: ปล่อยให้เปิดของคนอื่นได้ตามโจทย์บั๊ก (API ฝั่ง B08 ก็ทำแบบเดียวกัน)
    if (!c || (c.user_id !== s.userId && !bug('B06'))) return notFound(res, s, 'ไม่พบคำขอ', 'not-found-msg');
    const svcs = Object.fromEntries(db.prepare('SELECT id, name FROM services').all().map((r) => [r.id, r.name]));
    const main = `<h1>คำขอเลขที่ <span data-testid="case-no">${esc(c.case_no)}</span></h1>
<div id="flash"></div>
<div id="case-body" aria-live="polite"><p>กำลังโหลดข้อมูลคำขอ…</p></div>`;
    res.type('html').send(page({
      title: `คำขอ ${c.case_no}`, user: s, nav: CITIZEN_NAV, main,
      boot: { caseNo: c.case_no, services: svcs, baseUrl: BASE_URL() }, scripts: ['/citizen-app/case.js'],
    }));
  });
};
