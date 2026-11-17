'use strict';
// Server-rendered HTML pages. Interactive bits live in /static/app.js.
const C = require('./core');
const D = require('./domain');
const S = () => C.state;

const esc = v => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const TH_M = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
function thDate(isoStr, withTime = true) {
  const [y, m, d] = isoStr.slice(0, 10).split('-').map(Number);
  return `${d} ${TH_M[m - 1]} ${y + 543}${withTime && isoStr.length > 10 ? ' ' + isoStr.slice(11, 16) : ''}`;
}
const money = n => (n == null ? '–' : '฿' + Number(n).toLocaleString('en-US'));
const svcLabel = id => `${id} ${C.SERVICES[id].name}`;
const timeEl = (testid, ms, tag = 'time') => (ms == null ? '' : `<${tag} data-testid="${testid}" data-iso="${C.iso(ms)}"${tag === 'time' ? ` datetime="${C.iso(ms)}"` : ''}>${thDate(C.iso(ms))}</${tag}>`);
const statusBadge = (testid, st) => `<span class="badge st-${st}" data-testid="${testid}" data-status="${st}">${C.STATUS_TH[st]}</span>`;
const levelBadge = (testid, lv) => `<span class="badge lv-${lv}" data-testid="${testid}" data-level="${lv}">${C.LEVEL_TH[lv]}</span>`;
const option = (v, label, cur) => `<option value="${v}"${v === cur ? ' selected' : ''}>${label}</option>`;
const pageData = obj => `<script type="application/json" id="page-data">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;

const NAV = {
  citizen: [['nav-my-cases', '/citizen', 'คำขอของฉัน']],
  officer: [['nav-queue', '/officer/queue', 'คิวงาน']],
  head: [['nav-queue', '/officer/queue', 'คิวงาน'], ['nav-approvals', '/head/approvals', 'รออนุมัติ']],
  executive: [['nav-dashboard', '/dashboard', 'Dashboard']],
  auditor: [['nav-audit', '/audit', 'Audit Trail']],
  admin: [['nav-admin-services', '/admin/services', 'บริการ'], ['nav-admin-holidays', '/admin/holidays', 'วันหยุด'], ['nav-admin-users', '/admin/users', 'ผู้ใช้']],
};
function header(s) {
  let user = '';
  if (s) {
    const nav = (s.registered ? NAV[s.role] : []).map(([id, href, label]) => `<a data-testid="${id}" href="${href}">${label}</a>`);
    if (s.registered && ['officer', 'head'].includes(s.role)) {
      nav.push(`<a data-testid="nav-bell" href="/notifications">แจ้งเตือน <span class="count" data-testid="bell-count">${D.notificationsOf(s.username).length}</span></a>`);
    }
    user = `<nav aria-label="เมนูหลัก">${nav.join('')}</nav>
      <div class="who"><span data-testid="user-name">${esc(s.name)}</span>
      <span class="role" data-testid="user-role" data-role="${s.role}"${s.role === 'officer' ? ` data-dept="${s.dept}"` : ''}>${C.ROLE_TH[s.role]}</span>
      <button type="button" class="link" data-testid="logout-btn">ออกจากระบบ</button></div>`;
  }
  return `<header class="top" data-testid="app-header"><a class="brand" href="/">เทศบาลนครตัวอย่าง · e-Service <small>(ระบบจำลอง)</small></a>${user}</header>`;
}
function render(ctx, title, body, status = 200, data = {}) {
  const html = `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · e-Service เทศบาลนครตัวอย่าง</title><link rel="stylesheet" href="/static/app.css"></head>
