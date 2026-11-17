'use strict';
/**
 * B10 · หน้าเว็บเจ้าหน้าที่ / หัวหน้า / ผู้บริหาร / ผู้ตรวจสอบ / ผู้ดูแลระบบ
 *
 *   GET /officer/queue            officer · head(อ่านอย่างเดียว)   CONTRACT §2.7
 *   GET /officer/cases/:caseNo    officer · head                   CONTRACT §2.6 (ปุ่มตาม workflow.availableActions)
 *   GET /head/approvals           head                             CONTRACT §2.8
 *   GET /dashboard                executive                        CONTRACT §2.9
 *   GET /audit                    auditor                          CONTRACT §2.10 (ไม่มีปุ่มแก้/ลบ)
 *   GET /admin/services|holidays|users   admin                     CONTRACT §2.11
 *   GET /notifications            officer · head                   CONTRACT §2.12
 *   GET /static/staff.js · /static/staff.css   สคริปต์/สไตล์ของหน้าเหล่านี้ (เสิร์ฟจากไฟล์นี้ ไม่มีไฟล์ใน public/)
 *
 * หลักการ
 *   - หน้า render ฝั่งเซิร์ฟเวอร์ทั้งหมด (ตัว render มีชุดเดียว) · ปุ่มเรียก API ผ่าน Egov.api() แล้ว
 *     ดึง HTML หน้าเดิมมาแทนเฉพาะกล่อง [data-region] (ไม่ navigate → ช่องกรอง/ข้อความแจ้งผลไม่หาย ไม่มี race กับ test)
 *   - ปุ่มที่ "ต้องไม่มี" = ไม่ render (CONTRACT §0.5) · ข้อความ error มาจาก API ({code,message} ตรงตัว CONTRACT §5)
 *   - action-error / action-success มีอย่างละ 1 ตัวต่อหน้า (อยู่นอก region) · ซ่อนทันทีเมื่อกดปุ่มใหม่ แล้วแสดงหลัง region อัปเดตเสร็จ
 *   - PDPA: หน้าเจ้าหน้าที่แสดงเลขบัตรแบบปิดบังเท่านั้น (X-XXXX-XXXXX-65-9) · เลขเต็มได้เฉพาะหลัง unmask (API ของ B05) ในหน้านั้น
 *   - ใช้ฟังก์ชันของ B06/B07/B08 แบบ lazy require · ถ้า workflow.js ยังไม่มี ใช้ตัวอ่าน DB สำรองในไฟล์นี้ (อ่านอย่างเดียว)
 *   - WCAG: ทุกช่องมี <label for> · สถานะ/ระดับมีข้อความเสมอ · ตารางเลื่อนในกล่องของตัวเอง (หน้าไม่ scroll แนวนอน)
 */

const QRCode = require('qrcode');
const { db } = require('../db');
const clock = require('../clock');
const crypto = require('../crypto');
const { esc, timeTag, thaiDateTime, thaiDate, baht, maskId } = require('../format');
const C = require('../constants');
const { baseUrl } = require('../http');
const { requirePage } = require('../session');
const layout = require('./layout');

const ASSETS = { scripts: ['/static/staff.js'], styles: ['/static/staff.css'] };
const QUEUE_FILTERS = [
  ['all', 'ทั้งหมด'],
  ['unclaimed', 'ยังไม่มีผู้รับ'],
  ['mine', 'ของฉัน'],
];
const AUDIT_EVENT_LABEL = {
  STAFF_LOGIN: 'เข้าสู่ระบบเจ้าหน้าที่',
  CLAIM: 'รับเรื่อง',
  RETURN: 'ตีกลับ',
  FORWARD: 'ผ่าน/ส่งต่อ',
  APPROVE: 'อนุมัติ',
  REJECT: 'ไม่อนุมัติ',
  ISSUE: 'ออกเอกสาร',
  UNMASK: 'แสดงเลขบัตรเต็ม',
  EXPORT: 'ส่งออกข้อมูล',
  ADMIN_CHANGE: 'แก้ไขการตั้งค่า',
};
const EVENT_TEXT = {
  CREATED: 'สร้างคำขอ',
  PAID: 'ชำระค่าธรรมเนียมแล้ว ส่งคำขอ',
  CLAIM: 'รับเรื่อง',
  RETURN: 'ตีกลับให้แก้ไขเอกสาร',
  RESUBMIT: 'ผู้ยื่นส่งแก้ไขแล้ว',
  FORWARD: 'ผ่าน/ส่งต่อ',
  APPROVE: 'อนุมัติ',
  REJECT: 'ไม่อนุมัติ',
  ISSUE: 'ออกเอกสาร',
  CANCEL: 'ผู้ยื่นยกเลิกคำขอ',
  AUTO_CANCEL: 'ยกเลิกอัตโนมัติ (ไม่ส่งแก้ไขภายใน 168 ชั่วโมง)',
};

// ---------------------------------------------------------------------------
// lazy require ของบล็อกอื่น (ไฟล์ยังไม่มี → null · error อื่นโยนต่อ)
// ---------------------------------------------------------------------------

function optional(rel) {
  try {
    return require(rel);
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(`'${rel}'`)) return null;
    throw e;
  }
}

/** ฟังก์ชันจาก workflow.js (B06) ถ้ามี ไม่งั้นใช้ตัวสำรองในไฟล์นี้ */
function wf(name) {
  const m = optional('../modules/workflow');
  return m && typeof m[name] === 'function' ? m[name] : FB[name];
}

function q1(v) {
  if (Array.isArray(v)) v = v[0];
  return v === undefined || v === null ? '' : String(v).trim();
}

// ---------------------------------------------------------------------------
// ตัวอ่าน DB สำรอง (ใช้เฉพาะเมื่อ workflow.js ของ B06 ยังไม่มี) — ตามนิยาม A-34 · BR-16 · DECISIONS §18
// ---------------------------------------------------------------------------

function maskedIdOf(idEnc) {
  try {
    return maskId(crypto.decrypt(idEnc));
  } catch (e) {
    return 'X-XXXX-XXXXX-XX-X';
  }
}

function levelOf(row, nowIso) {
  const sla = optional('../sla');
  if (sla && typeof sla.slaLevel === 'function') return sla.slaLevel(row, nowIso);
  if (!row.case_no) return null;
  if (C.FINAL_STATUSES.includes(row.status)) return 'closed';
  if (row.status === 'NEED_FIX') return 'paused';
  if (row.due_at && clock.toMs(nowIso) > clock.toMs(row.due_at)) return 'overdue';
  return 'normal';
}

