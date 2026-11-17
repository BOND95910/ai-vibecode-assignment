'use strict';
/**
 * API ประชาชน (B04) — ร่าง · ค่าธรรมเนียม · ไฟล์แนบ · ชำระ PromptPay QR จำลอง · คำขอของฉัน · ยกเลิก · ส่งแก้ไข
 * + test hook POST /api/test/payments/:ref/pay (ธนาคารจำลองยิง callback · เฉพาะ TEST_MODE=1)
 *
 * ที่มา: CONTRACT §5 §6.2 §6.7 §8 · DECISIONS §3 §4 §6 §7 §18 · REQUIREMENTS BR-04..BR-11 BR-13 BR-20 BR-22 · INTERFACES §6.3
 * BUG_MODE ในไฟล์นี้ (BUGS.md · INTERFACES §5):
 *   B01 calcFee SV-03 ใช้ area > 101 แทน ≥ 101      B02 อัปโหลด size < 5,242,880 แทน ≤
 *   B05 QR อายุ 15:00 พอดียังจ่ายได้ (≤ แทน <)     B06 loadCaseForViewer ไม่ตรวจเจ้าของ (IDOR)
 *
 * Route (ทั้งหมด requireApi('citizen') ยกเว้นที่ระบุ):
 *   GET    /api/fee-quote?serviceId=&qty=&areaSqm=  → {serviceId, fee}  (ให้หน้า wizard คำนวณสดด้วย calcFee ตัวเดียวกัน)
 *   POST   /api/drafts                        {serviceId, qty?|areaSqm?} → 201 draftJson
 *   GET    /api/drafts                        → {items:[draftJson]} (ร่าง/รอชำระที่ยังไม่มีเลขคำขอ)
 *   GET    /api/drafts/:id                    → draftJson (ของตัวเองเท่านั้น · ชำระแล้วก็ยังเปิดได้)
 *   PATCH  /api/drafts/:id                    {qty|areaSqm} → draftJson (เฉพาะ DRAFT)
 *   DELETE /api/drafts/:id                    → 204 (DRAFT/PENDING_PAYMENT · ref ชำระของร่างหายไปด้วย)
 *   POST   /api/drafts/:id/files              multipart file(s) + docKey → 201 {fileId,name,docKey,size}
 *   GET    /api/drafts/:id/files              → {items}
 *   DELETE /api/drafts/:id/files/:fileId      → 204
 *   POST   /api/drafts/:id/payment            → 201 {ref, amount, status, qrCreatedAt, qrExpiresAt, qrImage, …}
 *   GET    /api/payments/:ref                 → {ref, amount, status PENDING|PAID|EXPIRED, qrCreatedAt, qrExpiresAt, caseNo, receiptNo, paidAt, …}
 *   GET    /api/cases                         → {items:[{caseNo, serviceId, status, dueAt, slaLevel, …}]} เฉพาะของฉันที่มีเลขแล้ว
 *   GET    /api/cases/:caseNo                 (citizen เจ้าของ · officer · head) → caseJson (CONTRACT §6.7)
 *   POST   /api/cases/:caseNo/cancel          → {status:'CANCELLED'} · 409 CANNOT_CANCEL
 *   POST   /api/cases/:caseNo/resubmit        (multipart ไม่บังคับ) → {status:'IN_REVIEW', dueAt} · 409 FIX_WINDOW_EXPIRED / INVALID_STATE
 *   POST   /api/test/payments/:ref/pay        {amount} → {status:'PAID', caseNo, receiptNo, duplicate}
 *
 * ความพร้อมกัน: ทุก handler เป็น sync (ไม่มี await) และงานอ่าน-แล้ว-เขียนอยู่ใน db.transaction → เลขคำขอ/ใบเสร็จไม่ซ้ำ
 * (ชำระพร้อมกัน 6 รายการ · ข้ามปี พ.ศ.) และยกเลิกชนกับรับเรื่องสำเร็จฝั่งเดียว
 */

const QRCode = require('qrcode');
const { db, tx, nextSeq } = require('../db');
const clock = require('../clock');
const { fail, upload, sniffFileType } = require('../http');
const { requireApi } = require('../session');
const { isBug } = require('../bugs');
const { decrypt, randomCode } = require('../crypto');
const { maskId } = require('../format');
const {
  SERVICES, DOC_LABEL, DOC_KEYS, LIMITS, NUMBERING, COUNTER,
  STATUS_LABEL, SV03_STEP_LABEL, SLA_LEVEL_LABEL, PAYMENT_STATUS_LABEL,
} = require('../constants');

