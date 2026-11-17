'use strict';
// Domain helpers shared by the API and the HTML pages.
const crypto = require('node:crypto');
const C = require('./core');
const S = () => C.state;

const sessions = new Map(); // sid -> session (cleared by reset)

const staffBy = u => S().staff.find(s => s.username === u);
const staffName = u => staffBy(u)?.name ?? u;
const citizenBy = id => S().citizens.find(c => c.id === id);
const caseBy = no => S().cases.find(c => c.caseNo === no);
const draftBy = id => S().drafts.find(d => d.draftId === id && d.status !== 'DELETED');
const heads = () => S().staff.filter(s => s.role === 'head').map(s => s.username);
const officers = dept => S().staff.filter(s => s.role === 'officer' && s.dept === dept).map(s => s.username);
const workload = u => S().cases.filter(c => c.status === 'IN_REVIEW' && c.owner === u).length;
const applicantName = c => citizenBy(c.applicantId).name;
const applicantIdNo = c => C.dec(citizenBy(c.applicantId).idEnc);
const BACKLOG = ['SUBMITTED', 'IN_REVIEW', 'NEED_FIX', 'PENDING_APPROVAL', 'APPROVED'];
const OPEN_DRAFT = ['DRAFT', 'PENDING_PAYMENT'];
const ROLES = Object.keys(C.ROLE_TH);
const DEPTS = { '': '-', registry: 'ทะเบียน', works: 'โยธา' };
const openDraftsOf = citizenId => S().drafts.filter(d => d.ownerId === citizenId && OPEN_DRAFT.includes(d.status));
// a citizen may only see their own case; anything else looks like "not found" (BR-22) — B06 is the IDOR bug
const citizenCase = (s, caseNo) => { const c = caseBy(caseNo); return c && (c.applicantId === s.citizenId || C.bug('B06')) ? c : null; };
const holidaysSorted = () => [...S().holidays].sort((a, b) => (a.date < b.date ? -1 : 1));
const casesOf = citizenId => S().cases.filter(c => c.applicantId === citizenId).sort((a, b) => (a.caseNo < b.caseNo ? 1 : -1)); // newest first
const ACTIVE = ['SUBMITTED', 'IN_REVIEW', 'PENDING_APPROVAL', 'APPROVED'];

class ApiError extends Error {
  constructor(status, code, extra) { super(code); this.status = status; this.code = code; this.extra = extra; }
}
const E = (status, code, extra) => new ApiError(status, code, extra);

// where a case currently waits: registry / works / head
function queueDept(c) {
  if (c.status === 'APPROVED') return 'registry';
  if (c.status === 'PENDING_APPROVAL') return 'head';
  return c.serviceId === 'SV-03' && c.step === 2 ? 'works' : 'registry';
}
const STEP_TH = { 1: 'ขั้นตอน 1/3 · ฝ่ายทะเบียน', 2: 'ขั้นตอน 2/3 · ฝ่ายโยธา', 3: 'ขั้นตอน 3/3 · หัวหน้าฝ่าย' };

// UI capability checks (API handlers re-check with ordered error codes)
function can(s, c, action) {
  if (!s || !c) return false;
  const own = s.role === 'officer' && c.owner === s.username && c.status === 'IN_REVIEW';
  switch (action) {
    case 'claim': return s.role === 'officer' && ['SUBMITTED', 'IN_REVIEW'].includes(c.status) && !c.owner && queueDept(c) === s.dept;
    case 'return': return own && (c.returnCount < 2 || C.bug('B12'));
    case 'forward': return own && c.serviceId !== 'SV-01';
    case 'decide': return c.serviceId === 'SV-01' ? own : s.role === 'head' && c.status === 'PENDING_APPROVAL';
    case 'issue': return s.role === 'officer' && c.issuer === s.username && c.status === 'APPROVED';
    default: return false;
  }
}

