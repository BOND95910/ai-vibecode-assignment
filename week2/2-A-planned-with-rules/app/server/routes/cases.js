// B08 · คำขอ: รายการ/รายละเอียด (ประชาชน/เจ้าหน้าที่) · ยกเลิก · ส่งแก้ไข · ไฟล์แนบ · อนุมัติ/ไม่อนุมัติ (CONTRACT 6.2 6.3 6.7)
// ส่วนของเจ้าหน้าที่ (คิว/รับเรื่อง/ตีกลับ/ส่งต่อ/ออกเอกสาร/เลขเต็ม/แจ้งเตือน) อยู่ routes/officer.js และใช้ตัวช่วยที่ export จากไฟล์นี้
// ตรวจสิทธิ์ที่ API ทุกครั้ง · ทุกการเปลี่ยนสถานะ = transaction เดียว (UPDATE มีเงื่อนไขสถานะ) + timeline_events + audit
const multer = require('multer');
const { db, tx } = require('../db');
const { sendError, decrypt, formatId } = require('../util');
const { requireRole } = require('../rbac');
const clock = require('../clock');
const audit = require('../audit');
const sla = require('../sla');
const { bug } = require('../bugs');
const { requiredDocs } = require('../fees');
const drafts = require('./drafts'); // sniff / nextFileId ของ B05 (ตรวจไฟล์กติกาเดียวกัน)
const notify = require('../notify'); // ลง requestHooks ตอนโหลด

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 5;
const DOC_KEYS = ['id-card', 'map', 'site-photo', 'plan', 'deed', 'extra'];
const RETURN_MAX = 2;

const M = {
  notFound: 'ไม่พบคำขอ',
  state: 'สถานะคำขอไม่ถูกต้องสำหรับรายการนี้',
  forbidden: 'ไม่มีสิทธิ์ทำรายการนี้',
  cannotCancel: 'ยกเลิกไม่ได้ คำขอมีเจ้าหน้าที่รับเรื่องแล้ว',
  fixExpired: 'หมดเวลาแก้ไขแล้ว คำขอถูกยกเลิก',
  claimed: 'มีเจ้าหน้าที่รับเรื่องนี้แล้ว',
  workload: 'รับงานได้สูงสุด 10 เรื่อง',
  returnLimit: 'ตีกลับได้สูงสุด 2 ครั้ง',
  reasonShort: 'กรุณากรอกเหตุผลอย่างน้อย 10 ตัวอักษร',
  reasonRequired: 'กรุณากรอกเหตุผล',
};
const E = (status, code, message, extra) => Object.assign(new Error(message), { status, code, extra });
const err = {
  notFound: () => E(404, 'NOT_FOUND', M.notFound),
  state: () => E(409, 'INVALID_STATE', M.state),
  forbidden: () => E(403, 'FORBIDDEN', M.forbidden),
};
// handler ที่ throw E(...) ได้ → ตอบ {code,message}
const h = (fn) => (req, res, next) => {
  try { return fn(req, res, next); } catch (e) {
    if (e && e.status && e.code) return sendError(res, e.status, e.code, e.message, e.extra);
    throw e;
  }
};

const getCase = (no) => db.prepare('SELECT * FROM cases WHERE case_no=?').get(no);
const reasonLen = (r) => (typeof r === 'string' ? Array.from(r.trim()).length : 0);

function slaLevel(c, nowISO) {
  try { return sla.level(c, nowISO || clock.nowISO()); } catch (e) { if (e.code === 'INVALID_TIME') return null; throw e; }
}
const fixExpired = (c) => {
  const t = c.fix_deadline && clock.parseISO(c.fix_deadline);
  return !!t && clock.now().getTime() >= t.getTime();
};