const FB = {
  queueRows(user, filter = 'all') {
    const now = clock.nowIso();
    const where = ["c.case_no IS NOT NULL", "c.status IN ('SUBMITTED','IN_REVIEW','APPROVED')"];
    const params = [];
    if (user.role === 'officer') {
      where.push('c.dept = ?');
      params.push(user.dept || '');
    }
    if (filter === 'unclaimed') where.push("c.status IN ('SUBMITTED','IN_REVIEW') AND (c.owner IS NULL OR c.owner = '')");
    if (filter === 'mine') {
      where.push("c.status = 'IN_REVIEW' AND c.owner = ?");
      params.push(user.username);
    }
    return db
      .prepare(
        `SELECT c.*, u.name AS applicant_name, u.id_enc AS applicant_id_enc
           FROM cases c JOIN users u ON u.id = c.applicant_id
          WHERE ${where.join(' AND ')} ORDER BY c.due_at, c.case_no`
      )
      .all(...params)
      .map((r) => ({
        caseNo: r.case_no,
        serviceId: r.service_id,
        applicantName: r.applicant_name,
        idMasked: maskedIdOf(r.applicant_id_enc),
        status: r.status,
        step: r.service_id === 'SV-03' ? r.step : null,
        owner: r.status === 'APPROVED' ? null : r.owner || null,
        dueAt: r.due_at,
        slaLevel: levelOf(r, now),
      }));
  },
  approvalRows() {
    const now = clock.nowIso();
    return db
      .prepare(
        `SELECT c.*, u.name AS applicant_name FROM cases c JOIN users u ON u.id = c.applicant_id
          WHERE c.status = 'PENDING_APPROVAL' AND c.case_no IS NOT NULL ORDER BY c.due_at, c.case_no`
      )
      .all()
      .map((r) => ({ caseNo: r.case_no, serviceId: r.service_id, applicantName: r.applicant_name, dueAt: r.due_at, slaLevel: levelOf(r, now) }));
  },
  workloadOf(username) {
    return db.prepare("SELECT COUNT(*) AS n FROM cases WHERE status = 'IN_REVIEW' AND owner = ?").get(username).n;
  },
  availableActions(user, c) {
    const officer = user.role === 'officer';
    const head = user.role === 'head';
    const mine = officer && !!c.owner && c.owner === user.username && c.status === 'IN_REVIEW';
    const sv01 = c.service_id === 'SV-01';
    return {
      claim: officer && !c.owner && ['SUBMITTED', 'IN_REVIEW'].includes(c.status) && c.dept === user.dept,
      return: mine && (c.return_count || 0) < C.LIMITS.MAX_RETURNS,
      forward: mine && !sv01,
      approve: (mine && sv01) || (head && !sv01 && c.status === 'PENDING_APPROVAL'),
      reject: (mine && sv01) || (head && !sv01 && c.status === 'PENDING_APPROVAL'),
      issue: officer && c.status === 'APPROVED' && c.issuer === user.username,
      unmask: officer || head,
    };
  },
  fileAccess(user, c) {
    if (user.role === 'head') return 'ok';
    if (user.role !== 'officer') return 'forbidden';
    if (user.dept === 'registry') return 'ok';
    if (user.dept === 'works' && c.service_id === 'SV-03' && Number(c.step) >= 2) return 'ok';
    return 'forbidden';
  },
  caseFiles(caseId) {
    return db
      .prepare('SELECT id AS fileId, name, doc_key AS docKey, size FROM case_files WHERE case_id = ? ORDER BY created_at, rowid')
      .all(caseId);
  },
  timeline(caseId) {
    return db
      .prepare('SELECT * FROM case_events WHERE case_id = ? ORDER BY at, id')
      .all(caseId)
      .map((e) => ({
        at: e.at,
        actor: e.actor,
        event: e.event,
        fromStatus: e.from_status,
        toStatus: e.to_status,
        note: e.note,
        text: (EVENT_TEXT[e.event] || e.event) + (e.note ? `: ${e.note}` : ''),
      }));
  },
  documentForCase(caseId) {
    const d = db.prepare('SELECT * FROM documents WHERE case_id = ? ORDER BY issued_at DESC LIMIT 1').get(caseId);
    return d ? { docNo: d.doc_no, verifyCode: d.verify_code, issuedAt: d.issued_at, validUntil: d.valid_until, signer: d.signer } : null;
  },
};

// ---------------------------------------------------------------------------
// ชิ้นส่วน HTML
// ---------------------------------------------------------------------------

const serviceText = (id) => (C.SERVICES[id] ? `${id} ${C.SERVICES[id].name}` : String(id || ''));

function statusChip(testid, status) {
  const t = testid ? ` data-testid="${testid}"` : '';
  return `<span class="chip"${t} data-status="${esc(status)}">${esc(C.STATUS_LABEL[status] || status || '–')}</span>`;
}

function levelChip(testid, level) {
  const t = testid ? ` data-testid="${testid}"` : '';
  if (!level) return `<span class="chip"${t} data-level="">–</span>`;
  return `<span class="chip"${t} data-level="${esc(level)}">${esc(C.SLA_LEVEL_LABEL[level] || level)}</span>`;
}

/** เวลาไม่มี testid (data-iso ด้วยตาม CONTRACT §0.3) */
function timeEl(iso, text) {
  if (!iso) return '–';
  return `<time datetime="${esc(iso)}" data-iso="${esc(iso)}">${esc(text === undefined ? thaiDateTime(iso) : text)}</time>`;
}

/** กล่องข้อความผลการกระทำ (1 ตัวต่อหน้า · CONTRACT §2.1) */
function messages() {
  return `<div class="msgs">
  <div class="alert alert-error" data-testid="action-error" role="alert" tabindex="-1" hidden></div>
  <div class="alert alert-ok" data-testid="action-success" role="status" tabindex="-1" hidden></div>
</div>`;
}

function tableWrap(label, inner) {
  return `<div class="table-wrap" role="region" aria-label="${esc(label)}" tabindex="0">${inner}</div>`;
}

function kv(label, valueHtml) {
  return `<div><dt>${esc(label)}</dt><dd>${valueHtml}</dd></div>`;
}

function send(req, res, title, body, status) {
  layout.sendPage(req, res, { title, body, status, ...ASSETS });
}

// ---------------------------------------------------------------------------
// /officer/queue
// ---------------------------------------------------------------------------

function queueRegion(user, filter) {
  const rows = wf('queueRows')(user, filter) || [];
  const officer = user.role === 'officer';
  const body = rows
    .map((r) => {
      const owner = r.status === 'APPROVED' ? '' : r.owner || '';
      const canClaim = officer && !owner && (r.status === 'SUBMITTED' || r.status === 'IN_REVIEW');
      return `<tr data-testid="queue-row" data-case-no="${esc(r.caseNo)}" data-owner="${esc(owner)}" data-status="${esc(r.status)}" data-sla-level="${esc(r.slaLevel || '')}">
  <td data-testid="row-case-no"><a href="/officer/cases/${encodeURIComponent(r.caseNo)}">${esc(r.caseNo)}</a></td>
  <td data-testid="row-service">${esc(serviceText(r.serviceId))}</td>
  <td data-testid="row-applicant">${esc(r.applicantName)}</td>
  <td data-testid="row-id-masked" class="nowrap">${esc(r.idMasked)}</td>
  <td>${statusChip('row-status', r.status)}</td>
  <td>${timeTag('row-due', r.dueAt)}</td>
  <td>${levelChip('row-sla-level', r.slaLevel)}</td>
  <td data-testid="row-owner">${esc(owner)}</td>
  <td>${canClaim ? `<button type="button" class="btn-sm" data-testid="claim-btn" data-act="claim" data-case-no="${esc(r.caseNo)}">รับเรื่อง</button>` : ''}</td>
</tr>`;
    })
    .join('\n');
  const workload = officer
    ? `<p class="workload">งานในมือของฉัน (กำลังตรวจสอบ): <strong data-testid="workload-count">${esc(wf('workloadOf')(user.username))}</strong> เรื่อง · รับได้สูงสุด ${C.LIMITS.MAX_WORKLOAD} เรื่อง</p>`
    : '';
  const table = `<table data-testid="queue-table">
<caption class="visually-hidden">คิวงาน เรียงตามกำหนดเสร็จเร็วสุดก่อน</caption>
<thead><tr><th scope="col">เลขคำขอ</th><th scope="col">บริการ</th><th scope="col">ผู้ยื่น</th><th scope="col">เลขบัตร (ปิดบัง)</th><th scope="col">สถานะ</th><th scope="col">กำหนดเสร็จ</th><th scope="col">ระดับเตือน</th><th scope="col">ผู้ถือเรื่อง</th><th scope="col">ดำเนินการ</th></tr></thead>
<tbody>
${body}
</tbody>
</table>`;
  return `<div id="queue-region" data-region>
${workload}
${tableWrap('ตารางคิวงาน', table)}
${rows.length ? '' : '<p class="empty" data-testid="queue-empty">ไม่มีงานในคิว</p>'}
<p class="muted small">แสดง ${rows.length} รายการ</p>
</div>`;
}

function queuePage(req, res) {
  const user = req.user;
  const f = q1(req.query.filter);
  const filter = QUEUE_FILTERS.some(([v]) => v === f) ? f : 'all';
  const scope =
    user.role === 'head'
      ? 'ทุกแผนก (อ่านอย่างเดียว)'
      : C.DEPT_LABEL[user.dept] || 'แผนกของฉัน';
  const opts = QUEUE_FILTERS.map(([v, t]) => `<option value="${v}"${v === filter ? ' selected' : ''}>${t}</option>`).join('');
  const body = `<h1>คิวงาน <span class="sub">· ${esc(scope)}</span></h1>
${messages()}
<form class="filters" method="get" action="/officer/queue" data-form="queue">
  <div class="field">
    <label for="queue-filter">ตัวกรองคิว</label>
    <select id="queue-filter" name="filter" data-testid="queue-filter" data-change="queue">${opts}</select>
  </div>
  <noscript><button type="submit">แสดง</button></noscript>
</form>
${queueRegion(user, filter)}`;
  send(req, res, 'คิวงาน', body);
}

// ---------------------------------------------------------------------------
// /officer/cases/:caseNo
// ---------------------------------------------------------------------------

async function qrSvg(url) {
  try {
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return svg.replace('<svg ', '<svg aria-hidden="true" focusable="false" width="168" height="168" ');
  } catch (e) {
    return '';
  }
}

