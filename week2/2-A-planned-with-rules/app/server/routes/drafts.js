// B05 · ร่างคำขอ + ไฟล์แนบ (FR-04..07, BR-04..08, CONTRACT 6.2) · การสร้าง QR/ชำระเงินเป็นของ B06 (routes/payments.js)
// ค่าธรรมเนียมคิดตอนสร้าง/แก้ร่างแล้วเก็บใน drafts.fee · ยอดที่ล็อกจริงตอนเข้า PENDING_PAYMENT เป็นหน้าที่ B06
const multer = require('multer');
const { db, tx, nextNumber } = require('../db');
const { sendError, formatNo } = require('../util');
const { requireRole } = require('../rbac');
const clock = require('../clock');
const { bug } = require('../bugs');
const { computeFee, requiredDocs, missingDocs } = require('../fees');

const MAX_BYTES = 5 * 1024 * 1024; // 5,242,880 (BR-07 รวมค่านี้)
const MAX_FILES = 5;
const DOC_KEYS = ['id-card', 'map', 'site-photo', 'plan', 'deed', 'extra'];
const E = {
  notFound: ['NOT_FOUND', 'ไม่พบคำขอ'],
  state: ['INVALID_STATE', 'สถานะคำขอไม่ถูกต้องสำหรับรายการนี้'],
  tooLarge: ['FILE_TOO_LARGE', 'ไฟล์ใหญ่เกิน 5 MB'],
  type: ['FILE_TYPE', 'รองรับเฉพาะไฟล์ PDF, JPG, PNG'],
  count: ['FILE_COUNT', 'แนบได้สูงสุด 5 ไฟล์ต่อคำขอ'],
  planPdf: ['PLAN_NOT_PDF', 'แบบแปลนต้องเป็นไฟล์ PDF เท่านั้น'],
  // ไม่อยู่ในตาราง 5 (ดู QUESTIONS.md B05)
  docKey: ['INVALID_DOC_KEY', 'ประเภทเอกสารไม่ถูกต้อง'],
  noFile: ['FILE_REQUIRED', 'กรุณาเลือกไฟล์'],
  upload: ['UPLOAD_INVALID', 'ข้อมูลอัปโหลดไม่ถูกต้อง'],
};
const err = (res, status, [code, message]) => sendError(res, status, code, message);

// ชนิดจริงจาก magic bytes เท่านั้น (ไม่ดูนามสกุล/Content-Type) · ไม่ตรง -> null
function sniff(b) {
  if (b.length >= 4 && b.toString('latin1', 0, 4) === '%PDF') return 'application/pdf';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  return null;
}

// multer อ่านชื่อไฟล์เป็น latin1 -> แปลงกลับ utf8 (ชื่อไทย) · ถ้าไม่ใช่ utf8 ที่ถูกต้องคงเดิม
function fixName(n) {
  const u = Buffer.from(String(n || ''), 'latin1').toString('utf8');
  return u.includes('�') ? String(n) : u;
}

// limits.fileSize ต้อง >= 6 MB เพื่อให้ 5,242,881 เข้ามาถึงตัวตรวจขนาดของเราเอง (ได้ 400 ไม่ใช่ 413/error เฟรมเวิร์ก)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024 + 1024, files: 1 } }).single('file');
function parseUpload(req, res, next) {
  upload(req, res, (e) => {
    if (!e) return next();
    if (e.code === 'LIMIT_FILE_SIZE') return err(res, 400, E.tooLarge);
    if (e.name === 'MulterError') return err(res, 400, E.upload);
    next(e);
  });
}

const fileView = (f) => ({ fileId: f.file_id, name: f.name, docKey: f.doc_key, size: f.size });
const filesOf = (id) => db.prepare('SELECT file_id, name, doc_key, size FROM files WHERE draft_id=? ORDER BY file_id').all(id).map(fileView);

function view(d) {
  return {
    draftId: d.draft_id, serviceId: d.service_id, status: d.status, fee: d.fee,
    qty: d.qty, areaSqm: d.area_sqm, caseNo: d.case_no,
    createdAt: d.created_at, updatedAt: d.updated_at,
  };
}

// โหลดร่างของ "ฉัน" -> req.draft · ของคนอื่น/ไม่มี = 404 เหมือนกัน (ไม่เปิดเผยว่ามีอยู่)
function ownDraft(req, res, next) {
  const d = db.prepare('SELECT * FROM drafts WHERE draft_id=? AND user_id=?').get(req.params.id, req.user.userId);
  if (!d) return err(res, 404, E.notFound);
  req.draft = d;
  next();
}

// ไฟล์แก้ได้ตอน DRAFT / PENDING_PAYMENT (B06 ตรวจเอกสารซ้ำทุกครั้งที่สร้าง QR) · SUBMITTED = ปิดแล้ว
function filesEditable(req, res, next) {
  if (req.draft.status === 'SUBMITTED') return err(res, 409, E.state);
  next();
}

// ถัดไปของ file_id รูป F-0001 (seed ไม่ได้ตั้ง counter ของไฟล์ จึงอ่านจากค่าสูงสุด) · เรียกใน tx()
function nextFileId() {
  const r = db.prepare("SELECT MAX(CAST(SUBSTR(file_id, 3) AS INTEGER)) AS m FROM files WHERE file_id LIKE 'F-%'").get();
  return 'F-' + String(((r && r.m) || 0) + 1).padStart(4, '0');
}