// timeline_events + (เมื่อ event ระบุ) audit ในที่เดียว · เรียกใน tx()
function record(c, { kind, text, actor = null, role = null, from = null, to = null, event, detail = '', time }) {
  db.prepare(
    `INSERT INTO timeline_events (case_no,time,actor,actor_role,kind,text,from_status,to_status) VALUES (?,?,?,?,?,?,?,?)`
  ).run(c.case_no, time || clock.nowISO(), actor, role, kind, text, from, to);
  if (event) audit({ actor: actor || '', role: role || '', event, caseNo: c.case_no, fromStatus: from, toStatus: to, detail });
}

// สิทธิ์ทำรายการต่อผู้เรียก (ให้ UI render ปุ่ม) · API ตรวจซ้ำเองทุกครั้ง · B12 ทำให้ปุ่มตีกลับยังโผล่ (ตามที่ BUGS ระบุ)
function can(c, s) {
  const f = { claim: false, return: false, forward: false, approve: false, reject: false, issue: false, unmask: false, cancel: false, resubmit: false };
  if (!s) return f;
  if (s.role === 'citizen') {
    if (c.user_id === s.userId) {
      f.cancel = c.status === 'SUBMITTED' && !c.owner;
      f.resubmit = c.status === 'NEED_FIX' && !fixExpired(c);
    }
  } else if (s.role === 'officer') {
    const mine = c.owner === s.username && c.status === 'IN_REVIEW';
    f.unmask = true;
    f.claim = !!c.dept && c.dept === s.dept && !c.owner && (c.status === 'SUBMITTED' || c.status === 'IN_REVIEW');
    f.return = mine && (bug('B12') || c.return_count < RETURN_MAX);
    f.forward = mine && c.service_id !== 'SV-01';
    f.approve = f.reject = mine && c.service_id === 'SV-01';
    f.issue = c.status === 'APPROVED' && c.registry_owner === s.username;
  } else if (s.role === 'head') {
    f.unmask = true;
    f.approve = f.reject = c.status === 'PENDING_APPROVAL' && c.service_id !== 'SV-01';
  }
  return f;
}

const STEP_LABEL = { 1: 'ขั้นตอน 1/3 · ฝ่ายทะเบียน', 2: 'ขั้นตอน 2/3 · ฝ่ายโยธา', 3: 'ขั้นตอน 3/3 · หัวหน้าฝ่าย' };
const fileRow = (f) => ({ fileId: f.file_id, name: f.name, docKey: f.doc_key, size: f.size, mime: f.mime });
const filesOf = (no) => db.prepare('SELECT file_id,name,doc_key,size,mime FROM files WHERE case_no=? ORDER BY file_id').all(no).map(fileRow);

// สิทธิ์เปิดไฟล์ของคำขอ (BR-29/A-59) → 'ok' | 'forbidden' | 'notfound'
//  citizen: เจ้าของ (คนอื่น = notfound) · head: ทุกใบ · officer ทะเบียน: ทุกใบที่ชำระแล้ว · officer โยธา: SV-03 ที่ถึงขั้น 2 แล้ว (อยู่ขั้น 2/3 หรือผ่านแล้ว)
function fileScope(c, s) {
  if (s.role === 'citizen') return c.user_id === s.userId ? 'ok' : 'notfound';
  if (s.role === 'head') return 'ok';
  if (s.role === 'officer') {
    if (s.dept === 'registry') return 'ok';
    if (s.dept === 'works') return c.service_id === 'SV-03' && ((c.step || 0) >= 2 || c.dept === 'works' || c.works_owner) ? 'ok' : 'forbidden';
  }
  return 'forbidden';
}