/** สถานะที่ยังเป็น "ร่าง" (ยังไม่มีเลขคำขอ) */
const DRAFT_STATUSES = ['DRAFT', 'PENDING_PAYMENT'];
/** บทบาทที่เปิดรายละเอียดคำขอได้ (CONTRACT §6.2) */
const VIEWER_ROLES = ['citizen', 'officer', 'head'];

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const Q = {
  service: db.prepare('SELECT * FROM services WHERE id = ?'),
  caseById: db.prepare('SELECT * FROM cases WHERE id = ?'),
  caseByNo: db.prepare('SELECT * FROM cases WHERE case_no = ?'),
  caseByDraft: db.prepare('SELECT * FROM cases WHERE draft_id = ?'),
  draftsOf: db.prepare(
    `SELECT * FROM cases WHERE applicant_id = ? AND case_no IS NULL AND status IN ('DRAFT','PENDING_PAYMENT')
     ORDER BY length(draft_id), draft_id, id`
  ),
  casesOf: db.prepare('SELECT * FROM cases WHERE applicant_id = ? AND case_no IS NOT NULL ORDER BY case_no DESC'),
  user: db.prepare('SELECT id, name, id_enc FROM users WHERE id = ?'),
  insertDraft: db.prepare(
    `INSERT INTO cases (draft_id, service_id, applicant_id, qty, area_sqm, fee, status, return_count, created_at, updated_at)
     VALUES (@draftId, @serviceId, @applicantId, @qty, @areaSqm, @fee, 'DRAFT', 0, @now, @now)`
  ),
  updateDraftInput: db.prepare(
    "UPDATE cases SET qty = @qty, area_sqm = @areaSqm, fee = @fee, updated_at = @now WHERE id = @id AND status = 'DRAFT'"
  ),
  lockFee: db.prepare(
    "UPDATE cases SET fee = @fee, status = 'PENDING_PAYMENT', updated_at = @now WHERE id = @id AND status = 'DRAFT' AND case_no IS NULL"
  ),
  markPaid: db.prepare(
    `UPDATE cases SET case_no = @caseNo, receipt_no = @receiptNo, paid_at = @now, due_at = @dueAt,
            status = 'SUBMITTED', dept = @dept, step = @step, owner = NULL, updated_at = @now
     WHERE id = @id AND status = 'PENDING_PAYMENT' AND case_no IS NULL`
  ),
  cancel: db.prepare(
    `UPDATE cases SET status = 'CANCELLED', cancelled_at = @now, dept = NULL, owner = NULL, updated_at = @now
     WHERE id = @id AND status = 'SUBMITTED' AND owner IS NULL`
  ),
  resubmit: db.prepare(
    `UPDATE cases SET status = 'IN_REVIEW', due_at = @dueAt, fix_deadline = NULL, updated_at = @now
     WHERE id = @id AND status = 'NEED_FIX'`
  ),
  deleteCase: db.prepare('DELETE FROM cases WHERE id = ?'),
  deleteCaseFiles: db.prepare('DELETE FROM case_files WHERE case_id = ?'),
  deleteCasePayments: db.prepare('DELETE FROM payments WHERE case_id = ?'),
  deleteCaseEvents: db.prepare('DELETE FROM case_events WHERE case_id = ?'),

  files: db.prepare(
    'SELECT id AS fileId, name, doc_key AS docKey, size, mime FROM case_files WHERE case_id = ? ORDER BY rowid'
  ),
  fileKinds: db.prepare('SELECT doc_key, mime FROM case_files WHERE case_id = ?'),
  fileCount: db.prepare('SELECT COUNT(*) AS n FROM case_files WHERE case_id = ?'),
  insertFile: db.prepare(
    `INSERT INTO case_files (id, case_id, doc_key, name, mime, size, data, uploaded_by, created_at)
     VALUES (@id, @caseId, @docKey, @name, @mime, @size, @data, @uploadedBy, @now)`
  ),
  fileExists: db.prepare('SELECT 1 FROM case_files WHERE id = ?'),
  deleteFile: db.prepare('DELETE FROM case_files WHERE id = ? AND case_id = ?'),

  payByRef: db.prepare('SELECT * FROM payments WHERE ref = ?'),
  latestPay: db.prepare('SELECT * FROM payments WHERE case_id = ? ORDER BY rowid DESC LIMIT 1'),
  insertPay: db.prepare(
    `INSERT INTO payments (ref, case_id, amount, status, qr_created_at, qr_expires_at, paid_at)
     VALUES (@ref, @caseId, @amount, 'PENDING', @now, @expiresAt, NULL)`
  ),
  voidPending: db.prepare("UPDATE payments SET status = 'VOID' WHERE case_id = ? AND status = 'PENDING'"),
  voidOthers: db.prepare("UPDATE payments SET status = 'VOID' WHERE case_id = ? AND status = 'PENDING' AND ref <> ?"),
  payPaid: db.prepare("UPDATE payments SET status = 'PAID', paid_at = ? WHERE ref = ? AND status = 'PENDING'"),

  doc: db.prepare('SELECT doc_no, verify_code FROM documents WHERE case_id = ? ORDER BY issued_at DESC, rowid DESC LIMIT 1'),
  event: db.prepare(
    'INSERT INTO case_events (case_id, at, actor, event, from_status, to_status, note) VALUES (?,?,?,?,?,?,?)'
  ),
  hasAutoCancel: db.prepare("SELECT 1 FROM case_events WHERE case_id = ? AND event = 'AUTO_CANCEL' LIMIT 1"),
  syncCounter: db.prepare(
    'INSERT INTO counters(name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = max(value, excluded.value)'
  ),
};

// ---------------------------------------------------------------------------
// ตัวช่วย
// ---------------------------------------------------------------------------

/** require sla.js (B03) แบบ lazy · ยังไม่มีไฟล์ → null (เว็บยังรันได้) */
function slaMod() {
  try {
    return require('../sla');
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes("'../sla'")) return null;
    throw e;
  }
}

/** ค่าจำนวนเต็มจาก number หรือสตริงตัวเลข ("5", " 101 ") · อื่น ๆ → NaN */
function toInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
  if (typeof v === 'string' && /^\s*[-+]?\d+\s*$/.test(v)) return parseInt(v, 10);
  return NaN;
}

/** ยอดเงินจาก callback (number หรือสตริงตัวเลข) · อื่น ๆ → NaN */
function toAmount(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return NaN;
}

function serviceRow(serviceId) {
  return Q.service.get(serviceId);
}

function badService() {
  fail('BAD_REQUEST', {}, 'ไม่พบบริการที่เลือก');
}

function addEvent(caseId, at, actor, event, from, to, note) {
  Q.event.run(caseId, at, actor, event, from || null, to || null, note === undefined ? null : note);
}

