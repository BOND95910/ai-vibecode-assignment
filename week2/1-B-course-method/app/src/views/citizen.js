'use strict';
/**
 * หน้าเว็บฝั่งประชาชน + หน้าสาธารณะ (B09)
 *
 *   GET /login                    ล็อกอินประชาชน (ThaiD จำลอง) / เจ้าหน้าที่ (SSO จำลอง)          CONTRACT §2.2
 *   GET /register                 ลงทะเบียนครั้งแรก + ยินยอม PDPA                                  CONTRACT §2.3
 *   GET /citizen                  คำขอ/ร่างของฉัน + เริ่มบริการ                                    CONTRACT §2.4
 *   GET /citizen/new/:service     ขั้นตอนยื่น 3 ขั้น (?draft=DR-0003 เปิดร่างเดิม · &step=2|3)      CONTRACT §2.5
 *   GET /citizen/cases/:caseNo    รายละเอียดคำขอของฉัน                                            CONTRACT §2.6
 *   GET /verify/:code             ตรวจเอกสาร (ไม่ต้องล็อกอิน · NOT_FOUND → HTTP 404)               CONTRACT §2.13
 *   GET /verify?code=…            ฟอร์มกรอกรหัส → redirect /verify/:code
 *
 * กติกา (INTERFACES §2 §6.8)
 *  - ไม่สร้าง API ใหม่: ปุ่มทุกปุ่มเรียก API ของ B04/B05 ผ่าน window.Egov.api() แล้วอัปเดต DOM หรือโหลดหน้าใหม่
 *  - อ่านข้อมูลด้วยฟังก์ชันของบล็อกอื่นแบบ lazy require (citizen.calcFee / loadCaseForViewer / caseJson ·
 *    workflow.timeline / caseFiles / documentForCase / verifyDocument · sla.slaLevel) ถ้ายังไม่มีใช้การอ่าน DB ตรงแทน
 *  - /citizen/cases/:caseNo ใช้ citizen.loadCaseForViewer → บั๊ก B06 มีผลกับหน้านี้ด้วย
 *  - ตารางค่าธรรมเนียมในหน้า (fee-total) คำนวณล่วงหน้าด้วย citizen.calcFee ฝั่งเซิร์ฟเวอร์ → ตัวเลขบนจอ = API เสมอ (รวมบั๊ก B01)
 *  - สคริปต์ฝั่งเบราว์เซอร์อยู่ในไฟล์นี้ (ฟังก์ชัน client* ถูกส่งไปด้วย fn.toString() · ห้ามอ้างตัวแปรฝั่ง Node)
 *    ข้อมูลส่งผ่าน <script type="application/json" id="b09-data"> · common.js (defer) พร้อมก่อน DOMContentLoaded
 *  - ทุกค่าที่แสดง escape ด้วย format.esc · วันเวลาใช้ format.timeTag (data-iso) · เงิน format.baht
 */

const { db } = require('../db');
const clock = require('../clock');
const crypto = require('../crypto');
const { esc, timeTag, baht, thaiDate, thaiDateTime, formatId, maskName } = require('../format');
const C = require('../constants');
const http = require('../http');
const { requirePage } = require('../session');
const layout = require('./layout');

const DASH = '–'; // en dash (CONTRACT: ค่าไม่ถูกต้อง → "–")

// ───────────────────────────── require แบบ lazy (บล็อกอื่นอาจยังไม่เสร็จ) ─────────────────────────────

function optional(rel) {
  try {
    return require(rel);
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(`'${rel}'`)) return null;
    throw e;
  }
}
const mods = {
  citizen: () => optional('../modules/citizen'),
  workflow: () => optional('../modules/workflow'),
  sla: () => optional('../sla'),
};
const fnOf = (mod, name) => (mod && typeof mod[name] === 'function' ? mod[name].bind(mod) : null);

// ───────────────────────────── SQL (อ่านอย่างเดียว) ─────────────────────────────

const Q = {
  service: db.prepare('SELECT * FROM services WHERE id = ?'),
  services: db.prepare('SELECT * FROM services ORDER BY sort, id'),
  user: db.prepare('SELECT * FROM users WHERE id = ?'),
  myCases: db.prepare('SELECT * FROM cases WHERE applicant_id = ? AND case_no IS NOT NULL ORDER BY case_no DESC'),
  myDrafts: db.prepare(
    "SELECT * FROM cases WHERE applicant_id = ? AND case_no IS NULL AND status IN ('DRAFT','PENDING_PAYMENT') ORDER BY id DESC"
  ),
  draft: db.prepare('SELECT * FROM cases WHERE draft_id = ?'),
  caseByNo: db.prepare('SELECT * FROM cases WHERE case_no = ?'),
  files: db.prepare('SELECT id AS fileId, name, doc_key AS docKey, size FROM case_files WHERE case_id = ? ORDER BY created_at, rowid'),
  payments: db.prepare('SELECT * FROM payments WHERE case_id = ? ORDER BY qr_created_at DESC, rowid DESC'),
  events: db.prepare('SELECT * FROM case_events WHERE case_id = ? ORDER BY at, id'),
  docByCase: db.prepare('SELECT * FROM documents WHERE case_id = ? ORDER BY issued_at DESC, doc_no DESC LIMIT 1'),
  docByCode: db.prepare('SELECT * FROM documents WHERE verify_code = ?'),
};

// ───────────────────────────── ข้อความ ─────────────────────────────

/** ข้อความ error ทั้งตาราง (CONTRACT §5) ให้สคริปต์ฝั่งเบราว์เซอร์ใช้เมื่อ response ไม่มี message */
const MSGS = Object.fromEntries(Object.entries(http.ERRORS).map(([k, v]) => [k, v[1]]));

const STEP_NAMES = { 1: '1/3 กรอกข้อมูล', 2: '2/3 แนบเอกสาร', 3: '3/3 ชำระเงิน' };

const VERIFY_LABEL = {
  VALID: 'เอกสารถูกต้อง',
  EXPIRED: 'เอกสารหมดอายุ',
  TAMPERED: 'ลายเซ็นไม่ถูกต้อง',
  NOT_FOUND: 'ไม่พบเอกสาร',
};
const VERIFY_EXPLAIN = {
  VALID: 'ลายเซ็นดิจิทัลตรงกับข้อมูลในเอกสาร และเอกสารยังอยู่ในระยะเวลาที่ใช้ได้',
  EXPIRED: 'ลายเซ็นดิจิทัลถูกต้อง แต่เอกสารพ้นวันที่ใช้ได้แล้ว',
  TAMPERED: 'ข้อมูลในเอกสารไม่ตรงกับลายเซ็นดิจิทัล เอกสารอาจถูกแก้ไข ห้ามใช้เอกสารฉบับนี้',
  NOT_FOUND: 'ไม่พบรหัสตรวจสอบนี้ในระบบ กรุณาตรวจรหัส 8 ตัวอีกครั้ง',
};

/** ข้อความไทยของเหตุการณ์ในไทม์ไลน์ (ใช้เมื่อ workflow.timeline ยังไม่มี) */
const EVENT_TEXT = {
  CREATED: 'สร้างคำขอ',
  PAID: 'ชำระค่าธรรมเนียมแล้ว · ส่งคำขอ',
  CLAIM: 'เจ้าหน้าที่รับเรื่อง',
  RETURN: 'ตีกลับให้แก้ไขเอกสาร',
  RESUBMIT: 'ส่งแก้ไขเอกสารแล้ว',
  FORWARD: 'ส่งต่อขั้นถัดไป',
  APPROVE: 'อนุมัติ',
  REJECT: 'ไม่อนุมัติ',
  ISSUE: 'ออกเอกสารดิจิทัล',
  CANCEL: 'ยกเลิกคำขอ',
  AUTO_CANCEL: 'ระบบยกเลิกอัตโนมัติ (เลยเวลาแก้ไข 7 วัน)',
};
/** เหตุการณ์ที่แสดงหมายเหตุให้ประชาชนเห็นได้ (FORWARD/CLAIM เป็นข้อมูลภายใน) */
const EVENT_NOTE_PUBLIC = new Set(['PAID', 'RETURN', 'REJECT', 'ISSUE']);

// ───────────────────────────── ตัวช่วย HTML ─────────────────────────────

const serviceLabel = (id) => `${id} ${C.SERVICES[id] ? C.SERVICES[id].name : ''}`.trim();

function statusChip(testid, status) {
  return `<span class="chip" data-testid="${testid}" data-status="${esc(status)}">${esc(C.STATUS_LABEL[status] || status)}</span>`;
}

function levelChip(testid, level) {
  if (!level) return `<span class="muted">${DASH}</span>`;
  return `<span class="chip" data-testid="${testid}" data-level="${esc(level)}">${esc(C.SLA_LEVEL_LABEL[level] || level)}</span>`;
}

/** <time> ไม่มี testid (ยังมี data-iso ตาม CONTRACT §0.3) */
function timeEl(iso) {
  if (!iso) return DASH;
  return `<time datetime="${esc(iso)}" data-iso="${esc(iso)}">${esc(thaiDateTime(iso))}</time>`;
}

function fileSize(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  if (n >= 1048576) return `${(n / 1048576).toFixed(2)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} ไบต์`;
}

/** ข้อมูลให้สคริปต์ฝั่งเบราว์เซอร์ (กัน </script> และตัวขึ้นบรรทัดพิเศษ) */
function dataScript(data) {
  const json = JSON.stringify({ msgs: MSGS, ...data })
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `<script type="application/json" id="b09-data">${json}</script>`;
}

/** สคริปต์ของหน้า: helpers + ฟังก์ชันของหน้า (รันหลัง common.js ซึ่งโหลดแบบ defer) */
function pageScript(fn) {
  return `<script>document.addEventListener('DOMContentLoaded', function () { (${fn.toString()})((${clientHelpers.toString()})()); });</script>`;
}

function actionBoxes() {
  return (
    '<p class="alert alert-error" role="alert" data-testid="action-error" hidden></p>\n' +
    '<p class="alert alert-ok" role="status" data-testid="action-success" hidden></p>'
  );
}