// รายละเอียดคำขอ (CONTRACT 6.7 + ฟิลด์ที่ UI ต้องใช้ · ดู ARCHITECTURE "สัญญาที่ B08 กำหนดเพิ่ม")
// citizen = ได้ idNo เต็ม (ไม่มี idMasked) · officer/head = idMasked เท่านั้น ห้ามมี idNo/เลข 13 หลักใน response
function caseView(c, s, asCitizen) {
  const u = db.prepare('SELECT display_name, id_masked, id_no_enc FROM users WHERE id=?').get(c.user_id) || {};
  const svc = db.prepare('SELECT name FROM services WHERE id=?').get(c.service_id);
  const doc = db.prepare('SELECT * FROM documents WHERE case_no=?').get(c.case_no);
  const ownerName = c.owner && (db.prepare('SELECT display_name FROM users WHERE username=?').get(c.owner) || {}).display_name;
  const files = asCitizen || fileScope(c, s) === 'ok' ? filesOf(c.case_no) : [];
  const base = process.env.BASE_URL || 'http://localhost:3000';
  const out = {
    caseNo: c.case_no, serviceId: c.service_id, serviceName: svc ? svc.name : '', status: c.status,
    step: c.step || null, stepLabel: c.service_id === 'SV-03' && c.step ? STEP_LABEL[c.step] : null, dept: c.dept,
    fee: c.fee, qty: c.qty, areaSqm: c.area_sqm, paidAt: c.paid_at, receiptNo: c.receipt_no,
    dueAt: c.due_at, slaLevel: slaLevel(c),
    owner: c.owner || null, ownerName: ownerName || null,
    returnCount: c.return_count, returnReason: c.return_reason || null,
    fixDeadline: c.status === 'NEED_FIX' ? c.fix_deadline : null,
    rejectReason: c.status === 'REJECTED' ? c.reject_reason : null,
    closedAt: c.closed_at || null,
    applicantName: u.display_name || '',
    docNo: c.doc_no || null, verifyCode: doc ? doc.verify_code : null,
    document: doc ? { docNo: doc.doc_no, verifyCode: doc.verify_code, issuedAt: doc.issued_at, validUntil: doc.valid_until, signer: doc.signer, verifyUrl: `${base}/verify/${doc.verify_code}` } : null,
    timeline: db.prepare('SELECT time,kind,text,actor,actor_role,from_status,to_status FROM timeline_events WHERE case_no=? ORDER BY time, id').all(c.case_no)
      .map((t) => ({ time: t.time, kind: t.kind, text: t.text, actor: asCitizen ? null : t.actor, actorRole: t.actor_role, fromStatus: t.from_status, toStatus: t.to_status })),
    files, docs: files,
    can: can(c, s),
  };
  if (asCitizen) { // เลขเต็มของผู้ยื่นเอง (B06: ประชาชนคนอื่นก็ได้ — นั่นคือบั๊กที่ใส่ตั้งใจ)
    out.idNo = decrypt(u.id_no_enc);
    out.idFormatted = formatId(out.idNo);
  } else {
    out.idMasked = u.id_masked || '';
  }
  return out;
}

// ---- ตรวจไฟล์แนบตอนส่งแก้ไข: กติกาเดียวกับ B05 (ขนาด → ชนิด magic bytes → จำนวน → แบบแปลน PDF) ----
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024 + 1024, files: 10 } }).any();
function parseUpload(req, res, next) {
  upload(req, res, (e) => {
    if (!e) return next();
    if (e.code === 'LIMIT_FILE_SIZE') return sendError(res, 400, 'FILE_TOO_LARGE', 'ไฟล์ใหญ่เกิน 5 MB');
    if (e.name === 'MulterError') return sendError(res, 400, 'UPLOAD_INVALID', 'ข้อมูลอัปโหลดไม่ถูกต้อง');
    next(e);
  });
}
const fixName = (n) => { // multer อ่านชื่อเป็น latin1 → utf8 (ชื่อไทย)
  const u = Buffer.from(String(n || ''), 'latin1').toString('utf8');
  return u.includes('�') ? String(n) : u;
};