function actorLabel(a) {
  if (!a) return '';
  if (a === 'citizen') return 'ผู้ยื่น';
  if (a === 'system') return 'ระบบ';
  return a;
}

function actionsSection(c, act) {
  const no = esc(c.case_no);
  const parts = [];
  const buttons = [];
  if (act.claim) buttons.push(`<button type="button" data-testid="claim-btn" data-act="claim" data-case-no="${no}">รับเรื่อง</button>`);
  if (act.approve) buttons.push(`<button type="button" data-testid="approve-btn" data-act="approve" data-case-no="${no}">อนุมัติ</button>`);
  if (act.issue) buttons.push(`<button type="button" data-testid="issue-btn" data-act="issue" data-case-no="${no}">ออกเอกสาร</button>`);
  if (act.return)
    buttons.push(
      `<button type="button" class="btn-secondary" data-testid="return-btn" data-act="open" aria-controls="return-panel" aria-expanded="false">ตีกลับ</button>`
    );
  if (act.reject)
    buttons.push(
      `<button type="button" class="btn-danger" data-testid="reject-btn" data-act="open" aria-controls="reject-panel" aria-expanded="false">ไม่อนุมัติ</button>`
    );
  if (buttons.length) parts.push(`<div class="row actions-row">${buttons.join('\n')}</div>`);

  if (act.forward) {
    parts.push(`<form class="panel" data-form="forward" data-case-no="${no}" novalidate>
  <label for="forward-note">หมายเหตุส่งต่อ (ไม่บังคับ)</label>
  <textarea id="forward-note" name="note" data-testid="forward-note" rows="2" maxlength="500"></textarea>
  <p class="muted small">ระบบส่งต่อไปขั้นถัดไปตามเส้นทางของบริการโดยอัตโนมัติ</p>
  <button type="submit" data-testid="forward-btn">ผ่าน/ส่งต่อ</button>
</form>`);
  }
  if (act.return) {
    parts.push(`<form class="panel" id="return-panel" data-form="return" data-case-no="${no}" novalidate hidden>
  <label for="return-reason">เหตุผลที่ตีกลับ (อย่างน้อย ${C.LIMITS.REASON_MIN} ตัวอักษร)</label>
  <textarea id="return-reason" name="reason" data-testid="return-reason" rows="3" maxlength="500" aria-describedby="return-reason-error"></textarea>
  <p class="field-error" id="return-reason-error" data-testid="return-reason-error" role="alert" hidden></p>
  <p class="muted small">ตีกลับแล้ว ${esc(c.return_count || 0)} จาก ${C.LIMITS.MAX_RETURNS} ครั้ง · ผู้ยื่นมีเวลาแก้ไข 168 ชั่วโมง</p>
  <button type="submit" data-testid="return-submit">ยืนยันตีกลับ</button>
</form>`);
  }
  if (act.reject) {
    parts.push(`<form class="panel" id="reject-panel" data-form="reject" data-case-no="${no}" novalidate hidden>
  <label for="reject-reason">เหตุผลที่ไม่อนุมัติ (อย่างน้อย ${C.LIMITS.REASON_MIN} ตัวอักษร)</label>
  <textarea id="reject-reason" name="reason" data-testid="reject-reason" rows="3" maxlength="500" aria-describedby="reject-reason-error"></textarea>
  <p class="field-error" id="reject-reason-error" data-testid="reject-reason-error" role="alert" hidden></p>
  <button type="submit" class="btn-danger" data-testid="reject-submit">ยืนยันไม่อนุมัติ</button>
</form>`);
  }
  if (!parts.length) parts.push('<p class="muted">ไม่มีรายการที่คุณดำเนินการได้ในสถานะนี้</p>');
  return `<section class="card" aria-labelledby="h-actions"><h2 id="h-actions">ดำเนินการ</h2>
${parts.join('\n')}
</section>`;
}

async function casePage(req, res) {
  const user = req.user;
  const caseNo = q1(req.params.caseNo);
  const c = caseNo ? db.prepare('SELECT * FROM cases WHERE case_no = ?').get(caseNo) : null;
  if (!c) return layout.notFoundPage(req, res);
  const applicant = db.prepare('SELECT name, id_enc FROM users WHERE id = ?').get(c.applicant_id) || {};
  const now = clock.nowIso();
  const level = levelOf(c, now);
  const act = wf('availableActions')(user, c) || {};
  const svc = C.SERVICES[c.service_id];
  const no = esc(c.case_no);

  // ---- ข้อมูลคำขอ ----
  const info = [];
  info.push(kv('สถานะ', statusChip('case-status', c.status)));
  info.push(kv('บริการ', `<span data-testid="case-service">${esc(serviceText(c.service_id))}</span>`));
  if (c.service_id === 'SV-03' && C.SV03_STEP_LABEL[c.step]) {
    info.push(kv('ขั้นตอน', `<span data-testid="case-step">${esc(C.SV03_STEP_LABEL[c.step])}</span>`));
  }
  let feeNote = '';
  if (c.service_id === 'SV-01' && c.qty) feeNote = ` <span class="muted">(${esc(c.qty)} ฉบับ)</span>`;
  if (c.service_id === 'SV-03' && c.area_sqm) feeNote = ` <span class="muted">(พื้นที่ ${esc(c.area_sqm)} ตร.ม.)</span>`;
  info.push(kv('ค่าธรรมเนียม', `<span data-testid="case-fee">${esc(baht(c.fee))}</span>${feeNote}`));
  info.push(kv('ผู้ยื่น', `<span data-testid="applicant-name">${esc(applicant.name || '')}</span>`));
  const unmask = act.unmask
    ? ` <button type="button" class="btn-sm btn-secondary" data-testid="show-full-id-btn" data-act="open" aria-controls="unmask-panel" aria-expanded="false">แสดงเลขเต็ม</button>
<form class="panel" id="unmask-panel" data-form="unmask" data-case-no="${no}" novalidate hidden>
  <label for="unmask-reason">เหตุผลที่ต้องดูเลขบัตรเต็ม (บันทึกใน Audit)</label>
  <input type="text" id="unmask-reason" name="reason" data-testid="unmask-reason" maxlength="500" autocomplete="off" aria-describedby="unmask-error">
  <p class="field-error" id="unmask-error" data-testid="unmask-error" role="alert" hidden></p>
  <button type="submit" data-testid="unmask-submit">ยืนยันแสดงเลขเต็ม</button>
</form>
<div id="full-id-slot"></div>`
    : '';
  info.push(kv('เลขบัตรประชาชน', `<span data-testid="applicant-id" class="nowrap">${esc(maskedIdOf(applicant.id_enc))}</span>${unmask}`));
  info.push(kv('ยื่น/ชำระเมื่อ', timeEl(c.paid_at)));
  info.push(kv('กำหนดเสร็จ', timeTag('sla-due', c.due_at)));
  info.push(kv('ระดับเตือน', levelChip('sla-level', level)));
  if (c.status === 'COMPLETED' || c.status === 'REJECTED') info.push(kv('ปิดงานเมื่อ', timeTag('closed-at', c.closed_at)));
  if (c.status === 'CANCELLED') info.push(kv('ยกเลิกเมื่อ', timeEl(c.cancelled_at)));
  info.push(kv('ผู้ถือเรื่อง', `<span data-testid="case-owner">${esc(c.owner || 'ยังไม่มีผู้รับ')}</span>`));
  info.push(kv('ตีกลับแล้ว', `<span data-testid="return-count">${esc(c.return_count || 0)}</span> <span class="muted">จากสูงสุด ${C.LIMITS.MAX_RETURNS} ครั้ง</span>`));
  if (c.status === 'NEED_FIX') {
    if (c.return_reason) info.push(kv('เหตุผลที่ตีกลับล่าสุด', esc(c.return_reason)));
    info.push(kv('เส้นตายให้ผู้ยื่นแก้ไข', timeEl(c.fix_deadline)));
  }
  if (c.status === 'REJECTED' && c.reject_reason) info.push(kv('เหตุผลที่ไม่อนุมัติ', esc(c.reject_reason)));
  if ((c.status === 'APPROVED' || c.status === 'COMPLETED') && c.approver) info.push(kv('ผู้อนุมัติ', esc(c.approver)));
  if (c.status === 'APPROVED' && c.issuer) info.push(kv('ผู้ออกเอกสาร', esc(c.issuer)));

  // ---- เอกสารดิจิทัล ----
  let docHtml = '';
  const doc = wf('documentForCase')(c.id);
  if (doc) {
    const url = `${baseUrl(req)}/verify/${doc.verifyCode}`;
    const svg = await qrSvg(url);
    docHtml = `<section class="card" aria-labelledby="h-doc"><h2 id="h-doc">เอกสารดิจิทัล</h2>
<div class="doc-grid">
  <dl class="kv">
    ${kv('เลขเอกสาร', `<span data-testid="doc-no">${esc(doc.docNo)}</span>`)}
    ${kv('รหัสตรวจสอบ', `<span data-testid="verify-code" class="mono">${esc(doc.verifyCode)}</span>`)}
    ${kv('ออกเมื่อ', timeEl(doc.issuedAt))}
    ${kv('ใช้ได้ถึง', timeEl(doc.validUntil, thaiDate(doc.validUntil)))}
    ${kv('ผู้ลงนาม', esc(doc.signer || ''))}
  </dl>
  <div class="qr" data-testid="doc-qr" data-url="${esc(url)}" role="img" aria-label="QR สำหรับตรวจสอบเอกสาร ${esc(doc.docNo)}">${svg}</div>
</div>
<p class="row"><a href="/verify/${encodeURIComponent(doc.verifyCode)}">เปิดหน้าตรวจสอบเอกสาร</a> <a href="/api/documents/${encodeURIComponent(doc.docNo)}/pdf" download>ดาวน์โหลดเอกสาร PDF</a></p>
</section>`;
  }

  // ---- เอกสารแนบ ----
  let filesHtml;
  const access = wf('fileAccess')(user, c);
  if (access === 'ok') {
    const files = wf('caseFiles')(c.id) || [];
    filesHtml = files.length
      ? `<ul class="doc-list">${files
          .map(
            (f) => `<li data-testid="doc-item" data-name="${esc(f.name)}" data-file-id="${esc(f.fileId)}">
  <span class="doc-kind">${esc(C.DOC_LABEL[f.docKey] || f.docKey || '')}</span>
  <a data-testid="doc-download-link" href="/api/files/${encodeURIComponent(f.fileId)}" target="_blank" rel="noopener">${esc(f.name)}</a>
  <span class="muted small">${esc(Math.max(1, Math.round((Number(f.size) || 0) / 1024)).toLocaleString('en-US'))} KB</span>
</li>`
          )
          .join('\n')}</ul>`
      : '<p class="muted">ไม่มีไฟล์แนบ</p>';
  } else {
    filesHtml = '<p class="muted">เอกสารแนบของคำขอนี้อยู่นอกขอบเขตแผนกของคุณ (ดูได้เมื่อคำขออยู่หรือเคยผ่านแผนกของคุณ)</p>';
  }

  // ---- ไทม์ไลน์ ----
  const tl = wf('timeline')(c.id) || [];
  const timelineHtml = `<ol class="timeline" data-testid="case-timeline">
${tl
  .map((e) => {
    const who = actorLabel(e.actor);
    return `<li data-testid="timeline-item" data-iso="${esc(e.at)}" data-event="${esc(e.event || '')}">${timeEl(e.at)} <span class="tl-text">${esc(e.text || EVENT_TEXT[e.event] || e.event || '')}</span>${who ? ` <span class="muted small">โดย ${esc(who)}</span>` : ''}</li>`;
  })
  .join('\n')}
</ol>`;

  const back =
    user.role === 'head'
      ? '<a href="/head/approvals">รายการรออนุมัติ</a> <a href="/officer/queue">คิวงาน</a>'
      : '<a href="/officer/queue">กลับไปคิวงาน</a>';

  const body = `<p class="row back">${back}</p>
${messages()}
<div id="case-region" data-region>
<h1>คำขอ <span data-testid="case-no">${no}</span></h1>
<section class="card" aria-labelledby="h-info"><h2 id="h-info">ข้อมูลคำขอ${svc ? ` · ${esc(svc.name)}` : ''}</h2>
<dl class="kv">
${info.join('\n')}
</dl>
</section>
${actionsSection(c, act)}
${docHtml}
<section class="card" aria-labelledby="h-files"><h2 id="h-files">เอกสารแนบ</h2>
${filesHtml}
</section>
<section class="card" aria-labelledby="h-tl"><h2 id="h-tl">ไทม์ไลน์</h2>
${timelineHtml}
</section>
</div>`;
  send(req, res, `คำขอ ${c.case_no}`, body);
}