module.exports = function (app) {
  const citizen = requireRole('citizen');

  app.post('/api/drafts', citizen, (req, res) => {
    const b = req.body || {};
    let fee;
    try { ({ fee } = computeFee(b.serviceId, b)); } catch (e) { if (e.status) return sendError(res, e.status, e.code, e.message); throw e; }
    const now = clock.nowISO();
    const draftId = tx(() => {
      const id = formatNo('DR', 0, nextNumber('DR', 0), 4);
      db.prepare(`INSERT INTO drafts (draft_id,user_id,service_id,status,qty,area_sqm,fee,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(id, req.user.userId, b.serviceId, 'DRAFT', b.serviceId === 'SV-01' ? b.qty : null, b.serviceId === 'SV-03' ? b.areaSqm : null, fee, now, now);
      return id;
    });
    res.status(201).json({ draftId, fee });
  });

  // ร่าง = ยังไม่ส่ง (SUBMITTED กลายเป็นคำขอใน /api/cases แล้ว จึงไม่อยู่ในรายการ)
  app.get('/api/drafts', citizen, (req, res) => {
    const rows = db.prepare("SELECT * FROM drafts WHERE user_id=? AND status<>'SUBMITTED' ORDER BY draft_id").all(req.user.userId);
    res.json({ items: rows.map(view) });
  });

  app.get('/api/drafts/:id', citizen, ownDraft, (req, res) => {
    res.json({ ...view(req.draft), files: filesOf(req.draft.draft_id), missing: missingDocs(req.draft.draft_id) });
  });

  // แก้จำนวนฉบับ/พื้นที่ของร่าง (DRAFT เท่านั้น) · คิดค่าธรรมเนียมใหม่จากอัตราปัจจุบัน
  app.put('/api/drafts/:id', citizen, ownDraft, (req, res) => {
    const d = req.draft;
    if (d.status !== 'DRAFT') return err(res, 409, E.state);
    const b = req.body || {};
    const qty = 'qty' in b ? b.qty : d.qty;
    const areaSqm = 'areaSqm' in b ? b.areaSqm : d.area_sqm;
    let fee;
    try { ({ fee } = computeFee(d.service_id, { qty, areaSqm })); } catch (e) { if (e.status) return sendError(res, e.status, e.code, e.message); throw e; }
    db.prepare('UPDATE drafts SET qty=?, area_sqm=?, fee=?, updated_at=? WHERE draft_id=?')
      .run(d.service_id === 'SV-01' ? qty : null, d.service_id === 'SV-03' ? areaSqm : null, fee, clock.nowISO(), d.draft_id);
    res.json({ draftId: d.draft_id, fee });
  });

  app.post('/api/drafts/:id/files', citizen, ownDraft, filesEditable, parseUpload, (req, res) => {
    const d = req.draft;
    const docKey = req.body && req.body.docKey;
    if (!DOC_KEYS.includes(docKey)) return err(res, 400, E.docKey);
    const f = req.file;
    if (!f) return err(res, 400, E.noFile);
    // ลำดับตรวจ (กรณีผิดหลายข้อ): ขนาด -> ชนิด -> จำนวน -> แบบแปลน (ตามลำดับตาราง 5)
    // B02: ใช้ >= แทน > -> ไฟล์ 5,242,880 พอดีถูกปฏิเสธ (5,242,879 ยังรับ)
    if (bug('B02') ? f.size >= MAX_BYTES : f.size > MAX_BYTES) return err(res, 400, E.tooLarge);
    const mime = sniff(f.buffer);
    if (!mime) return err(res, 400, E.type);
    const id = tx(() => {
      const n = db.prepare('SELECT COUNT(*) AS n FROM files WHERE draft_id=?').get(d.draft_id).n;
      if (n >= MAX_FILES) return E.count;
      const need = requiredDocs(d.service_id).find((r) => r.docKey === docKey);
      if (need && need.pdfOnly && mime !== 'application/pdf') return E.planPdf;
      const fid = nextFileId();
      db.prepare('INSERT INTO files (file_id,draft_id,user_id,name,doc_key,size,mime,content,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(fid, d.draft_id, req.user.userId, fixName(f.originalname), docKey, f.size, mime, f.buffer, clock.nowISO());
      return fid;
    });
    if (Array.isArray(id)) return err(res, 400, id);
    const row = db.prepare('SELECT file_id, name, doc_key, size FROM files WHERE file_id=?').get(id);
    res.status(201).json(fileView(row));
  });

  app.delete('/api/drafts/:id/files/:fileId', citizen, ownDraft, filesEditable, (req, res) => {
    const r = db.prepare('DELETE FROM files WHERE file_id=? AND draft_id=?').run(req.params.fileId, req.draft.draft_id);
    if (!r.changes) return err(res, 404, E.notFound);
    res.status(204).end();
  });

  // ลบร่าง: DRAFT / PENDING_PAYMENT ที่ยังไม่ชำระ -> 204 · ref ชำระของร่างนั้นกลายเป็น 404 (ลบแถว payments) · ชำระแล้ว -> 409
  app.delete('/api/drafts/:id', citizen, ownDraft, (req, res) => {
    const id = req.draft.draft_id;
    const out = tx(() => {
      const paid = db.prepare("SELECT 1 FROM payments WHERE draft_id=? AND status='PAID'").get(id);
      if (req.draft.status === 'SUBMITTED' || paid) return false;
      db.prepare('DELETE FROM payments WHERE draft_id=?').run(id);
      db.prepare('DELETE FROM files WHERE draft_id=?').run(id);
      db.prepare('DELETE FROM drafts WHERE draft_id=?').run(id);
      return true;
    });
    if (!out) return err(res, 409, E.state);
    res.status(204).end();
  });
};

module.exports.sniff = sniff;
module.exports.nextFileId = nextFileId;