/** QR (SVG → data URL) · ไม่สำเร็จ → null */
async function qrDataUrl(text) {
  try {
    const QR = require('qrcode');
    const svg = await QR.toString(String(text), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
  } catch (e) {
    return null;
  }
}

const STYLE = `<style>
.app-bar .user-role{background:var(--primary-dark);color:#fff}
.sr-only{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.narrow{max-width:640px}
.small{font-size:.875rem}
.lead{font-size:1.0625rem}
.tabs{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 12px}
.tabs [role=tab][aria-selected=false]{background:#fff;color:var(--primary)}
.tabs [role=tab][aria-selected=false]:hover{background:var(--info-bg)}
.otp-step{margin-top:16px;padding-top:12px;border-top:1px solid var(--border)}
.svc-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));margin-bottom:8px}
.svc-grid .card{display:flex;flex-direction:column;gap:6px;margin:0}
.svc-grid .card h3{margin:0;font-size:1.0625rem}
.svc-grid .card p{margin:0}
.svc-grid .card .btn{align-self:flex-start;margin-top:auto}
.stepper{list-style:none;display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px;padding:0}
.stepper li{padding:4px 12px;border-radius:999px;background:var(--gray-bg);color:var(--gray-fg);font-size:.875rem}
.stepper li[aria-current=step]{background:var(--primary);color:#fff;font-weight:700}
.wizard-now{margin:0 0 12px}
.fee-line{font-size:1.25rem;margin:12px 0}
.fee-line output{font-weight:700}
.upload-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr))}
.upload-field{border:1px dashed var(--border);border-radius:6px;padding:8px 10px;background:#fbfcfd}
.upload-field label{margin-top:0}
.file-list{list-style:none;margin:8px 0;padding:0}
.file-list li{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;padding:8px 10px;margin-bottom:6px;border:1px solid var(--border);border-radius:6px;background:#fff}
.file-list .file-name{font-weight:600}
.btn-sm{padding:4px 10px;font-size:.875rem}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;margin:0}
.kv dt{font-weight:600;color:var(--muted)}
.kv dd{margin:0}
.qr-box{margin:12px 0}
.qr-box img{display:block;width:200px;max-width:100%;height:auto;background:#fff;border:1px solid var(--border);border-radius:6px;padding:6px}
.qr-box figcaption{margin-top:6px}
.timeline{list-style:none;margin:0;padding:0 0 0 14px;border-left:3px solid var(--border)}
.timeline li{padding:2px 0 10px}
.timeline time{font-weight:600}
.attention{border-color:#f0d68a;background:var(--warn-bg)}
.chip[data-result=VALID]{background:var(--ok-bg);color:var(--ok-fg)}
.chip[data-result=EXPIRED]{background:var(--warn-bg);color:var(--warn-fg)}
.chip[data-result=TAMPERED],.chip[data-result=NOT_FOUND]{background:var(--bad-bg);color:var(--bad-fg)}
.verify-result .chip{font-size:1.125rem;padding:4px 14px}
.confirm-box{border-color:#f2b8b8}
fieldset{border:1px solid var(--border);border-radius:6px;padding:8px 12px;margin:12px 0}
legend{font-weight:700;padding:0 4px}
@media (max-width:480px){.kv{grid-template-columns:1fr;gap:2px}.kv dd{margin-bottom:8px}}
</style>`;

function send(req, res, opts) {
  return layout.sendPage(req, res, { ...opts, head: STYLE + (opts.head || '') });
}

/** หน้า 404/403 แบบเดียวกับ layout.notFoundPage/forbiddenPage แต่ผ่าน send() เพื่อให้ได้ STYLE (สี .user-role ผ่าน axe) */
function notFound(req, res, message = 'ไม่พบคำขอ') {
  return send(req, res, {
    status: 404,
    title: 'ไม่พบ',
    body: `<h1>ไม่พบ</h1>\n<p class="alert alert-error" role="alert" data-testid="not-found-msg">${esc(message)}</p>`,
  });
}
function forbidden(req, res) {
  return send(req, res, {
    status: 403,
    title: 'ไม่มีสิทธิ์',
    body: `<h1>ไม่มีสิทธิ์</h1>\n<p class="alert alert-error" role="alert" data-testid="forbidden-msg">${esc(http.FORBIDDEN_PAGE_MSG)}</p>`,
  });
}

// ───────────────────────────── ค่าธรรมเนียม ─────────────────────────────

/** สูตรสำรองตาม DECISIONS §3 (ใช้เมื่อ citizen.calcFee ยังไม่มี) */
function fallbackCalcFee(serviceId, input, svc) {
  const L = C.LIMITS;
  const s = svc || Q.service.get(serviceId) || { fee: 0, fee_per_sqm: 0 };
  if (serviceId === 'SV-01') {
    const qty = input.qty;
    if (!Number.isInteger(qty) || qty < L.SV01_QTY_MIN || qty > L.SV01_QTY_MAX) throw http.apiError('INVALID_QTY');
    return s.fee * qty;
  }
  if (serviceId === 'SV-03') {
    const a = input.areaSqm;
    if (!Number.isInteger(a) || a < L.SV03_AREA_MIN) throw http.apiError('INVALID_AREA');
    if (a > L.SV03_AREA_MAX) throw http.apiError('AREA_TOO_LARGE');
    return s.fee + (a > L.SV03_BASE_AREA ? (a - L.SV03_BASE_AREA) * (s.fee_per_sqm || 0) : 0);
  }
  return s.fee;
}

/**
 * ตารางค่าธรรมเนียมของบริการสำหรับหน้า (คำนวณด้วย citizen.calcFee ทุกค่าในช่วงขอบ ±1)
 * → { input: 'qty'|'area'|null, table: {n: fee|CODE}, min, max, fixedFee }
 */
function feeModel(serviceId) {
  const L = C.LIMITS;
  const svc = Q.service.get(serviceId);
  const calc = fnOf(mods.citizen(), 'calcFee');
  const run = (input) => {
    try {
      const v = calc ? calc(serviceId, input) : fallbackCalcFee(serviceId, input, svc);
      return Number(v);
    } catch (e) {
      if (e && e.code && http.ERRORS[e.code]) return e.code;
      throw e;
    }
  };
  if (serviceId === 'SV-01' || serviceId === 'SV-03') {
    const qty = serviceId === 'SV-01';
    const min = (qty ? L.SV01_QTY_MIN : L.SV03_AREA_MIN) - 2;
    const max = (qty ? L.SV01_QTY_MAX : L.SV03_AREA_MAX) + 1;
    const table = {};
    for (let n = min; n <= max; n++) table[n] = run(qty ? { qty: n } : { areaSqm: n });
    return { input: qty ? 'qty' : 'area', table, min, max, fixedFee: null };
  }
  return { input: null, table: {}, min: 0, max: 0, fixedFee: run({}) };
}

function feeDescription(svcRow) {
  if (!svcRow) return '';
  if (svcRow.id === 'SV-01') return `${baht(svcRow.fee)} ต่อฉบับ (1${DASH}5 ฉบับ)`;
  if (svcRow.id === 'SV-03') {
    return `${baht(svcRow.fee)} สำหรับพื้นที่ 1${DASH}100 ตร.ม. · ส่วนเกินคิด ${baht(svcRow.fee_per_sqm)} ต่อ ตร.ม. (ไม่เกิน 500 ตร.ม.)`;
  }
  return `${baht(svcRow.fee)} (อัตราคงที่)`;
}

function docsOf(serviceId) {
  return (C.SERVICES[serviceId] ? C.SERVICES[serviceId].docs : []).map((d) => ({
    key: d.key,
    label: C.DOC_LABEL[d.key] || d.key,
    required: !!d.required,
    pdfOnly: !!d.pdfOnly,
  }));
}

function missingOf(serviceId, files) {
  const have = new Set(files.map((f) => f.docKey));
  return docsOf(serviceId).filter((d) => d.required && !have.has(d.key)).map((d) => d.label);
}

// ───────────────────────────── อ่านข้อมูลคำขอ (ผ่านบล็อกอื่น + สำรอง) ─────────────────────────────

function levelOf(row, nowIso) {
  const f = fnOf(mods.sla(), 'slaLevel');
  if (f) return f(row, nowIso);
  if (!row.case_no) return null;
  if (C.FINAL_STATUSES.includes(row.status)) return 'closed';
  if (row.status === 'NEED_FIX') return 'paused';
  if (row.due_at && clock.toMs(nowIso) > clock.toMs(row.due_at)) return 'overdue';
  return 'normal';
}

function loadCase(user, caseNo) {
  const f = fnOf(mods.citizen(), 'loadCaseForViewer');
  if (f) return f(user, caseNo);
  const row = Q.caseByNo.get(caseNo);
  if (!row || user.role !== 'citizen' || row.applicant_id !== user.id) throw http.apiError('NOT_FOUND');
  return row;
}

function filesOf(caseId) {
  const f = fnOf(mods.workflow(), 'caseFiles');
  const list = f ? f(caseId) : Q.files.all(caseId);
  return (list || []).map((x) => ({
    fileId: x.fileId !== undefined ? x.fileId : x.id,
    name: x.name,
    docKey: x.docKey !== undefined ? x.docKey : x.doc_key,
    size: x.size,
  }));
}

function timelineOf(caseId) {
  const f = fnOf(mods.workflow(), 'timeline');
  if (f) return f(caseId) || [];
  return Q.events.all(caseId).map((e) => ({
    at: e.at,
    actor: e.actor,
    event: e.event,
    fromStatus: e.from_status,
    toStatus: e.to_status,
    note: e.note,
    text: null,
  }));
}

function documentOf(caseId) {
  const f = fnOf(mods.workflow(), 'documentForCase');
  if (f) return f(caseId);
  const d = Q.docByCase.get(caseId);
  return d ? { docNo: d.doc_no, verifyCode: d.verify_code, issuedAt: d.issued_at, validUntil: d.valid_until, signer: d.signer } : null;
}

function verifyOf(code, nowIso) {
  const f = fnOf(mods.workflow(), 'verifyDocument');
  if (f) return f(code, nowIso) || { result: 'NOT_FOUND' };
  const d = Q.docByCode.get(code);
  if (!d) return { result: 'NOT_FOUND' };
  const fields = {
    docNo: d.doc_no, caseNo: d.case_no, applicant: d.applicant, serviceId: d.service_id,
    issuedAt: d.issued_at, validUntil: d.valid_until, signer: d.signer,
  };
  if (!crypto.verifyDocSignature(fields, d.signature)) return { result: 'TAMPERED' };
  return {
    result: clock.bkkDate(nowIso) > d.valid_until ? 'EXPIRED' : 'VALID',
    docNo: d.doc_no,
    applicantMasked: maskName(d.applicant),
    serviceId: d.service_id,
    issuedAt: d.issued_at,
    validUntil: d.valid_until,
    signer: d.signer,
  };
}

/** เลขบัตรเต็มของผู้ยื่น (หน้าของประชาชนเจ้าของ · A-24) */
function applicantIdNo(row, cj) {
  if (cj && cj.idNo) return String(cj.idNo);
  const u = Q.user.get(row.applicant_id);
  if (!u || !u.id_enc) return '';
  try {
    return crypto.decrypt(u.id_enc) || '';
  } catch (e) {
    return '';
  }
}

/** สถานะชำระล่าสุดของร่าง → null (ยังไม่สร้าง QR) | {ref, amount, status PENDING|EXPIRED|PAID, qrCreatedAt, qrExpiresAt, paidAt} */
function paymentOf(row, nowIso) {
  const pays = Q.payments.all(row.id).filter((p) => p.status !== 'VOID');
  const paid = pays.find((p) => p.status === 'PAID');
  if (row.case_no) {
    return {
      ref: paid ? paid.ref : null,
      amount: paid ? paid.amount : row.fee,
      status: 'PAID',
      qrCreatedAt: paid ? paid.qr_created_at : null,
      qrExpiresAt: paid ? paid.qr_expires_at : null,
      paidAt: row.paid_at || (paid && paid.paid_at) || null,
    };
  }
  const p = paid || pays[0];
  if (!p) return null;
  let status = 'PENDING';
  if (p.status === 'PAID') status = 'PAID';
  else if (p.status === 'EXPIRED' || clock.toMs(nowIso) >= clock.toMs(p.qr_expires_at)) status = 'EXPIRED';
  return {
    ref: p.ref,
    amount: p.amount,
    status,
    qrCreatedAt: p.qr_created_at,
    qrExpiresAt: p.qr_expires_at,
    paidAt: p.paid_at || null,
  };
}

// ═════════════════════════════ /login ═════════════════════════════

function loginPage(req, res) {
  const staffFirst = req.query.tab === 'staff';
  const already = req.user
    ? `<p class="alert alert-warn">ขณะนี้เข้าสู่ระบบอยู่ในชื่อ ${esc(req.user.name)} · <a href="/">ไปหน้าหลักของฉัน</a> หรือเข้าสู่ระบบด้วยบัญชีอื่นด้านล่าง</p>`
    : '';
  const tab = (id, testid, label, on) =>
    `<button type="button" role="tab" id="tab-${id}" data-testid="${testid}" aria-controls="panel-${id}" aria-selected="${on}" tabindex="${on ? 0 : -1}">${label}</button>`;
  const body = `<div class="narrow">
<h1>เข้าสู่ระบบ</h1>
<p class="muted">e-Service กลาง ${esc(layout.ORG_NAME)} (หน่วยงานสมมติ) · ThaiD และ SSO ภาครัฐในระบบนี้เป็นตัวจำลอง</p>
${already}
${actionBoxes()}
<div class="tabs" role="tablist" aria-label="ประเภทผู้ใช้">
  ${tab('citizen', 'login-tab-citizen', 'ประชาชน (ThaiD)', !staffFirst)}
  ${tab('staff', 'login-tab-staff', 'เจ้าหน้าที่ (SSO)', staffFirst)}
</div>

<section id="panel-citizen" class="card" role="tabpanel" aria-labelledby="tab-citizen"${staffFirst ? ' hidden' : ''}>
  <h2>ประชาชน · ยืนยันตัวตนด้วย ThaiD (จำลอง)</h2>
  <form id="thaid-form" novalidate>
    <label for="thaid-id">เลขประจำตัวประชาชน 13 หลัก</label>
    <input id="thaid-id" name="idNo" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" data-testid="thaid-id-input" aria-describedby="thaid-hint thaid-error">
    <p id="thaid-hint" class="muted small">กรอกตัวเลข 13 หลักติดกัน ไม่ต้องมีขีด</p>
    <p id="thaid-error" class="field-error" role="alert" data-testid="thaid-error" hidden></p>
    <button type="submit" data-testid="thaid-submit">เข้าสู่ระบบด้วย ThaiD (จำลอง)</button>
  </form>
  <div id="lock-box" class="alert alert-error" role="alert" hidden></div>
  <form id="otp-step" class="otp-step" data-testid="otp-step" novalidate hidden>
    <h3>ยืนยันรหัส OTP</h3>
    <p class="muted small">ระบบจำลองส่งรหัส OTP ไปยังเบอร์ที่ผูกกับ ThaiD แล้ว (โหมดจำลอง: รหัสคือ 123456) · ผิดติดกัน 3 ครั้ง เลขบัตรจะถูกล็อก 15 นาที</p>
    <label for="otp">รหัส OTP 6 หลัก</label>
    <input id="otp" name="otp" type="text" inputmode="numeric" autocomplete="one-time-code" spellcheck="false" data-testid="otp-input" aria-describedby="otp-error otp-left">
    <p id="otp-error" class="field-error" role="alert" data-testid="otp-error" hidden></p>
    <p id="otp-left" class="muted" data-testid="otp-attempts-left" hidden></p>
    <button type="submit" data-testid="otp-submit">ยืนยัน OTP</button>
  </form>
</section>

<section id="panel-staff" class="card" role="tabpanel" aria-labelledby="tab-staff"${staffFirst ? '' : ' hidden'}>
  <h2>เจ้าหน้าที่ · SSO ภาครัฐ (จำลอง)</h2>
  <form id="staff-form" novalidate>
    <label for="staff-user">ชื่อผู้ใช้</label>
    <input id="staff-user" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" data-testid="staff-username">
    <label for="staff-pass">รหัสผ่าน</label>
    <input id="staff-pass" name="password" type="password" autocomplete="current-password" data-testid="staff-password" aria-describedby="staff-error">
    <p id="staff-error" class="field-error" role="alert" data-testid="staff-error" hidden></p>
    <button type="submit" data-testid="staff-submit">เข้าสู่ระบบเจ้าหน้าที่ (SSO ภาครัฐ จำลอง)</button>
  </form>
</section>
<p class="small"><a href="/verify">ตรวจสอบเอกสารดิจิทัลด้วยรหัส 8 ตัว</a> (ไม่ต้องเข้าสู่ระบบ)</p>
</div>`;
  send(req, res, { title: 'เข้าสู่ระบบ', body: body + dataScript({}) + pageScript(clientLogin) });
}

// ═════════════════════════════ /register ═════════════════════════════

function registerPage(req, res) {
  const body = `<div class="narrow">
<h1>ลงทะเบียนใช้งานครั้งแรก</h1>
<p class="lead">ยืนยันตัวตนด้วย ThaiD แล้ว กรุณากรอกข้อมูลติดต่อและให้ความยินยอมก่อนใช้บริการ</p>
${actionBoxes()}
<form id="reg-form" class="card" novalidate>
  <label for="reg-name">ชื่อ-สกุล (จาก ThaiD)</label>
  <input id="reg-name" type="text" value="${esc(req.user.name)}" readonly data-testid="reg-name" aria-describedby="reg-name-hint">
  <p id="reg-name-hint" class="muted small">ดึงจาก ThaiD (จำลอง) แก้ไขไม่ได้</p>

  <label for="reg-mobile">เบอร์มือถือ (บังคับ)</label>
  <input id="reg-mobile" name="mobile" type="tel" inputmode="numeric" autocomplete="tel" data-testid="reg-mobile" aria-required="true" aria-describedby="reg-mobile-hint reg-error-mobile">
  <p id="reg-mobile-hint" class="muted small">ตัวเลข 10 หลัก ขึ้นต้นด้วย 0 เช่น 0812345678</p>
  <p id="reg-error-mobile" class="field-error" role="alert" data-testid="reg-error-mobile" hidden></p>

  <label for="reg-email">อีเมล (ไม่บังคับ)</label>
  <input id="reg-email" name="email" type="email" autocomplete="email" data-testid="reg-email" aria-describedby="reg-error-email">
  <p id="reg-error-email" class="field-error" role="alert" hidden></p>

  <fieldset>
    <legend>ความยินยอมตาม พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล (PDPA)</legend>
    <p class="small">${esc(layout.ORG_NAME)} จะใช้เลขประจำตัวประชาชน ชื่อ-สกุล เบอร์มือถือ และอีเมล เพื่อดำเนินการคำขอและติดต่อกลับเท่านั้น ข้อมูลเลขบัตรและเบอร์โทรถูกเข้ารหัสเมื่อจัดเก็บ</p>
    <label class="check" for="reg-consent"><input type="checkbox" id="reg-consent" name="consent" data-testid="reg-consent" aria-required="true" aria-describedby="reg-error-consent"> <span>ข้าพเจ้ายินยอมให้ประมวลผลข้อมูลส่วนบุคคลตามวัตถุประสงค์ข้างต้น (บังคับ)</span></label>
    <p id="reg-error-consent" class="field-error" role="alert" data-testid="reg-error-consent" hidden></p>
  </fieldset>
  <button type="submit" data-testid="reg-submit">ลงทะเบียน</button>
</form>
</div>`;
  send(req, res, { title: 'ลงทะเบียน', body: body + dataScript({}) + pageScript(clientRegister) });
}

// ═════════════════════════════ /citizen ═════════════════════════════

function homePage(req, res) {
  const now = clock.nowIso();
  const cases = Q.myCases.all(req.user.id);
  const drafts = Q.myDrafts.all(req.user.id);
  const svcRows = Q.services.all();

  const services = svcRows
    .filter((s) => C.SERVICES[s.id])
    .map((s) => {
      const def = C.SERVICES[s.id];
      const docs = def.docs.map((d) => `${C.DOC_LABEL[d.key]}${d.required ? ' ✱' : ''}`).join(' · ');
      return `<article class="card" aria-labelledby="svc-${esc(s.id)}">
  <h3 id="svc-${esc(s.id)}">${esc(s.id)} ${esc(def.name)}</h3>
  <p>ค่าธรรมเนียม ${esc(feeDescription(s))}</p>
  <p class="muted small">กำหนดเสร็จ ${esc(s.sla_days)} วันทำการ · เอกสาร: ${esc(docs)}</p>
  <a class="btn" data-testid="start-service-${esc(s.id)}" href="/citizen/new/${esc(s.id)}">ยื่นคำขอ<span class="sr-only"> ${esc(def.name)}</span></a>
</article>`;
    })
    .join('\n');

  const caseRows = cases
    .map((r) => `<tr data-testid="my-case-row" data-case-no="${esc(r.case_no)}" data-status="${esc(r.status)}">
  <td><a data-testid="row-case-no" href="/citizen/cases/${esc(r.case_no)}">${esc(r.case_no)}</a></td>
  <td data-testid="row-service">${esc(serviceLabel(r.service_id))}</td>
  <td>${statusChip('row-status', r.status)}</td>
  <td>${timeTag('row-due', r.due_at)}</td>
  <td>${levelChip('row-sla-level', levelOf(r, now))}</td>
</tr>`)
    .join('\n');

  const draftRows = drafts
    .map((r) => `<tr data-testid="my-draft-row" data-draft-id="${esc(r.draft_id)}" data-status="${esc(r.status)}">
  <td data-testid="row-draft-id">${esc(r.draft_id)}</td>
  <td data-testid="row-service">${esc(serviceLabel(r.service_id))}</td>
  <td>${statusChip('row-status', r.status)}</td>
  <td>${esc(baht(r.fee))}</td>
  <td><div class="row">
    <a class="btn btn-secondary btn-sm" data-testid="open-draft-btn" href="/citizen/new/${esc(r.service_id)}?draft=${encodeURIComponent(r.draft_id)}">เปิดร่าง<span class="sr-only"> ${esc(r.draft_id)}</span></a>
    <button type="button" class="btn-secondary btn-sm" data-testid="delete-draft-btn" data-draft-id="${esc(r.draft_id)}">ลบร่าง<span class="sr-only"> ${esc(r.draft_id)}</span></button>
  </div></td>
</tr>`)
    .join('\n');

  const body = `<h1 data-testid="citizen-welcome">สวัสดี ${esc(req.user.name)}</h1>
${actionBoxes()}
<h2 id="h-services">เริ่มยื่นคำขอ</h2>
<div class="svc-grid" role="list" aria-labelledby="h-services">
${services.split('<article ').filter(Boolean).map((a) => `<div role="listitem"><article ${a}</div>`).join('\n')}
</div>
<p class="muted small">✱ = เอกสารบังคับ · แนบได้ PDF, JPG, PNG ไม่เกิน 5 MB ต่อไฟล์ สูงสุด 5 ไฟล์ต่อคำขอ · ชำระด้วย PromptPay QR (จำลอง) แล้วจึงได้เลขคำขอ</p>

<h2 id="h-cases">คำขอของฉัน</h2>
${cases.length
    ? `<div class="table-wrap" role="region" aria-labelledby="h-cases" tabindex="0"><table>
<thead><tr><th scope="col">เลขคำขอ</th><th scope="col">บริการ</th><th scope="col">สถานะ</th><th scope="col">กำหนดเสร็จ</th><th scope="col">ระดับเตือน</th></tr></thead>
<tbody>
${caseRows}
</tbody></table></div>`
    : '<p class="muted">ยังไม่มีคำขอที่ยื่นแล้ว</p>'}

<h2 id="h-drafts">ร่างและรายการรอชำระ</h2>
${drafts.length
    ? `<div class="table-wrap" role="region" aria-labelledby="h-drafts" tabindex="0"><table>
<thead><tr><th scope="col">รหัสร่าง</th><th scope="col">บริการ</th><th scope="col">สถานะ</th><th scope="col">ค่าธรรมเนียม</th><th scope="col">จัดการ</th></tr></thead>
<tbody>
${draftRows}
</tbody></table></div>`
    : '<p class="muted">ไม่มีร่างค้างอยู่</p>'}`;
  send(req, res, { title: 'คำขอของฉัน', body: body + dataScript({}) + pageScript(clientHome) });
}

// ═════════════════════════════ /citizen/new/:service ═════════════════════════════

async function wizardPage(req, res) {
  const serviceId = String(req.params.service || '');
  const def = C.SERVICES[serviceId];
  if (!def) return notFound(req, res, 'ไม่พบบริการ');
  const now = clock.nowIso();

  // ---- ร่างเดิม (?draft=) ----
  let row = null;
  const draftParam = typeof req.query.draft === 'string' ? req.query.draft.trim() : '';
  if (draftParam) {
    row = Q.draft.get(draftParam);
    const isDraftState = row && (row.case_no || row.status === 'DRAFT' || row.status === 'PENDING_PAYMENT');
    if (!row || row.applicant_id !== req.user.id || !isDraftState) return notFound(req, res);
    if (row.service_id !== serviceId) {
      return res.redirect(302, `/citizen/new/${encodeURIComponent(row.service_id)}?draft=${encodeURIComponent(row.draft_id)}`);
    }
  }

  const svcRow = Q.service.get(serviceId);
  const model = feeModel(serviceId);
  const docs = docsOf(serviceId);
  const files = row ? Q.files.all(row.id) : [];
  const missing = missingOf(serviceId, files);
  const editable = !row || row.status === 'DRAFT';

  // ---- ขั้นที่แสดง ----
  let step = 1;
  if (!editable) step = 3;
  else if (row) {
    const want = Number(req.query.step);
    if (want === 3) step = missing.length ? 2 : 3;
    else if (want === 2) step = 2;
  }

  // ---- ค่าเริ่มต้นของช่องกรอก ----
  let value = '';
  if (model.input === 'qty') value = row ? row.qty : 1; // A-56 ค่าตั้งต้น 1
  if (model.input === 'area') value = row ? row.area_sqm : '';
  if (value === null || value === undefined) value = '';
  let currentFee = row ? row.fee : null;
  if (!row) {
    if (model.input) {
      const v = model.table[value];
      currentFee = typeof v === 'number' ? v : null;
    } else currentFee = model.fixedFee;
  }

  const stepper = [1, 2, 3]
    .map((n) => `<li id="stepper-${n}"${n === step ? ' aria-current="step"' : ''}>${esc(STEP_NAMES[n])}</li>`)
    .join('');

  const head = `<h1>ยื่นคำขอ · <span data-testid="service-name">${esc(def.name)}</span></h1>
<p class="muted">รหัสบริการ ${esc(serviceId)} · ค่าธรรมเนียม ${esc(feeDescription(svcRow))} · กำหนดเสร็จ ${esc(svcRow ? svcRow.sla_days : '')} วันทำการนับจากวันที่ชำระ</p>
<ol class="stepper" aria-label="ขั้นตอนการยื่นคำขอ">${stepper}</ol>
<p class="wizard-now">ขั้นปัจจุบัน: <strong data-testid="wizard-step">${esc(STEP_NAMES[step])}</strong></p>
<p id="draft-box"${row ? '' : ' hidden'}>รหัสร่าง <strong data-testid="draft-id">${esc(row ? row.draft_id : '')}</strong> <span class="muted small">(ยังไม่มีเลขคำขอ จนกว่าจะชำระเงินสำเร็จ)</span></p>
${actionBoxes()}`;

  let sections = '';
  if (editable) {
    sections += step1Html(serviceId, model, value, currentFee, step);
    sections += step2Html(serviceId, docs, files, missing, step);
    sections += step3DraftHtml(currentFee, step);
  } else {
    sections += await step3PaymentHtml(row, now);
  }

  const data = {
    serviceId,
    input: model.input,
    table: model.table,
    tableMin: model.min,
    tableMax: model.max,
    fixedFee: model.fixedFee,
    draftId: row ? row.draft_id : null,
    savedValue: row ? (model.input ? String(value) : 'fixed') : null,
    fee: currentFee,
    showFeeError: value !== '',
    editable,
    step,
    files,
    docs,
    docLabels: C.DOC_LABEL,
    stepNames: STEP_NAMES,
  };
  send(req, res, {
    title: `ยื่นคำขอ ${def.name}`,
    body: head + sections + dataScript(data) + pageScript(clientWizard),
  });
}

function step1Html(serviceId, model, value, fee, step) {
  let field = '';
  if (model.input === 'qty') {
    field = `<label for="fee-input">จำนวนฉบับ (1${DASH}5 ฉบับ)</label>
    <input id="fee-input" name="qty" type="number" min="1" max="5" step="1" inputmode="numeric" value="${esc(value)}" data-testid="qty-input" aria-describedby="fee-error">`;
  } else if (model.input === 'area') {
    field = `<label for="fee-input">พื้นที่อาคาร (ตร.ม. จำนวนเต็ม 1${DASH}500)</label>
    <input id="fee-input" name="areaSqm" type="number" min="1" max="500" step="1" inputmode="numeric" value="${esc(value)}" data-testid="area-input" aria-describedby="fee-hint fee-error">
    <p id="fee-hint" class="muted small">1${DASH}100 ตร.ม. คิดอัตราฐาน · ส่วนที่เกิน 100 ตร.ม. คิดเพิ่มต่อ ตร.ม. · เกิน 500 ตร.ม. ต้องยื่นที่สำนักงาน</p>`;
  } else {
    field = '<p>บริการนี้ไม่ต้องกรอกข้อมูลเพิ่ม ค่าธรรมเนียมเป็นอัตราคงที่</p>';
  }
  const valid = typeof fee === 'number';
  return `<section id="step-1" class="card" aria-labelledby="h-step-1"${step === 1 ? '' : ' hidden'}>
  <h2 id="h-step-1" tabindex="-1">1. กรอกข้อมูล</h2>
  <form id="form-step-1" novalidate>
    ${field}
    <p id="fee-error" class="field-error" role="alert" data-testid="fee-error" hidden></p>
    <p class="fee-line">ค่าธรรมเนียม <output id="fee-total" for="fee-input" data-testid="fee-total" aria-live="polite">${esc(valid ? baht(fee) : DASH)}</output></p>
    <div class="row">
      <button type="button" class="btn-secondary" data-testid="save-draft-btn">บันทึกร่าง</button>
      <button type="submit" data-testid="to-upload-btn"${valid ? '' : ' disabled'}>ถัดไป: แนบเอกสาร</button>
    </div>
  </form>
</section>
`;
}

function fileItemsHtml(files) {
  return files
    .map((f) => `<li data-testid="file-item" data-name="${esc(f.name)}" data-doc-key="${esc(f.docKey)}" data-file-id="${esc(f.fileId)}">
      <span class="file-name">${esc(f.name)}</span>
      <span class="muted">${esc(C.DOC_LABEL[f.docKey] || f.docKey)} · ${esc(fileSize(f.size))}</span>
      <button type="button" class="btn-secondary btn-sm" data-testid="file-remove-btn" aria-label="ลบไฟล์ ${esc(f.name)}">ลบ</button>
    </li>`)
    .join('\n');
}

function step2Html(serviceId, docs, files, missing, step) {
  const all = [...docs, { key: 'extra', label: C.DOC_LABEL.extra, required: false, multiple: true }];
  const inputs = all
    .map((d) => {
      const note = d.required ? ' <span aria-hidden="true">✱</span><span class="sr-only"> (บังคับ)</span>' : ' <span class="muted small">(ไม่บังคับ)</span>';
      const hint = d.pdfOnly ? '<p class="muted small" id="hint-' + d.key + '">PDF เท่านั้น</p>' : d.multiple ? '<p class="muted small" id="hint-' + d.key + '">เลือกได้หลายไฟล์</p>' : '';
      const described = hint ? `upload-help hint-${d.key}` : 'upload-help';
      return `<div class="upload-field">
      <label for="up-${d.key}">${esc(d.label)}${note}</label>
      <input type="file" id="up-${d.key}" name="file" data-doc-key="${d.key}" data-testid="upload-input-${d.key}"${d.multiple ? ' multiple' : ''} aria-describedby="${described}">
      ${hint}
    </div>`;
    })
    .join('\n    ');
  const missingHtml = missing.length
    ? `<p class="alert alert-warn" data-testid="missing-docs">${esc('ยังขาดเอกสาร: ' + missing.join(', '))}</p>`
    : '';
  return `<section id="step-2" class="card" aria-labelledby="h-step-2"${step === 2 ? '' : ' hidden'}>
  <h2 id="h-step-2" tabindex="-1">2. แนบเอกสาร</h2>
  <p id="upload-help" class="muted small">รองรับ PDF, JPG, PNG (ตรวจจากเนื้อไฟล์) ไม่เกิน 5 MB ต่อไฟล์ · แนบได้สูงสุด 5 ไฟล์ต่อคำขอ · ✱ = เอกสารบังคับ · เลือกไฟล์แล้วระบบอัปโหลดทันที</p>
  <div class="upload-grid">
    ${inputs}
  </div>
  <p class="alert alert-error" role="alert" data-testid="upload-error" hidden></p>
  <p id="upload-busy" class="muted small" role="status" aria-live="polite"></p>
  <h3 id="h-files" tabindex="-1">ไฟล์ที่แนบแล้ว <span id="file-count" class="muted small">(${files.length}/${C.LIMITS.MAX_FILES})</span></h3>
  <ul id="file-list" class="file-list">
    ${fileItemsHtml(files)}
  </ul>
  <p id="no-files" class="muted"${files.length ? ' hidden' : ''}>ยังไม่มีไฟล์แนบ</p>
  <div id="missing-box" aria-live="polite">${missingHtml}</div>
  <div class="row">
    <button type="button" class="btn-secondary" id="back-to-1">ย้อนกลับ</button>
    <button type="button" data-testid="to-payment-btn"${missing.length ? ' disabled' : ''}>ไปชำระเงิน</button>
  </div>
</section>
`;
}

/** ขั้น 3 ของร่างที่ยังไม่สร้าง QR (แสดงฝั่งเบราว์เซอร์เมื่อกด to-payment-btn) */
function step3DraftHtml(fee, step) {
  return `<section id="step-3" class="card" aria-labelledby="h-step-3"${step === 3 ? '' : ' hidden'}>
  <h2 id="h-step-3" tabindex="-1">3. ชำระเงิน</h2>
  <p class="fee-line">ยอดที่ต้องชำระ <strong data-testid="payment-amount">${esc(baht(fee))}</strong></p>
  <p>กด “สร้าง QR” แล้วสแกนจ่ายด้วยแอปธนาคาร (PromptPay จำลอง) ภายใน 15 นาที · ยอดถูกล็อกเมื่อสร้าง QR · เลขคำขอออกเมื่อชำระสำเร็จ</p>
  <div class="row">
    <button type="button" class="btn-secondary" id="back-to-2">ย้อนกลับ</button>
    <button type="button" data-testid="create-qr-btn">สร้าง QR</button>
  </div>
</section>
`;
}

/** ขั้น 3 ของร่างที่สร้าง QR แล้ว/ชำระแล้ว (เรนเดอร์ฝั่งเซิร์ฟเวอร์ · ปุ่มสร้าง QR/ตรวจสอบ → โหลดหน้าใหม่) */
async function step3PaymentHtml(row, now) {
  const p = paymentOf(row, now);
  const amount = p ? p.amount : row.fee;
  let inner = '';
  if (!p) {
    inner = `<p>ยังไม่ได้สร้าง QR</p>
  <div class="row"><button type="button" data-testid="create-qr-btn">สร้าง QR</button></div>`;
  } else if (p.status === 'PAID') {
    inner = `<p>สถานะการชำระ: <span class="chip" data-testid="payment-status" data-status="PAID">${esc(C.PAYMENT_STATUS_LABEL.PAID)}</span></p>
  <section class="card" aria-labelledby="h-receipt">
    <h3 id="h-receipt">ใบเสร็จรับเงิน (จำลอง)</h3>
    <dl class="kv">
      <dt>เลขคำขอ</dt><dd data-testid="submitted-case-no">${esc(row.case_no)}</dd>
      <dt>เลขใบเสร็จ</dt><dd data-testid="receipt-no">${esc(row.receipt_no)}</dd>
      <dt>ยอดชำระ</dt><dd data-testid="receipt-amount">${esc(baht(amount))}</dd>
      <dt>ชำระเมื่อ</dt><dd>${timeTag('receipt-paid-at', p.paidAt)}</dd>
      ${p.ref ? `<dt>เลขอ้างอิง</dt><dd>${esc(p.ref)}</dd>` : ''}
    </dl>
  </section>
  <p class="muted small">ติดตามสถานะและกำหนดเสร็จได้ที่หน้าคำขอ</p>
  <a class="btn" data-testid="go-case-btn" href="/citizen/cases/${esc(row.case_no)}">ดูคำขอ</a>`;
  } else {
    const expired = p.status === 'EXPIRED';
    let qr = '';
    if (!expired) {
      const src = await qrDataUrl(`EGOV-PROMPTPAY-SIM;ref=${p.ref};amount=${amount}.00`);
      qr = src
        ? `<figure class="qr-box"><img data-testid="qr-image" src="${src}" alt="QR ชำระเงิน (จำลอง) เลขอ้างอิง ${esc(p.ref)} ยอด ${esc(baht(amount))}" width="200" height="200">`
        : `<figure class="qr-box"><div data-testid="qr-image" role="img" aria-label="QR ชำระเงิน (จำลอง) เลขอ้างอิง ${esc(p.ref)}" class="card">QR จำลอง ${esc(p.ref)}</div>`;
      qr += `<figcaption>สแกนด้วยแอปธนาคาร (PromptPay จำลอง)</figcaption></figure>`;
    }
    inner = `${qr}
  <dl class="kv">
    <dt>เลขอ้างอิง</dt><dd data-testid="qr-ref">${esc(p.ref)}</dd>
    <dt>อายุ QR</dt><dd>${timeTag('qr-expires', p.qrExpiresAt, 'หมดอายุ ' + thaiDateTime(p.qrExpiresAt))}</dd>
    <dt>สถานะการชำระ</dt><dd><span class="chip" data-testid="payment-status" data-status="${expired ? 'EXPIRED' : 'PENDING'}">${esc(C.PAYMENT_STATUS_LABEL[expired ? 'EXPIRED' : 'PENDING'])}</span></dd>
  </dl>
  ${expired ? `<p class="alert alert-error" role="alert" data-testid="qr-expired-msg">${esc(http.ERRORS.QR_EXPIRED[1])}</p>` : ''}
  <div class="row">
    ${expired ? '<button type="button" data-testid="regenerate-qr-btn">สร้าง QR ใหม่</button>' : ''}
    <button type="button" class="${expired ? 'btn-secondary' : ''}" data-testid="refresh-payment-btn" data-ref="${esc(p.ref)}">ตรวจสอบการชำระเงิน</button>
  </div>`;
  }
  const summary = [
    row.qty ? `จำนวน ${esc(row.qty)} ฉบับ` : '',
    row.area_sqm ? `พื้นที่ ${esc(row.area_sqm)} ตร.ม.` : '',
  ].filter(Boolean).join(' · ');
  return `<section id="step-3" class="card" aria-labelledby="h-step-3">
  <h2 id="h-step-3" tabindex="-1">3. ชำระเงิน</h2>
  ${summary ? `<p class="muted">${summary}</p>` : ''}
  <p class="fee-line">ยอดที่ต้องชำระ <strong data-testid="payment-amount">${esc(baht(amount))}</strong></p>
  ${inner}
</section>
`;
}

// ═════════════════════════════ /citizen/cases/:caseNo ═════════════════════════════

async function casePage(req, res) {
  const caseNo = String(req.params.caseNo || '');
  let row;
  try {
    row = loadCase(req.user, caseNo);
  } catch (e) {
    if (e && e.code === 'NOT_FOUND') return notFound(req, res);
    if (e && e.code === 'FORBIDDEN') return forbidden(req, res);
    throw e;
  }
  if (!row || !row.case_no) return notFound(req, res);

  const now = clock.nowIso();
  const cjFn = fnOf(mods.citizen(), 'caseJson');
  const cj = cjFn ? cjFn(row, req.user, now) : null;
  const level = levelOf(row, now);
  const idNo = applicantIdNo(row, cj);
  const applicant = Q.user.get(row.applicant_id);
  const files = filesOf(row.id);
  const events = timelineOf(row.id);
  const doc = documentOf(row.id);
  const status = row.status;
  const closed = status === 'COMPLETED' || status === 'REJECTED';

  // ---- สรุป ----
  const detail = [
    row.qty ? `จำนวน ${esc(row.qty)} ฉบับ` : '',
    row.area_sqm ? `พื้นที่ ${esc(row.area_sqm)} ตร.ม.` : '',
  ].filter(Boolean).join(' · ');
  const stepText = row.service_id === 'SV-03' && row.step ? C.SV03_STEP_LABEL[row.step] : null;
  const summary = `<section class="card" aria-labelledby="h-summary">
  <h2 id="h-summary">สรุปคำขอ</h2>
  <dl class="kv">
    <dt>สถานะ</dt><dd>${statusChip('case-status', status)}</dd>
    <dt>บริการ</dt><dd data-testid="case-service">${esc(serviceLabel(row.service_id))}</dd>
    ${stepText ? `<dt>ขั้นตอน</dt><dd data-testid="case-step">${esc(stepText)}</dd>` : ''}
    ${detail ? `<dt>รายละเอียด</dt><dd>${detail}</dd>` : ''}
    <dt>ค่าธรรมเนียม</dt><dd data-testid="case-fee">${esc(baht(row.fee))}</dd>
    <dt>ยื่น (ชำระ) เมื่อ</dt><dd>${timeEl(row.paid_at)}${row.receipt_no ? ` · ใบเสร็จ ${esc(row.receipt_no)}` : ''}</dd>
    <dt>กำหนดเสร็จ</dt><dd>${timeTag('sla-due', row.due_at)}</dd>
    <dt>ระดับเตือน</dt><dd>${levelChip('sla-level', level)}</dd>
    ${closed ? `<dt>ปิดงานเมื่อ</dt><dd>${timeTag('closed-at', row.closed_at)}</dd>` : ''}
    ${status === 'CANCELLED' && row.cancelled_at ? `<dt>ยกเลิกเมื่อ</dt><dd>${timeEl(row.cancelled_at)}</dd>` : ''}
    <dt>ผู้ยื่น</dt><dd>${esc(applicant ? applicant.name : '')}</dd>
    <dt>เลขประจำตัวประชาชน</dt><dd data-testid="case-id-full">${esc(formatId(idNo))}</dd>
  </dl>
</section>`;

  // ---- ส่งแก้ไข (NEED_FIX) ----
  let fixHtml = '';
  if (status === 'NEED_FIX') {
    const canFix = !row.fix_deadline || clock.toMs(now) < clock.toMs(row.fix_deadline);
    const docOptions = [...docsOf(row.service_id), { key: 'extra', label: C.DOC_LABEL.extra }]
      .map((d) => `<option value="${esc(d.key)}"${d.key === 'extra' ? ' selected' : ''}>${esc(d.label)}</option>`)
      .join('');
    fixHtml = `<section class="card attention" aria-labelledby="h-fix">
  <h2 id="h-fix">คำขอถูกตีกลับให้แก้ไขเอกสาร</h2>
  <p>เหตุผลจากเจ้าหน้าที่: <strong data-testid="return-reason-display">${esc(row.return_reason || '')}</strong></p>
  <p>ส่งแก้ไขได้ถึง ${timeTag('fix-deadline', row.fix_deadline)} <span class="muted small">(7 วันนับจากเวลาที่ถูกตีกลับ · เลยกำหนดระบบจะยกเลิกคำขออัตโนมัติ · ระหว่างนี้หยุดนับเวลา SLA)</span></p>
  ${canFix
    ? `<form id="fix-form" novalidate>
    <label for="fix-doc-key">ประเภทเอกสารที่แนบใหม่</label>
    <select id="fix-doc-key" name="docKey">${docOptions}</select>
    <label for="fix-files">แนบไฟล์ใหม่ (ไม่บังคับ · PDF, JPG, PNG ไม่เกิน 5 MB)</label>
    <input type="file" id="fix-files" name="files" multiple data-testid="fix-upload-input">
    <div class="row" style="margin-top:12px"><button type="submit" data-testid="submit-fix-btn">ส่งแก้ไข</button></div>
  </form>`
    : `<p class="alert alert-error">${esc(http.ERRORS.FIX_WINDOW_EXPIRED[1])}</p>`}
</section>`;
  }

  // ---- ยกเลิก (เฉพาะ SUBMITTED ที่ยังไม่มีผู้รับ) ----
  let cancelHtml = '';
  if (status === 'SUBMITTED' && !row.owner) {
    cancelHtml = `<section class="card" aria-labelledby="h-cancel">
  <h2 id="h-cancel">ยกเลิกคำขอ</h2>
  <p class="muted small">ยกเลิกได้เฉพาะก่อนเจ้าหน้าที่รับเรื่อง</p>
  <button type="button" class="btn-danger" data-testid="cancel-case-btn" aria-expanded="false" aria-controls="cancel-box">ยกเลิกคำขอ</button>
  <div id="cancel-box" class="card confirm-box" role="group" aria-labelledby="cancel-title" hidden>
    <p id="cancel-title"><strong>ยืนยันการยกเลิกคำขอ ${esc(row.case_no)}</strong></p>
    <p class="alert alert-warn" data-testid="cancel-confirm-text">ค่าธรรมเนียมที่ชำระแล้วไม่คืน</p>
    <div class="row">
      <button type="button" class="btn-danger" data-testid="confirm-cancel-btn">ยืนยันยกเลิก</button>
      <button type="button" class="btn-secondary" id="cancel-no">ไม่ยกเลิก</button>
    </div>
  </div>
</section>`;
  }

  // ---- ผล (ไม่อนุมัติ/ยกเลิก) ----
  let resultHtml = '';
  if (status === 'REJECTED' || status === 'CANCELLED') {
    resultHtml = `<section class="card" aria-labelledby="h-result">
  <h2 id="h-result">${status === 'REJECTED' ? 'ผลพิจารณา: ไม่อนุมัติ' : 'คำขอถูกยกเลิก'}</h2>
  ${status === 'REJECTED' && row.reject_reason ? `<p>เหตุผล: ${esc(row.reject_reason)}</p>` : ''}
  <p class="alert alert-warn" data-testid="no-refund-note">ค่าธรรมเนียมที่ชำระแล้วไม่คืน</p>
</section>`;
  }

  // ---- เอกสารดิจิทัล ----
  let docHtml = '';
  if (doc && doc.docNo) {
    const verifyUrl = `${http.baseUrl(req)}/verify/${doc.verifyCode}`;
    const src = await qrDataUrl(verifyUrl);
    const qr = src
      ? `<img data-testid="doc-qr" data-url="${esc(verifyUrl)}" src="${src}" alt="QR สำหรับตรวจสอบเอกสาร ${esc(doc.docNo)}" width="160" height="160">`
      : `<div data-testid="doc-qr" data-url="${esc(verifyUrl)}" role="img" aria-label="QR สำหรับตรวจสอบเอกสาร ${esc(doc.docNo)}">${esc(verifyUrl)}</div>`;
    // download-doc-btn ไม่ใส่แอตทริบิวต์ download: Chromium จัดการ <a download> เป็นดาวน์โหลดโดยตรง ทำให้ test ดักคำขอด้วย route ไม่ได้
    // (API ตอบ Content-Disposition: attachment อยู่แล้ว ผู้ใช้จึงได้ไฟล์ดาวน์โหลดและอยู่หน้าเดิม)
    docHtml = `<section class="card" aria-labelledby="h-doc">
  <h2 id="h-doc">เอกสารดิจิทัล</h2>
  <dl class="kv">
    <dt>เลขเอกสาร</dt><dd data-testid="doc-no">${esc(doc.docNo)}</dd>
    <dt>รหัสตรวจสอบ</dt><dd data-testid="verify-code">${esc(doc.verifyCode)}</dd>
    ${doc.issuedAt ? `<dt>ออกเมื่อ</dt><dd>${timeEl(doc.issuedAt)}</dd>` : ''}
    ${doc.validUntil ? `<dt>ใช้ได้ถึง</dt><dd><time datetime="${esc(doc.validUntil)}" data-iso="${esc(doc.validUntil)}">${esc(thaiDate(doc.validUntil))}</time></dd>` : ''}
    ${doc.signer ? `<dt>ผู้ลงนาม</dt><dd>${esc(doc.signer)}</dd>` : ''}
  </dl>
  <figure class="qr-box">${qr}<figcaption>ผู้รับเอกสารสแกนเพื่อตรวจสอบที่ <a href="/verify/${esc(encodeURIComponent(doc.verifyCode))}">หน้าตรวจสอบเอกสาร</a></figcaption></figure>
  <a class="btn" data-testid="download-doc-btn" href="/api/documents/${esc(encodeURIComponent(doc.docNo))}/pdf">ดาวน์โหลดเอกสาร</a>
</section>`;
  }

  // ---- ไฟล์แนบ ----
  const filesHtml = `<section class="card" aria-labelledby="h-files">
  <h2 id="h-files">เอกสารแนบ</h2>
  ${files.length
    ? `<ul class="file-list">
    ${files.map((f) => `<li data-testid="doc-item" data-name="${esc(f.name)}" data-file-id="${esc(f.fileId)}">
      <a data-testid="doc-download-link" href="/api/files/${esc(encodeURIComponent(f.fileId))}" download="${esc(f.name)}">${esc(f.name)}</a>
      <span class="muted">${esc(C.DOC_LABEL[f.docKey] || f.docKey || '')}${f.size ? ' · ' + esc(fileSize(f.size)) : ''}</span>
    </li>`).join('\n    ')}
  </ul>`
    : '<p class="muted">ไม่มีไฟล์แนบ</p>'}
</section>`;

  // ---- ไทม์ไลน์ ----
  const items = events
    .map((ev) => {
      const text = ev.text || EVENT_TEXT[ev.event] || ev.event;
      const note = ev.note && EVENT_NOTE_PUBLIC.has(ev.event) && !String(text).includes(ev.note) ? ` · <span class="muted">${esc(ev.note)}</span>` : '';
      const move = !ev.text && ev.toStatus && ev.fromStatus !== ev.toStatus
        ? ` <span class="muted small">(${esc(ev.fromStatus ? (C.STATUS_LABEL[ev.fromStatus] || ev.fromStatus) + ' → ' : '')}${esc(C.STATUS_LABEL[ev.toStatus] || ev.toStatus)})</span>`
        : '';
      return `<li data-testid="timeline-item" data-iso="${esc(ev.at)}" data-event="${esc(ev.event || '')}">${timeEl(ev.at)} ${esc(text)}${note}${move}</li>`;
    })
    .join('\n    ');
  const timelineHtml = `<section class="card" aria-labelledby="h-timeline">
  <h2 id="h-timeline">ไทม์ไลน์</h2>
  ${items ? `<ol class="timeline" data-testid="case-timeline">
    ${items}
  </ol>` : '<p class="muted" data-testid="case-timeline">ยังไม่มีเหตุการณ์</p>'}
</section>`;

  const body = `<p><a href="/citizen">← กลับไปคำขอของฉัน</a></p>
<h1>คำขอ <span data-testid="case-no">${esc(row.case_no)}</span></h1>
${actionBoxes()}
${summary}
${fixHtml}
${cancelHtml}
${resultHtml}
${docHtml}
${filesHtml}
${timelineHtml}`;
  send(req, res, {
    title: `คำขอ ${row.case_no}`,
    body: body + dataScript({ caseNo: row.case_no }) + pageScript(clientCase),
  });
}

// ═════════════════════════════ /verify ═════════════════════════════

function verifyFormHtml(value) {
  return `<form class="card" method="get" action="/verify" aria-labelledby="h-verify-form">
  <h2 id="h-verify-form">ตรวจเอกสารฉบับอื่น</h2>
  <label for="verify-code-input">รหัสตรวจสอบ 8 ตัว (A${DASH}Z, 0${DASH}9)</label>
  <input id="verify-code-input" name="code" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${esc(value || '')}">
  <div class="row" style="margin-top:8px"><button type="submit">ตรวจสอบ</button></div>
</form>`;
}

function verifyIndex(req, res) {
  const code = typeof req.query.code === 'string' ? req.query.code.trim() : '';
  if (code) return res.redirect(302, `/verify/${encodeURIComponent(code)}`);
  const body = `<div class="narrow">
<h1>ตรวจสอบเอกสารดิจิทัล</h1>
<p>กรอกรหัสตรวจสอบ 8 ตัวที่พิมพ์อยู่บนเอกสาร หรือสแกน QR บนเอกสาร</p>
${verifyFormHtml('')}
</div>`;
  send(req, res, { title: 'ตรวจสอบเอกสาร', body });
}

function verifyPage(req, res) {
  const code = String(req.params.code || '').trim();
  const v = verifyOf(code, clock.nowIso());
  const result = v && VERIFY_LABEL[v.result] ? v.result : 'NOT_FOUND';
  const showDetail = result === 'VALID' || result === 'EXPIRED';
  const detail = showDetail
    ? `<dl class="kv">
    <dt>เลขเอกสาร</dt><dd data-testid="verify-doc-no">${esc(v.docNo)}</dd>
    <dt>ผู้ยื่น</dt><dd data-testid="verify-applicant">${esc(v.applicantMasked)}</dd>
    <dt>บริการ</dt><dd data-testid="verify-service">${esc(serviceLabel(v.serviceId))}</dd>
    <dt>วันที่ออก</dt><dd>${timeTag('verify-issued', v.issuedAt)}</dd>
    <dt>ใช้ได้ถึง</dt><dd>${timeTag('verify-expires', v.validUntil, thaiDate(v.validUntil))}</dd>
    <dt>ผู้ลงนาม</dt><dd data-testid="verify-signer">${esc(v.signer)}</dd>
  </dl>`
    : '';
  const body = `<div class="narrow">
<h1>ตรวจสอบเอกสารดิจิทัล</h1>
<section class="card" aria-labelledby="h-verify">
  <h2 id="h-verify">ผลการตรวจสอบ</h2>
  <p class="verify-result"><span class="chip" data-testid="verify-result" data-result="${result}">${esc(VERIFY_LABEL[result])}</span></p>
  <p>${esc(VERIFY_EXPLAIN[result])}</p>
  ${detail}
  <p class="muted small">ลายเซ็นดิจิทัลในระบบนี้เป็นตัวจำลอง (HMAC-SHA256) ของ ${esc(layout.ORG_NAME)} (หน่วยงานสมมติ)</p>
</section>
${verifyFormHtml('')}
</div>`;
  send(req, res, { status: result === 'NOT_FOUND' ? 404 : 200, title: 'ตรวจสอบเอกสาร', body });
}

// ═════════════════════════════ สคริปต์ฝั่งเบราว์เซอร์ ═════════════════════════════
// ฟังก์ชันด้านล่างถูกส่งเป็นข้อความ (fn.toString()) ไปให้เบราว์เซอร์ · ห้ามอ้างตัวแปร/โมดูลฝั่ง Node

/* eslint-disable no-var, prefer-arrow-callback */

/** ตัวช่วยร่วม → H */
function clientHelpers() {
  var E = window.Egov;
  var el = document.getElementById('b09-data');
  var DATA = el ? JSON.parse(el.textContent) : {};
  var MSG = DATA.msgs || {};
  function $(id) { return document.getElementById(id); }
  function tid(t, root) { return (root || document).querySelector('[data-testid="' + t + '"]'); }
  function setText(node, text) {
    if (!node) return;
    node.textContent = text || '';
    node.hidden = !text;
  }
  function errorText(res, fallbackCode) {
    var d = res && res.data;
    if (d && typeof d.message === 'string' && d.message) return d.message;
    if (d && d.code && MSG[d.code]) return MSG[d.code];
    if (res && res.status === 401) return MSG.UNAUTHENTICATED;
    if (res && res.status === 403) return MSG.FORBIDDEN;
    if (res && res.status === 404) return MSG.NOT_FOUND;
    if (fallbackCode && MSG[fallbackCode]) return MSG[fallbackCode];
    return 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง';
  }
  function actionError(text) { setText(tid('action-success'), ''); setText(tid('action-error'), text); }
  function actionOk(text) { setText(tid('action-error'), ''); setText(tid('action-success'), text); }
  function clearActions() { setText(tid('action-error'), ''); setText(tid('action-success'), ''); }
  function call(method, url, body) {
    return E.api(method, url, body).catch(function () {
      return { ok: false, status: 0, data: { message: 'เชื่อมต่อระบบไม่ได้ กรุณาลองใหม่อีกครั้ง' } };
    });
  }
  return { E: E, DATA: DATA, MSG: MSG, $: $, tid: tid, setText: setText, errorText: errorText, actionError: actionError, actionOk: actionOk, clearActions: clearActions, call: call };
}

/** /login */
function clientLogin(H) {
  var tabs = [H.$('tab-citizen'), H.$('tab-staff')];
  function select(tab, focus) {
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      H.$(t.getAttribute('aria-controls')).hidden = !on;
    });
    if (focus) tab.focus();
  }
  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () { select(t, false); });
    t.addEventListener('keydown', function (e) {
      var k = e.key;
      if (k === 'ArrowRight' || k === 'ArrowLeft' || k === 'Home' || k === 'End') {
        e.preventDefault();
        var next = k === 'Home' ? 0 : k === 'End' ? tabs.length - 1 : (i + (k === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
        select(tabs[next], true);
      }
    });
  });

  // ---- ประชาชน: ThaiD จำลอง ----
  var idInput = H.$('thaid-id');
  var idErr = H.$('thaid-error');
  var otpStep = H.$('otp-step');
  var otpInput = H.$('otp');
  var otpErr = H.$('otp-error');
  var otpLeft = H.$('otp-left');
  var lockBox = H.$('lock-box');
  var currentId = null;
  var pending = false;

  function hideLock() { lockBox.hidden = true; lockBox.textContent = ''; }
  function showLock(until, message) {
    lockBox.textContent = '';
    var p = document.createElement('p');
    p.setAttribute('data-testid', 'lock-message');
    p.textContent = message || H.MSG.LOCKED;
    lockBox.appendChild(p);
    if (until) {
      var p2 = document.createElement('p');
      p2.appendChild(document.createTextNode('ลองใหม่ได้ตั้งแต่ '));
      var t = document.createElement('time');
      t.setAttribute('data-testid', 'lock-until');
      t.setAttribute('data-iso', until);
      t.setAttribute('datetime', until);
      t.textContent = H.E.thaiDateTime(until);
      p2.appendChild(t);
      lockBox.appendChild(p2);
    }
    lockBox.hidden = false;
    H.setText(otpErr, '');
    H.setText(otpLeft, '');
  }

  H.$('thaid-form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (pending) return;
    pending = true;
    var idNo = idInput.value.trim();
    H.clearActions();
    H.setText(idErr, '');
    idInput.removeAttribute('aria-invalid');
    hideLock();
    otpStep.hidden = true;
    H.setText(otpErr, '');
    H.setText(otpLeft, '');
    currentId = null;
    H.call('POST', '/api/auth/thaid/start', { idNo: idNo }).then(function (r) {
      if (r.ok) {
        currentId = idNo;
        otpInput.value = '';
        otpStep.hidden = false;
        otpInput.focus();
        return;
      }
      if (r.data && r.data.code === 'LOCKED') { showLock(r.data.lockedUntil, r.data.message); return; }
      H.setText(idErr, H.errorText(r, 'INVALID_ID'));
      idInput.setAttribute('aria-invalid', 'true');
      idInput.focus();
    }).then(function () { pending = false; });
  });

  otpStep.addEventListener('submit', function (e) {
    e.preventDefault();
    if (pending || !currentId) return;
    pending = true;
    H.clearActions();
    H.setText(otpErr, '');
    otpInput.removeAttribute('aria-invalid');
    H.call('POST', '/api/auth/thaid/verify', { idNo: currentId, otp: otpInput.value.trim() }).then(function (r) {
      var d = r.data || {};
      if (r.ok) {
        window.location.assign(d.landing || (d.registered === false ? '/register' : '/citizen'));
        return;
      }
      if (d.code === 'LOCKED') { showLock(d.lockedUntil, d.message); otpInput.value = ''; return; }
      H.setText(otpErr, H.errorText(r, 'OTP_INVALID'));
      otpInput.setAttribute('aria-invalid', 'true');
      H.setText(otpLeft, typeof d.attemptsLeft === 'number' ? 'เหลือ ' + d.attemptsLeft + ' ครั้ง' : '');
      otpInput.select();
    }).then(function () { pending = false; });
  });

  // ---- เจ้าหน้าที่: SSO จำลอง ----
  var staffErr = H.$('staff-error');
  var staffPending = false;
  H.$('staff-form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (staffPending) return;
    staffPending = true;
    H.clearActions();
    H.setText(staffErr, '');
    var u = H.$('staff-user');
    var p = H.$('staff-pass');
    H.call('POST', '/api/auth/staff/login', { username: u.value.trim(), password: p.value }).then(function (r) {
      if (r.ok) { window.location.assign((r.data && r.data.landing) || '/'); return; }
      H.setText(staffErr, H.errorText(r, 'INVALID_CREDENTIALS'));
      p.value = '';
      p.focus();
    }).then(function () { staffPending = false; });
  });
}