// ---------------------------------------------------------------------------
// /head/approvals
// ---------------------------------------------------------------------------

function approvalsPage(req, res) {
  const rows = wf('approvalRows')() || [];
  const tbody = rows
    .map(
      (r) => `<tr data-testid="approval-row" data-case-no="${esc(r.caseNo)}">
  <td data-testid="row-case-no">${esc(r.caseNo)}</td>
  <td data-testid="row-service">${esc(serviceText(r.serviceId))}</td>
  <td data-testid="row-applicant">${esc(r.applicantName)}</td>
  <td>${timeTag('row-due', r.dueAt)}</td>
  <td>${levelChip('row-sla-level', r.slaLevel)}</td>
  <td><a class="btn btn-sm" data-testid="approval-open" href="/officer/cases/${encodeURIComponent(r.caseNo)}">เปิดคำขอ</a></td>
</tr>`
    )
    .join('\n');
  const table = `<table data-testid="approval-table">
<caption class="visually-hidden">คำขอรออนุมัติ เรียงตามกำหนดเสร็จเร็วสุดก่อน</caption>
<thead><tr><th scope="col">เลขคำขอ</th><th scope="col">บริการ</th><th scope="col">ผู้ยื่น</th><th scope="col">กำหนดเสร็จ</th><th scope="col">ระดับเตือน</th><th scope="col">ดำเนินการ</th></tr></thead>
<tbody>
${tbody}
</tbody>
</table>`;
  const body = `<h1>รายการรออนุมัติ</h1>
<p class="muted">คำขอ SV-02 / SV-03 ที่ผ่านแผนกแล้ว (สถานะรออนุมัติ) · เปิดคำขอเพื่ออนุมัติหรือไม่อนุมัติ</p>
${tableWrap('ตารางรายการรออนุมัติ', table)}
${rows.length ? '' : '<p class="empty" data-testid="approval-empty">ไม่มีรายการรออนุมัติ</p>'}`;
  send(req, res, 'รายการรออนุมัติ', body);
}

// ---------------------------------------------------------------------------
// /dashboard
// ---------------------------------------------------------------------------

function exportHref(format, f) {
  return `/api/dashboard/export?format=${format}&period=${encodeURIComponent(f.period)}&service=${encodeURIComponent(f.service)}`;
}

