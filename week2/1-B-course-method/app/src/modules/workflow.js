'use strict';
/**
 * B06 · งานเจ้าหน้าที่/หัวหน้า — คิว · รับเรื่อง · ตีกลับ · ส่งต่อ · อนุมัติ/ไม่อนุมัติ · ออกเอกสาร
 *        + ไฟล์แนบตามสิทธิ์ · ไทม์ไลน์ · PDF เอกสาร · /api/verify · ยกเลิกอัตโนมัติ 168 ชม. · test hook tamper
 *
 * API (CONTRACT §6.2 §6.3 §6.4 §8 · INTERFACES §6.5 §7):
 *   GET  /api/officer/queue?filter=all|unclaimed|mine     officer·head → {items:[{caseNo,serviceId,applicantName,idMasked,status,step,owner,dueAt,slaLevel}], filter, workload}
 *                                                          (BUG B09: ใส่ idNo เต็มใน JSON · queueRows ไม่เปลี่ยน → หน้าจอยังปิดบัง)
 *   POST /api/officer/cases/:caseNo/claim                 officer แผนกที่ถือเรื่อง → {owner,status} · ลำดับ: สิทธิ์ 403 → ALREADY_CLAIMED → WORKLOAD_LIMIT (B08: ข้าม ALREADY_CLAIMED)
 *   POST /api/officer/cases/:caseNo/return {reason}       ผู้ถือเรื่อง → {status:'NEED_FIX',returnCount,fixDeadline} · RETURN_LIMIT (B12: ข้าม) · REASON_TOO_SHORT
 *   POST /api/officer/cases/:caseNo/forward {note?}       ผู้ถือเรื่อง → {status:'IN_REVIEW',step:2} | {status:'PENDING_APPROVAL'} (เส้นทางอัตโนมัติ เลือกปลายทางไม่ได้)
 *   POST /api/cases/:caseNo/approve                       SV-01 ผู้ถือเรื่อง · SV-02/03 head ที่ PENDING_APPROVAL → {status:'APPROVED'} (B07: officer อนุมัติ SV-02 ได้)
 *   POST /api/cases/:caseNo/reject {reason}               อำนาจเดียวกับ approve → {status:'REJECTED',closedAt}
 *   POST /api/officer/cases/:caseNo/issue                 ผู้ออกเอกสาร (A-27) ที่ APPROVED → {docNo,verifyCode,status:'COMPLETED'}
 *   GET  /api/head/approvals                              head → {items: approvalRows()}
 *   GET  /api/cases/:caseNo/files · GET /api/files/:fileId   ตาม fileAccess (DECISIONS §18) · citizen ไม่ใช่เจ้าของ → 404 · นอกขอบเขต/บทบาทอื่น → 403
 *   GET  /api/cases/:caseNo/timeline                      citizen เจ้าของ · officer · head → {items: timeline()}
 *   GET  /api/documents/:docNo/pdf                        citizen เจ้าของ · officer · head → application/pdf (attachment DOC-….pdf) · citizen อื่น → 404
 *   GET  /api/verify/:code                                ไม่ต้องล็อกอิน → 200 VALID/EXPIRED (+ฟิลด์) · 200 {result:'TAMPERED'} · 404 {result:'NOT_FOUND'}
 *   POST /api/test/documents/:docNo/tamper                (TEST_MODE) แก้ applicant ที่เก็บโดยไม่ลงนามใหม่ → {ok:true} · 404
 *
 * กฎหลัก: DECISIONS §5 §9 §10 §18 · REQUIREMENTS FR-12..18 FR-29 BR-16..21
 * - ทุก action: อ่าน-ตัดสิน-เขียน (cases + case_events + audit) ใน db.transaction เดียว ไม่มี await คั่น → claim ได้คนเดียวแม้ยิงพร้อมกัน
 * - เวลาอ่านจาก clock เท่านั้น · ไม่มี idNo ใน JSON ของเจ้าหน้าที่ (ยกเว้น B09)
 * - B06 (IDOR) อยู่ที่ citizen.loadCaseForViewer — ไฟล์นี้ตรวจเจ้าของเอง (ไฟล์แนบ/PDF/ไทม์ไลน์ไม่รั่วตาม B06)
 */

const fs = require('fs');
const { db, nextSeq } = require('../db');
const clock = require('../clock');
const crypto = require('../crypto');
const format = require('../format');
const { fail, baseUrl } = require('../http');
const { requireApi } = require('../session');
const { logAudit } = require('../audit');
const { isBug } = require('../bugs');
const { SERVICES, LIMITS, NUMBERING, COUNTER, DEPT_LABEL } = require('../constants');

const MAX_WORKLOAD = LIMITS.MAX_WORKLOAD;     // 10 (A-19)
const MAX_RETURNS = LIMITS.MAX_RETURNS;       // 2 (A-20)
const FIX_WINDOW_MS = LIMITS.FIX_WINDOW_MS;   // 168 ชม. (A-21)
const REASON_MIN = LIMITS.REASON_MIN;         // 10 ตัวอักษร (A-12)

/** สถานะที่อยู่ในคิวแผนก (มี dept) · APPROVED = รอออกเอกสาร (data-owner ว่าง) */
const QUEUE_STATUSES = ['SUBMITTED', 'IN_REVIEW', 'APPROVED'];
/** สถานะที่ "รับเรื่อง" ได้เมื่อยังไม่มีผู้ถือ */
const CLAIMABLE = ['SUBMITTED', 'IN_REVIEW'];
const FILTERS = ['all', 'unclaimed', 'mine'];
const CASE_ROLES = ['citizen', 'officer', 'head'];
const STAFF_ROLES = ['officer', 'head'];
const AUTO_CANCEL_NOTE = 'เลยเวลาแก้ไข 168 ชั่วโมง ระบบยกเลิกอัตโนมัติ';
const TAMPER_SUFFIX = ' (ถูกแก้ไข)';

// ---------------------------------------------------------------------------
// statements
// ---------------------------------------------------------------------------

const CASE_WITH_APPLICANT = `SELECT c.*, u.name AS applicant_name, u.id_enc AS applicant_id_enc
  FROM cases c JOIN users u ON u.id = c.applicant_id`;
const Q_IN = QUEUE_STATUSES.map((s) => `'${s}'`).join(', ');