/** /register */
function clientRegister(H) {
  var form = H.$('reg-form');
  var mob = H.$('reg-mobile');
  var email = H.$('reg-email');
  var consent = H.$('reg-consent');
  var eMob = H.$('reg-error-mobile');
  var eCon = H.$('reg-error-consent');
  var eMail = H.$('reg-error-email');
  var pending = false;
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (pending) return;
    pending = true;
    H.clearActions();
    [eMob, eCon, eMail].forEach(function (x) { H.setText(x, ''); });
    [mob, consent, email].forEach(function (x) { x.removeAttribute('aria-invalid'); });
    var body = { mobile: mob.value.trim(), email: email.value.trim(), consent: consent.checked };
    H.call('POST', '/api/auth/register', body).then(function (r) {
      if (r.ok) { window.location.assign((r.data && r.data.landing) || '/citizen'); return; }
      var d = r.data || {};
      var inv = Array.isArray(d.invalid) ? d.invalid : [];
      var first = null;
      if (d.code === 'INVALID_MOBILE' || inv.indexOf('mobile') >= 0) {
        H.setText(eMob, H.MSG.INVALID_MOBILE);
        mob.setAttribute('aria-invalid', 'true');
        first = first || mob;
      }
      if (d.code === 'CONSENT_REQUIRED' || inv.indexOf('consent') >= 0) {
        H.setText(eCon, H.MSG.CONSENT_REQUIRED);
        consent.setAttribute('aria-invalid', 'true');
        first = first || consent;
      }
      if (inv.indexOf('email') >= 0) {
        H.setText(eMail, d.code === 'BAD_REQUEST' && d.message ? d.message : 'รูปแบบอีเมลไม่ถูกต้อง');
        email.setAttribute('aria-invalid', 'true');
        first = first || email;
      }
      if (!first) H.actionError(H.errorText(r));
      else first.focus();
    }).then(function () { pending = false; });
  });
}