/** เลขบัตรเต็ม (13 หลัก) ของผู้ยื่นจากคอลัมน์เข้ารหัส · อ่านไม่ได้ → null */
function applicantIdNo(enc) {
  if (!enc) return null;
  try {
    const plain = decrypt(enc);
    const digits = String(plain || '').replace(/\D/g, '');
    return digits.length === 13 ? digits : plain;
  } catch {
    return null;
  }
}

/** ชื่อไฟล์จาก multer (busboy ถอดเป็น latin1) → UTF-8 · ตัดอักขระควบคุม · ยาวไม่เกิน 200 */
function cleanFileName(name, ext) {
  let s = String(name || '');
  if (/[\u0080-ÿ]/.test(s) && !/[^\u0000-ÿ]/.test(s)) {
    const u = Buffer.from(s, 'latin1').toString('utf8');
    if (!u.includes('�')) s = u;
  }
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return s || `file.${ext || 'bin'}`;
}

/** ชนิดเอกสารที่บริการรับ (ตาม SERVICES.docs) + extra */
function allowedDocKeys(serviceId) {
  return SERVICES[serviceId].docs.map((d) => d.key).concat('extra');
}

/** docKey ของไฟล์ลำดับที่ i: ฟิลด์ docKey (สตริงหรืออาร์เรย์) → ชื่อฟิลด์ไฟล์ถ้าเป็น docKey → 'extra' */
function pickDocKey(body, file, i, serviceId) {
  let k = body ? body.docKey : undefined;
  if (Array.isArray(k)) k = k[i] !== undefined ? k[i] : k[0];
  let key;
  if (typeof k === 'string' && k.trim()) key = k.trim().toLowerCase().replace(/_/g, '-');
  else if (DOC_KEYS.includes(file.fieldname)) key = file.fieldname;
  else key = 'extra';
  if (!allowedDocKeys(serviceId).includes(key)) fail('BAD_REQUEST', {}, 'ประเภทเอกสารไม่ถูกต้องสำหรับบริการนี้');
  return key;
}

/**
 * ตรวจไฟล์ 1 ไฟล์ (BR-06 BR-07 BR-08 · A-49) → ชนิดจริง {mime, ext}
 * ลำดับ: จำนวนไฟล์ (≤ 5 ต่อคำขอ) → ขนาด (≤ 5,242,880 · B02 ใช้ <) → ชนิดจาก magic bytes → แบบแปลนต้อง PDF
 */
function checkFile(buf, docKey, serviceId, currentCount) {
  if (currentCount >= LIMITS.MAX_FILES) fail('FILE_COUNT');
  const size = buf ? buf.length : 0;
  const sizeOk = isBug('B02') ? size < LIMITS.MAX_FILE_BYTES : size <= LIMITS.MAX_FILE_BYTES;
  if (!sizeOk) fail('FILE_TOO_LARGE');
  const type = sniffFileType(buf);
  if (!type) fail('FILE_TYPE');
  const def = SERVICES[serviceId].docs.find((d) => d.key === docKey);
  if (def && def.pdfOnly && type.mime !== 'application/pdf') fail('PLAN_NOT_PDF');
  return type;
}

/** fileId สุ่ม 'F-XXXXXXXXXX' ([A-Z0-9] 10 ตัว → ไม่มีทางเป็นเลข 13 หลักติดกัน · PDPA regex) */
function newFileId() {
  for (;;) {
    const id = 'F-' + randomCode(10);
    if (!Q.fileExists.get(id)) return id;
  }
}

function storeFile(caseId, docKey, file, type, user, now) {
  const rec = {
    id: newFileId(),
    caseId,
    docKey,
    name: cleanFileName(file.originalname, type.ext),
    mime: type.mime,
    size: file.buffer.length,
    data: file.buffer,
    uploadedBy: user.id,
    now,
  };
  Q.insertFile.run(rec);
  return { fileId: rec.id, name: rec.name, docKey, size: rec.size, mime: rec.mime };
}

// ---------------------------------------------------------------------------
// ค่าธรรมเนียม (BR-04 BR-05 · DECISIONS §3)
// ---------------------------------------------------------------------------

/**
 * คำนวณค่าธรรมเนียมจากค่าปัจจุบันในตาราง services (admin แก้ได้)
 * SV-01 = fee × จำนวนฉบับ (1–5) · SV-02 = fee คงที่ · SV-03 พื้นที่ 1–100 = ฐาน · 101–500 = ฐาน + ต่อ ตร.ม. × (พื้นที่ − 100)
 * ผิด → throw ApiError INVALID_QTY | INVALID_AREA | AREA_TOO_LARGE · บริการไม่มี → BAD_REQUEST
 * B01: SV-03 ใช้ area > 101 แทน area ≥ 101 (พื้นที่ 101 ได้ ฿1,000 · 102 ยังถูก)
 * @param {string} serviceId
 * @param {{qty?:number|string, areaSqm?:number|string}} input
 * @param {object} [svcRow] แถว services ({fee, fee_per_sqm}) หรือรูปแบบ listServices ({fee, feePerSqm}) · ไม่ให้ = อ่านจาก DB
 */