<body><a class="skip" href="#main">ข้ามไปเนื้อหาหลัก</a>${header(ctx.session)}
<main id="main"><div id="flash"></div>${body}</main>${pageData(data)}<script src="/static/app.js"></script></body></html>`;
  ctx.send(status, html, { 'Content-Type': 'text/html; charset=utf-8' });
}
const redirect = (ctx, to) => ctx.send(302, '', { Location: to });
const forbidden = ctx => render(ctx, 'ไม่มีสิทธิ์', '<h1 data-testid="forbidden-msg">ไม่มีสิทธิ์เข้าถึงหน้านี้</h1>', 403);
const caseNotFound = ctx => render(ctx, 'ไม่พบคำขอ', '<h1 data-testid="not-found-msg">ไม่พบคำขอ</h1>', 404);
const table = (label, head, rows, testid = '') => `<div class="table-wrap" tabindex="0" role="region" aria-label="${label}">
  <table${testid ? ` data-testid="${testid}"` : ''}><thead><tr>${head.map(h => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;

// ---------------------------------------------------------------- login / register
function loginPage(ctx) {
  render(ctx, 'เข้าสู่ระบบ', `<h1>เข้าสู่ระบบ</h1>
<div class="tabs" role="tablist" aria-label="ประเภทผู้ใช้">
  <button type="button" role="tab" id="tab-c" aria-controls="panel-c" aria-selected="true" data-testid="login-tab-citizen">ประชาชน (ThaiD)</button>
  <button type="button" role="tab" id="tab-s" aria-controls="panel-s" aria-selected="false" data-testid="login-tab-staff">เจ้าหน้าที่</button>
</div>
<section class="card" role="tabpanel" id="panel-c" aria-labelledby="tab-c">
  <form id="thaid-form" novalidate>
    <label for="idNo">เลขบัตรประชาชน 13 หลัก</label>
    <input id="idNo" data-testid="thaid-id-input" inputmode="numeric" autocomplete="off">
    <button type="submit" data-testid="thaid-submit">เข้าสู่ระบบด้วย ThaiD (จำลอง)</button>
  </form>
  <form id="otp-form" data-testid="otp-step" hidden novalidate>
    <p>ระบบส่งรหัส OTP แล้ว (โหมดทดสอบ: 123456)</p>
    <label for="otp">รหัส OTP 6 หลัก</label>
    <input id="otp" data-testid="otp-input" inputmode="numeric" autocomplete="one-time-code">
    <button type="submit" data-testid="otp-submit">ยืนยัน OTP</button>
  </form>
  <div id="citizen-msg" aria-live="polite"></div>
</section>
<section class="card" role="tabpanel" id="panel-s" aria-labelledby="tab-s" hidden>
  <form id="staff-form" novalidate>
    <label for="su">ชื่อผู้ใช้</label><input id="su" data-testid="staff-username" autocomplete="username">
    <label for="sp">รหัสผ่าน</label><input id="sp" type="password" data-testid="staff-password" autocomplete="current-password">
    <button type="submit" data-testid="staff-submit">เข้าสู่ระบบเจ้าหน้าที่ (SSO ภาครัฐ จำลอง)</button>
  </form>
  <div id="staff-msg" aria-live="polite"></div>
</section>`, 200, { page: 'login' });
}
function registerPage(ctx) {
  const s = ctx.session;
  if (!s) return redirect(ctx, '/login');
  if (s.registered) return redirect(ctx, C.LANDING[s.role]);
  render(ctx, 'ลงทะเบียน', `<h1>ลงทะเบียนใช้งานครั้งแรก</h1>
<form id="reg-form" class="card" novalidate>
  <label for="rn">ชื่อ-สกุล (จาก ThaiD แก้ไขไม่ได้)</label><input id="rn" data-testid="reg-name" value="${esc(s.name)}" readonly>
  <label for="rm">เบอร์มือถือ (บังคับ 10 หลัก)</label><input id="rm" data-testid="reg-mobile" inputmode="tel" autocomplete="tel">
  <div id="err-mobile"></div>
  <label for="re">อีเมล (ไม่บังคับ)</label><input id="re" type="email" data-testid="reg-email" autocomplete="email">
  <div class="check"><input type="checkbox" id="rc" data-testid="reg-consent">
    <label for="rc">ข้าพเจ้ายินยอมให้ประมวลผลข้อมูลส่วนบุคคลเพื่อให้บริการตาม พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล (PDPA)</label></div>
  <div id="err-consent"></div>
  <button type="submit" data-testid="reg-submit">ลงทะเบียน</button>
</form>`, 200, { page: 'register' });
}

// ---------------------------------------------------------------- citizen
function citizenHome(ctx, s) {
  const cases = D.casesOf(s.citizenId);
  const drafts = D.openDraftsOf(s.citizenId);
  const draftRows = drafts.map(d => `<tr data-testid="my-draft-row" data-draft-id="${d.draftId}" data-status="${d.status}">
    <td data-testid="row-draft-id">${d.draftId}</td><td data-testid="row-service">${svcLabel(d.serviceId)}</td>
    <td>${statusBadge('row-status', d.status)}</td><td>${money(D.draftFee(d))}</td>
    <td><a class="btn small" data-testid="open-draft-btn" href="/citizen/new/${d.serviceId}?draft=${d.draftId}">เปิดร่าง ${d.draftId}</a></td></tr>`);
  const caseRows = cases.map(c => `<tr data-testid="my-case-row" data-case-no="${c.caseNo}" data-status="${c.status}">
    <td data-testid="row-case-no"><a href="/citizen/cases/${c.caseNo}">${c.caseNo}</a></td><td data-testid="row-service">${svcLabel(c.serviceId)}</td>
    <td>${statusBadge('row-status', c.status)}</td>${timeEl('row-due', c.dueAt, 'td')}
    <td>${levelBadge('row-sla-level', C.slaLevel(c))}</td></tr>`);
  render(ctx, 'คำขอของฉัน', `<h1 data-testid="citizen-welcome">สวัสดี ${esc(s.name)}</h1>
<h2>เริ่มยื่นคำขอ</h2>
<ul class="services">${Object.keys(C.SERVICES).map(id => `<li><a class="btn" data-testid="start-service-${id}" href="/citizen/new/${id}">${svcLabel(id)}</a></li>`).join('')}</ul>
<h2>ร่างและรอชำระเงิน</h2>
${drafts.length ? table('ร่างคำขอ', ['รหัสร่าง', 'บริการ', 'สถานะ', 'ค่าธรรมเนียม', ''], draftRows) : '<p>ไม่มีร่าง</p>'}
<h2>คำขอของฉัน</h2>
${cases.length ? table('คำขอของฉัน', ['เลขคำขอ', 'บริการ', 'สถานะ', 'กำหนดเสร็จ', 'ระดับเตือน'], caseRows) : '<p>ยังไม่มีคำขอ</p>'}`);
}

function wizardPage(ctx, s, svc) {
  if (!C.SERVICES[svc]) return caseNotFound(ctx);
  let draft = null;
  const draftId = ctx.query.get('draft');
  if (draftId) {
    const d = D.draftBy(draftId);
    if (!d || d.ownerId !== s.citizenId || d.serviceId !== svc) return caseNotFound(ctx);
    draft = D.draftJson(d);
  }
  const conf = S().services[svc];
  const docs = C.SERVICES[svc].docs.map(([key, name, required]) => ({ key, name, required }));
  const input = svc === 'SV-01'
    ? `<label for="qty">จำนวนฉบับ (1–5 ฉบับ ฉบับละ ${money(conf.fee)})</label><input id="qty" type="number" inputmode="numeric" data-testid="qty-input" value="${draft?.qty ?? 1}">`
    : svc === 'SV-03'
      ? `<label for="area">พื้นที่ก่อสร้าง/ต่อเติม (ตร.ม. จำนวนเต็ม 1–500)</label><input id="area" type="number" inputmode="numeric" data-testid="area-input" value="${draft?.areaSqm ?? ''}">`
      : `<p>ค่าธรรมเนียมคงที่</p>`;
  const initFee = C.calcFee(svc, { qty: draft?.qty ?? 1, areaSqm: draft?.areaSqm ?? '' }).fee;
  const uploads = docs.map(d => `<div class="field"><label for="up-${d.key}">${d.name}${d.required ? ' ✱ (บังคับ)' : ' (ไม่บังคับ)'}${d.key === 'plan' ? ' · PDF เท่านั้น' : ''}</label>
    <input type="file" id="up-${d.key}" data-testid="upload-input-${d.key}" data-doc-key="${d.key}"></div>`).join('')
    + `<div class="field"><label for="up-extra">เอกสารเพิ่มเติม (ไม่บังคับ เลือกได้หลายไฟล์)</label><input type="file" id="up-extra" multiple data-testid="upload-input-extra" data-doc-key="extra"></div>`;
  render(ctx, C.SERVICES[svc].name, `<h1 data-testid="service-name">${C.SERVICES[svc].name}</h1>
<p class="step" data-testid="wizard-step" aria-live="polite">1/3 กรอกข้อมูล</p>
<section id="step1" class="card">
  <form id="f1" novalidate>
    ${input}
    <p>ค่าธรรมเนียม: <output id="fee" data-testid="fee-total" aria-live="polite">${initFee == null ? '–' : money(initFee)}</output></p>
    <div id="fee-msg"></div>
    <p id="draft-line">${draft ? `รหัสร่าง: <span data-testid="draft-id">${draft.draftId}</span>` : ''}</p>
    <div class="actions"><button type="button" class="secondary" data-testid="save-draft-btn">บันทึกร่าง</button>
    <button type="submit" data-testid="to-upload-btn"${initFee == null ? ' disabled' : ''}>ถัดไป: แนบเอกสาร</button></div>
  </form>
</section>
<section id="step2" class="card" hidden>
  <h2>แนบเอกสาร</h2>
  <p class="hint">PDF, JPG, PNG ไม่เกิน 5 MB ต่อไฟล์ รวมไม่เกิน 5 ไฟล์ต่อคำขอ</p>
  ${uploads}
  <div id="upload-msg" aria-live="polite"></div>
  <ul id="file-list" class="files" aria-label="ไฟล์ที่แนบแล้ว"></ul>
  <div id="missing" aria-live="polite"></div>
  <button type="button" data-testid="to-payment-btn" disabled>ไปชำระเงิน</button>
</section>
<section id="step3" class="card" hidden><h2>ชำระเงินด้วย PromptPay QR (จำลอง)</h2><div id="pay" aria-live="polite"></div></section>`,
  200, { page: 'wizard', serviceId: svc, docs, draft });
}

function docList(c) {
  const files = D.draftFiles(c.fileIds);
  return `<h2>เอกสารแนบ</h2><ul class="files">${files.map(f => `<li data-testid="doc-item" data-name="${esc(f.name)}" data-file-id="${f.fileId}">
    <a data-testid="doc-download-link" href="/api/files/${f.fileId}" download="${esc(f.name)}">${esc(f.name)}</a> <span class="hint">(${C.DOC_LABEL[f.docKey] || f.docKey} · ${f.size.toLocaleString('en-US')} ไบต์)</span></li>`).join('')}</ul>`;
}
function caseCore(ctx, c, staff) {
  const lvl = C.slaLevel(c);
  const doc = c.docNo ? D.docBy(c.docNo) : null;
  const host = ctx.req.headers.host;
  const idNo = D.applicantIdNo(c);
  const idPart = staff
    ? `<span data-testid="applicant-id">${C.maskId(idNo)}</span>
       <button type="button" class="small secondary" data-testid="show-full-id-btn" aria-expanded="false" aria-controls="unmask-form">แสดงเลขเต็ม</button>
       <span id="full-id-slot"></span>
       <div id="unmask-form" class="inline-form" hidden><label for="unmask-reason">เหตุผลที่ขอดูเลขเต็ม</label>
         <input id="unmask-reason" data-testid="unmask-reason"><button type="button" data-testid="unmask-submit">ยืนยันแสดงเลขเต็ม</button><div id="unmask-msg"></div></div>`
    : `<span data-testid="case-id-full">${C.fmtId(idNo)}</span>`;
  return `<dl class="kv">
  <dt>เลขคำขอ</dt><dd data-testid="case-no">${c.caseNo}</dd>
  <dt>สถานะ</dt><dd>${statusBadge('case-status', c.status)}</dd>
  <dt>บริการ</dt><dd data-testid="case-service">${svcLabel(c.serviceId)}</dd>
  ${c.serviceId === 'SV-03' ? `<dt>ขั้นตอน</dt><dd data-testid="case-step">${D.STEP_TH[c.step]}</dd>` : ''}
  <dt>ค่าธรรมเนียม</dt><dd data-testid="case-fee">${money(c.fee)}</dd>
  ${staff ? `<dt>ผู้ยื่น</dt><dd data-testid="applicant-name">${esc(D.applicantName(c))}</dd>` : ''}
  <dt>เลขบัตรประชาชน</dt><dd>${idPart}</dd>
  <dt>กำหนดเสร็จ</dt><dd>${timeEl('sla-due', c.dueAt)}</dd>
  <dt>ระดับเตือน</dt><dd>${levelBadge('sla-level', lvl)}</dd>
  ${staff ? `<dt>ผู้ถือเรื่อง</dt><dd data-testid="case-owner">${c.owner || 'ยังไม่มีผู้รับ'}</dd><dt>ตีกลับแล้ว (ครั้ง)</dt><dd data-testid="return-count">${c.returnCount}</dd>` : ''}
  ${['COMPLETED', 'REJECTED'].includes(c.status) && c.closedAt ? `<dt>ปิดงานเมื่อ</dt><dd>${timeEl('closed-at', c.closedAt)}</dd>` : ''}
  ${doc ? `<dt>เลขเอกสาร</dt><dd data-testid="doc-no">${doc.docNo}</dd><dt>รหัสตรวจสอบ</dt><dd data-testid="verify-code">${doc.verifyCode}</dd>` : ''}
</dl>
${doc ? `<figure class="qr" data-testid="doc-qr" data-url="http://${esc(host)}/verify/${doc.verifyCode}">${qrSvg(doc.verifyCode, 'QR ตรวจสอบเอกสาร ' + doc.docNo)}
  <figcaption><a href="/verify/${doc.verifyCode}">/verify/${doc.verifyCode}</a></figcaption></figure>` : ''}`;
}
function qrSvg(seed, label) { // decorative stand-in for a QR code (simulation only)
  let h = 0; for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  let cells = '';
  for (let y = 0; y < 21; y++) for (let x = 0; x < 21; x++) {
    const finder = (x < 7 && y < 7) || (x > 13 && y < 7) || (x < 7 && y > 13);
    h = (h * 1103515245 + 12345) >>> 0;
    if (finder ? (x % 6 === 0 || y % 6 === 0 || (x % 7 > 1 && x % 7 < 5 && y % 7 > 1 && y % 7 < 5)) : h & 0x100) cells += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
  }
  return `<svg role="img" aria-label="${esc(label)}" viewBox="-1 -1 23 23" width="160" height="160"><rect x="-1" y="-1" width="23" height="23" fill="#fff"/><g fill="#000">${cells}</g></svg>`;
}
const timeline = c => `<h2>ไทม์ไลน์</h2><ol class="timeline" data-testid="case-timeline">${[...c.timeline].sort((a, b) => a.at - b.at)
  .map(e => `<li data-testid="timeline-item" data-iso="${C.iso(e.at)}"><time datetime="${C.iso(e.at)}">${thDate(C.iso(e.at))}</time> ${esc(e.text)}</li>`).join('')}</ol>`;

function citizenCase(ctx, s, caseNo) {
  const c = D.citizenCase(s, caseNo);
  if (!c) return caseNotFound(ctx);
  const t = C.now();
  const parts = [];
  if (c.status === 'NEED_FIX') {
    parts.push(`<section class="card warn"><h2>คำขอถูกตีกลับให้แก้ไข</h2>
      <p>เหตุผล: <span data-testid="return-reason-display">${esc(c.returns.at(-1).reason)}</span></p>
      <p>ส่งแก้ไขได้ถึง ${timeEl('fix-deadline', c.fixDeadline)}</p>
      ${t < c.fixDeadline ? `<label for="fix-files">แนบไฟล์ใหม่ (ไม่บังคับ)</label><input type="file" id="fix-files" multiple data-testid="fix-upload-input">
      <button type="button" data-testid="submit-fix-btn">ส่งแก้ไข</button>` : ''}</section>`);
  }
  if (c.status === 'SUBMITTED' && !c.owner) {
    parts.push(`<button type="button" class="danger" data-testid="cancel-case-btn" aria-controls="cancel-dialog">ยกเลิกคำขอ</button>
      <div id="cancel-dialog" class="card warn" role="dialog" aria-modal="false" aria-labelledby="cancel-title" hidden>
        <h2 id="cancel-title">ยืนยันการยกเลิกคำขอ</h2><p data-testid="cancel-confirm-text">ค่าธรรมเนียมที่ชำระแล้วไม่คืน</p>
        <button type="button" class="danger" data-testid="confirm-cancel-btn">ยืนยันยกเลิก</button> <button type="button" class="secondary" id="cancel-no">ไม่ยกเลิก</button></div>`);
  }
  if (['REJECTED', 'CANCELLED'].includes(c.status)) parts.push('<p class="note" data-testid="no-refund-note">ค่าธรรมเนียมที่ชำระแล้วไม่คืน</p>');
  if (c.docNo) parts.push(`<a class="btn" data-testid="download-doc-btn" href="/api/documents/${c.docNo}/pdf" download="${c.docNo}.pdf">ดาวน์โหลดเอกสาร</a>`);
  render(ctx, `คำขอ ${c.caseNo}`, `<h1>คำขอ ${c.caseNo}</h1>${caseCore(ctx, c, false)}<div class="actions">${parts.join('')}</div>${docList(c)}${timeline(c)}`,
    200, { page: 'case', caseNo: c.caseNo });
}

function officerCase(ctx, s, caseNo) {
  const c = D.caseBy(caseNo);
  if (!c) return caseNotFound(ctx);
  const a = [];
  if (D.can(s, c, 'claim')) a.push('<button type="button" data-testid="claim-btn">รับเรื่อง</button>');
  if (D.can(s, c, 'decide')) a.push('<button type="button" data-testid="approve-btn">อนุมัติ</button>');
  if (D.can(s, c, 'forward')) a.push(`<div class="inline-form"><label for="forward-note">หมายเหตุส่งต่อ (ไม่บังคับ)</label>
    <textarea id="forward-note" data-testid="forward-note" rows="2"></textarea><button type="button" data-testid="forward-btn">ผ่าน/ส่งต่อ</button></div>`);
  if (D.can(s, c, 'return')) a.push(`<button type="button" class="secondary" data-testid="return-btn" aria-expanded="false" aria-controls="return-form">ตีกลับ</button>
    <div id="return-form" class="inline-form" hidden><label for="return-reason">เหตุผลการตีกลับ (อย่างน้อย 10 ตัวอักษร)</label>
    <textarea id="return-reason" data-testid="return-reason" rows="2"></textarea><button type="button" data-testid="return-submit">ยืนยันตีกลับ</button><div id="return-msg"></div></div>`);
  if (D.can(s, c, 'decide')) a.push(`<button type="button" class="danger" data-testid="reject-btn" aria-expanded="false" aria-controls="reject-form">ไม่อนุมัติ</button>
    <div id="reject-form" class="inline-form" hidden><label for="reject-reason">เหตุผลที่ไม่อนุมัติ (อย่างน้อย 10 ตัวอักษร)</label>
    <textarea id="reject-reason" data-testid="reject-reason" rows="2"></textarea><button type="button" data-testid="reject-submit">ยืนยันไม่อนุมัติ</button><div id="reject-msg"></div></div>`);
  if (D.can(s, c, 'issue')) a.push('<button type="button" data-testid="issue-btn">ออกเอกสาร</button>');
  render(ctx, `คำขอ ${c.caseNo}`, `<h1>คำขอ ${c.caseNo}</h1>${caseCore(ctx, c, true)}
<h2>ดำเนินการ</h2><div class="actions">${a.join('') || '<p class="hint">ไม่มีรายการที่ทำได้ในสถานะนี้</p>'}</div>${docList(c)}${timeline(c)}`,
  200, { page: 'case', caseNo: c.caseNo });
}

// ---------------------------------------------------------------- staff lists
function queuePage(ctx, s) {
  const filter = ['all', 'unclaimed', 'mine'].includes(ctx.query.get('filter')) ? ctx.query.get('filter') : 'all';
  const rows = D.queueFor(s, filter).map(c => {
    const q = D.queueItem(c); // same owner/mask/level rules as GET /api/officer/queue
    const owner = q.owner || '';
    return `<tr data-testid="queue-row" data-case-no="${c.caseNo}" data-owner="${owner}" data-status="${c.status}" data-sla-level="${q.slaLevel}">
    <td data-testid="row-case-no"><a href="/officer/cases/${c.caseNo}">${c.caseNo}</a></td><td data-testid="row-service">${svcLabel(c.serviceId)}${c.serviceId === 'SV-03' ? ` (${c.step}/3)` : ''}</td>
    <td data-testid="row-applicant">${esc(q.applicantName)}</td><td data-testid="row-id-masked">${q.idMasked}</td>
    <td>${statusBadge('row-status', c.status)}</td>${timeEl('row-due', c.dueAt, 'td')}
    <td>${levelBadge('row-sla-level', q.slaLevel)}</td><td data-testid="row-owner">${owner}</td>
    <td>${D.can(s, c, 'claim') ? `<button type="button" class="small" data-testid="claim-btn" data-case="${c.caseNo}">รับเรื่อง</button>` : ''}</td></tr>`;
  });
  const opt = (v, l) => option(v, l, filter);
  render(ctx, 'คิวงาน', `<h1>คิวงาน${s.role === 'head' ? ' (ทุกแผนก · อ่านอย่างเดียว)' : ''}</h1>
${s.role === 'officer' ? `<p>งานในมือของฉัน: <strong data-testid="workload-count">${D.workload(s.username)}</strong> / 10 เรื่อง</p>` : ''}
<form method="get" class="filters"><label for="qf">ตัวกรอง</label>
<select id="qf" name="filter" data-testid="queue-filter" data-autosubmit>${opt('all', 'ทั้งหมด')}${opt('unclaimed', 'ยังไม่มีผู้รับ')}${opt('mine', 'ของฉัน')}</select>
<button type="submit" class="secondary">กรอง</button></form>
${table('ตารางคิวงาน', ['เลขคำขอ', 'บริการ', 'ผู้ยื่น', 'เลขบัตร', 'สถานะ', 'กำหนดเสร็จ', 'ระดับเตือน', 'ผู้ถือเรื่อง', 'ดำเนินการ'], rows, 'queue-table')}
${rows.length ? '' : '<p data-testid="queue-empty">ไม่มีงานในคิว</p>'}`, 200, { page: 'queue' });
}
function approvalsPage(ctx) {
  const rows = S().cases.filter(c => c.status === 'PENDING_APPROVAL').sort(D.sortQueue)
    .map(c => `<tr data-testid="approval-row" data-case-no="${c.caseNo}"><td data-testid="row-case-no">${c.caseNo}</td>
    <td data-testid="row-service">${svcLabel(c.serviceId)}</td><td data-testid="row-applicant">${esc(D.applicantName(c))}</td>
    ${timeEl('row-due', c.dueAt, 'td')}<td>${levelBadge('row-sla-level', C.slaLevel(c))}</td>
    <td><a class="btn small" data-testid="approval-open" href="/officer/cases/${c.caseNo}">เปิดคำขอ</a></td></tr>`);
  render(ctx, 'รออนุมัติ', `<h1>รายการรออนุมัติ</h1>${rows.length ? table('รายการรออนุมัติ', ['เลขคำขอ', 'บริการ', 'ผู้ยื่น', 'กำหนดเสร็จ', 'ระดับเตือน', ''], rows) : '<p>ไม่มีรายการรออนุมัติ</p>'}`);
}
function notificationsPage(ctx, s) {
  const items = D.notificationsOf(s.username);
  render(ctx, 'แจ้งเตือน', `<h1>แจ้งเตือน</h1>${items.length ? `<ul class="noti">${items.map(n => `<li data-testid="noti-item" data-case-no="${n.caseNo}" data-level="${n.level}" class="lv-${n.level}"><a href="/officer/cases/${n.caseNo}">${esc(n.text)}</a> <time class="hint" datetime="${C.iso(n.createdAt)}">${thDate(C.iso(n.createdAt))}</time></li>`).join('')}</ul>`
    : '<p data-testid="noti-empty">ไม่มีแจ้งเตือน</p>'}`);
}

// ---------------------------------------------------------------- executive / auditor
function dashboardPage(ctx) {
  const period = D.periodOf(ctx.query.get('period')), service = D.serviceOf(ctx.query.get('service'));
  const k = D.dashboard(period, service);
  const nowIso = C.iso(C.now());
  const months = [];
  let [y, m] = nowIso.slice(0, 7).split('-').map(Number);
  for (let i = 0; i < 12; i++) { months.push(`${y}-${C.pad(m)}`); if (--m === 0) { m = 12; y--; } }
  const years = [Number(nowIso.slice(0, 4)), Number(nowIso.slice(0, 4)) - 1].map(String);
  const opts = [...months.map(v => [v, `${TH_M[Number(v.slice(5)) - 1]} ${Number(v.slice(0, 4)) + 543}`]), ...years.map(v => [v, `ทั้งปี ${Number(v) + 543}`])];
  if (!opts.some(([v]) => v === period)) opts.push([period, period]);
    const q = `period=${period}&service=${service}`;
  const kpi = (id, label, v) => `<div class="kpi"><span>${label}</span><strong data-testid="${id}">${v}</strong></div>`;
  render(ctx, 'Dashboard', `<h1>Dashboard สรุปการให้บริการ</h1>
<form method="get" class="filters">
  <label for="period">เดือน/ปี</label><select id="period" name="period" data-testid="period-select" data-autosubmit>${opts.map(([v, l]) => option(v, l, period)).join('')}</select>
  <label for="service">บริการ</label><select id="service" name="service" data-testid="service-select" data-autosubmit>
    ${['ALL', ...Object.keys(C.SERVICES)].map(v => option(v, v === 'ALL' ? 'ทุกบริการ' : svcLabel(v), service)).join('')}</select>
  <button type="submit" class="secondary">แสดง</button>
</form>
<div class="kpis">${kpi('kpi-received', 'รับเรื่อง', k.received)}${kpi('kpi-closed', 'ปิดงาน', k.closed)}${kpi('kpi-ontime-pct', 'ทันกำหนด %', D.pctText(k.ontimePct))}
${kpi('kpi-backlog', 'งานคงค้าง (ณ ตอนนี้)', k.backlog)}${kpi('kpi-overdue', 'เกินกำหนดคงค้าง', k.overdue)}</div>
<div class="actions"><a class="btn" data-testid="export-xlsx-btn" href="/api/dashboard/export?format=xlsx&${q}" download>ส่งออก Excel</a>
<a class="btn" data-testid="export-pdf-btn" href="/api/dashboard/export?format=pdf&${q}" download>ส่งออก PDF</a></div>
<h2>งานในมือรายเจ้าหน้าที่</h2>
${table('งานในมือรายเจ้าหน้าที่', ['เจ้าหน้าที่', 'งานในมือ'], k.workload.map(w => `<tr data-testid="workload-row" data-username="${w.username}"><td>${w.username} · ${esc(D.staffName(w.username))}</td><td data-testid="workload-value">${w.count}</td></tr>`))}`);
}
function auditPage(ctx) {
  const f = D.auditFilters(ctx.query);
  const rows = D.auditQuery(f);
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  render(ctx, 'Audit Trail', `<h1>Audit Trail (อ่านอย่างเดียว)</h1>
<form method="get" class="filters">
  <label for="fa">ผู้ทำรายการ (username)</label><input id="fa" name="actor" data-testid="audit-filter-actor" value="${esc(f.actor)}">
  <label for="fe">เหตุการณ์</label><select id="fe" name="event" data-testid="audit-filter-event"><option value="">ทั้งหมด</option>
    ${D.AUDIT_EVENTS.map(e => option(e, e, f.event)).join('')}</select>
  <label for="ff">ตั้งแต่วันที่</label><input id="ff" type="date" name="from" data-testid="audit-filter-from" value="${esc(f.from)}">
  <label for="ft">ถึงวันที่</label><input id="ft" type="date" name="to" data-testid="audit-filter-to" value="${esc(f.to)}">
  <button type="submit" data-testid="audit-apply-btn">ค้นหา</button>
</form>
<p>พบ <strong data-testid="audit-count">${rows.length}</strong> รายการ · <a class="btn small" data-testid="audit-export-csv-btn" href="/api/audit/export.csv${qs ? '?' + qs : ''}" download>ส่งออก CSV</a></p>
${table('ตาราง Audit Trail', ['เวลา', 'ผู้ทำ', 'บทบาท', 'เหตุการณ์', 'เลขคำขอ', 'สถานะก่อน → หลัง', 'รายละเอียด'], rows.map(a => `<tr data-testid="audit-row" data-id="${a.id}" data-event="${a.event}" data-actor="${a.username}" data-case-no="${a.caseNo || ''}">
  <td data-testid="audit-time" data-iso="${C.iso(a.time)}">${thDate(C.iso(a.time))}:${C.iso(a.time).slice(17, 19)}</td><td data-testid="audit-actor">${a.username}</td>
  <td data-testid="audit-role">${a.role}</td><td data-testid="audit-event">${a.event}</td><td data-testid="audit-case-no">${a.caseNo || '–'}</td>
  <td data-testid="audit-transition">${a.fromStatus ? `${a.fromStatus} → ${a.toStatus}` : '–'}</td><td data-testid="audit-detail">${esc(a.detail)}</td></tr>`))}`);
}

// ---------------------------------------------------------------- admin
function adminServices(ctx) {
  const cards = Object.entries(S().services).map(([id, v]) => `<section class="card" data-testid="service-row" data-service-id="${id}"><h2>${svcLabel(id)}</h2>
  <div class="grid">
   <div class="field"><label for="fee-${id}">${id === 'SV-01' ? 'ค่าธรรมเนียม (฿ ต่อฉบับ)' : id === 'SV-03' ? 'ค่าธรรมเนียมฐาน (฿ พื้นที่ 1–100 ตร.ม.)' : 'ค่าธรรมเนียม (฿ คงที่)'}</label>
     <input id="fee-${id}" type="number" inputmode="numeric" data-testid="svc-fee-${id}" value="${v.fee}"></div>
   ${id === 'SV-03' ? `<div class="field"><label for="psq-${id}">฿ ต่อ ตร.ม. ส่วนเกิน 100</label><input id="psq-${id}" type="number" inputmode="numeric" data-testid="svc-fee-per-sqm-${id}" value="${v.feePerSqm}"></div>` : ''}
   <div class="field"><label for="sla-${id}">SLA (วันทำการ)</label><input id="sla-${id}" type="number" inputmode="numeric" data-testid="svc-sla-${id}" value="${v.sla}"></div>
  </div><button type="button" data-testid="svc-save-${id}" data-svc="${id}">บันทึก ${id}</button></section>`);
  render(ctx, 'จัดการบริการ', `<h1>ค่าธรรมเนียมและ SLA</h1><p class="hint">ค่าที่แก้มีผลกับคำขอที่เข้าสถานะรอชำระเงินหลังแก้ไขเท่านั้น</p>${cards.join('')}`, 200, { page: 'admin-services' });
}
function adminHolidays(ctx) {
  const rows = D.holidaysSorted().map(h => `<tr data-testid="holiday-row" data-date="${h.date}"><td>${h.date} (${thDate(h.date, false)})</td><td>${esc(h.name)}</td>
    <td><button type="button" class="small danger" data-testid="holiday-delete-btn" data-date="${h.date}">ลบ ${h.date}</button></td></tr>`);
  render(ctx, 'วันหยุด', `<h1>วันหยุด</h1>
<form id="holiday-form" class="card filters" novalidate>
  <label for="hd">วันที่ (ค.ศ.)</label><input id="hd" type="date" data-testid="holiday-date-input">
  <label for="hn">ชื่อวันหยุด</label><input id="hn" data-testid="holiday-name-input">
  <button type="submit" data-testid="holiday-add-btn">เพิ่มวันหยุด</button>
</form>
${table('ตารางวันหยุด', ['วันที่', 'ชื่อ', ''], rows)}`, 200, { page: 'admin-holidays' });
}
function adminUsers(ctx) {
  const rows = S().staff.map(u => `<tr data-testid="user-row" data-username="${u.username}"><td>${u.username}<br><span class="hint">${esc(u.name)}</span></td>
    <td><label class="sr" for="role-${u.username}">บทบาทของ ${u.username}</label><select id="role-${u.username}" data-testid="user-role-select">${D.ROLES.map(r => option(r, `${r} · ${C.ROLE_TH[r]}`, u.role)).join('')}</select></td>
    <td><label class="sr" for="dept-${u.username}">แผนกของ ${u.username}</label><select id="dept-${u.username}" data-testid="user-dept-select">${Object.entries(D.DEPTS).map(([v, l]) => option(v, l, u.dept)).join('')}</select></td>
    <td><button type="button" class="small" data-testid="user-save-btn" data-user="${u.username}">บันทึก ${u.username}</button></td></tr>`);
  render(ctx, 'ผู้ใช้และบทบาท', `<h1>ผู้ใช้และบทบาท</h1><p class="hint">การเปลี่ยนบทบาทมีผลเมื่อผู้ใช้ล็อกอินครั้งถัดไป</p>${table('ตารางผู้ใช้', ['ผู้ใช้', 'บทบาท', 'แผนก', ''], rows)}`, 200, { page: 'admin-users' });
}

// ---------------------------------------------------------------- verify (public)
function verifyPage(ctx, code) {
  const d = S().docs.find(x => x.verifyCode === code);
  const TXT = { VALID: 'เอกสารถูกต้อง', EXPIRED: 'เอกสารหมดอายุ', TAMPERED: 'ลายเซ็นไม่ถูกต้อง', NOT_FOUND: 'ไม่พบเอกสาร' };
  const result = d ? C.verifyResult(d) : 'NOT_FOUND';
  let body = `<h1>ตรวจสอบเอกสารดิจิทัล</h1><p class="result r-${result}" data-testid="verify-result" data-result="${result}">${TXT[result]}</p>`;
  if (result === 'VALID' || result === 'EXPIRED') {
    body += `<dl class="kv"><dt>เลขเอกสาร</dt><dd data-testid="verify-doc-no">${d.docNo}</dd>
    <dt>ผู้ยื่น</dt><dd data-testid="verify-applicant">${esc(C.maskName(d.applicant))}</dd>
    <dt>บริการ</dt><dd data-testid="verify-service">${svcLabel(d.serviceId)}</dd>
    <dt>วันที่ออก</dt><dd><time data-testid="verify-issued" data-iso="${d.issuedAt}" datetime="${d.issuedAt}">${thDate(d.issuedAt)}</time></dd>
    <dt>ใช้ได้ถึง</dt><dd><time data-testid="verify-expires" data-iso="${d.validUntil}" datetime="${d.validUntil}">${thDate(d.validUntil, false)}</time></dd>
    <dt>ผู้ลงนาม</dt><dd data-testid="verify-signer">${esc(d.signer)}</dd></dl>`;
  }
  render(ctx, 'ตรวจสอบเอกสาร', body, result === 'NOT_FOUND' ? 404 : 200);
}

// ---------------------------------------------------------------- router
const ROUTES = [
  [/^\/citizen$/, ['citizen'], citizenHome], [/^\/citizen\/new\/([^/]+)$/, ['citizen'], wizardPage],
  [/^\/citizen\/cases\/([^/]+)$/, ['citizen'], citizenCase], [/^\/officer\/queue$/, ['officer', 'head'], queuePage],
  [/^\/officer\/cases\/([^/]+)$/, ['officer', 'head'], officerCase], [/^\/head\/approvals$/, ['head'], approvalsPage],
  [/^\/dashboard$/, ['executive'], dashboardPage], [/^\/audit$/, ['auditor'], auditPage],
  [/^\/admin\/services$/, ['admin'], adminServices], [/^\/admin\/holidays$/, ['admin'], adminHolidays],
  [/^\/admin\/users$/, ['admin'], adminUsers], [/^\/notifications$/, ['officer', 'head'], notificationsPage],
];
function page(ctx) {
  const p = ctx.path, s = ctx.session;
  if (p === '/') return redirect(ctx, !s ? '/login' : s.registered ? C.LANDING[s.role] : '/register');
  if (p === '/login') return loginPage(ctx);
  if (p === '/register') return registerPage(ctx);
  const v = /^\/verify\/([^/]+)$/.exec(p);
  if (v) return verifyPage(ctx, v[1]);
  for (const [re, roles, fn] of ROUTES) {
    const m = re.exec(p);
    if (!m) continue;
    if (!s) return redirect(ctx, '/login');
    if (!s.registered) return redirect(ctx, '/register');
    if (!roles.includes(s.role)) return forbidden(ctx);
    return fn(ctx, s, ...m.slice(1));
  }
  render(ctx, 'ไม่พบหน้า', '<h1>ไม่พบหน้านี้</h1>', 404);
}

module.exports = { page };