const Q = {
  caseByNo: db.prepare('SELECT * FROM cases WHERE case_no = ?'),
  caseById: db.prepare('SELECT * FROM cases WHERE id = ?'),
  userByUsername: db.prepare('SELECT username, name, role, dept FROM users WHERE username = ?'),
  userById: db.prepare('SELECT id, name, id_enc FROM users WHERE id = ?'),
  workload: db.prepare("SELECT COUNT(*) AS n FROM cases WHERE status = 'IN_REVIEW' AND owner = ?"),
  queueAll: db.prepare(`${CASE_WITH_APPLICANT}
    WHERE c.case_no IS NOT NULL AND c.dept IS NOT NULL AND c.status IN (${Q_IN})
    ORDER BY c.due_at, c.case_no`),
  queueDept: db.prepare(`${CASE_WITH_APPLICANT}
    WHERE c.case_no IS NOT NULL AND c.dept = ? AND c.status IN (${Q_IN})
    ORDER BY c.due_at, c.case_no`),
  approvals: db.prepare(`${CASE_WITH_APPLICANT}
    WHERE c.case_no IS NOT NULL AND c.status = 'PENDING_APPROVAL'
    ORDER BY c.due_at, c.case_no`),
  applicantIdEnc: db.prepare('SELECT u.id_enc FROM cases c JOIN users u ON u.id = c.applicant_id WHERE c.case_no = ?'),
  files: db.prepare('SELECT id, case_id, doc_key, name, mime, size FROM case_files WHERE case_id = ? ORDER BY created_at, rowid'),
  fileById: db.prepare('SELECT * FROM case_files WHERE id = ?'),
  events: db.prepare('SELECT * FROM case_events WHERE case_id = ? ORDER BY at, id'),
  insEvent: db.prepare('INSERT INTO case_events (case_id, at, actor, event, from_status, to_status, note) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  needFix: db.prepare("SELECT id, fix_deadline FROM cases WHERE status = 'NEED_FIX' AND fix_deadline IS NOT NULL"),
  autoCancel: db.prepare(`UPDATE cases SET status = 'CANCELLED', cancelled_at = @at, dept = NULL, owner = NULL, updated_at = @at
    WHERE id = @id AND status = 'NEED_FIX'`),
  docByCase: db.prepare('SELECT * FROM documents WHERE case_id = ? ORDER BY issued_at DESC, doc_no DESC LIMIT 1'),
  docByNo: db.prepare('SELECT * FROM documents WHERE doc_no = ?'),
  docByCode: db.prepare('SELECT * FROM documents WHERE verify_code = ?'),
  insDoc: db.prepare(`INSERT INTO documents
    (doc_no, case_id, case_no, verify_code, applicant, service_id, issued_at, valid_until, signer, issued_by, signature)
    VALUES (@docNo, @caseId, @caseNo, @verifyCode, @applicant, @serviceId, @issuedAt, @validUntil, @signer, @issuedBy, @signature)`),
  tamper: db.prepare('UPDATE documents SET applicant = applicant || ? WHERE doc_no = ?'),
};

const updCache = new Map();
/** UPDATE cases SET <คอลัมน์ที่ให้> WHERE id (ชื่อคอลัมน์มาจากโค้ดเท่านั้น) */
function updateCase(id, fields) {
  const cols = Object.keys(fields);
  const key = cols.join(',');
  let st = updCache.get(key);
  if (!st) {
    st = db.prepare(`UPDATE cases SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`);
    updCache.set(key, st);
  }
  return st.run({ ...fields, id });
}

// ---------------------------------------------------------------------------
// ตัวช่วยทั่วไป
// ---------------------------------------------------------------------------

/** แถว cases จากเลขคำขอ (ร่าง/ไม่มีเลข → null) */
function caseByNo(caseNo) {
  if (typeof caseNo !== 'string' || !caseNo) return null;
  return Q.caseByNo.get(caseNo) || null;
}

/** ระดับเตือนจาก sla.js (B03 · lazy) · ไม่มีโมดูล → คิดอย่างง่าย */
function levelOf(row, nowIso) {
  try {
    const sla = require('../sla');
    if (typeof sla.slaLevel === 'function') return sla.slaLevel(row, nowIso);
  } catch (e) {
    if (!(e && e.code === 'MODULE_NOT_FOUND')) throw e;
  }
  if (['COMPLETED', 'REJECTED', 'CANCELLED'].includes(row.status)) return 'closed';
  if (row.status === 'NEED_FIX') return 'paused';
  if (!row.due_at) return null;
  return clock.toMs(nowIso) > clock.toMs(row.due_at) ? 'overdue' : 'normal';
}

/** เลขบัตรที่เข้ารหัส → `X-XXXX-XXXXX-65-9` (ไม่ส่งเลขเต็มออกไป) */
function maskedFromEnc(enc) {
  try {
    return format.maskId(crypto.decrypt(enc));
  } catch {
    return 'X-XXXX-XXXXX-XX-X';
  }
}

/** step แสดงผล: เฉพาะบริการหลายแผนก (SV-03) · อื่น ๆ null (CONTRACT §6.7) */
function isStepped(serviceId) {
  const svc = SERVICES[serviceId];
  return !!svc && svc.route.filter((s) => s.dept).length > 1;
}
function stepOf(row) {
  return isStepped(row.service_id) ? Number(row.step) || 1 : null;
}

/** เหตุผลจาก body: ตัดช่องว่างหัวท้าย (BR-19 นับหลังตัด) */
function reasonFrom(body) {
  const v = body && body.reason;
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}
function requireReason(reason) {
  if (Array.from(reason).length < REASON_MIN) fail('REASON_TOO_SHORT');
}

/** ชื่อแสดงของ username (เช่น off.reg2 → เจ้าหน้าที่ทะเบียน 2) */
function displayName(username) {
  if (!username) return '';
  const u = Q.userByUsername.get(username);
  return (u && u.name) || username;
}

// ---------------------------------------------------------------------------
// เส้นทางบริการ (DECISIONS §3 Routing อัตโนมัติ · BR-21)
// ---------------------------------------------------------------------------

/** ดัชนีขั้นปัจจุบันใน SERVICES[...].route */
function stageIndex(row) {
  const svc = SERVICES[row.service_id];
  if (!svc) return -1;
  if (isStepped(row.service_id)) {
    const s = Number(row.step) || 1;
    return Math.min(Math.max(s, 1), svc.route.length) - 1;
  }
  if (row.status === 'PENDING_APPROVAL') return svc.route.findIndex((s) => s.head);
  const i = svc.route.findIndex((s) => s.dept && s.dept === row.dept);
  return i >= 0 ? i : 0;
}

/** ขั้นถัดไปเมื่อกด "ผ่าน/ส่งต่อ" ({dept} | {head:true}) หรือ null (SV-01 ไม่มีส่งต่อ) */
function nextStage(row) {
  const svc = SERVICES[row.service_id];
  const i = stageIndex(row);
  if (!svc || i < 0) return null;
  return svc.route[i + 1] || null;
}

/** แผนก dept เคย/กำลังอยู่ในเส้นทางของคำขอนี้หรือไม่ (ไฟล์แนบ DECISIONS §18: ขั้นปัจจุบันหรือเคยผ่าน) */
function deptReached(dept, row) {
  if (!dept) return false;
  if (row.dept === dept) return true;
  const svc = SERVICES[row.service_id];
  if (!svc) return false;
  const upto = isStepped(row.service_id) ? Math.max(Number(row.step) || 1, 1) : 1;
  return svc.route.slice(0, upto).some((s) => s.dept === dept);
}

// ---------------------------------------------------------------------------
// สิทธิ์ต่อคำขอ (ใช้ร่วมกันทั้ง API และปุ่มบนหน้า)
// ---------------------------------------------------------------------------

/** officer แผนกเดียวกับคิวที่คำขออยู่ และคำขอยังไม่มีผู้ถือ (ไม่ตรวจเพดาน 10: ปุ่มยังแสดง → กดแล้วได้ WORKLOAD_LIMIT) */
function canClaim(user, row) {
  return !!user && user.role === 'officer' && !!user.dept && !!row.dept && row.dept === user.dept &&
    CLAIMABLE.includes(row.status) && !row.owner;
}

/** ผู้ถือเรื่อง (IN_REVIEW ที่ owner = ฉัน) */
function isHolder(user, row) {
  return !!user && user.role === 'officer' && row.status === 'IN_REVIEW' && !!row.owner && row.owner === user.username;
}

/** ผู้ออกเอกสาร (A-27): issuer ของคำขอ · ไม่มีบันทึก issuer (ไม่ควรเกิด) → officer แผนกที่คำขออยู่ */
function isIssuer(user, row) {
  if (!user || user.role !== 'officer') return false;
  if (row.issuer) return row.issuer === user.username;
  return !!user.dept && user.dept === (row.dept || 'registry');
}

/**
 * ปุ่มที่ใช้ได้ (CONTRACT §2.6) — หน้า /officer/cases/:caseNo render ตามนี้
 * BUG B12: return ยัง true แม้ตีกลับครบ 2 ครั้ง · B07/B08/B09 ไม่เปลี่ยนค่าที่นี่ (บั๊กอยู่ที่ API)
 */
function availableActions(user, row) {
  const a = { claim: false, return: false, forward: false, approve: false, reject: false, issue: false, unmask: false };
  if (!user || !row || !row.case_no) return a;
  if (!STAFF_ROLES.includes(user.role)) return a;
  a.unmask = true;
  const svc = SERVICES[row.service_id];
  if (!svc) return a;
  if (user.role === 'officer') {
    a.claim = canClaim(user, row);
    const holder = isHolder(user, row);
    a.return = holder && (Number(row.return_count || 0) < MAX_RETURNS || isBug('B12'));
    a.forward = holder && !!nextStage(row);
    a.approve = holder && svc.approver === 'officer';
    a.reject = a.approve;
    a.issue = row.status === 'APPROVED' && isIssuer(user, row);
  } else {
    a.approve = row.status === 'PENDING_APPROVAL' && svc.approver === 'head';
    a.reject = a.approve;
  }
  return a;
}

/**
 * สิทธิ์เปิด/ดาวน์โหลดไฟล์แนบ (DECISIONS §18 · FR-29 · TC-RBAC-05)
 * → 'ok' | 'notfound' (citizen ไม่ใช่เจ้าของ / ไม่มีคำขอ) | 'forbidden' (officer นอกแผนก · executive/auditor/admin)
 */
function fileAccess(user, caseRow) {
  if (!user || !CASE_ROLES.includes(user.role)) return 'forbidden';
  if (!caseRow) return 'notfound';
  if (user.role === 'citizen') return caseRow.applicant_id === user.id ? 'ok' : 'notfound';
  if (!caseRow.case_no) return 'notfound'; // เจ้าหน้าที่ไม่เห็นร่าง
  if (user.role === 'head') return 'ok';
  return deptReached(user.dept, caseRow) ? 'ok' : 'forbidden';
}

// ---------------------------------------------------------------------------
// คิว / รออนุมัติ / งานในมือ
// ---------------------------------------------------------------------------

/** งานในมือ = IN_REVIEW ที่ owner = username (NEED_FIX ไม่นับ · BR-18) */
function workloadOf(username) {
  if (!username) return 0;
  return Q.workload.get(username).n;
}

/**
 * แถวคิว (BR-16: กำหนดเสร็จเร็วก่อน เท่ากันเลขน้อยก่อน) · officer = คิวแผนกตัวเอง · head = ทุกแผนก (อ่านอย่างเดียว)
 * filter: all · unclaimed (SUBMITTED/IN_REVIEW ไม่มีผู้ถือ) · mine (IN_REVIEW ที่ฉันถือ) · ไม่มี idNo เสมอ
 */
function queueRows(user, filter = 'all') {
  if (!user || !STAFF_ROLES.includes(user.role)) return [];
  let rows;
  if (user.role === 'officer') {
    if (!user.dept) return [];
    rows = Q.queueDept.all(user.dept);
  } else {
    rows = Q.queueAll.all();
  }
  const f = FILTERS.includes(filter) ? filter : 'all';
  if (f === 'unclaimed') rows = rows.filter((r) => CLAIMABLE.includes(r.status) && !r.owner);
  else if (f === 'mine') rows = rows.filter((r) => r.status === 'IN_REVIEW' && r.owner === user.username);
  const now = clock.nowIso();
  return rows.map((r) => ({
    caseNo: r.case_no,
    serviceId: r.service_id,
    applicantName: r.applicant_name,
    idMasked: maskedFromEnc(r.applicant_id_enc),
    status: r.status,
    step: stepOf(r),
    owner: r.owner || null,
    dueAt: r.due_at,
    slaLevel: levelOf(r, now),
  }));
}

/** รออนุมัติ (PENDING_APPROVAL) เรียง BR-16 → หน้า /head/approvals */
function approvalRows() {
  const now = clock.nowIso();
  return Q.approvals.all().map((r) => ({
    caseNo: r.case_no,
    serviceId: r.service_id,
    applicantName: r.applicant_name,
    step: stepOf(r),
    dueAt: r.due_at,
    slaLevel: levelOf(r, now),
  }));
}

// ---------------------------------------------------------------------------
// ไฟล์แนบ / ไทม์ไลน์ / เอกสาร
// ---------------------------------------------------------------------------

/** ไฟล์แนบของคำขอ (ตามลำดับที่แนบ) */
function caseFiles(caseId) {
  return Q.files.all(caseId).map((f) => ({ fileId: f.id, name: f.name, docKey: f.doc_key, size: f.size, mime: f.mime }));
}

function actorLabel(actor) {
  if (!actor || actor === 'citizen') return 'ผู้ยื่น';
  if (actor === 'system') return 'ระบบ';
  return displayName(actor);
}

/**
 * ข้อความไทยของเหตุการณ์ (ไม่ใส่ชื่อผู้ทำ — หน้าจอแสดง actor แยกเอง) ·
 * หมายเหตุส่งต่อ (FORWARD) เป็นข้อมูลภายใน: ใส่ในข้อความเฉพาะเมื่อ opts.internal (หน้าเจ้าหน้าที่) · เหตุผลตีกลับ/ไม่อนุมัติแสดงเสมอ
 */
function eventText(e, opts = {}) {
  const note = e.note ? String(e.note) : '';
  switch (e.event) {
    case 'CREATED':
      return 'สร้างร่างคำขอ';
    case 'PAID':
      return note ? `ชำระเงินสำเร็จ ส่งคำขอแล้ว (ใบเสร็จ ${note})` : 'ชำระเงินสำเร็จ ส่งคำขอแล้ว';
    case 'CLAIM':
      return 'เจ้าหน้าที่รับเรื่อง';
    case 'RETURN':
      return `ตีกลับให้แก้ไขเอกสาร${note ? `: ${note}` : ''}`;
    case 'RESUBMIT':
      return `ส่งแก้ไขเอกสารแล้ว${note ? ` (${note})` : ''}`;
    case 'FORWARD': {
      const dest = e.to_status === 'PENDING_APPROVAL' ? 'ให้หัวหน้าฝ่ายพิจารณาอนุมัติ' : `ไป${DEPT_LABEL.works}`;
      return `ผ่าน/ส่งต่อ${dest}${opts.internal && note ? ` (หมายเหตุ: ${note})` : ''}`;
    }
    case 'APPROVE':
      return 'อนุมัติ';
    case 'REJECT':
      return `ไม่อนุมัติ${note ? `: ${note}` : ''}`;
    case 'ISSUE':
      return `ออกเอกสาร${note ? ` ${note}` : ''}`;
    case 'CANCEL':
      return 'ยกเลิกคำขอ';
    case 'AUTO_CANCEL':
      return 'ยกเลิกอัตโนมัติ เนื่องจากเลยเวลาแก้ไข 168 ชั่วโมง';
    default:
      return e.event;
  }
}

/**
 * ไทม์ไลน์ของคำขอ (case_events เรียง at, id) → [{at, actor, actorName, event, fromStatus, toStatus, note, text}]
 * opts.internal = true (หน้าเจ้าหน้าที่) → ข้อความ FORWARD มีหมายเหตุส่งต่อด้วย
 */
function timeline(caseId, opts = {}) {
  return Q.events.all(caseId).map((e) => ({
    at: e.at,
    actor: e.actor,
    actorName: actorLabel(e.actor),
    event: e.event,
    fromStatus: e.from_status,
    toStatus: e.to_status,
    note: e.note,
    text: eventText(e, opts),
  }));
}

/** เอกสารล่าสุดของคำขอ หรือ null */
function documentForCase(caseId) {
  const d = Q.docByCase.get(caseId);
  if (!d) return null;
  return {
    docNo: d.doc_no,
    caseNo: d.case_no,
    serviceId: d.service_id,
    verifyCode: d.verify_code,
    issuedAt: d.issued_at,
    validUntil: d.valid_until,
    signer: d.signer,
  };
}

/** URL ของ QR เอกสาร (doc-qr data-url) = <BASE_URL>/verify/<รหัส> */
function verifyUrl(req, code) {
  return `${baseUrl(req)}/verify/${encodeURIComponent(code)}`;
}

/**
 * วันสุดท้ายที่เอกสารใช้ได้ (A-23 · A-43): SV-01 90 วัน = วันออก + 89 วัน ·
 * SV-02/03 1 ปี = วันครบรอบ (29 ก.พ. → 28 ก.พ.) − 1 วัน · ตามวันที่เวลาไทย
 */
function validUntilFor(serviceId, issuedAtIso) {
  const v = (SERVICES[serviceId] && SERVICES[serviceId].validity) || { days: 90 };
  const ymd = clock.bkkDate(issuedAtIso);
  if (v.days) return clock.addDaysYmd(ymd, v.days - 1);
  const [y, m, d] = ymd.split('-').map(Number);
  const ty = y + (v.years || 1);
  const dim = new Date(Date.UTC(ty, m, 0)).getUTCDate();
  const anniv = `${ty}-${String(m).padStart(2, '0')}-${String(Math.min(d, dim)).padStart(2, '0')}`;
  return clock.addDaysYmd(anniv, -1);
}

/** ฟิลด์ที่ลงนามตามลำดับ CONTRACT §3 จากแถว documents */
function signedFields(d) {
  return {
    docNo: d.doc_no,
    caseNo: d.case_no,
    applicant: d.applicant,
    serviceId: d.service_id,
    issuedAt: d.issued_at,
    validUntil: d.valid_until,
    signer: d.signer,
  };
}

/**
 * ตรวจเอกสาร (A-43): ไม่พบ → NOT_FOUND · ลายเซ็นไม่ตรง → TAMPERED (ตรวจก่อนหมดอายุ) ·
 * วันนี้ (เวลาไทย) > validUntil → EXPIRED · ไม่งั้น VALID · ชื่อผู้ยื่นปิดบัง (A-54)
 */
function verifyDocument(code, nowIso) {
  const c = String(code === undefined || code === null ? '' : code).trim().toUpperCase();
  if (!/^[A-Z0-9]{1,64}$/.test(c)) return { result: 'NOT_FOUND' };
  const d = Q.docByCode.get(c);
  if (!d) return { result: 'NOT_FOUND' };
  if (!crypto.verifyDocSignature(signedFields(d), d.signature)) return { result: 'TAMPERED' };
  const today = clock.bkkDate(nowIso || clock.nowIso());
  return {
    result: today > d.valid_until ? 'EXPIRED' : 'VALID',
    docNo: d.doc_no,
    applicantMasked: format.maskName(d.applicant),
    serviceId: d.service_id,
    serviceName: SERVICES[d.service_id] ? SERVICES[d.service_id].name : '',
    issuedAt: d.issued_at,
    validUntil: d.valid_until,
    signer: d.signer,
  };
}

/** รหัสตรวจสอบ 8 ตัวที่ไม่ซ้ำ */
function uniqueVerifyCode() {
  for (let i = 0; i < 50; i++) {
    const code = crypto.randomCode(8);
    if (!Q.docByCode.get(code)) return code;
  }
  throw new Error('workflow: cannot allocate a unique verify code');
}

/** ชื่อผู้ลงนาม = ผู้อนุมัติ (DECISIONS §10) */
function signerName(row) {
  return displayName(row.approver) || displayName(row.issuer) || '';
}

// ---------------------------------------------------------------------------
// ยกเลิกอัตโนมัติ (tick ทุก request · A-46 · BR-20)
// ---------------------------------------------------------------------------

/**
 * NEED_FIX ที่ now ≥ fix_deadline (ตีกลับ + 168 ชม.) → CANCELLED
 * cancelled_at = fix_deadline · case_events AUTO_CANCEL ที่ at = fix_deadline (TC-WORKFLOW-06) · ไม่เขียน Audit (ไม่ใช่ 10 เหตุการณ์)
 * คืนจำนวนที่ยกเลิก
 */
function autoCancelExpired(nowIso) {
  try {
    const nowMs = clock.toMs(nowIso || clock.nowIso());
    if (!Number.isFinite(nowMs)) return 0;
    const due = Q.needFix.all().filter((r) => {
      const t = clock.toMs(r.fix_deadline);
      return Number.isFinite(t) && t <= nowMs;
    });
    if (!due.length) return 0;
    let n = 0;
    db.transaction(() => {
      for (const r of due) {
        const at = clock.toIso(r.fix_deadline);
        if (Q.autoCancel.run({ id: r.id, at }).changes) {
          Q.insEvent.run(r.id, at, 'system', 'AUTO_CANCEL', 'NEED_FIX', 'CANCELLED', AUTO_CANCEL_NOTE);
          n += 1;
        }
      }
    })();
    return n;
  } catch (err) {
    console.error('[workflow] autoCancelExpired failed:', err && err.stack ? err.stack : err);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// การกระทำ (ทุกตัวอยู่ใน transaction เดียว: ตรวจ → cases → case_events → audit)
// ---------------------------------------------------------------------------

function loadForAction(caseNo) {
  const row = caseByNo(caseNo);
  if (!row) fail('NOT_FOUND');
  if (!SERVICES[row.service_id]) fail('INVALID_STATE');
  return row;
}

/** รับเรื่อง · ลำดับตรวจ: สิทธิ์ (บทบาท/แผนก) → สถานะ → ALREADY_CLAIMED → WORKLOAD_LIMIT */
function claimCase(user, caseNo) {
  return db.transaction(() => {
    const row = loadForAction(caseNo);
    if (user.role !== 'officer') fail('FORBIDDEN');
    if (row.dept && row.dept !== user.dept) fail('FORBIDDEN'); // ข้ามแผนก
    if (!row.dept || !CLAIMABLE.includes(row.status)) fail('INVALID_STATE');
    // BUG B08: ข้ามการตรวจว่ามีผู้ถือแล้ว → คนที่ 2 ได้ 200 และเป็นผู้ถือแทน
    if (row.owner && !isBug('B08')) fail('ALREADY_CLAIMED');
    if (workloadOf(user.username) >= MAX_WORKLOAD) fail('WORKLOAD_LIMIT');

    const now = clock.nowIso();
    const fields = { status: 'IN_REVIEW', owner: user.username, updated_at: now };
    if (row.dept === 'registry' && !row.issuer) fields.issuer = user.username; // ทะเบียนคนแรกที่รับ = ผู้ออกเอกสาร (A-27)
    updateCase(row.id, fields);
    Q.insEvent.run(row.id, now, user.username, 'CLAIM', row.status, 'IN_REVIEW', null);
    logAudit(user, 'CLAIM', { caseNo: row.case_no, from: row.status, to: 'IN_REVIEW', detail: '' });
    return { caseNo: row.case_no, owner: user.username, status: 'IN_REVIEW' };
  })();
}

/** ตีกลับ · ผู้ถือเรื่องเท่านั้น · RETURN_LIMIT ก่อน REASON_TOO_SHORT */
function returnCase(user, caseNo, reason) {
  return db.transaction(() => {
    const row = loadForAction(caseNo);
    if (user.role !== 'officer') fail('FORBIDDEN');
    if (row.status !== 'IN_REVIEW') fail('INVALID_STATE');
    if (row.owner !== user.username) fail('FORBIDDEN');
    const count = Number(row.return_count || 0);
    // BUG B12: ตีกลับครั้งที่ 3 ได้
    if (count >= MAX_RETURNS && !isBug('B12')) fail('RETURN_LIMIT');
    requireReason(reason);

    const now = clock.nowIso();
    const fixDeadline = clock.addMs(now, FIX_WINDOW_MS);
    updateCase(row.id, {
      status: 'NEED_FIX',
      return_count: count + 1,
      returned_at: now,
      return_reason: reason,
      fix_deadline: fixDeadline,
      updated_at: now,
    });
    Q.insEvent.run(row.id, now, user.username, 'RETURN', 'IN_REVIEW', 'NEED_FIX', reason);
    logAudit(user, 'RETURN', { caseNo: row.case_no, from: 'IN_REVIEW', to: 'NEED_FIX', detail: reason });
    return { caseNo: row.case_no, status: 'NEED_FIX', returnCount: count + 1, fixDeadline };
  })();
}

/** ผ่าน/ส่งต่อ ตามเส้นทางของบริการ (ไม่มีปลายทางให้เลือก) */
function forwardCase(user, caseNo, note) {
  return db.transaction(() => {
    const row = loadForAction(caseNo);
    if (user.role !== 'officer') fail('FORBIDDEN');
    if (row.status !== 'IN_REVIEW') fail('INVALID_STATE');
    if (row.owner !== user.username) fail('FORBIDDEN');
    const next = nextStage(row);
    if (!next) fail('INVALID_STATE'); // SV-01: ไม่มีขั้นถัดไป (อนุมัติเอง)

    const now = clock.nowIso();
    const stepped = isStepped(row.service_id);
    const newStep = stepped ? stageIndex(row) + 2 : null;
    let fields;
    let out;
    if (next.dept) {
      // แผนกถัดไป (SV-03 ทะเบียน → โยธา): เข้าคิวแผนกนั้น ยังไม่มีผู้รับ
      fields = { status: 'IN_REVIEW', dept: next.dept, owner: null, updated_at: now };
      if (stepped) fields.step = newStep;
      out = { caseNo: row.case_no, status: 'IN_REVIEW', step: newStep };
    } else {
      // ขั้นหัวหน้า → /head/approvals
      fields = { status: 'PENDING_APPROVAL', dept: null, owner: null, updated_at: now };
      if (stepped) fields.step = newStep;
      out = { caseNo: row.case_no, status: 'PENDING_APPROVAL' };
      if (stepped) out.step = newStep;
    }
    updateCase(row.id, fields);
    Q.insEvent.run(row.id, now, user.username, 'FORWARD', 'IN_REVIEW', fields.status, note || null);
    logAudit(user, 'FORWARD', { caseNo: row.case_no, from: 'IN_REVIEW', to: fields.status, detail: note || '' });
    return out;
  })();
}

/**
 * อำนาจตัดสิน (อนุมัติ/ไม่อนุมัติ · BR-21): SV-01 = ผู้ถือเรื่อง (officer) ที่ IN_REVIEW · SV-02/03 = head ที่ PENDING_APPROVAL
 * ผิดบทบาท → 403 ก่อนตรวจสถานะ (officer กับ SV-02/03 · head กับ SV-01 → 403 เสมอ)
 * opts.bugB07: เปิดช่องให้ officer อนุมัติ SV-02 (approve เท่านั้น)
 */
function checkDecision(user, row, opts = {}) {
  const svc = SERVICES[row.service_id];
  if (svc.approver === 'officer') {
    if (user.role !== 'officer') fail('FORBIDDEN');
    if (row.status !== 'IN_REVIEW') fail('INVALID_STATE');
    if (row.owner !== user.username) fail('FORBIDDEN');
    return;
  }
  if (user.role === 'head') {
    if (row.status !== 'PENDING_APPROVAL') fail('INVALID_STATE');
    return;
  }
  if (opts.bugB07 && user.role === 'officer' && row.service_id === 'SV-02') {
    // BUG B07: API ไม่เช็กอำนาจอนุมัติ → เจ้าหน้าที่อนุมัติ SV-02 ได้เองโดยไม่ผ่านหัวหน้า (ปุ่มยังซ่อน)
    if (!['IN_REVIEW', 'PENDING_APPROVAL'].includes(row.status)) fail('INVALID_STATE');
    return;
  }
  fail('FORBIDDEN');
}

function approveCase(user, caseNo) {
  return db.transaction(() => {
    const row = loadForAction(caseNo);
    checkDecision(user, row, { bugB07: isBug('B07') });
    const svc = SERVICES[row.service_id];
    const now = clock.nowIso();
    const fields = { status: 'APPROVED', approver: user.username, dept: 'registry', owner: null, updated_at: now };
    // SV-01: ผู้ถือเรื่องที่อนุมัติ = ผู้กดออกเอกสาร · SV-02/03 คง issuer (ทะเบียนขั้นแรก · A-27)
    if (svc.approver === 'officer') fields.issuer = user.username;
    updateCase(row.id, fields);
    Q.insEvent.run(row.id, now, user.username, 'APPROVE', row.status, 'APPROVED', null);
    logAudit(user, 'APPROVE', { caseNo: row.case_no, from: row.status, to: 'APPROVED', detail: '' });
    return { caseNo: row.case_no, status: 'APPROVED' };
  })();
}

function rejectCase(user, caseNo, reason) {
  return db.transaction(() => {
    const row = loadForAction(caseNo);
    checkDecision(user, row);
    requireReason(reason);
    const now = clock.nowIso();
    updateCase(row.id, {
      status: 'REJECTED',
      approver: user.username,
      reject_reason: reason,
      closed_at: now,
      dept: null,
      owner: null,
      updated_at: now,
    });
    Q.insEvent.run(row.id, now, user.username, 'REJECT', row.status, 'REJECTED', reason);
    logAudit(user, 'REJECT', { caseNo: row.case_no, from: row.status, to: 'REJECTED', detail: reason });
    return { caseNo: row.case_no, status: 'REJECTED', closedAt: now };
  })();
}

/** ออกเอกสาร: ผู้ออกเอกสาร (A-27) ที่ APPROVED → เอกสาร + ลายเซ็น HMAC → COMPLETED */
function issueDocument(user, caseNo) {
  return db.transaction(() => {
    const row = loadForAction(caseNo);
    if (!isIssuer(user, row)) fail('FORBIDDEN');
    if (row.status !== 'APPROVED') fail('INVALID_STATE');

    const now = clock.nowIso();
    const be = clock.beYear(now);
    const docNo = NUMBERING.docNo(be, nextSeq(COUNTER.docNo(be))); // ปีของเวลาออก (A-48)
    const applicantRow = Q.userById.get(row.applicant_id);
    const doc = {
      docNo,
      caseNo: row.case_no,
      applicant: applicantRow ? applicantRow.name : '',
      serviceId: row.service_id,
      issuedAt: now,
      validUntil: validUntilFor(row.service_id, now),
      signer: signerName(row),
    };
    const verifyCode = uniqueVerifyCode();
    Q.insDoc.run({
      ...doc,
      caseId: row.id,
      verifyCode,
      issuedBy: user.username,
      signature: crypto.signDoc(doc),
    });
    updateCase(row.id, { status: 'COMPLETED', closed_at: now, dept: null, owner: null, updated_at: now });
    Q.insEvent.run(row.id, now, user.username, 'ISSUE', 'APPROVED', 'COMPLETED', docNo);
    logAudit(user, 'ISSUE', { caseNo: row.case_no, from: 'APPROVED', to: 'COMPLETED', detail: docNo });
    return { caseNo: row.case_no, docNo, verifyCode, status: 'COMPLETED', closedAt: now, validUntil: doc.validUntil };
  })();
}

// ---------------------------------------------------------------------------
// PDF เอกสาร (CONTRACT §3 · A-63): บรรทัด ASCII ที่เครื่องอ่านได้ + QR ไป /verify/<รหัส>
// ---------------------------------------------------------------------------

const SERVICE_EN = {
  'SV-01': 'Certificate request',
  'SV-02': 'Business operation permit',
  'SV-03': 'Building construction / extension permit',
};

/** บรรทัดที่ test ตรวจ: docNo=… caseNo=… verify=… validUntil=YYYY-MM-DD */
function machineLine(d) {
  return `docNo=${d.doc_no} caseNo=${d.case_no} verify=${d.verify_code} validUntil=${d.valid_until}`;
}

let thaiFontPath;
/** ฟอนต์ไทยของเครื่อง (ถ้ามี) · อิมเมจ Docker ไม่มี → เอกสารเป็น ASCII ล้วน (ข้อความไทยตรวจผ่าน /verify · DECISIONS §18) */
function findThaiFont() {
  if (thaiFontPath !== undefined) return thaiFontPath;
  const candidates = [
    process.env.PDF_THAI_FONT,
    '/usr/share/fonts/truetype/tlwg/Garuda.ttf',
    '/usr/share/fonts/truetype/tlwg/Loma.ttf',
    '/usr/share/fonts/truetype/noto/NotoSansThai-Regular.ttf',
  ].filter(Boolean);
  thaiFontPath = null;
  for (const p of candidates) {
    try {
      if (fs.statSync(p).isFile()) {
        thaiFontPath = p;
        break;
      }
    } catch {
      /* ไม่มีไฟล์ */
    }
  }
  return thaiFontPath;
}

/** วาด QR เป็นสี่เหลี่ยมเวกเตอร์ (รวมช่วงต่อเนื่องในแถว) */
function drawQr(doc, text, x, y, size) {
  const QR = require('qrcode');
  const qr = QR.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const quiet = 2;
  const cell = size / (n + quiet * 2);
  doc.save();
  doc.rect(x, y, size, size).fill('#ffffff');
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!qr.modules.get(r, c)) {
        c += 1;
        continue;
      }
      let e = c;
      while (e < n && qr.modules.get(r, e)) e += 1;
      doc.rect(x + (c + quiet) * cell, y + (r + quiet) * cell, (e - c) * cell + 0.2, cell + 0.2);
      c = e;
    }
  }
  doc.fill('#000000');
  doc.restore();
}