module.exports = function (app) {
  const citizen = requireRole('citizen');
  const anyone = requireRole('citizen', 'officer', 'head');

  // รายการของฉันที่มีเลขแล้ว (เรียงเลขมาก → น้อย · FR-09)
  app.get('/api/cases', citizen, (req, res) => {
    const now = clock.nowISO();
    const svc = Object.fromEntries(db.prepare('SELECT id,name FROM services').all().map((r) => [r.id, r.name]));
    const rows = db.prepare('SELECT * FROM cases WHERE user_id=? ORDER BY case_no DESC').all(req.user.userId);
    res.json({
      items: rows.map((c) => ({
        caseNo: c.case_no, serviceId: c.service_id, serviceName: svc[c.service_id] || '', status: c.status,
        step: c.step || null, fee: c.fee, paidAt: c.paid_at, dueAt: c.due_at, slaLevel: slaLevel(c, now),
      })),
    });
  });

  app.get('/api/cases/:caseNo', anyone, h((req, res) => {
    const s = req.user;
    const c = getCase(req.params.caseNo);
    if (!c) throw err.notFound();
    // B06: ข้ามการตรวจเจ้าของ (IDOR) → ประชาชนเปิดของคนอื่นได้
    if (s.role === 'citizen' && c.user_id !== s.userId && !bug('B06')) throw err.notFound();
    res.json(caseView(c, s, s.role === 'citizen'));
  }));

  // ---- ยกเลิก (SUBMITTED ที่ยังไม่มีผู้รับ) · ชนกับ claim: UPDATE มีเงื่อนไขใน tx → สำเร็จฝั่งเดียว ----
  app.post('/api/cases/:caseNo/cancel', citizen, h((req, res) => {
    tx(() => {
      const c = db.prepare('SELECT * FROM cases WHERE case_no=? AND user_id=?').get(req.params.caseNo, req.user.userId);
      if (!c) throw err.notFound(); // ของคนอื่น/ไม่มี = 404 เหมือนกัน
      const now = clock.nowISO();
      const r = db.prepare(
        `UPDATE cases SET status='CANCELLED', closed_at=?, dept='', updated_at=? WHERE case_no=? AND status='SUBMITTED' AND owner IS NULL`
      ).run(now, now, c.case_no);
      if (!r.changes) {
        if (['COMPLETED', 'REJECTED', 'CANCELLED'].includes(c.status)) throw err.state();
        throw E(409, 'CANNOT_CANCEL', M.cannotCancel);
      }
      record(c, { kind: 'CANCEL', text: 'ผู้ยื่นยกเลิกคำขอ', role: 'citizen', from: 'SUBMITTED', to: 'CANCELLED' });
    });
    res.json({ status: 'CANCELLED' });
  }));

  // ---- ส่งแก้ไข (NEED_FIX → IN_REVIEW คืนผู้ถือเดิม ไม่ตรวจเพดาน 10 งาน) ----
  app.post('/api/cases/:caseNo/resubmit', citizen, parseUpload, h((req, res) => {
    notify.autoCancelExpired(); // กันกรณี hook ยังไม่ถูกเรียก: 168:00 พอดีต้องยกเลิกก่อนตัดสิน
    const out = tx(() => {
      const c = db.prepare('SELECT * FROM cases WHERE case_no=? AND user_id=?').get(req.params.caseNo, req.user.userId);
      if (!c) throw err.notFound();
      if (c.status === 'CANCELLED' && db.prepare("SELECT 1 FROM timeline_events WHERE case_no=? AND kind='AUTO_CANCEL'").get(c.case_no)) {
        throw E(409, 'FIX_WINDOW_EXPIRED', M.fixExpired);
      }
      if (c.status !== 'NEED_FIX') throw err.state();
      if (fixExpired(c)) throw E(409, 'FIX_WINDOW_EXPIRED', M.fixExpired);

      // ตรวจไฟล์ใหม่ทั้งหมดก่อนเขียน (ผิดข้อใด = ไม่เก็บสักไฟล์)
      const files = req.files || [];
      const docKey = (req.body && req.body.docKey) || 'extra';
      if (files.length) {
        if (!DOC_KEYS.includes(docKey)) throw E(400, 'INVALID_DOC_KEY', 'ประเภทเอกสารไม่ถูกต้อง');
        for (const f of files) if (f.size > MAX_BYTES) throw E(400, 'FILE_TOO_LARGE', 'ไฟล์ใหญ่เกิน 5 MB');
        for (const f of files) if (!(f.mime = drafts.sniff(f.buffer))) throw E(400, 'FILE_TYPE', 'รองรับเฉพาะไฟล์ PDF, JPG, PNG');
        const have = db.prepare('SELECT COUNT(*) AS n FROM files WHERE case_no=?').get(c.case_no).n;
        if (have + files.length > MAX_FILES) throw E(400, 'FILE_COUNT', 'แนบได้สูงสุด 5 ไฟล์ต่อคำขอ');
        const need = requiredDocs(c.service_id).find((r) => r.docKey === docKey);
        if (need && need.pdfOnly && files.some((f) => f.mime !== 'application/pdf')) throw E(400, 'PLAN_NOT_PDF', 'แบบแปลนต้องเป็นไฟล์ PDF เท่านั้น');
      }

      const now = clock.nowISO();
      // BR-13: กำหนดใหม่ = กำหนดเดิม + วันทำการใน (วันตีกลับ, วันส่งแก้] · sla.js เป็นผู้คิด (ตารางวันหยุด ณ ตอนนี้)
      const due = sla.extendForFix(c.due_at, c.returned_at, now);
      const paused = sla.workingDaysLeft(c.returned_at, now); // = จำนวนวันทำการใน (วันตีกลับ, วันส่งแก้]
      const r = db.prepare(
        `UPDATE cases SET status='IN_REVIEW', due_at=?, returned_at=NULL, fix_deadline=NULL, updated_at=? WHERE case_no=? AND status='NEED_FIX'`
      ).run(due, now, c.case_no);
      if (!r.changes) throw err.state();
      db.prepare(
        `UPDATE case_returns SET resubmitted_at=?, paused_days=? WHERE id=(SELECT id FROM case_returns WHERE case_no=? AND resubmitted_at IS NULL ORDER BY seq DESC LIMIT 1)`
      ).run(now, paused, c.case_no);
      for (const f of files) {
        db.prepare('INSERT INTO files (file_id,draft_id,case_no,user_id,name,doc_key,size,mime,content,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(drafts.nextFileId(), null, c.case_no, c.user_id, fixName(f.originalname), docKey, f.size, f.mime, f.buffer, now);
      }
      record(c, { kind: 'RESUBMIT', text: `ส่งแก้ไขครั้งที่ ${c.return_count}`, role: 'citizen', from: 'NEED_FIX', to: 'IN_REVIEW', time: now });
      return { status: 'IN_REVIEW', dueAt: due };
    });
    res.json(out);
  }));

  // ---- ไฟล์แนบ (BR-29): ลำดับ 401 → 403 บทบาท → 404 ไม่มีคำขอ/ของคนอื่น → 403 นอกขอบเขต ----
  app.get('/api/cases/:caseNo/files', anyone, h((req, res) => {
    const c = getCase(req.params.caseNo);
    if (!c) throw err.notFound();
    const sc = fileScope(c, req.user);
    if (sc === 'notfound') throw err.notFound();
    if (sc === 'forbidden') throw err.forbidden();
    res.json({ items: filesOf(c.case_no) });
  }));

  app.get('/api/files/:fileId', anyone, h((req, res) => {
    const f = db.prepare('SELECT * FROM files WHERE file_id=?').get(req.params.fileId);
    const nf = () => E(404, 'NOT_FOUND', 'ไม่พบไฟล์');
    if (!f) throw nf();
    const c = f.case_no && getCase(f.case_no);
    if (!c) { // ไฟล์ของร่าง (ยังไม่มีคำขอ): เฉพาะเจ้าของ
      if (req.user.role === 'citizen' && f.user_id === req.user.userId) return sendFile(res, f);
      throw nf();
    }
    const sc = fileScope(c, req.user);
    if (sc === 'notfound') throw nf();
    if (sc === 'forbidden') throw err.forbidden();
    sendFile(res, f);
  }));

  // ---- อนุมัติ / ไม่อนุมัติ (FR-16 · BR-21) ----
  // SV-01: ผู้ถือเรื่อง (IN_REVIEW) · SV-02/03: เฉพาะ head ที่ PENDING_APPROVAL · ลำดับ: บทบาท(403) → สถานะ(409) → ผู้ถือ(403) → เหตุผล(400)
  const decider = requireRole('officer', 'head');
  const decide = (kind) => h((req, res) => {
    const s = req.user;
    const out = tx(() => {
      const c = getCase(req.params.caseNo);
      if (!c) throw err.notFound();
      const sv01 = c.service_id === 'SV-01';
      const roleOk = sv01 ? s.role === 'officer' : s.role === 'head';
      // B07: API ไม่เช็กว่าเจ้าหน้าที่อนุมัติ SV-02/03 ได้ไหม (หน้าเว็บไม่มีปุ่มจึงดูปกติ)
      if (!roleOk && !(bug('B07') && kind === 'APPROVE' && s.role === 'officer')) throw err.forbidden();
      if (c.status !== (sv01 ? 'IN_REVIEW' : 'PENDING_APPROVAL')) throw err.state();
      if (sv01 && c.owner !== s.username) throw err.forbidden();
      const now = clock.nowISO();
      if (kind === 'APPROVE') {
        // APPROVED: ไม่มีผู้ถือ (owner NULL) · dept = registry (รอผู้ออกเอกสาร = registry_owner · อยู่ในคิวทะเบียนแบบ data-owner ว่าง)
        const r = db.prepare(
          `UPDATE cases SET status='APPROVED', approver=?, approved_at=?, owner=NULL, dept='registry', updated_at=? WHERE case_no=? AND status=?`
        ).run(s.username, now, now, c.case_no, c.status);
        if (!r.changes) throw err.state();
        record(c, { kind: 'APPROVE', text: 'อนุมัติ', actor: s.username, role: s.role, from: c.status, to: 'APPROVED', event: 'APPROVE', time: now });
        return { status: 'APPROVED' };
      }
      const reason = req.body && req.body.reason;
      if (reasonLen(reason) < 10) throw E(400, 'REASON_TOO_SHORT', M.reasonShort);
      const r = db.prepare(
        `UPDATE cases SET status='REJECTED', approver=?, reject_reason=?, closed_at=?, owner=NULL, dept='', updated_at=? WHERE case_no=? AND status=?`
      ).run(s.username, reason.trim(), now, now, c.case_no, c.status);
      if (!r.changes) throw err.state();
      record(c, { kind: 'REJECT', text: `ไม่อนุมัติ: ${reason.trim()}`, actor: s.username, role: s.role, from: c.status, to: 'REJECTED', event: 'REJECT', detail: reason.trim(), time: now });
      return { status: 'REJECTED', closedAt: now };
    });
    res.json(out);
  });
  app.post('/api/cases/:caseNo/approve', decider, decide('APPROVE'));
  app.post('/api/cases/:caseNo/reject', decider, decide('REJECT'));
};

function sendFile(res, f) {
  res.set({
    'Content-Type': f.mime,
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    'X-Content-Type-Options': 'nosniff',
  }).send(Buffer.from(f.content));
}

// ตัวช่วยร่วมกับ routes/officer.js
Object.assign(module.exports, { M, E, err, h, getCase, can, caseView, slaLevel, record, reasonLen, RETURN_MAX });