function calcFee(serviceId, input, svcRow) {
  if (!SERVICES[serviceId]) badService();
  const svc = svcRow || serviceRow(serviceId);
  if (!svc) badService();
  const { qty, areaSqm } = input || {};
  const base = Number(svc.fee !== undefined && svc.fee !== null ? svc.fee : svc.feeBase) || 0;

  if (serviceId === 'SV-01') {
    const q = toInt(qty);
    if (!Number.isInteger(q) || q < LIMITS.SV01_QTY_MIN || q > LIMITS.SV01_QTY_MAX) fail('INVALID_QTY');
    return base * q;
  }

  if (serviceId === 'SV-03') {
    const a = toInt(areaSqm);
    if (!Number.isInteger(a) || a < LIMITS.SV03_AREA_MIN) fail('INVALID_AREA');
    if (a > LIMITS.SV03_AREA_MAX) fail('AREA_TOO_LARGE');
    const perRaw = svc.fee_per_sqm !== undefined ? svc.fee_per_sqm : svc.feePerSqm;
    const per = Number(perRaw) || 0;
    const first = LIMITS.SV03_BASE_AREA + 1; // 101 = ตร.ม. แรกที่คิดเพิ่ม
    const extra = isBug('B01') ? a > first : a >= first;
    return extra ? base + per * (a - LIMITS.SV03_BASE_AREA) : base;
  }

  return base; // SV-02 คงที่
}

/** ค่าที่กรอกของร่างตามบริการ (SV-01 qty · SV-03 areaSqm) → {qty, areaSqm} ที่เก็บ */
function storedInput(serviceId, input) {
  return {
    qty: serviceId === 'SV-01' ? toInt(input.qty) : null,
    areaSqm: serviceId === 'SV-03' ? toInt(input.areaSqm) : null,
  };
}

/** อ่าน areaSqm จาก body (รองรับชื่อ area_sqm / area ด้วย) */
function bodyArea(b) {
  if (b.areaSqm !== undefined) return b.areaSqm;
  if (b.area_sqm !== undefined) return b.area_sqm;
  return b.area;
}

// ---------------------------------------------------------------------------
// เอกสารที่ขาด (BR-08 · FR-06)
// ---------------------------------------------------------------------------

/** ชื่อไทยของเอกสารบังคับที่ยังขาด เรียงตาม SERVICES.docs เช่น ['แบบแปลน','โฉนด'] · ครบ → [] */
function missingDocs(caseId) {
  const row = Q.caseById.get(caseId);
  if (!row || !SERVICES[row.service_id]) return [];
  const kinds = Q.fileKinds.all(caseId);
  return SERVICES[row.service_id].docs
    .filter((d) => d.required)
    .filter((d) => !kinds.some((f) => f.doc_key === d.key && (!d.pdfOnly || f.mime === 'application/pdf')))
    .map((d) => DOC_LABEL[d.key]);
}

// ---------------------------------------------------------------------------
// ชำระเงิน (BR-09 BR-10 BR-11 · DECISIONS §6 §7)
// ---------------------------------------------------------------------------

/** QR ยังใช้ได้ไหม: (ตอนนี้ − เวลาสร้าง) < 15:00 · B05 ใช้ ≤ (15:00 พอดียังจ่ายได้) */
function qrUsable(pay, nowIso) {
  const age = clock.diffMs(nowIso, pay.qr_created_at);
  return isBug('B05') ? age <= LIMITS.QR_TTL_MS : age < LIMITS.QR_TTL_MS;
}

/** สถานะที่แสดง: PAID · PENDING (ยังใช้ได้) · EXPIRED (หมดอายุ หรือถูกแทนด้วย QR ใหม่) */
function payStatus(pay, nowIso) {
  if (pay.status === 'PAID') return 'PAID';
  if (pay.status === 'PENDING' && qrUsable(pay, nowIso)) return 'PENDING';
  return 'EXPIRED';
}

/** ข้อความใน QR จำลอง (ไม่ใช่ PromptPay จริง) */
function qrPayload(pay) {
  return `MOCK-PROMPTPAY|SAMPLE-CITY-ESERVICE|ref=${pay.ref}|amount=${pay.amount}|expires=${pay.qr_expires_at}`;
}