function renderPdf(d, ctx, thaiFont) {
  const PDFDocument = require('pdfkit');
  const line = machineLine(d);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 56,
      info: {
        Title: `${d.doc_no} (simulated digital document)`,
        Subject: line,
        Keywords: `${d.doc_no} ${d.case_no} ${d.verify_code}`,
        Author: 'e-Service (fictional municipality)',
        Creator: 'e-Service',
        Producer: 'e-Service',
        CreationDate: Number.isFinite(clock.toMs(d.issued_at)) ? new Date(clock.toMs(d.issued_at)) : clock.now(),
        ModDate: clock.now(),
        DocNo: d.doc_no,
        CaseNo: d.case_no,
        Applicant: d.applicant,
        Service: `${d.service_id} ${SERVICES[d.service_id] ? SERVICES[d.service_id].name : ''}`,
        IssuedAt: d.issued_at,
        ValidUntil: d.valid_until,
        Signer: d.signer,
        VerifyCode: d.verify_code,
        VerifyUrl: ctx.url,
      },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const body = thaiFont ? 'thai' : 'Helvetica';
    const bold = thaiFont ? 'thai' : 'Helvetica-Bold';
    if (thaiFont) doc.registerFont('thai', thaiFont);

    const left = doc.page.margins.left;
    const wide = doc.page.width - left - doc.page.margins.right;
    const qrSize = 132;
    const qrX = left + wide - qrSize;

    doc.font(bold).fontSize(16).fillColor('#000000')
      .text(thaiFont ? 'เอกสารดิจิทัล (จำลอง) · Digital Document (simulated)' : 'Digital Document (simulated)', left, 56, { width: wide - qrSize - 12 });
    doc.font(body).fontSize(9).fillColor('#444444')
      .text(
        thaiFont
          ? 'เทศบาลนครตัวอย่าง (หน่วยงานสมมติ) · e-Service · ไม่ใช่เอกสารราชการจริง'
          : 'Example Municipality e-Service (fictional organisation) - not a real government document',
        { width: wide - qrSize - 12 }
      );

    drawQr(doc, ctx.url, qrX, 50, qrSize);
    doc.font('Helvetica').fontSize(7).fillColor('#444444')
      .text('Scan to verify', qrX, 50 + qrSize + 2, { width: qrSize, align: 'center', lineBreak: false });

    const svcName = SERVICES[d.service_id] ? SERVICES[d.service_id].name : '';
    const rows = [
      ['Document No', 'เลขเอกสาร', d.doc_no],
      ['Case No', 'เลขคำขอ', d.case_no],
      ['Applicant', 'ชื่อผู้ยื่น', thaiFont ? d.applicant : '(Thai name - shown on the verification page)'],
      ['Service', 'บริการ', thaiFont ? `${d.service_id} ${svcName}` : `${d.service_id} ${SERVICE_EN[d.service_id] || ''}`],
      ['Issued at', 'วันออก', thaiFont ? `${format.thaiDateTime(d.issued_at)} (${d.issued_at})` : `${d.issued_at.slice(0, 16).replace('T', ' ')} (UTC+07:00)`],
      ['Valid until', 'ใช้ได้ถึง', thaiFont ? `${format.thaiDate(d.valid_until)} (${d.valid_until})` : `${d.valid_until} (last valid day)`],
      ['Signer', 'ผู้ลงนาม', thaiFont ? d.signer : `${ctx.approver || '-'} (approver; display name on the verification page)`],
      ['Verification code', 'รหัสตรวจสอบ', d.verify_code],
      ['Verify at', 'ตรวจสอบที่', ctx.url],
    ];
    let y = 200;
    for (const [en, th, val] of rows) {
      doc.font(bold).fontSize(10).fillColor('#000000').text(thaiFont ? `${th} / ${en}` : en, left, y, { width: 150 });
      doc.font(body).fontSize(10).text(String(val), left + 160, y, { width: wide - 160 });
      y = Math.max(doc.y, y + 14) + 6;
    }

    y += 10;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#000000').text('Machine-readable line', left, y, { lineBreak: false });
    y += 14;
    // บรรทัดเดียว ไม่ตัดคำ (pdf text) · ซ้ำใน Info/Subject เพื่อให้ค้นจากไบต์ดิบได้
    doc.font('Courier').fontSize(9).text(line, left, y, { lineBreak: false });
    y += 22;

    doc.font('Helvetica-Bold').fontSize(9).text('Simulated signature (HMAC-SHA256, test key)', left, y, { lineBreak: false });
    y += 13;
    doc.font('Courier').fontSize(8).text(d.signature, left, y, { lineBreak: false });
    y += 20;
    doc.font('Helvetica').fontSize(8).fillColor('#444444').text(
      'Signed fields (in order, joined by "|"): docNo, caseNo, applicant, serviceId, issuedAt, validUntil, signer. ' +
        'This is a simulation for testing only: the signature uses a test key and is not a legal electronic signature ' +
        'or a certificate issued by a real certification authority.',
      left,
      y,
      { width: wide }
    );
    doc.end();
  });
}