function dashboardPage(req, res) {
  const dash = optional('../modules/dashboard');
  if (!dash) return layout.errorPage(req, res, 503, 'ระบบ Dashboard ยังไม่พร้อมใช้งาน');
  const now = clock.nowIso();
  const want = { period: q1(req.query.period), service: q1(req.query.service) };
  let d;
  let notice = '';
  try {
    d = dash.computeDashboard(want, now);
  } catch (e) {
    d = dash.computeDashboard({}, now);
    notice = '<p class="alert alert-warn">ตัวกรองไม่ถูกต้อง แสดงค่าเริ่มต้นแทน</p>';
  }
  const f = { period: d.period, service: d.service };
  const periods = dash.periodOptions(now, f.period);
  const services = typeof dash.serviceOptions === 'function'
    ? dash.serviceOptions()
    : [{ value: 'ALL', label: 'ทุกบริการ' }].concat(C.SERVICE_IDS.map((id) => ({ value: id, label: serviceText(id) })));
  const opt = (list, cur) =>
    list.map((o) => `<option value="${esc(o.value)}"${o.value === cur ? ' selected' : ''}>${esc(o.label)}</option>`).join('');

  const kpis = [
    ['kpi-received', 'รับเรื่อง', d.received, 'คำขอที่ชำระในช่วงที่เลือก'],
    ['kpi-closed', 'ปิดงาน', d.closed, 'เสร็จสิ้น + ไม่อนุมัติ ในช่วงที่เลือก'],
    ['kpi-ontime-pct', 'ทันกำหนด %', d.ontimeText, 'ปิดงานทันกำหนด ÷ ปิดงาน'],
    ['kpi-backlog', 'งานคงค้าง', d.backlog, 'ณ ตอนนี้'],
    ['kpi-overdue', 'เกินกำหนดคงค้าง', d.overdue, 'ณ ตอนนี้'],
  ];
  const kpiHtml = kpis
    .map(
      ([tid, label, value, hint], i) => `<li class="kpi">
  <span class="label" id="kpi-label-${i}">${esc(label)}</span>
  <span class="value" data-testid="${tid}" aria-describedby="kpi-label-${i}">${esc(value)}</span>
  <span class="hint">${esc(hint)}</span>
</li>`
    )
    .join('\n');
  const wl = (d.workload || [])
    .map(
      (w) => `<tr data-testid="workload-row" data-username="${esc(w.username)}">
  <td>${esc(w.name || w.username)}</td><td>${esc(w.username)}</td><td class="num"><span data-testid="workload-value">${esc(w.count)}</span></td>
</tr>`
    )
    .join('\n');
  const wlTable = `<table>
<caption class="visually-hidden">งานในมือรายเจ้าหน้าที่ (กำลังตรวจสอบ ณ ตอนนี้)</caption>
<thead><tr><th scope="col">เจ้าหน้าที่</th><th scope="col">ชื่อผู้ใช้</th><th scope="col" class="num">งานในมือ</th></tr></thead>
<tbody>
${wl}
</tbody>
</table>`;

  const body = `<h1>Dashboard ผู้บริหาร</h1>
${messages()}
<form class="filters" method="get" action="/dashboard" data-form="dashboard">
  <div class="field">
    <label for="period-select">ช่วงเวลา</label>
    <select id="period-select" name="period" data-testid="period-select" data-change="dashboard">${opt(periods, f.period)}</select>
  </div>
  <div class="field">
    <label for="service-select">บริการ</label>
    <select id="service-select" name="service" data-testid="service-select" data-change="dashboard">${opt(services, f.service)}</select>
  </div>
  <noscript><button type="submit">แสดงผล</button></noscript>
</form>
<p class="row exports">
  <a class="btn btn-secondary" data-testid="export-xlsx-btn" data-act="export-dash" data-format="xlsx" href="${esc(exportHref('xlsx', f))}" download>ส่งออก Excel</a>
  <a class="btn btn-secondary" data-testid="export-pdf-btn" data-act="export-dash" data-format="pdf" href="${esc(exportHref('pdf', f))}" download>ส่งออก PDF</a>
</p>
<div id="dash-region" data-region>
${notice}
<p class="muted small">ช่วง ${esc(d.periodLabel || f.period)} · ${esc(d.serviceLabel || f.service)} · งานคงค้างและเกินกำหนดเป็นค่า ณ ${esc(thaiDateTime(d.asOf || now))} · ไม่มีข้อมูลส่วนบุคคลของผู้ยื่น</p>
<ul class="kpis" aria-label="ตัวชี้วัด">
${kpiHtml}
</ul>
<h2>งานในมือรายเจ้าหน้าที่</h2>
${tableWrap('ตารางงานในมือรายเจ้าหน้าที่', wlTable)}
</div>`;
  send(req, res, 'Dashboard', body);
}

// ---------------------------------------------------------------------------
// /audit
// ---------------------------------------------------------------------------

function auditPage(req, res) {
  const aa = optional('../modules/admin-audit');
  const filters = { actor: q1(req.query.actor), event: q1(req.query.event).toUpperCase(), from: q1(req.query.from), to: q1(req.query.to) };
  let result = { count: 0, items: [] };
  let err = '';
  try {
    if (!aa) throw new Error('ระบบ Audit ยังไม่พร้อมใช้งาน');
    result = aa.queryAudit(filters);
  } catch (e) {
    err = e && e.message ? e.message : 'ตัวกรองไม่ถูกต้อง';
  }
  const rows = result.items
    .map((it) => {
      const tr = it.fromStatus || it.toStatus ? `${it.fromStatus || '–'} → ${it.toStatus || '–'}` : '–';
      return `<tr data-testid="audit-row" data-id="${esc(it.id)}" data-event="${esc(it.event)}" data-actor="${esc(it.username)}" data-case-no="${esc(it.caseNo || '')}">
  <td class="nowrap">${timeTag('audit-time', it.time)}</td>
  <td data-testid="audit-actor">${esc(it.username)}</td>
  <td data-testid="audit-role">${esc(it.role)}</td>
  <td data-testid="audit-event">${esc(it.event)}</td>
  <td data-testid="audit-case-no" class="nowrap">${esc(it.caseNo || '')}</td>
  <td data-testid="audit-transition" class="nowrap">${esc(tr)}</td>
  <td data-testid="audit-detail">${esc(it.detail || '')}</td>
</tr>`;
    })
    .join('\n');
  const table = `<table data-testid="audit-table">
<caption class="visually-hidden">บันทึก Audit เรียงเวลาใหม่ไปเก่า</caption>
<thead><tr><th scope="col">เวลา</th><th scope="col">ผู้ทำ</th><th scope="col">บทบาท</th><th scope="col">เหตุการณ์</th><th scope="col">เลขคำขอ</th><th scope="col">สถานะก่อน → หลัง</th><th scope="col">รายละเอียด</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
  const evOpts = ['<option value="">ทั้งหมด</option>']
    .concat(C.AUDIT_EVENTS.map((e) => `<option value="${e}"${e === filters.event ? ' selected' : ''}>${e} · ${esc(AUDIT_EVENT_LABEL[e] || e)}</option>`))
    .join('');
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
  const body = `<h1>Audit Trail</h1>
<p class="muted">บันทึกเพิ่มได้อย่างเดียว ไม่มีการแก้ไขหรือลบ · ช่วงวันที่ตามเวลาประเทศไทย</p>
${messages()}
<form class="filters card" method="get" action="/audit" data-form="audit" novalidate>
  <div class="field">
    <label for="audit-filter-actor">ผู้ทำ (username)</label>
    <input type="text" id="audit-filter-actor" name="actor" data-testid="audit-filter-actor" value="${esc(filters.actor)}" autocomplete="off">
  </div>
  <div class="field">
    <label for="audit-filter-event">เหตุการณ์</label>
    <select id="audit-filter-event" name="event" data-testid="audit-filter-event">${evOpts}</select>
  </div>
  <div class="field">
    <label for="audit-filter-from">ตั้งแต่วันที่</label>
    <input type="date" id="audit-filter-from" name="from" data-testid="audit-filter-from" value="${esc(filters.from)}">
  </div>
  <div class="field">
    <label for="audit-filter-to">ถึงวันที่</label>
    <input type="date" id="audit-filter-to" name="to" data-testid="audit-filter-to" value="${esc(filters.to)}">
  </div>
  <div class="field field-btn"><button type="submit" data-testid="audit-apply-btn">ค้นหา</button></div>
</form>
<p class="row"><a class="btn btn-secondary" data-testid="audit-export-csv-btn" data-act="export-audit" href="/api/audit/export.csv${qs ? `?${esc(qs)}` : ''}" download>ส่งออก CSV</a></p>
<div id="audit-region" data-region>
${err ? `<p class="alert alert-error" role="alert">${esc(err)}</p>` : ''}
<p>พบ <strong data-testid="audit-count">${esc(result.count)}</strong> รายการ</p>
${tableWrap('ตาราง Audit Trail', table)}
</div>`;
  send(req, res, 'Audit Trail', body);
}

// ---------------------------------------------------------------------------
// /admin/*
// ---------------------------------------------------------------------------

function adminMod() {
  return optional('../modules/admin-audit');
}

function numInput(id, label, value, hint) {
  return `<div class="field">
  <label for="${id}">${esc(label)}</label>
  <input type="number" inputmode="numeric" step="1" id="${id}" data-testid="${id}" value="${esc(value)}"${hint ? ` aria-describedby="${id}-hint"` : ''}>
  ${hint ? `<p class="muted small" id="${id}-hint">${esc(hint)}</p>` : ''}
</div>`;
}

function servicesPage(req, res) {
  const aa = adminMod();
  const list = aa ? aa.listServices() : db.prepare('SELECT id, name, fee, fee_per_sqm AS feePerSqm, sla_days AS sla FROM services ORDER BY sort, id').all();
  const cards = list
    .map((s) => {
      const id = s.id;
      const per = id === 'SV-03' || (s.feePerSqm !== null && s.feePerSqm !== undefined);
      const name = C.SERVICES[id] ? C.SERVICES[id].name : s.name;
      const feeLabel = per ? 'ค่าธรรมเนียมฐาน พื้นที่ 1–100 ตร.ม. (บาท)' : id === 'SV-01' ? 'ค่าธรรมเนียมต่อฉบับ (บาท)' : 'ค่าธรรมเนียมคงที่ (บาท)';
      return `<form class="card svc" data-testid="service-row" data-service-id="${esc(id)}" data-form="service" novalidate>
  <h2>${esc(id)} ${esc(name)}</h2>
  <div class="grid">
    ${numInput(`svc-fee-${id}`, feeLabel, per ? (s.feeBase !== undefined ? s.feeBase : s.fee) : s.fee, 'จำนวนเต็ม 0–100,000')}
    ${per ? numInput(`svc-fee-per-sqm-${id}`, 'ต่อ ตร.ม. ส่วนที่เกิน 100 (บาท)', s.feePerSqm, 'จำนวนเต็ม 0–100,000') : ''}
    ${numInput(`svc-sla-${id}`, 'SLA (วันทำการ)', s.sla, 'จำนวนเต็ม 1–60')}
  </div>
  <button type="submit" data-testid="svc-save-${esc(id)}">บันทึก ${esc(id)}</button>
</form>`;
    })
    .join('\n');
  const body = `<h1>ตั้งค่าบริการ: ค่าธรรมเนียมและ SLA</h1>
<p class="muted">ค่าที่แก้มีผลกับร่าง/คำขอใหม่เท่านั้น · ยอดที่ล็อกแล้วและกำหนดเสร็จของคำขอเดิมไม่เปลี่ยน · ทุกการแก้ไขบันทึกใน Audit</p>
${messages()}
${cards}`;
  send(req, res, 'ตั้งค่าบริการ', body);
}

function holidaysPage(req, res) {
  const aa = adminMod();
  const list = aa ? aa.listHolidays() : db.prepare('SELECT date, name FROM holidays ORDER BY date').all();
  const rows = list
    .map(
      (h) => `<tr data-testid="holiday-row" data-date="${esc(h.date)}">
  <td class="nowrap"><time datetime="${esc(h.date)}" data-iso="${esc(h.date)}">${esc(thaiDate(h.date))}</time> <span class="muted small">${esc(h.date)}</span></td>
  <td>${esc(h.name)}</td>
  <td><button type="button" class="btn-sm btn-danger" data-testid="holiday-delete-btn" data-act="holiday-delete" data-date="${esc(h.date)}" aria-label="ลบ วันหยุด ${esc(h.date)}">ลบ</button></td>
</tr>`
    )
    .join('\n');
  const table = `<table>
<caption class="visually-hidden">วันหยุดราชการที่ไม่นับเป็นวันทำการ</caption>
<thead><tr><th scope="col">วันที่</th><th scope="col">ชื่อวันหยุด</th><th scope="col">ดำเนินการ</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
  const body = `<h1>วันหยุด</h1>
<p class="muted">วันหยุดใช้คำนวณกำหนดเสร็จของคำขอที่ชำระหลังจากนี้ (คำขอเดิมไม่คำนวณใหม่) · เสาร์–อาทิตย์ไม่นับเป็นวันทำการอยู่แล้ว</p>
${messages()}
<form class="filters card" data-form="holiday-add" novalidate>
  <div class="field">
    <label for="holiday-date-input">วันที่ (ค.ศ.)</label>
    <input type="date" id="holiday-date-input" name="date" data-testid="holiday-date-input">
  </div>
  <div class="field">
    <label for="holiday-name-input">ชื่อวันหยุด</label>
    <input type="text" id="holiday-name-input" name="name" data-testid="holiday-name-input" maxlength="100">
  </div>
  <div class="field field-btn"><button type="submit" data-testid="holiday-add-btn">เพิ่มวันหยุด</button></div>
</form>
<div id="holiday-region" data-region>
<p>ทั้งหมด ${list.length} วัน</p>
${tableWrap('ตารางวันหยุด', table)}
</div>`;
  send(req, res, 'วันหยุด', body);
}