/** QR เป็นรูป SVG (data URL) สร้างแบบ sync จาก qrcode.create · ผิดพลาด → null */
function qrSvgDataUrl(text) {
  try {
    const qr = QRCode.create(String(text), { errorCorrectionLevel: 'M' });
    const n = qr.modules.size;
    const m = 4;
    const dim = n + m * 2;
    let d = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (qr.modules.get(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
    }
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim * 6}" height="${dim * 6}" shape-rendering="crispEdges">` +
      `<rect width="${dim}" height="${dim}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
    return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
  } catch {
    return null;
  }
}

/**
 * JSON ของรายการชำระ (CONTRACT §6.2 GET /api/payments/:ref)
 * caseNo/receiptNo มีค่าเฉพาะ ref ที่ชำระสำเร็จ
 */
function paymentJson(pay, nowIso, opts = {}) {
  const now = nowIso || clock.nowIso();
  const row = opts.caseRow || Q.caseById.get(pay.case_id);
  const status = payStatus(pay, now);
  const paid = status === 'PAID' && row;
  const out = {
    ref: pay.ref,
    amount: pay.amount,
    status,
    statusLabel: PAYMENT_STATUS_LABEL[status],
    qrCreatedAt: pay.qr_created_at,
    qrExpiresAt: pay.qr_expires_at,
    paidAt: paid ? pay.paid_at || row.paid_at : null,
    caseNo: paid ? row.case_no : null,
    receiptNo: paid ? row.receipt_no : null,
    draftId: row ? row.draft_id : null,
    serviceId: row ? row.service_id : null,
  };
  if (opts.withImage) {
    out.qrPayload = qrPayload(pay);
    out.qrImage = status === 'PENDING' ? qrSvgDataUrl(out.qrPayload) : null;
  }
  return out;
}

/**
 * ธนาคารจำลองยิง callback (เรียกภายใน transaction)
 * ลำดับตรวจ: ไม่มี ref → 404 · ชำระแล้ว → ตอบเลขเดิม duplicate:true (idempotent) · QR หมดอายุ/ถูกแทน → 410 · ยอดไม่ตรง → 422
 * สำเร็จ: ออกเลขคำขอ + ใบเสร็จตามปี พ.ศ. ของเวลาชำระ (ลำดับเดียวกัน A-48) · กำหนดเสร็จ = sla.computeDueAt ครั้งเดียว
 */
function settlePayment(ref, amountRaw, now) {
  const pay = Q.payByRef.get(String(ref || ''));
  if (!pay) fail('NOT_FOUND');
  const row = Q.caseById.get(pay.case_id);
  if (!row) fail('NOT_FOUND');

  if (pay.status === 'PAID') {
    return {
      status: 'PAID', caseNo: row.case_no, receiptNo: row.receipt_no, duplicate: true,
      amount: pay.amount, paidAt: pay.paid_at || row.paid_at,
    };
  }
  if (pay.status !== 'PENDING' || !qrUsable(pay, now)) fail('QR_EXPIRED');
  if (toAmount(amountRaw) !== pay.amount) fail('AMOUNT_MISMATCH');
  if (row.case_no || row.status !== 'PENDING_PAYMENT') fail('INVALID_STATE');

  const be = clock.beYear(now);
  const seq = nextSeq(COUNTER.caseNo(be));
  const caseNo = NUMBERING.caseNo(be, seq);
  const receiptNo = NUMBERING.receiptNo(be, seq);
  Q.syncCounter.run(COUNTER.receiptNo(be), seq);

  const svc = serviceRow(row.service_id);
  const sla = slaMod();
  const dueAt = sla && svc ? sla.computeDueAt(now, svc.sla_days) : null;
  const firstStep = SERVICES[row.service_id].route[0];

  const r = Q.markPaid.run({
    id: row.id, caseNo, receiptNo, now, dueAt,
    dept: firstStep.dept,
    step: row.service_id === 'SV-03' ? 1 : null,
  });
  if (r.changes !== 1) fail('INVALID_STATE');
  Q.payPaid.run(now, pay.ref);
  Q.voidOthers.run(row.id, pay.ref);
  addEvent(row.id, now, 'citizen', 'PAID', 'PENDING_PAYMENT', 'SUBMITTED', receiptNo);

  return { status: 'PAID', caseNo, receiptNo, duplicate: false, amount: pay.amount, paidAt: now };
}

// ---------------------------------------------------------------------------
// ร่าง / คำขอ: โหลดตามสิทธิ์ + รูปแบบ JSON
// ---------------------------------------------------------------------------

/** ร่างของผู้ใช้คนนี้ (ตาม draft_id) · ไม่มี/ของคนอื่น → 404 NOT_FOUND (ไม่เผยว่ามีอยู่) */
function loadDraftForOwner(user, draftId) {
  const row = typeof draftId === 'string' && draftId ? Q.caseByDraft.get(draftId) : null;
  if (!row || !user || row.applicant_id !== user.id) fail('NOT_FOUND');
  return row;
}

/** ร่างที่ยังแก้ได้ (ยังไม่ชำระ) · ชำระแล้ว → 409 INVALID_STATE */
function assertEditableDraft(row) {
  if (row.case_no || !DRAFT_STATUSES.includes(row.status)) fail('INVALID_STATE');
}

/** คำขอ (มีเลขแล้ว) ของประชาชนคนนี้สำหรับทำรายการ (ยกเลิก/ส่งแก้) · ไม่ขึ้นกับบั๊ก B06 */
function loadOwnCase(user, caseNo) {
  const row = typeof caseNo === 'string' && caseNo ? Q.caseByNo.get(caseNo) : null;
  if (!row || !user || row.applicant_id !== user.id) fail('NOT_FOUND');
  return row;
}

/**
 * โหลดคำขอสำหรับผู้ดู (API GET /api/cases/:caseNo และหน้า /citizen/cases/:caseNo · /officer/cases/:caseNo)
 * ไม่ล็อกอิน → 401 · บทบาทอื่นนอกจาก citizen/officer/head → 403 FORBIDDEN
 * citizen: เจ้าของเท่านั้น ไม่ใช่เจ้าของหรือไม่มี → 404 NOT_FOUND (ข้อความเดียวกัน) · B06: ข้ามการตรวจเจ้าของ (IDOR)
 * officer/head: ไม่มี → 404 NOT_FOUND
 */
function loadCaseForViewer(user, caseNo) {
  if (!user) fail('UNAUTHENTICATED');
  if (!VIEWER_ROLES.includes(user.role)) fail('FORBIDDEN');
  const row = typeof caseNo === 'string' && caseNo ? Q.caseByNo.get(caseNo) : null;
  if (!row) fail('NOT_FOUND');
  if (user.role === 'citizen' && row.applicant_id !== user.id && !isBug('B06')) fail('NOT_FOUND');
  return row;
}

/** ระดับเตือนจาก sla.js (B03) · ไม่มีโมดูล → null */
function levelOf(row, now) {
  const sla = slaMod();
  return sla ? sla.slaLevel(row, now) : null;
}

/**
 * JSON ของคำขอตาม CONTRACT §6.7 (+ ฟิลด์ช่วยแสดงผล)
 * citizen เจ้าของ → idNo (เต็ม 13 หลัก) แทน idMasked · คนอื่นทั้งหมด (officer/head) → idMasked เท่านั้น ไม่มี key idNo
 * @param {object} row แถวจากตาราง cases
 * @param {object} user req.user
 * @param {string} [nowIso]
 */
function caseJson(row, user, nowIso) {
  const now = nowIso || clock.nowIso();
  const applicant = Q.user.get(row.applicant_id) || {};
  const idNo = applicantIdNo(applicant.id_enc);
  const isOwner = !!user && user.role === 'citizen' && user.id === row.applicant_id;
  const doc = Q.doc.get(row.id);
  const isSv03 = row.service_id === 'SV-03';
  const step = isSv03 && row.step !== null && row.step !== undefined ? row.step : null;
  const slaLevel = levelOf(row, now);

  const out = {
    caseNo: row.case_no,
    serviceId: row.service_id,
    status: row.status,
    step,
    fee: row.fee,
    paidAt: row.paid_at || null,
    dueAt: row.due_at || null,
    slaLevel,
    owner: row.owner || null,
    returnCount: row.return_count || 0,
    closedAt: row.closed_at || null,
    applicantName: applicant.name || null,
  };
  if (isOwner) out.idNo = idNo;
  else out.idMasked = maskId(idNo);
  out.fixDeadline = row.status === 'NEED_FIX' ? row.fix_deadline || null : null;
  out.docNo = doc ? doc.doc_no : null;
  out.verifyCode = doc ? doc.verify_code : null;

  // ฟิลด์ช่วยแสดงผล (ไม่มีข้อมูลส่วนบุคคลเพิ่ม)
  out.serviceName = SERVICES[row.service_id] ? SERVICES[row.service_id].name : null;
  out.statusLabel = STATUS_LABEL[row.status] || row.status;
  out.stepLabel = step ? SV03_STEP_LABEL[step] || null : null;
  out.slaLevelLabel = slaLevel ? SLA_LEVEL_LABEL[slaLevel] || null : null;
  out.qty = row.qty === undefined ? null : row.qty;
  out.areaSqm = row.area_sqm === undefined ? null : row.area_sqm;
  out.receiptNo = row.receipt_no || null;
  out.dept = row.dept || null;
  out.issuer = row.issuer || null;
  out.approver = row.approver || null;
  out.returnedAt = row.returned_at || null;
  out.returnReason = row.return_reason || null;
  out.rejectReason = row.reject_reason || null;
  out.cancelledAt = row.cancelled_at || null;
  out.draftId = row.draft_id || null;
  out.createdAt = row.created_at || null;
  return out;
}

/** แถวสรุปในรายการคำขอของฉัน (GET /api/cases) */
function caseListItem(row, now) {
  const slaLevel = levelOf(row, now);
  return {
    caseNo: row.case_no,
    serviceId: row.service_id,
    serviceName: SERVICES[row.service_id] ? SERVICES[row.service_id].name : null,
    status: row.status,
    statusLabel: STATUS_LABEL[row.status] || row.status,
    step: row.service_id === 'SV-03' && row.step ? row.step : null,
    fee: row.fee,
    paidAt: row.paid_at || null,
    dueAt: row.due_at || null,
    slaLevel,
    slaLevelLabel: slaLevel ? SLA_LEVEL_LABEL[slaLevel] || null : null,
    receiptNo: row.receipt_no || null,
    closedAt: row.closed_at || null,
    cancelledAt: row.cancelled_at || null,
  };
}

/**
 * JSON ของร่าง (INTERFACES §6.3)
 * { draftId, serviceId, status, fee, qty, areaSqm, files:[{fileId,name,docKey,size}], missing:[…],
 *   payment:{ref,amount,status,qrCreatedAt,qrExpiresAt,…}|null, caseNo, receiptNo, paidAt, … }
 */
function draftJson(row, nowIso) {
  const now = nowIso || clock.nowIso();
  const pay = Q.latestPay.get(row.id);
  return {
    draftId: row.draft_id,
    serviceId: row.service_id,
    serviceName: SERVICES[row.service_id] ? SERVICES[row.service_id].name : null,
    status: row.status,
    statusLabel: STATUS_LABEL[row.status] || row.status,
    fee: row.fee,
    qty: row.qty === undefined ? null : row.qty,
    areaSqm: row.area_sqm === undefined ? null : row.area_sqm,
    files: Q.files.all(row.id),
    missing: missingDocs(row.id),
    payment: pay ? paymentJson(pay, now, { caseRow: row }) : null,
    caseNo: row.case_no || null,
    receiptNo: row.receipt_no || null,
    paidAt: row.paid_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

function register(app, ctx) {
  const citizenOnly = requireApi('citizen');

  // ค่าธรรมเนียมสด (หน้า wizard ใช้แสดง fee-total / fee-error ให้ตรงกับ API และ BUG_MODE)
  app.get('/api/fee-quote', citizenOnly, (req, res) => {
    const serviceId = String(req.query.serviceId || '').trim();
    const fee = calcFee(serviceId, { qty: req.query.qty, areaSqm: bodyArea(req.query) });
    res.json({ serviceId, fee });
  });

  // ---- ร่าง ----
  app.post('/api/drafts', citizenOnly, (req, res) => {
    const b = req.body || {};
    const serviceId = typeof b.serviceId === 'string' ? b.serviceId.trim() : '';
    if (!SERVICES[serviceId]) badService();
    // SV-01 ไม่ส่งจำนวนฉบับ = ค่าตั้งต้น 1 (A-56)
    const input = {
      qty: serviceId === 'SV-01' && (b.qty === undefined || b.qty === null) ? LIMITS.SV01_QTY_MIN : b.qty,
      areaSqm: bodyArea(b),
    };
    const now = clock.nowIso();
    const row = tx(() => {
      const fee = calcFee(serviceId, input, serviceRow(serviceId));
      const draftId = NUMBERING.draftId(nextSeq(COUNTER.draftId));
      const keep = storedInput(serviceId, input);
      const info = Q.insertDraft.run({
        draftId, serviceId, applicantId: req.user.id, qty: keep.qty, areaSqm: keep.areaSqm, fee, now,
      });
      const id = Number(info.lastInsertRowid);
      addEvent(id, now, 'citizen', 'CREATED', null, 'DRAFT', null);
      return Q.caseById.get(id);
    })();
    res.status(201).json(draftJson(row, now));
  });

  app.get('/api/drafts', citizenOnly, (req, res) => {
    const now = clock.nowIso();
    res.json({ items: Q.draftsOf.all(req.user.id).map((r) => draftJson(r, now)) });
  });

  app.get('/api/drafts/:id', citizenOnly, (req, res) => {
    res.json(draftJson(loadDraftForOwner(req.user, req.params.id)));
  });

  // แก้จำนวนฉบับ/พื้นที่ของร่าง (PUT ใช้แทน PATCH ได้)
  app.patch('/api/drafts/:id', citizenOnly, updateDraft);
  app.put('/api/drafts/:id', citizenOnly, updateDraft);
  function updateDraft(req, res) {
    const b = req.body || {};
    const now = clock.nowIso();
    const row = tx(() => {
      const cur = loadDraftForOwner(req.user, req.params.id);
      assertEditableDraft(cur);
      if (cur.status !== 'DRAFT') fail('INVALID_STATE'); // PENDING_PAYMENT: ยอดล็อกแล้ว (A-42)
      const area = bodyArea(b);
      const input = {
        qty: b.qty !== undefined ? b.qty : cur.qty,
        areaSqm: area !== undefined ? area : cur.area_sqm,
      };
      const fee = calcFee(cur.service_id, input);
      const keep = storedInput(cur.service_id, input);
      Q.updateDraftInput.run({ id: cur.id, qty: keep.qty, areaSqm: keep.areaSqm, fee, now });
      return Q.caseById.get(cur.id);
    })();
    res.json(draftJson(row, now));
  }

  app.delete('/api/drafts/:id', citizenOnly, (req, res) => {
    tx(() => {
      const row = loadDraftForOwner(req.user, req.params.id);
      assertEditableDraft(row);
      Q.deleteCaseFiles.run(row.id);
      Q.deleteCasePayments.run(row.id); // ref ชำระของร่างนี้ → 404
      Q.deleteCaseEvents.run(row.id);
      Q.deleteCase.run(row.id);
    })();
    res.status(204).end();
  });

  // ---- ไฟล์แนบของร่าง ----
  app.post('/api/drafts/:id/files', citizenOnly, upload.any(), (req, res) => {
    const files = (req.files || []).filter((f) => f && f.buffer);
    const now = clock.nowIso();
    const row = loadDraftForOwner(req.user, req.params.id);
    assertEditableDraft(row);
    if (!files.length) fail('BAD_REQUEST', {}, 'กรุณาเลือกไฟล์');
    // ทีละไฟล์ตามลำดับ (handler เป็น sync จึงไม่มีคำขออื่นแทรก): ไฟล์ที่ผ่านถูกเก็บ · หยุดที่ไฟล์แรกที่ไม่ผ่าน
    // ไฟล์ที่ถูกปฏิเสธไม่เก็บและไม่นับจำนวน (A-49) · คำขอหลายไฟล์ที่ผิดกลางทาง → error ของไฟล์นั้น + saved = ไฟล์ที่เก็บแล้ว
    const saved = [];
    files.forEach((f, i) => {
      try {
        const docKey = pickDocKey(req.body, f, i, row.service_id);
        const type = checkFile(f.buffer, docKey, row.service_id, Q.fileCount.get(row.id).n);
        saved.push(storeFile(row.id, docKey, f, type, req.user, now));
      } catch (e) {
        if (saved.length && e && e.extra) e.extra = { ...e.extra, saved };
        throw e;
      }
    });
    res.status(201).json({ ...saved[0], items: saved });
  });

  app.get('/api/drafts/:id/files', citizenOnly, (req, res) => {
    const row = loadDraftForOwner(req.user, req.params.id);
    res.json({ items: Q.files.all(row.id) });
  });

  app.delete('/api/drafts/:id/files/:fileId', citizenOnly, (req, res) => {
    tx(() => {
      const row = loadDraftForOwner(req.user, req.params.id);
      assertEditableDraft(row);
      const r = Q.deleteFile.run(String(req.params.fileId || ''), row.id);
      if (!r.changes) fail('NOT_FOUND');
    })();
    res.status(204).end();
  });

  // ---- ชำระเงิน ----
  app.post('/api/drafts/:id/payment', citizenOnly, (req, res) => {
    const now = clock.nowIso();
    const pay = tx(() => {
      const row = loadDraftForOwner(req.user, req.params.id);
      assertEditableDraft(row);
      const missing = missingDocs(row.id);
      if (missing.length) fail('MISSING_DOCS', { missing }, 'ยังขาดเอกสาร: ' + missing.join(', '));
      let amount = row.fee;
      if (row.status === 'DRAFT') {
        // ยอดถูกล็อกตอนเข้า PENDING_PAYMENT ด้วยค่าธรรมเนียมปัจจุบัน (A-42) · QR ใหม่ของคำขอเดิมใช้ยอดที่ล็อก
        amount = calcFee(row.service_id, { qty: row.qty, areaSqm: row.area_sqm });
        if (Q.lockFee.run({ id: row.id, fee: amount, now }).changes !== 1) fail('INVALID_STATE');
      }
      Q.voidPending.run(row.id); // QR เดิมที่ยังไม่จ่ายใช้ไม่ได้อีก (ใช้ QR ล่าสุดเท่านั้น)
      const ref = NUMBERING.payRef(nextSeq(COUNTER.payRef));
      Q.insertPay.run({ ref, caseId: row.id, amount, now, expiresAt: clock.addMs(now, LIMITS.QR_TTL_MS) });
      return Q.payByRef.get(ref);
    })();
    res.status(201).json(paymentJson(pay, now, { withImage: true }));
  });

  app.get('/api/payments/:ref', citizenOnly, (req, res) => {
    const pay = Q.payByRef.get(String(req.params.ref || ''));
    const row = pay ? Q.caseById.get(pay.case_id) : null;
    if (!pay || !row || row.applicant_id !== req.user.id) fail('NOT_FOUND');
    res.json(paymentJson(pay, clock.nowIso(), { withImage: true, caseRow: row }));
  });

  // ธนาคารจำลอง (TEST_MODE=1 เท่านั้น · ไม่ต้องล็อกอิน)
  ctx.testRouter.post('/payments/:ref/pay', (req, res) => {
    const now = clock.nowIso();
    const amount = req.body ? req.body.amount : undefined;
    const out = tx(() => settlePayment(req.params.ref, amount, now))();
    res.status(200).json(out);
  });

  // ---- คำขอของฉัน ----
  app.get('/api/cases', citizenOnly, (req, res) => {
    const now = clock.nowIso();
    res.json({ items: Q.casesOf.all(req.user.id).map((r) => caseListItem(r, now)) });
  });

  app.get('/api/cases/:caseNo', requireApi(...VIEWER_ROLES), (req, res) => {
    const row = loadCaseForViewer(req.user, req.params.caseNo);
    res.json(caseJson(row, req.user));
  });

  // ยกเลิก: เฉพาะ SUBMITTED ที่ยังไม่มีผู้รับ (BR-22 · A-62) · ชนกับรับเรื่อง → สำเร็จฝั่งเดียว (UPDATE มีเงื่อนไข)
  app.post('/api/cases/:caseNo/cancel', citizenOnly, (req, res) => {
    const now = clock.nowIso();
    const out = tx(() => {
      const row = loadOwnCase(req.user, req.params.caseNo);
      if (row.status === 'CANCELLED') fail('INVALID_STATE');
      if (row.status !== 'SUBMITTED' || row.owner) fail('CANNOT_CANCEL');
      if (Q.cancel.run({ id: row.id, now }).changes !== 1) fail('CANNOT_CANCEL');
      addEvent(row.id, now, 'citizen', 'CANCEL', 'SUBMITTED', 'CANCELLED', null);
      return { status: 'CANCELLED', caseNo: row.case_no, cancelledAt: now };
    })();
    res.json(out);
  });

  // ส่งแก้ไข: NEED_FIX ภายใน 168 ชม. (BR-20) → IN_REVIEW ผู้ถือเดิม ขั้นเดิม (A-29 ไม่ตรวจเพดาน 10)
  // กำหนดเสร็จใหม่ = sla.extendDueAt(เดิม, เวลาตีกลับ, ตอนนี้) (BR-13) · แนบไฟล์ใหม่ได้ (ไม่บังคับ · ตรวจแบบเดียวกับอัปโหลด)
  app.post('/api/cases/:caseNo/resubmit', citizenOnly, upload.any(), (req, res) => {
    const files = (req.files || []).filter((f) => f && f.buffer);
    const now = clock.nowIso();
    const out = tx(() => {
      const row = loadOwnCase(req.user, req.params.caseNo);
      if (row.status !== 'NEED_FIX') {
        const expired = row.status === 'CANCELLED' &&
          (Q.hasAutoCancel.get(row.id) || (row.fix_deadline && row.cancelled_at && clock.diffMs(row.cancelled_at, row.fix_deadline) >= 0));
        fail(expired ? 'FIX_WINDOW_EXPIRED' : 'INVALID_STATE');
      }
      const deadline = row.fix_deadline || (row.returned_at ? clock.addMs(row.returned_at, LIMITS.FIX_WINDOW_MS) : null);
      if (deadline && clock.diffMs(now, deadline) >= 0) fail('FIX_WINDOW_EXPIRED'); // 167:59 ส่งได้ · 168:00 ไม่ได้

      const saved = [];
      files.forEach((f, i) => {
        const docKey = pickDocKey(req.body, f, i, row.service_id);
        const type = checkFile(f.buffer, docKey, row.service_id, Q.fileCount.get(row.id).n);
        saved.push(storeFile(row.id, docKey, f, type, req.user, now));
      });

      const sla = slaMod();
      const dueAt = sla && row.due_at && row.returned_at ? sla.extendDueAt(row.due_at, row.returned_at, now) : row.due_at;
      if (Q.resubmit.run({ id: row.id, dueAt, now }).changes !== 1) fail('INVALID_STATE');
      addEvent(row.id, now, 'citizen', 'RESUBMIT', 'NEED_FIX', 'IN_REVIEW',
        saved.length ? `แนบไฟล์ใหม่ ${saved.length} ไฟล์` : null);
      return { status: 'IN_REVIEW', caseNo: row.case_no, dueAt, owner: row.owner || null, files: saved };
    })();
    res.json(out);
  });
}

module.exports = {
  register,
  calcFee,
  missingDocs,
  loadCaseForViewer,
  caseJson,
  draftJson,
  // ตัวช่วยเพิ่มเติมสำหรับหน้า (B09) — ไม่บังคับใช้
  loadDraftForOwner,
  paymentJson,
  qrSvgDataUrl,
};