function audit(s, event, c, from, to, detail) {
  S().audit.push({ id: ++S().seq.audit, time: C.now(), username: s.username, role: s.role, event,
    caseNo: c ? c.caseNo : null, fromStatus: from || null, toStatus: to || null, detail: detail || '' });
}
const auditJson = a => ({ id: a.id, time: C.iso(a.time), username: a.username, role: a.role, event: a.event,
  caseNo: a.caseNo, fromStatus: a.fromStatus, toStatus: a.toStatus, detail: a.detail });
function auditQuery({ actor, event, from, to } = {}) {
  actor = (actor || '').trim();
  return S().audit
    .filter(a => (!actor || a.username === actor) && (!event || a.event === event)
      && (!from || C.dateKey(a.time) >= from) && (!to || C.dateKey(a.time) <= to))
    .sort((a, b) => b.time - a.time || b.id - a.id);
}
const auditFilters = q => ({ actor: q.get('actor') || '', event: q.get('event') || '', from: q.get('from') || '', to: q.get('to') || '' });
const AUDIT_EVENTS = ['STAFF_LOGIN', 'CLAIM', 'RETURN', 'FORWARD', 'APPROVE', 'REJECT', 'ISSUE', 'UNMASK', 'EXPORT', 'ADMIN_CHANGE'];

// Evaluated on every request except /api/test/* (A-30, A-46)
function recipients(c, level) {
  const out = new Set();
  if (c.status === 'PENDING_APPROVAL') heads().forEach(u => out.add(u));
  else if (c.status === 'APPROVED') { if (c.issuer) out.add(c.issuer); }
  else if (c.owner) out.add(c.owner);
  else officers(queueDept(c)).forEach(u => out.add(u));
  if (level === 'overdue') heads().forEach(u => out.add(u));
  return out;
}
function tick() {
  const t = C.now();
  let changed = false;
  for (const c of S().cases) {
    if (c.status === 'NEED_FIX' && t >= c.fixDeadline) {
      Object.assign(c, { status: 'CANCELLED', cancelledAt: c.fixDeadline, cancelReason: 'FIX_EXPIRED' });
      c.timeline.push({ at: c.fixDeadline, text: 'ระบบยกเลิกอัตโนมัติ (เลยเวลาแก้ไข 168 ชั่วโมง)' });
      changed = true;
    }
  }
  const seen = new Set(S().notifications.map(n => `${n.caseNo}|${n.level}|${n.username}`));
  for (const c of S().cases) {
    if (!ACTIVE.includes(c.status)) continue;
    const level = C.slaLevel(c, t);
    if (level !== 'near' && level !== 'overdue') continue;
    for (const u of recipients(c, level)) {
      const key = `${c.caseNo}|${level}|${u}`;
      if (seen.has(key)) continue;
      seen.add(key);
      S().notifications.push({ id: ++S().seq.noti, username: u, caseNo: c.caseNo, level, createdAt: t,
        text: `คำขอ ${c.caseNo} ${C.LEVEL_TH[level]}` });
      changed = true;
    }
  }
  return changed;
}
const notificationsOf = u => S().notifications.filter(n => n.username === u).sort((a, b) => b.id - a.id);