/** PDF ของเอกสาร (Buffer) · ใช้ฟอนต์ไทยถ้ามี ไม่งั้น/พังแล้ว ASCII ล้วน */
async function buildDocumentPdf(d, ctx) {
  const font = findThaiFont();
  if (font) {
    try {
      return await renderPdf(d, ctx, font);
    } catch (err) {
      console.warn('[workflow] Thai font PDF failed, using ASCII only:', err && err.message);
    }
  }
  return renderPdf(d, ctx, null);
}

/** Content-Disposition พร้อมชื่อไฟล์ UTF-8 (RFC 6266) */
function contentDisposition(kind, name) {
  const fallback = String(name || 'file').replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(String(name || 'file'))}`;
}

// ---------------------------------------------------------------------------
// route
// ---------------------------------------------------------------------------

function register(app, ctx) {
  // ---- คิวงาน ----
  app.get('/api/officer/queue', requireApi('officer', 'head'), (req, res) => {
    const filter = FILTERS.includes(req.query.filter) ? req.query.filter : 'all';
    let items = queueRows(req.user, filter);
    if (isBug('B09')) {
      // BUG B09: API ส่งเลขบัตรเต็ม (หน้าจอยังปิดบังเพราะ queueRows ไม่เปลี่ยน)
      items = items.map((it) => {
        const r = Q.applicantIdEnc.get(it.caseNo);
        let idNo = null;
        try {
          idNo = r ? crypto.decrypt(r.id_enc) : null;
        } catch {
          idNo = null;
        }
        return { ...it, idNo };
      });
    }
    res.json({
      items,
      filter,
      workload: req.user.role === 'officer' ? workloadOf(req.user.username) : null,
    });
  });

  // ---- การกระทำของเจ้าหน้าที่ ----
  app.post('/api/officer/cases/:caseNo/claim', requireApi('officer'), (req, res) => {
    res.json(claimCase(req.user, req.params.caseNo));
  });

  app.post('/api/officer/cases/:caseNo/return', requireApi('officer'), (req, res) => {
    res.json(returnCase(req.user, req.params.caseNo, reasonFrom(req.body)));
  });

  app.post('/api/officer/cases/:caseNo/forward', requireApi('officer'), (req, res) => {
    const body = req.body || {};
    const raw = body.note !== undefined ? body.note : body.forwardNote;
    const note = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '';
    res.json(forwardCase(req.user, req.params.caseNo, note));
  });

  app.post('/api/officer/cases/:caseNo/issue', requireApi('officer'), (req, res) => {
    res.json(issueDocument(req.user, req.params.caseNo));
  });

  app.post('/api/cases/:caseNo/approve', requireApi('officer', 'head'), (req, res) => {
    res.json(approveCase(req.user, req.params.caseNo));
  });

  app.post('/api/cases/:caseNo/reject', requireApi('officer', 'head'), (req, res) => {
    res.json(rejectCase(req.user, req.params.caseNo, reasonFrom(req.body)));
  });

  // ---- รออนุมัติ ----
  app.get('/api/head/approvals', requireApi('head'), (req, res) => {
    res.json({ items: approvalRows() });
  });

  // ---- ไฟล์แนบตามสิทธิ์ ----
  app.get('/api/cases/:caseNo/files', requireApi(), (req, res) => {
    const row = caseByNo(req.params.caseNo);
    const acc = fileAccess(req.user, row);
    if (acc === 'forbidden') fail('FORBIDDEN');
    if (acc !== 'ok') fail('NOT_FOUND');
    res.json({ caseNo: row.case_no, items: caseFiles(row.id) });
  });

  app.get('/api/files/:fileId', requireApi(), (req, res) => {
    const f = Q.fileById.get(String(req.params.fileId || ''));
    const row = f ? Q.caseById.get(f.case_id) : null;
    const acc = fileAccess(req.user, row || null);
    if (acc === 'forbidden') fail('FORBIDDEN');
    if (acc !== 'ok' || !f) fail('NOT_FOUND');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data || '');
    res.status(200);
    res.set('Content-Type', f.mime || 'application/octet-stream');
    res.set('Content-Length', String(data.length));
    res.set('Content-Disposition', contentDisposition('attachment', f.name));
    res.set('X-Content-Type-Options', 'nosniff');
    res.end(data);
  });

  // ---- ไทม์ไลน์ ----
  app.get('/api/cases/:caseNo/timeline', requireApi(), (req, res) => {
    const user = req.user;
    if (!CASE_ROLES.includes(user.role)) fail('FORBIDDEN');
    const row = caseByNo(req.params.caseNo);
    if (!row || (user.role === 'citizen' && row.applicant_id !== user.id)) fail('NOT_FOUND');
    res.json({ caseNo: row.case_no, items: timeline(row.id, { internal: STAFF_ROLES.includes(user.role) }) });
  });

  // ---- PDF เอกสาร ----
  app.get('/api/documents/:docNo/pdf', requireApi(), async (req, res) => {
    const user = req.user;
    if (!CASE_ROLES.includes(user.role)) fail('FORBIDDEN');
    const d = Q.docByNo.get(String(req.params.docNo || ''));
    const row = d ? Q.caseById.get(d.case_id) : null;
    if (!d || !row) fail('NOT_FOUND');
    if (user.role === 'citizen' && row.applicant_id !== user.id) fail('NOT_FOUND'); // ห้ามเผยว่ามีอยู่
    const buf = await buildDocumentPdf(d, { url: verifyUrl(req, d.verify_code), approver: row.approver });
    res.status(200);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Length', String(buf.length));
    res.set('Content-Disposition', contentDisposition('attachment', `${d.doc_no}.pdf`));
    res.end(buf);
  });

  // ---- ตรวจเอกสาร (ไม่ต้องล็อกอิน) ----
  app.get('/api/verify/:code', (req, res) => {
    const v = verifyDocument(req.params.code, clock.nowIso());
    if (v.result === 'NOT_FOUND') return res.status(404).json({ result: 'NOT_FOUND' });
    if (v.result === 'TAMPERED') return res.status(200).json({ result: 'TAMPERED' });
    return res.status(200).json(v);
  });

  // ---- test hook: แก้ข้อมูลเอกสารที่เก็บ โดยไม่ลงนามใหม่ ----
  ctx.testRouter.post('/documents/:docNo/tamper', (req, res) => {
    const info = Q.tamper.run(TAMPER_SUFFIX, String(req.params.docNo || ''));
    if (!info.changes) fail('NOT_FOUND');
    res.status(200).json({ ok: true });
  });
}

module.exports = {
  register,
  // INTERFACES §6.5
  autoCancelExpired,
  queueRows,
  approvalRows,
  workloadOf,
  availableActions,
  fileAccess,
  caseFiles,
  timeline,
  documentForCase,
  verifyDocument,
  // ตัวช่วยเพิ่มเติมสำหรับหน้า (B09/B10)
  caseByNo,
  verifyUrl,
  validUntilFor,
  nextStage,
  machineLine,
  buildDocumentPdf,
};