function usersPage(req, res) {
  const aa = adminMod();
  const list = aa
    ? aa.listUsers()
    : db.prepare('SELECT username, name, role, dept FROM users WHERE username IS NOT NULL ORDER BY id').all();
  const rows = list
    .map((u, i) => {
      const self = u.username === req.user.username;
      const roleOpts = C.ROLES.map((r) => `<option value="${r}"${r === u.role ? ' selected' : ''}>${esc(C.ROLE_LABEL[r])} (${r})</option>`).join('');
      const deptOpts = [['', 'ไม่มี']]
        .concat(C.DEPTS.map((d) => [d, C.DEPT_LABEL[d]]))
        .map(([v, t]) => `<option value="${v}"${v === (u.dept || '') ? ' selected' : ''}>${esc(t)}${v ? ` (${v})` : ''}</option>`)
        .join('');
      return `<tr data-testid="user-row" data-username="${esc(u.username)}">
  <td>${esc(u.username)}${self ? ' <span class="muted small">(บัญชีของคุณ)</span>' : ''}</td>
  <td>${esc(u.name)}</td>
  <td><label class="visually-hidden" for="role-${i}">บทบาทของ ${esc(u.username)}</label>
      <select id="role-${i}" data-testid="user-role-select">${roleOpts}</select></td>
  <td><label class="visually-hidden" for="dept-${i}">แผนกของ ${esc(u.username)}</label>
      <select id="dept-${i}" data-testid="user-dept-select">${deptOpts}</select></td>
  <td><button type="button" class="btn-sm" data-testid="user-save-btn" data-act="user-save" data-username="${esc(u.username)}" aria-label="บันทึก บทบาทของ ${esc(u.username)}">บันทึก</button></td>
</tr>`;
    })
    .join('\n');
  const table = `<table>
<caption class="visually-hidden">บัญชีเจ้าหน้าที่และบทบาท</caption>
<thead><tr><th scope="col">ชื่อผู้ใช้</th><th scope="col">ชื่อ</th><th scope="col">บทบาท</th><th scope="col">แผนก</th><th scope="col">ดำเนินการ</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
  const body = `<h1>ผู้ใช้และบทบาท</h1>
<p class="muted">การเปลี่ยนบทบาทมีผลเมื่อผู้ใช้ล็อกอินครั้งถัดไป · เจ้าหน้าที่ต้องมีแผนก (ทะเบียน/โยธา) · เปลี่ยนบทบาทของตัวเองไม่ได้</p>
${messages()}
${tableWrap('ตารางผู้ใช้', table)}`;
  send(req, res, 'ผู้ใช้และบทบาท', body);
}

// ---------------------------------------------------------------------------
// /notifications
// ---------------------------------------------------------------------------

function notificationsPage(req, res) {
  const aa = optional('../modules/admin-audit');
  const items = aa
    ? aa.listNotifications(req.user.username)
    : db
        .prepare('SELECT id, case_no AS caseNo, level, text, created_at AS createdAt FROM notifications WHERE username = ? ORDER BY created_at DESC, id DESC')
        .all(req.user.username);
  const list = items.length
    ? `<ul class="noti-list">
${items
  .map(
    // CONTRACT §2.12 · A-30: ข้อความของ noti-item = "คำขอ <เลข> <ระดับ>" พอดี → ป้ายระดับและเวลาอยู่นอก noti-item
    (n) => `<li class="noti-row">
  <a data-testid="noti-item" data-case-no="${esc(n.caseNo)}" data-level="${esc(n.level)}" href="/officer/cases/${encodeURIComponent(n.caseNo)}">${esc(n.text)}</a>
  ${levelChip('', n.level)}
  <span class="muted small">${timeEl(n.createdAt)}</span>
</li>`
  )
  .join('\n')}
</ul>`
    : '<p class="empty" data-testid="noti-empty">ไม่มีแจ้งเตือน</p>';
  const body = `<h1>แจ้งเตือน</h1>
<p class="muted">แจ้งเตือนคำขอที่ใกล้ครบกำหนดหรือเกินกำหนด (แจ้งครั้งเดียวต่อคำขอและระดับ)</p>
${list}`;
  send(req, res, 'แจ้งเตือน', body);
}

// ---------------------------------------------------------------------------
// สคริปต์ฝั่งเบราว์เซอร์ (เสิร์ฟที่ /static/staff.js) — เขียนเป็นฟังก์ชันจริงเพื่อให้ node ตรวจไวยากรณ์ตอนโหลด
// ---------------------------------------------------------------------------

/* eslint-disable no-var */
function clientMain() {
  'use strict';
  var E = window.Egov;
  if (!E) return;
  var enc = encodeURIComponent;

  function tid(name, root) {
    return (root || document).querySelector('[data-testid="' + name + '"]');
  }

  /** แสดงข้อความผล (kind: 'error' | 'ok' | null = ซ่อนทั้งคู่) */
  function msg(kind, text) {
    var err = tid('action-error');
    var ok = tid('action-success');
    [err, ok].forEach(function (el) {
      if (el) {
        el.hidden = true;
        el.textContent = '';
      }
    });
    if (!kind) return;
    var el = kind === 'error' ? err : ok;
    if (!el) return;
    el.hidden = false;
    el.textContent = text;
    var a = document.activeElement;
    if (!a || a === document.body || !document.contains(a)) {
      try {
        el.focus();
      } catch (e) {
        /* ignore */
      }
    }
  }

  /** ดึง HTML ของหน้าเดิม (URL ปัจจุบัน) แล้วแทนกล่อง [data-region] + ตัวเลขกระดิ่ง */
  var seq = 0;
  function refresh() {
    var my = ++seq;
    return fetch(location.pathname + location.search, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'text/html' },
    })
      .then(function (res) {
        if (res.redirected && /\/login(\?|$)/.test(res.url)) {
          location.href = '/login';
          return null;
        }
        return res.text();
      })
      .then(function (html) {
        if (html === null || my !== seq) return;
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var missing = false;
        Array.prototype.forEach.call(document.querySelectorAll('[data-region]'), function (r) {
          var n = doc.getElementById(r.id);
          if (n && n.hasAttribute('data-region')) r.replaceWith(document.importNode(n, true));
          else missing = true;
        });
        var b = tid('bell-count');
        var nb = tid('bell-count', doc);
        if (b && nb) {
          b.textContent = nb.textContent;
          var al = nb.getAttribute('aria-label');
          if (al) b.setAttribute('aria-label', al);
        }
        if (missing) location.reload();
      });
  }
  function safeRefresh() {
    return refresh().catch(function () {
      /* เครือข่ายขัดข้อง: คงหน้าเดิม */
    });
  }

  /**
   * เรียก API แล้วแสดงผล · o.fieldErr = กล่อง error ของช่อง (ใช้กับ 400 ที่ code อยู่ใน o.fieldCodes)
   * สำเร็จ → (onOk) → refresh region (ยกเว้น o.refresh === false) → action-success
   * ไม่สำเร็จ → (409 + o.refreshOnConflict → refresh) → action-error (ข้อความจาก API ตรงตัว)
   */
  function run(btn, method, url, body, o) {
    o = o || {};
    msg(null);
    if (o.fieldErr) E.clearError(o.fieldErr);
    if (btn) {
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
    }
    function done() {
      if (btn) {
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
      }
    }
    return E.api(method, url, body)
      .then(function (r) {
        var d = r.data || {};
        if (r.status === 401) {
          location.href = '/login';
          return null;
        }
        if (r.ok) {
          if (o.onOk) o.onOk(d);
          return (o.refresh === false ? Promise.resolve() : safeRefresh()).then(function () {
            done();
            msg('ok', typeof o.ok === 'function' ? o.ok(d) : o.ok || 'บันทึกเรียบร้อย');
          });
        }
        var text = d.message || 'ทำรายการไม่สำเร็จ (HTTP ' + r.status + ')';
        if (o.fieldErr && r.status === 400 && (!o.fieldCodes || o.fieldCodes.indexOf(d.code) >= 0)) {
          done();
          E.showError(o.fieldErr, text);
          if (o.focus) o.focus.focus();
          return null;
        }
        return (o.refreshOnConflict && r.status === 409 ? safeRefresh() : Promise.resolve()).then(function () {
          done();
          msg('error', text);
        });
      })
      .catch(function () {
        done();
        msg('error', 'เชื่อมต่อระบบไม่ได้ กรุณาลองใหม่');
      });
  }

  function num(v) {
    var s = String(v === null || v === undefined ? '' : v).trim();
    return /^-?\d+$/.test(s) ? Number(s) : s;
  }

  function setQuery(params) {
    var qs = new URLSearchParams();
    Object.keys(params).forEach(function (k) {
      if (params[k]) qs.set(k, params[k]);
    });
    var s = qs.toString();
    history.replaceState(null, '', location.pathname + (s ? '?' + s : ''));
  }

  function dashSync() {
    var p = tid('period-select');
    var s = tid('service-select');
    if (!p || !s) return;
    ['xlsx', 'pdf'].forEach(function (fmt) {
      var a = tid('export-' + fmt + '-btn');
      if (a) a.href = '/api/dashboard/export?format=' + fmt + '&period=' + enc(p.value) + '&service=' + enc(s.value);
    });
  }

  // ---- คลิก ----
  document.addEventListener('click', function (ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
    if (!el) return;
    var act = el.getAttribute('data-act');
    var no = el.getAttribute('data-case-no');
    if (act === 'claim') {
      ev.preventDefault();
      run(el, 'POST', '/api/officer/cases/' + enc(no) + '/claim', undefined, { ok: 'รับเรื่อง ' + no + ' เรียบร้อย', refreshOnConflict: true });
    } else if (act === 'approve') {
      ev.preventDefault();
      run(el, 'POST', '/api/cases/' + enc(no) + '/approve', undefined, { ok: 'อนุมัติคำขอเรียบร้อย', refreshOnConflict: true });
    } else if (act === 'issue') {
      ev.preventDefault();
      run(el, 'POST', '/api/officer/cases/' + enc(no) + '/issue', undefined, {
        ok: function (d) {
          return 'ออกเอกสารเรียบร้อย' + (d.docNo ? ' เลขที่ ' + d.docNo : '');
        },
        refreshOnConflict: true,
      });
    } else if (act === 'open') {
      ev.preventDefault();
      var panel = document.getElementById(el.getAttribute('aria-controls'));
      if (panel) {
        panel.hidden = false;
        el.setAttribute('aria-expanded', 'true');
        var f = panel.querySelector('textarea, input');
        if (f) f.focus();
      }
    } else if (act === 'holiday-delete') {
      ev.preventDefault();
      var date = el.getAttribute('data-date');
      run(el, 'DELETE', '/api/admin/holidays/' + enc(date), undefined, { ok: 'ลบวันหยุด ' + date + ' เรียบร้อย' });
    } else if (act === 'user-save') {
      ev.preventDefault();
      var row = el.closest('[data-testid="user-row"]');
      var user = el.getAttribute('data-username');
      var roleSel = tid('user-role-select', row);
      var deptSel = tid('user-dept-select', row);
      run(el, 'PUT', '/api/admin/users/' + enc(user), { role: roleSel.value, dept: deptSel.value }, {
        refresh: false,
        ok: 'บันทึกบทบาทของ ' + user + ' เรียบร้อย (มีผลเมื่อล็อกอินครั้งถัดไป)',
        onOk: function (d) {
          if (d.role) roleSel.value = d.role;
          deptSel.value = d.dept || '';
        },
      });
    } else if (act === 'export-dash') {
      dashSync(); // ให้ลิงก์ตรงกับตัวกรองล่าสุดเสมอ (ไม่ preventDefault → ดาวน์โหลดตามปกติ)
    } else if (act === 'export-audit') {
      el.href = '/api/audit/export.csv' + location.search;
      // การส่งออกถูกบันทึกใน Audit → อัปเดตจำนวน/ตารางตามหลัง
      setTimeout(safeRefresh, 800);
      setTimeout(safeRefresh, 2500);
    }
  });

  // ---- ส่งฟอร์ม ----
  document.addEventListener('submit', function (ev) {
    var f = ev.target;
    var kind = f && f.getAttribute ? f.getAttribute('data-form') : null;
    if (!kind) return;
    ev.preventDefault();
    var btn = ev.submitter || f.querySelector('[type="submit"]');
    var no = f.getAttribute('data-case-no');
    if (kind === 'return' || kind === 'reject') {
      var reason = f.querySelector('textarea');
      var url = kind === 'return' ? '/api/officer/cases/' + enc(no) + '/return' : '/api/cases/' + enc(no) + '/reject';
      run(btn, 'POST', url, { reason: reason.value }, {
        ok: kind === 'return' ? 'ตีกลับให้ผู้ยื่นแก้ไขเรียบร้อย' : 'บันทึกผลไม่อนุมัติเรียบร้อย',
        fieldErr: tid(kind + '-reason-error'),
        fieldCodes: ['REASON_TOO_SHORT'],
        focus: reason,
        refreshOnConflict: true,
      });
    } else if (kind === 'forward') {
      var note = f.querySelector('textarea');
      run(btn, 'POST', '/api/officer/cases/' + enc(no) + '/forward', { note: note ? note.value : '' }, {
        ok: 'ส่งต่อเรียบร้อย',
        refreshOnConflict: true,
      });
    } else if (kind === 'unmask') {
      var r = f.querySelector('input');
      run(btn, 'POST', '/api/officer/cases/' + enc(no) + '/unmask', { reason: r.value }, {
        refresh: false,
        ok: 'แสดงเลขบัตรเต็มแล้ว (บันทึกใน Audit)',
        fieldErr: tid('unmask-error'),
        fieldCodes: ['REASON_REQUIRED'],
        focus: r,
        onOk: function (d) {
          var slot = document.getElementById('full-id-slot');
          if (!slot || !d.idNo) return;
          slot.innerHTML = '';
          var p = document.createElement('p');
          p.className = 'full-id';
          p.appendChild(document.createTextNode('เลขบัตรเต็ม: '));
          var s = document.createElement('span');
          s.setAttribute('data-testid', 'full-id');
          s.textContent = E.formatId(d.idNo);
          p.appendChild(s);
          slot.appendChild(p);
        },
      });
    } else if (kind === 'service') {
      var id = f.getAttribute('data-service-id');
      var fee = tid('svc-fee-' + id, f);
      var per = tid('svc-fee-per-sqm-' + id, f);
      var sla = tid('svc-sla-' + id, f);
      var body = {};
      if (per) {
        body.feeBase = num(fee.value);
        body.feePerSqm = num(per.value);
      } else {
        body.fee = num(fee.value);
      }
      body.sla = num(sla.value);
      run(btn, 'PUT', '/api/admin/services/' + enc(id), body, {
        refresh: false,
        ok: 'บันทึก ' + id + ' เรียบร้อย',
        onOk: function (d) {
          var base = per ? (d.feeBase !== undefined ? d.feeBase : d.fee) : d.fee;
          if (base !== undefined && base !== null) fee.value = base;
          if (per && d.feePerSqm !== undefined && d.feePerSqm !== null) per.value = d.feePerSqm;
          if (d.sla !== undefined && d.sla !== null) sla.value = d.sla;
        },
      });
    } else if (kind === 'holiday-add') {
      var di = tid('holiday-date-input', f);
      var ni = tid('holiday-name-input', f);
      run(btn, 'POST', '/api/admin/holidays', { date: di.value, name: ni.value }, {
        ok: 'เพิ่มวันหยุด ' + di.value + ' เรียบร้อย',
        onOk: function () {
          di.value = '';
          ni.value = '';
        },
      });
    } else if (kind === 'audit') {
      msg(null);
      setQuery({
        actor: tid('audit-filter-actor', f).value.trim(),
        event: tid('audit-filter-event', f).value,
        from: tid('audit-filter-from', f).value,
        to: tid('audit-filter-to', f).value,
      });
      safeRefresh();
    } else if (kind === 'queue' || kind === 'dashboard') {
      f.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  // ---- เปลี่ยนตัวกรอง (ไม่ navigate: ช่องกรองคงค่า · ผลมาแทนใน region) ----
  document.addEventListener('change', function (ev) {
    var t = ev.target;
    var kind = t && t.getAttribute ? t.getAttribute('data-change') : null;
    if (!kind && t && t.tagName === 'FORM') kind = t.getAttribute('data-form');
    if (kind === 'queue') {
      var qf = tid('queue-filter');
      setQuery({ filter: qf && qf.value !== 'all' ? qf.value : '' });
      safeRefresh();
    } else if (kind === 'dashboard') {
      var p = tid('period-select');
      var s = tid('service-select');
      setQuery({ period: p.value, service: s.value });
      dashSync();
      safeRefresh();
    }
  });
}
/* eslint-enable no-var */

const CLIENT_JS = `/* staff.js (B10) — หน้าเจ้าหน้าที่: เรียก API แล้วอัปเดตกล่อง [data-region] */\n(${clientMain.toString()})();\n`;

const STAFF_CSS = `/* staff.css (B10) */
.visually-hidden { position: absolute !important; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
h1 .sub { font-weight: 400; font-size: 1rem; color: var(--muted); }
.small { font-size: .875rem; }
.nowrap { white-space: nowrap; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: .04em; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.msgs .alert { margin: 0 0 12px; }
.msgs .alert:focus { outline: 3px solid var(--focus); outline-offset: 2px; }
.back { margin: 0 0 8px; gap: 4px 16px; }
.empty { padding: 12px; background: var(--surface); border: 1px dashed var(--border); border-radius: var(--radius); }
.workload { font-size: 1.0625rem; margin: 0 0 12px; }
.filters { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: flex-end; margin: 0 0 16px; }
.filters .field { flex: 1 1 180px; min-width: 0; }
.filters .field-btn { flex: 0 0 auto; }
.filters label { margin-top: 0; }
.field { min-width: 0; }
.field p { margin: 4px 0 0; }
.btn-sm { padding: 4px 10px; font-size: .9375rem; }
td .btn, td button { white-space: nowrap; }
.table-wrap { margin-bottom: 12px; }
.table-wrap:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
caption { text-align: left; }
.kv { margin: 0; display: grid; gap: 6px; }
.kv > div { display: grid; grid-template-columns: minmax(150px, 220px) minmax(0, 1fr); gap: 4px 16px; align-items: baseline; }
.kv dt { font-weight: 600; color: var(--muted); }
.kv dd { margin: 0; min-width: 0; }
.panel { border: 1px solid var(--border); border-radius: var(--radius); background: #f4f6f8; padding: 12px; margin: 12px 0 0; }
.panel label { margin-top: 0; }
.panel textarea, .panel input[type=text] { max-width: 100%; }
.panel button { margin-top: 8px; }
.actions-row { gap: 8px 12px; }
.full-id { margin: 8px 0 0; font-weight: 600; }
.doc-grid { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
.doc-grid .kv { flex: 1 1 280px; }
.qr { flex: 0 0 auto; line-height: 0; background: #fff; border: 1px solid var(--border); border-radius: var(--radius); padding: 6px; }
.qr svg { width: 168px; height: 168px; }
.doc-list, .noti-list { list-style: none; margin: 0; padding: 0; }
.doc-list li, .noti-list li { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; padding: 8px 0; border-bottom: 1px solid #e3e7ec; }
.doc-list li:last-child, .noti-list li:last-child { border-bottom: 0; }
.doc-kind { font-weight: 600; min-width: 7em; }
.noti-list { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 0 12px; }
.timeline { margin: 0; padding-left: 1.25rem; }
.timeline li { margin: 0 0 6px; }
.timeline time { font-variant-numeric: tabular-nums; color: var(--muted); }
.kpis { list-style: none; padding: 0; margin: 0 0 16px; display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
.kpi { display: flex; flex-direction: column; gap: 2px; }
.kpi .value { font-variant-numeric: tabular-nums; line-height: 1.2; }
.kpi .hint { color: var(--muted); font-size: .8125rem; }
.exports { gap: 8px 12px; margin: 0 0 16px; }
.svc h2 { margin-top: 0; }
.svc .grid { margin-bottom: 12px; }
.svc input[type=number] { max-width: 220px; }
@media (max-width: 600px) {
  .kv > div { grid-template-columns: minmax(0, 1fr); }
  .filters .field { flex-basis: 100%; }
  .card { padding: 12px; }
}
/* header: ป้ายบทบาทของ layout (rgba ขาว 20%) contrast ไม่ถึง 4.5:1 → ใช้พื้นเข้มบนหน้าของ B10 */
.app-bar .user-role { background: var(--primary-dark); color: #fff; border: 1px solid rgba(255, 255, 255, .6); }
@media (forced-colors: active) {
  .chip { border: 1px solid CanvasText; }
}
`;

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

function register(app) {
  app.get('/static/staff.js', (req, res) => {
    res.set('Cache-Control', 'no-cache').type('application/javascript; charset=utf-8').send(CLIENT_JS);
  });
  app.get('/static/staff.css', (req, res) => {
    res.set('Cache-Control', 'no-cache').type('text/css; charset=utf-8').send(STAFF_CSS);
  });

  app.get('/officer/queue', requirePage('officer', 'head'), queuePage);
  app.get('/officer/cases/:caseNo', requirePage('officer', 'head'), casePage);
  app.get('/head/approvals', requirePage('head'), approvalsPage);
  app.get('/dashboard', requirePage('executive'), dashboardPage);
  app.get('/audit', requirePage('auditor'), auditPage);
  app.get('/admin', requirePage('admin'), (req, res) => res.redirect(302, '/admin/services'));
  app.get('/admin/services', requirePage('admin'), servicesPage);
  app.get('/admin/holidays', requirePage('admin'), holidaysPage);
  app.get('/admin/users', requirePage('admin'), usersPage);
  app.get('/notifications', requirePage('officer', 'head'), notificationsPage);
}

module.exports = { register };