function caseJson(c, forCitizen) {
  const idNo = applicantIdNo(c);
  const j = {
    caseNo: c.caseNo, serviceId: c.serviceId, status: c.status, step: c.step, fee: c.fee, paidAt: C.iso(c.paidAt),
    dueAt: C.iso(c.dueAt), slaLevel: C.slaLevel(c), owner: c.owner, returnCount: c.returnCount, closedAt: C.iso(c.closedAt),
    applicantName: applicantName(c), fixDeadline: c.status === 'NEED_FIX' ? C.iso(c.fixDeadline) : null,
    docNo: c.docNo, verifyCode: c.docNo ? docBy(c.docNo).verifyCode : null,
  };
  if (forCitizen) j.idNo = idNo; else j.idMasked = C.maskId(idNo);
  return j;
}
const sortQueue = (a, b) => a.dueAt - b.dueAt || (a.caseNo < b.caseNo ? -1 : 1);
function queueFor(s, filter) {
  let rows = S().cases.filter(c => ['SUBMITTED', 'IN_REVIEW', 'APPROVED'].includes(c.status) && (s.role === 'head' || queueDept(c) === s.dept));
  if (filter === 'unclaimed') rows = rows.filter(c => c.status !== 'APPROVED' && !c.owner);
  if (filter === 'mine') rows = rows.filter(c => c.status === 'IN_REVIEW' && c.owner === s.username);
  return rows.sort(sortQueue);
}
function queueItem(c) {
  const idNo = applicantIdNo(c);
  const item = { caseNo: c.caseNo, serviceId: c.serviceId, applicantName: applicantName(c), idMasked: C.maskId(idNo),
    status: c.status, step: c.step, owner: c.status === 'APPROVED' ? null : c.owner, dueAt: C.iso(c.dueAt), slaLevel: C.slaLevel(c) };
  if (C.bug('B09')) item.idNo = idNo; // B09: full ID leaks in the queue API
  return item;
}

const docBy = no => S().docs.find(d => d.docNo === no);
// next 6-digit sequence for a "<PREFIX>-<BE year>-" number; restarts every Buddhist-era year (A-14, A-48)
const nextSeq = (list, key, prefix) => 1 + Math.max(0, ...list.filter(x => x[key].startsWith(prefix)).map(x => Number(x[key].slice(-6))));
function issueDoc(c) {
  const t = C.now();
  const be = C.beYear(t);
  const seq = nextSeq(S().docs, 'docNo', `DOC-${be}-`);
  let code;
  do code = Array.from(crypto.randomBytes(8), b => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[b % 36]).join('');
  while (S().docs.some(d => d.verifyCode === code));
  const d = { docNo: `DOC-${be}-${C.pad(seq, 6)}`, caseNo: c.caseNo, applicant: applicantName(c), serviceId: c.serviceId,
    issuedAt: C.iso(t), validUntil: C.validUntil(c.serviceId, C.dateKey(t)), signer: staffName(c.approvedBy), verifyCode: code };
  d.sig = C.sign(d);
  S().docs.push(d);
  return d;
}

function dashboard(period, service) {
  const t = C.now();
  const cs = S().cases.filter(c => service === 'ALL' || c.serviceId === service);
  const inP = ms => ms != null && C.dateKey(ms).startsWith(period);
  const received = cs.filter(c => inP(c.paidAt)).length;
  const closedList = cs.filter(c => ['COMPLETED', 'REJECTED'].includes(c.status) && inP(c.closedAt));
  const onTime = closedList.filter(c => c.closedAt <= c.dueAt).length;
  const denom = C.bug('B10') ? received : closedList.length; // B10: divides by received
  const backlog = cs.filter(c => BACKLOG.includes(c.status));
  return {
    received, closed: closedList.length, onTime, ontimePct: denom ? Math.round((onTime * 1000) / denom) / 10 : null,
    backlog: backlog.length, overdue: backlog.filter(c => c.status !== 'NEED_FIX' && t > c.dueAt).length,
    workload: S().staff.filter(u => u.role === 'officer').map(u => ({ username: u.username, count: workload(u.username) })),
  };
}
const pctText = v => (v == null ? '–' : `${v.toFixed(1)}%`);
function periodOf(q) {
  const p = String(q || '');
  return /^\d{4}(-(0[1-9]|1[0-2]))?$/.test(p) ? p : C.iso(C.now()).slice(0, 7);
}
const serviceOf = q => (C.SERVICES[q] ? q : 'ALL');