/** /citizen */
function clientHome(H) {
  Array.prototype.forEach.call(document.querySelectorAll('[data-testid="delete-draft-btn"]'), function (b) {
    b.addEventListener('click', function () {
      var id = b.getAttribute('data-draft-id');
      if (!window.confirm('ลบร่าง ' + id + ' ใช่หรือไม่? ลบแล้วกู้คืนไม่ได้')) return;
      H.call('DELETE', '/api/drafts/' + encodeURIComponent(id)).then(function (r) {
        if (r.ok) { window.location.reload(); return; }
        H.actionError(H.errorText(r));
      });
    });
  });
}

/** /citizen/new/:service */
function clientWizard(H) {
  var D = H.DATA;
  var DASH = '–';
  var st = { draftId: D.draftId, saved: D.savedValue, fee: D.fee, files: D.files || [], step: D.step, pending: false };
  var feeInput = H.$('fee-input');
  var feeTotal = H.tid('fee-total');
  var feeErr = H.tid('fee-error');
  var toUpload = H.tid('to-upload-btn');
  var toPay = H.tid('to-payment-btn');
  var uploadErr = H.tid('upload-error');
  var busyEl = H.$('upload-busy');
  var queue = Promise.resolve();

  function wizUrl(step) {
    var u = window.location.pathname;
    if (st.draftId) {
      u += '?draft=' + encodeURIComponent(st.draftId);
      if (step > 1) u += '&step=' + step;
    }
    return u;
  }
  function syncUrl() {
    if (st.draftId && window.history && window.history.replaceState) window.history.replaceState(null, '', wizUrl(st.step));
  }
  function goStep(n, focus) {
    for (var i = 1; i <= 3; i++) {
      var s = H.$('step-' + i);
      if (s) s.hidden = i !== n;
      var li = H.$('stepper-' + i);
      if (li) { if (i === n) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current'); }
    }
    H.tid('wizard-step').textContent = D.stepNames[n];
    st.step = n;
    syncUrl();
    if (focus) { var h = H.$('h-step-' + n); if (h) h.focus(); }
  }

  // ---- ขั้น 1: ค่าธรรมเนียม (ตารางจาก calcFee ฝั่งเซิร์ฟเวอร์) ----
  function evalFee() {
    if (!D.input) return { fee: D.fixedFee };
    var bad = D.input === 'qty' ? 'INVALID_QTY' : 'INVALID_AREA';
    var s = String(feeInput.value).trim();
    if (!/^-?\d+$/.test(s)) return { code: bad };
    var n = parseInt(s, 10);
    var key = String(Math.max(D.tableMin, Math.min(D.tableMax, n)));
    var v = D.table[key];
    if (typeof v === 'number') return key === String(n) ? { fee: v, n: n } : { code: bad };
    return { code: v || bad };
  }
  function renderFee(showErr) {
    var r = evalFee();
    var ok = typeof r.fee === 'number' && isFinite(r.fee);
    if (feeTotal) feeTotal.textContent = ok ? H.E.baht(r.fee) : DASH;
    if (toUpload) toUpload.disabled = !ok;
    if (feeInput) {
      if (!ok && showErr) { H.setText(feeErr, H.MSG[r.code] || H.MSG.BAD_REQUEST); feeInput.setAttribute('aria-invalid', 'true'); }
      else { H.setText(feeErr, ''); feeInput.removeAttribute('aria-invalid'); }
    }
    return r;
  }
  function feeApiError(res) {
    var code = res.data && res.data.code;
    if (code === 'INVALID_QTY' || code === 'INVALID_AREA' || code === 'AREA_TOO_LARGE') {
      H.setText(feeErr, H.errorText(res));
      if (feeInput) feeInput.setAttribute('aria-invalid', 'true');
      if (feeTotal) feeTotal.textContent = DASH;
      if (toUpload) toUpload.disabled = true;
    } else {
      H.actionError(H.errorText(res));
    }
  }
  function setAmount() {
    var amt = H.tid('payment-amount');
    if (amt && typeof st.fee === 'number') amt.textContent = H.E.baht(st.fee);
  }
  /** สร้างร่าง (POST) หรือแก้ค่า (PATCH) ให้ตรงกับช่องกรอก → draftId | null */
  async function ensureDraft() {
    var r = renderFee(true);
    if (typeof r.fee !== 'number') { if (feeInput) feeInput.focus(); return null; }
    var key = D.input ? String(r.n) : 'fixed';
    if (!st.draftId) {
      var body = { serviceId: D.serviceId };
      if (D.input === 'qty') body.qty = r.n;
      if (D.input === 'area') body.areaSqm = r.n;
      var res = await H.call('POST', '/api/drafts', body);
      if (!res.ok || !res.data || !res.data.draftId) { feeApiError(res); return null; }
      st.draftId = res.data.draftId;
      st.fee = typeof res.data.fee === 'number' ? res.data.fee : r.fee;
      st.saved = key;
      H.tid('draft-id').textContent = st.draftId;
      H.$('draft-box').hidden = false;
      syncUrl();
    } else if (st.saved !== key) {
      var patch = {};
      if (D.input === 'qty') patch.qty = r.n; else patch.areaSqm = r.n;
      var res2 = await H.call('PATCH', '/api/drafts/' + encodeURIComponent(st.draftId), patch);
      if (!res2.ok) { feeApiError(res2); return null; }
      st.fee = res2.data && typeof res2.data.fee === 'number' ? res2.data.fee : r.fee;
      st.saved = key;
    }
    setAmount();
    return st.draftId;
  }

  if (feeInput) {
    feeInput.addEventListener('input', function () { renderFee(true); });
    feeInput.addEventListener('change', function () { renderFee(true); });
  }
  var form1 = H.$('form-step-1');
  if (form1) {
    renderFee(D.showFeeError);
    H.tid('save-draft-btn').addEventListener('click', async function () {
      if (st.pending) return;
      st.pending = true;
      H.clearActions();
      try {
        var id = await ensureDraft();
        if (id) H.actionOk('บันทึกร่าง ' + id + ' แล้ว');
      } finally { st.pending = false; }
    });
    form1.addEventListener('submit', async function (e) {
      e.preventDefault();
      if (st.pending) return;
      st.pending = true;
      H.clearActions();
      try {
        var id = await ensureDraft();
        if (id) { renderFiles(); goStep(2, true); }
      } finally { st.pending = false; }
    });
  }

  // ---- ขั้น 2: แนบเอกสาร (อัปโหลดทันทีเมื่อเลือกไฟล์) ----
  function fmtSize(n) {
    if (typeof n !== 'number') return '';
    if (n >= 1048576) return (n / 1048576).toFixed(2) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' ไบต์';
  }
  function missing() {
    var have = {};
    st.files.forEach(function (f) { have[f.docKey] = true; });
    return (D.docs || []).filter(function (d) { return d.required && !have[d.key]; }).map(function (d) { return d.label; });
  }
  function renderFiles() {
    var ul = H.$('file-list');
    if (!ul) return;
    ul.textContent = '';
    st.files.forEach(function (f) {
      var li = document.createElement('li');
      li.setAttribute('data-testid', 'file-item');
      li.setAttribute('data-name', f.name);
      li.setAttribute('data-doc-key', f.docKey);
      li.setAttribute('data-file-id', f.fileId);
      var name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = f.name;
      var meta = document.createElement('span');
      meta.className = 'muted';
      meta.textContent = (D.docLabels[f.docKey] || f.docKey) + ' · ' + fmtSize(f.size);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-secondary btn-sm';
      btn.setAttribute('data-testid', 'file-remove-btn');
      btn.setAttribute('aria-label', 'ลบไฟล์ ' + f.name);
      btn.textContent = 'ลบ';
      btn.addEventListener('click', function () { removeFile(f); });
      li.appendChild(name);
      li.appendChild(document.createTextNode(' '));
      li.appendChild(meta);
      li.appendChild(document.createTextNode(' '));
      li.appendChild(btn);
      ul.appendChild(li);
    });
    H.$('no-files').hidden = st.files.length > 0;
    H.$('file-count').textContent = '(' + st.files.length + '/5)';
    var miss = missing();
    var box = H.$('missing-box');
    box.textContent = '';
    if (miss.length) {
      var p = document.createElement('p');
      p.className = 'alert alert-warn';
      p.setAttribute('data-testid', 'missing-docs');
      p.textContent = 'ยังขาดเอกสาร: ' + miss.join(', ');
      box.appendChild(p);
    }
    if (toPay) toPay.disabled = miss.length > 0 || !st.draftId;
  }
  function normFile(f) {
    return { fileId: f.fileId !== undefined ? f.fileId : f.id, name: f.name, docKey: f.docKey !== undefined ? f.docKey : f.doc_key, size: f.size };
  }
  async function refreshFiles() {
    if (!st.draftId) { renderFiles(); return; }
    var base = '/api/drafts/' + encodeURIComponent(st.draftId);
    var got = null;
    var r = await H.call('GET', base);
    if (r.ok && r.data) {
      [r.data, r.data.item, r.data.draft].forEach(function (c) { if (!got && c && Array.isArray(c.files)) got = c; });
    }
    if (!got) {
      var r2 = await H.call('GET', base + '/files');
      if (r2.ok && r2.data && Array.isArray(r2.data.items)) got = { files: r2.data.items };
    }
    if (got) {
      st.files = got.files.map(normFile);
      if (typeof got.fee === 'number') st.fee = got.fee;
    }
    renderFiles();
  }
  function uploadFrom(inp) {
    var files = Array.prototype.slice.call(inp.files || []);
    if (!files.length) return;
    var docKey = inp.getAttribute('data-doc-key');
    queue = queue.then(async function () {
      H.clearActions();
      H.setText(uploadErr, '');
      if (!st.draftId) { H.setText(uploadErr, H.MSG.NOT_FOUND); return; }
      busyEl.textContent = 'กำลังอัปโหลด…';
      var failed = false;
      for (var i = 0; i < files.length; i++) {
        var fd = new FormData();
        fd.append('docKey', docKey);
        fd.append('file', files[i], files[i].name);
        var r = await H.call('POST', '/api/drafts/' + encodeURIComponent(st.draftId) + '/files', fd);
        if (!r.ok) { H.setText(uploadErr, H.errorText(r)); failed = true; break; }
      }
      try { inp.value = ''; } catch (err) { /* ignore */ }
      await refreshFiles();
      busyEl.textContent = failed ? '' : 'อัปโหลดเรียบร้อย';
    });
  }
  function removeFile(f) {
    queue = queue.then(async function () {
      H.clearActions();
      H.setText(uploadErr, '');
      var r = await H.call('DELETE', '/api/drafts/' + encodeURIComponent(st.draftId) + '/files/' + encodeURIComponent(f.fileId));
      if (!r.ok) H.setText(uploadErr, H.errorText(r));
      await refreshFiles();
      busyEl.textContent = r.ok ? 'ลบไฟล์ ' + f.name + ' แล้ว' : '';
      var h = H.$('h-files');
      if (h) h.focus();
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('input[type=file][data-doc-key]'), function (inp) {
    inp.addEventListener('change', function () { uploadFrom(inp); });
  });
  if (H.$('file-list')) renderFiles();
  if (toPay) {
    toPay.addEventListener('click', function () {
      if (missing().length || !st.draftId) return;
      H.clearActions();
      setAmount();
      goStep(3, true);
    });
  }
  var back1 = H.$('back-to-1');
  if (back1) back1.addEventListener('click', function () { H.clearActions(); goStep(1, true); });
  var back2 = H.$('back-to-2');
  if (back2) back2.addEventListener('click', function () { H.clearActions(); goStep(2, true); });

  // ---- ขั้น 3: QR (สร้างแล้วโหลดหน้าใหม่ให้เซิร์ฟเวอร์เรนเดอร์ QR/สถานะ/ใบเสร็จ) ----
  function createQr() {
    if (st.pending || !st.draftId) return;
    st.pending = true;
    H.clearActions();
    H.call('POST', '/api/drafts/' + encodeURIComponent(st.draftId) + '/payment').then(function (r) {
      if (r.ok) { window.location.replace(wizUrl(3)); return; }
      st.pending = false;
      H.actionError(H.errorText(r));
      if (r.data && r.data.code === 'MISSING_DOCS' && H.$('step-2')) refreshFiles().then(function () { goStep(2, true); });
    });
  }
  ['create-qr-btn', 'regenerate-qr-btn'].forEach(function (t) {
    var b = H.tid(t);
    if (b) b.addEventListener('click', createQr);
  });
  var refreshBtn = H.tid('refresh-payment-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', function () {
      if (st.pending) return;
      st.pending = true;
      H.clearActions();
      H.call('GET', '/api/payments/' + encodeURIComponent(refreshBtn.getAttribute('data-ref'))).then(function (r) {
        if (r.status === 401 || r.status === 0) { st.pending = false; H.actionError(H.errorText(r)); return; }
        window.location.replace(wizUrl(3));
      });
    });
  }
  syncUrl();
}

/** /citizen/cases/:caseNo */
function clientCase(H) {
  var caseNo = H.DATA.caseNo;
  var base = '/api/cases/' + encodeURIComponent(caseNo);
  var pending = false;

  var cancelBtn = H.tid('cancel-case-btn');
  var box = H.$('cancel-box');
  if (cancelBtn && box) {
    var confirmBtn = H.tid('confirm-cancel-btn');
    cancelBtn.addEventListener('click', function () {
      box.hidden = false;
      cancelBtn.setAttribute('aria-expanded', 'true');
      confirmBtn.focus();
    });
    H.$('cancel-no').addEventListener('click', function () {
      box.hidden = true;
      cancelBtn.setAttribute('aria-expanded', 'false');
      cancelBtn.focus();
    });
    confirmBtn.addEventListener('click', function () {
      if (pending) return;
      pending = true;
      H.clearActions();
      H.call('POST', base + '/cancel').then(function (r) {
        if (r.ok) { window.location.reload(); return; }
        pending = false;
        box.hidden = true;
        cancelBtn.setAttribute('aria-expanded', 'false');
        H.actionError(H.errorText(r));
      });
    });
  }

  var fix = H.$('fix-form');
  if (fix) {
    var formOf = function (field, files) {
      var fd = new FormData();
      fd.append('docKey', H.$('fix-doc-key').value);
      files.forEach(function (f) { fd.append(field, f, f.name); });
      return fd;
    };
    fix.addEventListener('submit', async function (e) {
      e.preventDefault();
      if (pending) return;
      pending = true;
      H.clearActions();
      var inp = H.tid('fix-upload-input');
      var files = inp && inp.files ? Array.prototype.slice.call(inp.files) : [];
      var url = base + '/resubmit';
      var r;
      if (!files.length) {
        r = await H.call('POST', url);
      } else {
        r = await H.call('POST', url, formOf('files', files));
        // ชื่อช่องไฟล์ของ API อาจเป็น 'file' (multer: Unexpected field) → ลองอีกครั้ง
        if (!r.ok && r.data && r.data.code === 'BAD_REQUEST' && /unexpected field/i.test(r.data.message || '')) {
          r = await H.call('POST', url, formOf('file', files.slice(0, 1)));
        }
      }
      if (r.ok) { window.location.reload(); return; }
      pending = false;
      H.actionError(H.errorText(r));
    });
  }
}

/* eslint-enable no-var, prefer-arrow-callback */

// ═════════════════════════════ register ═════════════════════════════

function register(app) {
  app.get('/login', loginPage);
  app.get('/register', requirePage.register, registerPage);
  app.get('/citizen', requirePage('citizen'), homePage);
  app.get('/citizen/new', requirePage('citizen'), (req, res) => res.redirect(302, '/citizen'));
  app.get('/citizen/new/:service', requirePage('citizen'), wizardPage);
  app.get('/citizen/cases/:caseNo', requirePage('citizen'), casePage);
  app.get('/verify', verifyIndex);
  app.get('/verify/:code', verifyPage);
}

module.exports = {
  register,
  // สำหรับทดสอบหน่วย/บล็อกอื่น (ไม่บังคับ)
  feeModel,
  paymentOf,
  verifyOf,
};