// drafts & payments
function draftFee(d) {
  if (d.lockedFee != null) return d.lockedFee;
  return C.calcFee(d.serviceId, d).fee ?? null;
}
function draftFiles(ids) { return ids.map(id => C.files.get(id)).filter(Boolean).map(f => ({ fileId: f.fileId, name: f.name, docKey: f.docKey, size: f.size })); }
function missingDocs(d) {
  const keys = new Set(draftFiles(d.fileIds).map(f => f.docKey));
  return C.SERVICES[d.serviceId].docs.filter(([k, , req]) => req && !keys.has(k)).map(([, name]) => name);
}
const qrExpired = p => (C.bug('B05') ? C.now() - p.createdAt > 15 * C.MIN : C.now() - p.createdAt >= 15 * C.MIN); // B05: 15:00 still valid
const payStatus = p => (p.paidAt != null ? 'PAID' : qrExpired(p) ? 'EXPIRED' : 'PENDING');
const payJson = p => ({ ref: p.ref, amount: p.amount, status: payStatus(p), qrCreatedAt: C.iso(p.createdAt),
  qrExpiresAt: C.iso(p.createdAt + 15 * C.MIN), caseNo: p.caseNo, receiptNo: p.receiptNo, paidAt: C.iso(p.paidAt) });
const latestPayment = d => S().payments.filter(p => p.draftId === d.draftId && !p.deleted).at(-1) || null;
function draftJson(d) {
  const p = latestPayment(d);
  return { draftId: d.draftId, serviceId: d.serviceId, status: d.status, fee: draftFee(d), qty: d.qty, areaSqm: d.areaSqm,
    files: draftFiles(d.fileIds), missing: missingDocs(d), caseNo: d.caseNo, payment: p ? payJson(p) : null };
}
function createCase(d, p) {
  const t = C.now();
  const be = C.beYear(t);
  const seq = nextSeq(S().cases, 'caseNo', `EG-${be}-`);
  const c = {
    caseNo: `EG-${be}-${C.pad(seq, 6)}`, serviceId: d.serviceId, qty: d.qty, areaSqm: d.areaSqm, fee: p.amount, applicantId: d.ownerId,
    status: 'SUBMITTED', step: d.serviceId === 'SV-03' ? 1 : null, owner: null, issuer: null, approvedBy: null, returnCount: 0,
    returns: [], fixDeadline: null, paidAt: t, receiptNo: `RC-${be}-${C.pad(seq, 6)}`,
    dueAt: C.computeDue(t, S().services[d.serviceId].sla), closedAt: null, cancelledAt: null, cancelReason: null,
    visited: ['registry'], fileIds: d.fileIds, docNo: null, timeline: [{ at: t, text: 'ชำระเงินสำเร็จ ส่งคำขอแล้ว' }],
  };
  for (const id of c.fileIds) C.files.get(id).owner = { caseNo: c.caseNo };
  S().cases.push(c);
  Object.assign(d, { status: 'SUBMITTED', caseNo: c.caseNo });
  Object.assign(p, { paidAt: t, caseNo: c.caseNo, receiptNo: c.receiptNo });
  return c;
}

// file access rules (BR-29)
function fileAccess(s, c) {
  if (!s) throw E(401, 'UNAUTHENTICATED');
  if (!['citizen', 'officer', 'head'].includes(s.role)) throw E(403, 'FORBIDDEN');
  if (s.role === 'citizen') { if (!c || c.applicantId !== s.citizenId) throw E(404, 'NOT_FOUND'); return; }
  if (!c) throw E(404, 'NOT_FOUND');
  if (s.role === 'officer' && !c.visited.includes(s.dept)) throw E(403, 'FORBIDDEN');
}

module.exports = {
  sessions, staffBy, staffName, citizenBy, caseBy, draftBy, workload, applicantName, applicantIdNo,
  OPEN_DRAFT, ROLES, DEPTS, openDraftsOf, casesOf, citizenCase, holidaysSorted, sortQueue, auditFilters,
  ApiError, E, queueDept, STEP_TH, can, audit, auditJson, auditQuery, AUDIT_EVENTS, tick, notificationsOf, caseJson, queueFor,
  queueItem, docBy, issueDoc, dashboard, pctText, periodOf, serviceOf, draftFee, draftFiles, missingDocs, payStatus, payJson,
  draftJson, createCase, fileAccess,
};
