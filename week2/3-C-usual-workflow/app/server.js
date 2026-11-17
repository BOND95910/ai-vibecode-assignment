'use strict';
// e-Service กลาง (เทศบาลนครตัวอย่าง · ระบบจำลอง) — plain node:http, no framework.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const C = require('./core');
const D = require('./domain');
const P = require('./pages');
const S = () => C.state;
const { E } = D;

const PORT = Number(process.env.PORT || 3000);
const MAX_BODY = 32 * 1024 * 1024; // must exceed 6 MB so oversize files get FILE_TOO_LARGE, not 413

// ---------------------------------------------------------------- plumbing
const readBody = req => new Promise((resolve, reject) => {
  const chunks = []; let n = 0;
  req.on('data', ch => { n += ch.length; if (n <= MAX_BODY) chunks.push(ch); });
  req.on('end', () => (n > MAX_BODY ? reject(E(413, 'INVALID_INPUT')) : resolve(Buffer.concat(chunks))));
  req.on('error', reject);
});
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim()).filter(Boolean)
  .map(s => [s.slice(0, s.indexOf('=')), decodeURIComponent(s.slice(s.indexOf('=') + 1))]));
async function parseForm(ctx) { // multipart/form-data via the built-in WHATWG parser
  try {
    const fd = await new Request('http://local/', { method: 'POST', headers: { 'content-type': ctx.req.headers['content-type'] || '' }, body: ctx.raw }).formData();
    const files = [];
    for (const [field, v] of fd) if (typeof v !== 'string') files.push({ field, filename: v.name, data: Buffer.from(await v.arrayBuffer()) });
    return { get: k => fd.get(k), files };
  } catch { throw E(400, 'INVALID_INPUT'); }
}
function newSession(sess) {
  const sid = crypto.randomBytes(24).toString('base64url');
  D.sessions.set(sid, sess);
  return `sid=${sid}; HttpOnly; Path=/; SameSite=Lax`;
}
function need(ctx, ...roles) {
  const s = ctx.session;
  if (!s || !s.registered) throw E(401, 'UNAUTHENTICATED');
  if (roles.length && !roles.includes(s.role)) throw E(403, 'FORBIDDEN');
  return s;
}
const reasonOk = (r, min) => [...String(r ?? '').trim()].length >= min;

const routes = [];
const route = (method, pattern, fn) => routes.push({ method, fn,
  re: new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$') });

// ---------------------------------------------------------------- health + auth
route('GET', '/api/health', ctx => ctx.json(200, { status: 'ok' }));

const otpState = id => (S().otp[C.idHash(id)] ||= { fails: 0, lockedUntil: null });
function thaidId(ctx) {
  const id = String(ctx.body.idNo ?? '').trim();
  if (!C.validId(id)) throw E(400, 'INVALID_ID');
  const o = otpState(id);
  if (o.lockedUntil && C.now() < o.lockedUntil) throw E(423, 'LOCKED', { lockedUntil: C.iso(o.lockedUntil) });
  return [id, o];
}
route('POST', '/api/auth/thaid/start', ctx => { thaidId(ctx); ctx.json(200, { status: 'OTP_SENT' }); });
route('POST', '/api/auth/thaid/verify', ctx => {
  const [id, o] = thaidId(ctx);
  if (String(ctx.body.otp ?? '') !== '123456') {
    o.fails++;
    if (o.fails >= 3) {
      Object.assign(o, { fails: 0, lockedUntil: C.now() + 15 * C.MIN });
      throw E(423, 'LOCKED', { lockedUntil: C.iso(o.lockedUntil) });
    }
    throw E(401, 'OTP_INVALID', { attemptsLeft: 3 - o.fails });
  }
  Object.assign(o, { fails: 0, lockedUntil: null });
  const h = C.idHash(id);
  let cz = S().citizens.find(c => c.idHash === h);
  if (!cz) { // simulated ThaiD returns a placeholder name for IDs outside the seed directory
    cz = { id: 'c-' + crypto.randomBytes(6).toString('hex'), idHash: h, idEnc: C.enc(id), name: 'ผู้ใช้ทดสอบ ThaiD', mobileEnc: null, emailEnc: null, registered: false };
    S().citizens.push(cz);
  }
  const cookie = newSession({ kind: 'citizen', citizenId: cz.id, username: null, name: cz.name, role: 'citizen', dept: '', registered: cz.registered });
  ctx.json(200, { registered: cz.registered }, { 'Set-Cookie': cookie });
});
route('POST', '/api/auth/register', ctx => {
  const s = ctx.session;
  if (!s || s.role !== 'citizen') throw E(401, 'UNAUTHENTICATED');
  const cz = D.citizenBy(s.citizenId);
  if (cz.registered) throw E(409, 'INVALID_STATE');
  const mobile = String(ctx.body.mobile ?? '').trim();
  if (!/^0\d{9}$/.test(mobile)) throw E(400, 'INVALID_MOBILE');
  if (ctx.body.consent !== true) throw E(400, 'CONSENT_REQUIRED');
  const email = String(ctx.body.email ?? '').trim();
  Object.assign(cz, { mobileEnc: C.enc(mobile), emailEnc: email ? C.enc(email) : null, registered: true });
  s.registered = true;
  ctx.json(201, { registered: true });
});
route('POST', '/api/auth/staff/login', async ctx => {
  const u = D.staffBy(String(ctx.body.username ?? '').trim());
  if (!u || !(await C.checkPw(u, ctx.body.password))) throw E(401, 'INVALID_CREDENTIALS');
  const s = { kind: 'staff', username: u.username, name: u.name, role: u.role, dept: u.dept, registered: true };
  const cookie = newSession(s);
  D.audit(s, 'STAFF_LOGIN');
  ctx.json(200, { role: u.role, dept: u.dept, landing: C.LANDING[u.role] }, { 'Set-Cookie': cookie });
});
route('POST', '/api/auth/logout', ctx => {
  if (ctx.sid) D.sessions.delete(ctx.sid);
  ctx.send(204, '', { 'Set-Cookie': 'sid=; HttpOnly; Path=/; Max-Age=0' });
});
route('GET', '/api/me', ctx => {
  const s = ctx.session;
  if (!s) throw E(401, 'UNAUTHENTICATED');
  ctx.json(200, { username: s.username, name: s.name, role: s.role, dept: s.dept });
});

// ---------------------------------------------------------------- citizen: drafts, files, payments
route('GET', '/api/fee', ctx => {
  need(ctx);
  const svc = ctx.query.get('serviceId');
  if (!C.SERVICES[svc]) throw E(400, 'INVALID_INPUT');
  const r = C.calcFee(svc, { qty: ctx.query.get('qty'), areaSqm: ctx.query.get('areaSqm') });
  if (r.code) throw E(400, r.code);
  ctx.json(200, { fee: r.fee });
});
function ownDraft(ctx) {
  const s = need(ctx, 'citizen');
  const d = D.draftBy(ctx.params.id);
  if (!d || d.ownerId !== s.citizenId) throw E(404, 'NOT_FOUND');
  return d;
}
function feeInput(svc, body) {
  const r = C.calcFee(svc, body);
  if (r.code) throw E(400, r.code);
  return { qty: r.qty ?? null, areaSqm: r.areaSqm ?? null, fee: r.fee };
}
route('POST', '/api/drafts', ctx => {
  const s = need(ctx, 'citizen');
  const svc = ctx.body.serviceId;
  if (!C.SERVICES[svc]) throw E(400, 'INVALID_INPUT');
  const { qty, areaSqm, fee } = feeInput(svc, ctx.body);
  const d = { draftId: 'DR-' + C.pad(++S().seq.draft, 4), ownerId: s.citizenId, serviceId: svc, qty, areaSqm, status: 'DRAFT', lockedFee: null, fileIds: [], caseNo: null };
  S().drafts.push(d);
  ctx.json(201, { draftId: d.draftId, fee });
});
route('PATCH', '/api/drafts/:id', ctx => {
  const d = ownDraft(ctx);
  if (d.status !== 'DRAFT') throw E(409, 'INVALID_STATE');
  const { qty, areaSqm, fee } = feeInput(d.serviceId, ctx.body);
  Object.assign(d, { qty, areaSqm });
  ctx.json(200, { draftId: d.draftId, fee });
});
route('GET', '/api/drafts', ctx => {
  const s = need(ctx, 'citizen');
  const items = D.openDraftsOf(s.citizenId)
    .map(d => ({ draftId: d.draftId, serviceId: d.serviceId, status: d.status, fee: D.draftFee(d) }));
  ctx.json(200, { items });
});
route('GET', '/api/drafts/:id', ctx => ctx.json(200, D.draftJson(ownDraft(ctx))));
route('DELETE', '/api/drafts/:id', ctx => {
  const d = ownDraft(ctx);
  if (!D.OPEN_DRAFT.includes(d.status)) throw E(409, 'INVALID_STATE');
  d.status = 'DELETED';
  S().payments.filter(p => p.draftId === d.draftId).forEach(p => { p.deleted = true; });
  d.fileIds.forEach(id => C.files.delete(id));
  ctx.send(204, '');
});
route('POST', '/api/drafts/:id/files', async ctx => {
  ownDraft(ctx); // auth/ownership before reading the body
  const mp = await parseForm(ctx);
  const d = ownDraft(ctx); // re-read after the await: checks + mutation below are synchronous
  if (d.status !== 'DRAFT') throw E(409, 'INVALID_STATE');
  const f = mp.files.find(x => x.field === 'file');
  const docKey = mp.get('docKey');
  const allowed = C.SERVICES[d.serviceId].docs.map(x => x[0]).concat('extra');
  if (!f || !allowed.includes(docKey)) throw E(400, 'INVALID_INPUT');
  const bad = C.checkFile(f.data, docKey);
  if (bad) throw E(400, bad);
  if (d.fileIds.length >= 5) throw E(400, 'FILE_COUNT');
  const fileId = C.addFile(f.filename, docKey, f.data, { draftId: d.draftId });
  d.fileIds.push(fileId);
  ctx.json(201, { fileId, name: f.filename, docKey, size: f.data.length });
});
route('DELETE', '/api/drafts/:id/files/:fileId', ctx => {
  const d = ownDraft(ctx);
  if (d.status !== 'DRAFT' || !d.fileIds.includes(ctx.params.fileId)) throw E(409, 'INVALID_STATE');
  d.fileIds = d.fileIds.filter(x => x !== ctx.params.fileId);
  C.files.delete(ctx.params.fileId);
  ctx.send(204, '');
});
route('POST', '/api/drafts/:id/payment', ctx => {
  const d = ownDraft(ctx);
  if (!D.OPEN_DRAFT.includes(d.status)) throw E(409, 'INVALID_STATE');
  const missing = D.missingDocs(d);
  if (missing.length) throw E(409, 'MISSING_DOCS', { missing, message: `ยังขาดเอกสาร: ${missing.join(', ')}` });
  if (d.status === 'DRAFT') { // amount is locked when the request enters PENDING_PAYMENT (A-42)
    d.lockedFee = feeInput(d.serviceId, d).fee;
    d.status = 'PENDING_PAYMENT';
  }
  const p = { ref: 'PP-' + C.pad(++S().seq.pp, 4), draftId: d.draftId, amount: d.lockedFee, createdAt: C.now(), paidAt: null, caseNo: null, receiptNo: null, deleted: false };
  S().payments.push(p);
  const j = D.payJson(p);
  ctx.json(201, { ref: j.ref, amount: j.amount, qrCreatedAt: j.qrCreatedAt, qrExpiresAt: j.qrExpiresAt });
});
route('GET', '/api/payments/:ref', ctx => {
  const s = need(ctx, 'citizen');
  const p = S().payments.find(x => x.ref === ctx.params.ref && !x.deleted);
  if (!p || D.draftBy(p.draftId)?.ownerId !== s.citizenId) throw E(404, 'NOT_FOUND');
  ctx.json(200, D.payJson(p));
});

// ---------------------------------------------------------------- cases (citizen + staff)
route('GET', '/api/cases', ctx => {
  const s = need(ctx, 'citizen');
  const items = D.casesOf(s.citizenId)
    .map(c => ({ caseNo: c.caseNo, serviceId: c.serviceId, status: c.status, dueAt: C.iso(c.dueAt), slaLevel: C.slaLevel(c) }));
  ctx.json(200, { items });
});
route('GET', '/api/cases/:caseNo', ctx => {
  const s = need(ctx, 'citizen', 'officer', 'head');
  const c = D.caseBy(ctx.params.caseNo);
  if (s.role === 'citizen') {
    if (!D.citizenCase(s, ctx.params.caseNo)) throw E(404, 'NOT_FOUND');
    return ctx.json(200, D.caseJson(c, true));
  }
  if (!c) throw E(404, 'NOT_FOUND');
  ctx.json(200, D.caseJson(c, false));
});
function ownCase(ctx) {
  const s = need(ctx, 'citizen');
  const c = D.caseBy(ctx.params.caseNo);
  if (!c || c.applicantId !== s.citizenId) throw E(404, 'NOT_FOUND');
  return [s, c];
}
route('POST', '/api/cases/:caseNo/cancel', ctx => {
  const [, c] = ownCase(ctx);
  if (c.status !== 'SUBMITTED' || c.owner) throw E(409, 'CANNOT_CANCEL');
  Object.assign(c, { status: 'CANCELLED', cancelledAt: C.now(), cancelReason: 'CITIZEN' });
  c.timeline.push({ at: C.now(), text: 'ผู้ยื่นยกเลิกคำขอ' });
  ctx.json(200, { status: 'CANCELLED' });
});
route('POST', '/api/cases/:caseNo/resubmit', async ctx => {
  // parse before any check so checks + mutation run without an await in between (no interleaving)
  const multipart = /multipart/i.test(ctx.req.headers['content-type'] || '');
  const uploads = (multipart ? (await parseForm(ctx)).files : []).filter(f => f.data.length);
  const [, c] = ownCase(ctx);
  if (c.status === 'CANCELLED' && c.cancelReason === 'FIX_EXPIRED') throw E(409, 'FIX_WINDOW_EXPIRED');
  if (c.status !== 'NEED_FIX') throw E(409, 'INVALID_STATE');
  for (const f of uploads) { const bad = C.checkFile(f.data, 'extra'); if (bad) throw E(400, bad); }
  for (const f of uploads) c.fileIds.push(C.addFile(f.filename, 'extra', f.data, { caseNo: c.caseNo }));
  const t = C.now();
  c.dueAt = C.extendDue(c.dueAt, c.returns.at(-1).at, t);
  c.returns.at(-1).resubmittedAt = t;
  Object.assign(c, { status: 'IN_REVIEW', fixDeadline: null }); // back to the same owner/step, no workload check (A-29)
  c.timeline.push({ at: t, text: 'ประชาชนส่งแก้ไขแล้ว' });
  ctx.json(200, { status: 'IN_REVIEW', dueAt: C.iso(c.dueAt) });
});

// ---------------------------------------------------------------- officer / head actions
function staffCase(ctx, ...roles) {
  const s = need(ctx, ...roles);
  const c = D.caseBy(ctx.params.caseNo);
  if (!c) throw E(404, 'NOT_FOUND');
  return [s, c];
}
function ownerOnly(s, c) {
  if (s.role !== 'officer' || c.owner !== s.username) throw E(403, 'FORBIDDEN');
  if (c.status !== 'IN_REVIEW') throw E(409, 'INVALID_STATE');
}
route('GET', '/api/officer/queue', ctx => {
  const s = need(ctx, 'officer', 'head');
  ctx.json(200, { items: D.queueFor(s, ctx.query.get('filter') || 'all').map(D.queueItem) });
});
route('POST', '/api/officer/cases/:caseNo/claim', ctx => {
  const s = need(ctx);
  if (s.role !== 'officer') throw E(403, 'FORBIDDEN');
  const c = D.caseBy(ctx.params.caseNo);
  if (!c) throw E(404, 'NOT_FOUND');
  if (D.queueDept(c) !== s.dept) throw E(403, 'FORBIDDEN');
  if (!['SUBMITTED', 'IN_REVIEW'].includes(c.status)) throw E(409, 'INVALID_STATE');
  if (c.owner && !C.bug('B08')) throw E(409, 'ALREADY_CLAIMED'); // B08: skips the "already claimed" check
  if (D.workload(s.username) >= 10) throw E(409, 'WORKLOAD_LIMIT');
  const from = c.status;
  Object.assign(c, { status: 'IN_REVIEW', owner: s.username });
  c.timeline.push({ at: C.now(), text: `รับเรื่องโดย ${s.name}` });
  D.audit(s, 'CLAIM', c, from, 'IN_REVIEW');
  ctx.json(200, { owner: s.username });
});
route('POST', '/api/officer/cases/:caseNo/return', ctx => {
  const [s, c] = staffCase(ctx);
  ownerOnly(s, c);
  if (c.returnCount >= 2 && !C.bug('B12')) throw E(409, 'RETURN_LIMIT'); // B12: third return allowed
  const reason = String(ctx.body.reason ?? '').trim();
  if (!reasonOk(reason, 10)) throw E(400, 'REASON_TOO_SHORT');
  const t = C.now();
  c.returns.push({ at: t, reason, resubmittedAt: null });
  Object.assign(c, { status: 'NEED_FIX', returnCount: c.returnCount + 1, fixDeadline: t + 168 * C.HOUR });
  c.timeline.push({ at: t, text: `ตีกลับให้แก้ไข: ${reason}` });
  D.audit(s, 'RETURN', c, 'IN_REVIEW', 'NEED_FIX', reason);
  ctx.json(200, { status: 'NEED_FIX', returnCount: c.returnCount });
});
route('POST', '/api/officer/cases/:caseNo/forward', ctx => {
  const [s, c] = staffCase(ctx);
  ownerOnly(s, c);
  if (c.serviceId === 'SV-01') throw E(409, 'INVALID_STATE');
  const note = String(ctx.body.note ?? '').trim();
  if (D.queueDept(c) === 'registry') c.issuer ||= s.username; // issuer of SV-02/03 = first registry officer (A-27)
  let resp;
  if (c.serviceId === 'SV-03' && c.step === 1) {
    Object.assign(c, { step: 2, owner: null });
    if (!c.visited.includes('works')) c.visited.push('works');
    resp = { status: 'IN_REVIEW', step: 2 };
  } else {
    Object.assign(c, { status: 'PENDING_APPROVAL', owner: null, step: c.serviceId === 'SV-03' ? 3 : null });
    resp = { status: 'PENDING_APPROVAL' };
  }
  c.timeline.push({ at: C.now(), text: `ส่งต่อโดย ${s.name}${note ? ` (${note})` : ''}` });
  D.audit(s, 'FORWARD', c, 'IN_REVIEW', resp.status, note);
  ctx.json(200, resp);
});
function decide(ctx, approving) {
  const [s, c] = staffCase(ctx);
  if (!['officer', 'head'].includes(s.role)) throw E(403, 'FORBIDDEN');
  let from = c.status;
  if (c.serviceId === 'SV-01') ownerOnly(s, c);
  else {
    const bypass = approving && C.bug('B07') && s.role === 'officer'; // B07: officer approves SV-02/03 itself
    if (s.role !== 'head' && !bypass) throw E(403, 'FORBIDDEN');
    if (c.status !== 'PENDING_APPROVAL' && !(bypass && c.status === 'IN_REVIEW')) throw E(409, 'INVALID_STATE');
  }
  const reason = String(ctx.body.reason ?? '').trim();
  if (!approving && !reasonOk(reason, 10)) throw E(400, 'REASON_TOO_SHORT');
  const t = C.now();
  if (approving) {
    if (c.serviceId === 'SV-01') c.issuer = s.username;
    Object.assign(c, { status: 'APPROVED', approvedBy: s.username, owner: null });
    c.timeline.push({ at: t, text: `อนุมัติโดย ${s.name}` });
  } else {
    Object.assign(c, { status: 'REJECTED', approvedBy: s.username, owner: null, closedAt: t });
    c.timeline.push({ at: t, text: `ไม่อนุมัติโดย ${s.name}: ${reason}` });
  }
  D.audit(s, approving ? 'APPROVE' : 'REJECT', c, from, c.status, approving ? '' : reason);
  ctx.json(200, approving ? { status: 'APPROVED' } : { status: 'REJECTED', closedAt: C.iso(t) });
}
route('POST', '/api/cases/:caseNo/approve', ctx => decide(ctx, true));
route('POST', '/api/cases/:caseNo/reject', ctx => decide(ctx, false));
route('POST', '/api/officer/cases/:caseNo/issue', ctx => {
  const [s, c] = staffCase(ctx);
  if (s.role !== 'officer' || c.issuer !== s.username) throw E(403, 'FORBIDDEN');
  if (c.status !== 'APPROVED') throw E(409, 'INVALID_STATE');
  const d = D.issueDoc(c);
  Object.assign(c, { status: 'COMPLETED', closedAt: C.now(), docNo: d.docNo });
  c.timeline.push({ at: C.now(), text: `ออกเอกสาร ${d.docNo} เสร็จสิ้น` });
  D.audit(s, 'ISSUE', c, 'APPROVED', 'COMPLETED', d.docNo);
  ctx.json(200, { docNo: d.docNo, verifyCode: d.verifyCode, status: 'COMPLETED' });
});
route('POST', '/api/officer/cases/:caseNo/unmask', ctx => {
  const [s, c] = staffCase(ctx, 'officer', 'head');
  const reason = String(ctx.body.reason ?? '').trim();
  if (!reason) throw E(400, 'REASON_REQUIRED');
  if (!C.bug('B11')) D.audit(s, 'UNMASK', c, null, null, reason); // B11: unmask not audited
  ctx.json(200, { idNo: D.applicantIdNo(c) });
});
route('GET', '/api/notifications', ctx => {
  const s = need(ctx, 'officer', 'head');
  ctx.json(200, { items: D.notificationsOf(s.username).map(n => ({ id: n.id, caseNo: n.caseNo, level: n.level, text: n.text, createdAt: C.iso(n.createdAt) })) });
});

// ---------------------------------------------------------------- files & documents
route('GET', '/api/cases/:caseNo/files', ctx => {
  const c = D.caseBy(ctx.params.caseNo);
  D.fileAccess(ctx.session?.registered ? ctx.session : null, c);
  ctx.json(200, { items: D.draftFiles(c.fileIds) });
});
route('GET', '/api/files/:fileId', ctx => {
  const s = ctx.session?.registered ? ctx.session : null;
  const f = C.files.get(ctx.params.fileId);
  if (!s) throw E(401, 'UNAUTHENTICATED');
  if (!f) D.fileAccess(s, null); // always throws (403 or 404 by role)
  if (f.owner.draftId) { // still in a draft: only the citizen who owns it
    if (s.role !== 'citizen') throw E(403, 'FORBIDDEN');
    if (D.draftBy(f.owner.draftId)?.ownerId !== s.citizenId) throw E(404, 'NOT_FOUND');
  } else D.fileAccess(s, D.caseBy(f.owner.caseNo));
  ctx.send(200, f.data, { 'Content-Type': C.MIME[f.type], 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.name)}` });
});
function docPdf(d, host) {
  return C.makePdf([
    'e-Service (simulated municipality) - digital document',
    `docNo=${d.docNo} caseNo=${d.caseNo} verify=${d.verifyCode} validUntil=${d.validUntil}`,
    `service=${d.serviceId} issuedAt=${d.issuedAt}`,
    `Verify: http://${host}/verify/${d.verifyCode}`,
    'Signature: HMAC-SHA256 (test key, simulated)',
  ]);
}
route('GET', '/api/documents/:docNo/pdf', ctx => {
  const s = need(ctx, 'citizen', 'officer', 'head');
  const d = D.docBy(ctx.params.docNo);
  const c = d && D.caseBy(d.caseNo);
  if (!d || (s.role === 'citizen' && c.applicantId !== s.citizenId)) throw E(404, 'NOT_FOUND');
  ctx.send(200, docPdf(d, ctx.req.headers.host), { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${d.docNo}.pdf"` });
});
route('GET', '/api/verify/:code', ctx => {
  const d = S().docs.find(x => x.verifyCode === ctx.params.code);
  if (!d) return ctx.json(404, { result: 'NOT_FOUND' });
  const result = C.verifyResult(d);
  if (result === 'TAMPERED') return ctx.json(200, { result });
  ctx.json(200, { result, docNo: d.docNo, applicantMasked: C.maskName(d.applicant), serviceId: d.serviceId, issuedAt: d.issuedAt, validUntil: d.validUntil, signer: d.signer });
});

// ---------------------------------------------------------------- dashboard / audit
route('GET', '/api/dashboard', ctx => {
  need(ctx, 'executive');
  ctx.json(200, D.dashboard(D.periodOf(ctx.query.get('period')), D.serviceOf(ctx.query.get('service'))));
});
route('GET', '/api/dashboard/export', async ctx => {
  const s = need(ctx, 'executive');
  const format = ctx.query.get('format');
  if (!['xlsx', 'pdf'].includes(format)) throw E(400, 'INVALID_INPUT');
  const period = D.periodOf(ctx.query.get('period')), service = D.serviceOf(ctx.query.get('service'));
  const k = D.dashboard(period, service);
  const pct = D.pctText(k.ontimePct);
  const fname = `dashboard-${period}-${service}.${format}`;
  let body, type;
  if (format === 'xlsx') {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('KPI');
    [['ตัวชี้วัด', 'ค่า'], ['รับเรื่อง', String(k.received)], ['ปิดงาน', String(k.closed)], ['ทันกำหนด %', pct],
      ['งานคงค้าง', String(k.backlog)], ['เกินกำหนดคงค้าง', String(k.overdue)]].forEach(r => ws.addRow(r));
    body = Buffer.from(await wb.xlsx.writeBuffer());
    type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  } else {
    body = C.makePdf(['e-Service dashboard report (simulated municipality)', `period=${period} service=${service}`,
      `kpi received=${k.received} closed=${k.closed} ontime=${k.ontimePct == null ? '-' : pct} backlog=${k.backlog} overdue=${k.overdue}`]);
    type = 'application/pdf';
  }
  D.audit(s, 'EXPORT', null, null, null, `${format} ${period} ${service}`);
  ctx.send(200, body, { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${fname}"` });
});
route('GET', '/api/audit', ctx => {
  need(ctx, 'auditor');
  const rows = D.auditQuery(D.auditFilters(ctx.query));
  ctx.json(200, { count: rows.length, items: rows.map(D.auditJson) });
});
route('GET', '/api/audit/export.csv', ctx => {
  const s = need(ctx, 'auditor');
  const q = v => {
    if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`; // neutralise spreadsheet formulas typed into free-text reasons
    return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const lines = ['time,username,role,event,caseNo,fromStatus,toStatus,detail'].concat(D.auditQuery(D.auditFilters(ctx.query)).map(D.auditJson)
    .map(a => [a.time, a.username, a.role, a.event, a.caseNo || '', a.fromStatus || '', a.toStatus || '', a.detail || ''].map(v => q(String(v))).join(',')));
  D.audit(s, 'EXPORT', null, null, null, 'audit-csv');
  ctx.send(200, lines.join('\r\n') + '\r\n', { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="audit.csv"' });
});

// ---------------------------------------------------------------- admin
// audit is append-only: GET /api/audit/:id exists only so the router answers PUT/PATCH/DELETE with 405 (not 404)
route('GET', '/api/audit/:id', () => { throw E(404, 'NOT_FOUND'); });

const svcJson = ([id, v]) => ({ id, fee: v.fee, feePerSqm: v.feePerSqm ?? null, sla: v.sla });
route('GET', '/api/admin/services', ctx => { need(ctx, 'admin'); ctx.json(200, { items: Object.entries(S().services).map(svcJson) }); });
route('PUT', '/api/admin/services/:id', ctx => {
  const s = need(ctx, 'admin');
  const svc = S().services[ctx.params.id];
  if (!svc) throw E(404, 'NOT_FOUND');
  const b = ctx.body;
  const changes = [];
  const fields = [ // [key, value, min, max, error] — validated in this order; absent fields stay unchanged (BR-28)
    ['fee', b.fee ?? b.feeBase, 0, 100000, 'INVALID_FEE'],
    ['feePerSqm', ctx.params.id === 'SV-03' ? b.feePerSqm : undefined, 0, 100000, 'INVALID_FEE'],
    ['sla', b.sla, 1, 60, 'INVALID_SLA'],
  ];
  for (const [key, v, min, max, code] of fields) {
    if (v == null || v === '') continue;
    const n = C.toInt(v);
    if (n == null || n < min || n > max) throw E(400, code);
    changes.push([key, n]);
  }
  for (const [key, n] of changes) {
    if (svc[key] === n) continue;
    D.audit(s, 'ADMIN_CHANGE', null, null, null, `${ctx.params.id} ${key} ${svc[key]} → ${n}`);
    svc[key] = n;
  }
  ctx.json(200, svcJson([ctx.params.id, svc]));
});
route('GET', '/api/admin/holidays', ctx => { need(ctx, 'admin'); ctx.json(200, { items: D.holidaysSorted() }); });
route('POST', '/api/admin/holidays', ctx => {
  const s = need(ctx, 'admin');
  const date = String(ctx.body.date ?? '').trim(), name = String(ctx.body.name ?? '').trim();
  if (!C.validDate(date)) throw E(400, 'INVALID_INPUT');
  if (S().holidays.some(h => h.date === date)) throw E(409, 'DUPLICATE_HOLIDAY');
  S().holidays.push({ date, name: name || 'วันหยุด' });
  D.audit(s, 'ADMIN_CHANGE', null, null, null, `holiday add ${date}`);
  ctx.json(201, { date, name });
});
route('DELETE', '/api/admin/holidays/:date', ctx => {
  const s = need(ctx, 'admin');
  const i = S().holidays.findIndex(h => h.date === ctx.params.date);
  if (i < 0) throw E(404, 'NOT_FOUND');
  S().holidays.splice(i, 1);
  D.audit(s, 'ADMIN_CHANGE', null, null, null, `holiday delete ${ctx.params.date}`);
  ctx.json(200, { ok: true });
});
route('GET', '/api/admin/users', ctx => { need(ctx, 'admin'); ctx.json(200, { items: S().staff.map(u => ({ username: u.username, name: u.name, role: u.role, dept: u.dept })) }); });
route('PUT', '/api/admin/users/:username', ctx => {
  const s = need(ctx, 'admin');
  const u = D.staffBy(ctx.params.username);
  if (!u) throw E(404, 'NOT_FOUND');
  if (u.username === s.username) throw E(409, 'SELF_ROLE_CHANGE');
  const role = ctx.body.role ?? u.role, dept = ctx.body.dept ?? u.dept;
  if (!D.ROLES.includes(role) || !(dept in D.DEPTS)) throw E(400, 'INVALID_INPUT');
  if (role !== u.role) D.audit(s, 'ADMIN_CHANGE', null, null, null, `${u.username} role ${u.role} → ${role}`);
  if (dept !== u.dept) D.audit(s, 'ADMIN_CHANGE', null, null, null, `${u.username} dept ${u.dept || '-'} → ${dept || '-'}`);
  Object.assign(u, { role, dept }); // takes effect at the user's next login
  ctx.json(200, { username: u.username, role, dept });
});

// ---------------------------------------------------------------- test hooks (TEST_MODE=1 only)
route('POST', '/api/test/reset', ctx => {
  D.sessions.clear();
  C.seed();
  ctx.json(200, { ok: true, now: C.iso(C.now()) });
});
route('GET', '/api/test/clock', ctx => ctx.json(200, { now: C.iso(C.now()) }));
route('PUT', '/api/test/clock', ctx => {
  const v = String(ctx.body.now ?? '');
  if (!C.ISO_RE.test(v) || Number.isNaN(Date.parse(v))) throw E(400, 'INVALID_TIME');
  C.setNow(Date.parse(v));
  ctx.json(200, { now: C.iso(C.now()) });
});
route('POST', '/api/test/payments/:ref/pay', ctx => {
  const p = S().payments.find(x => x.ref === ctx.params.ref && !x.deleted);
  if (!p) throw E(404, 'NOT_FOUND');
  if (p.paidAt != null) return ctx.json(200, { status: 'PAID', caseNo: p.caseNo, receiptNo: p.receiptNo, duplicate: true });
  if (D.payStatus(p) === 'EXPIRED') throw E(410, 'QR_EXPIRED');
  if (Number(ctx.body.amount) !== p.amount) throw E(422, 'AMOUNT_MISMATCH');
  const d = D.draftBy(p.draftId);
  if (!d || d.status !== 'PENDING_PAYMENT') throw E(409, 'INVALID_STATE');
  const c = D.createCase(d, p);
  ctx.json(200, { status: 'PAID', caseNo: c.caseNo, receiptNo: c.receiptNo, duplicate: false });
});
route('POST', '/api/test/documents/:docNo/tamper', ctx => {
  const d = D.docBy(ctx.params.docNo);
  if (!d) throw E(404, 'NOT_FOUND');
  d.applicant += ' (แก้ไข)'; // stored field changed, signature left as-is
  ctx.json(200, { ok: true });
});

// ---------------------------------------------------------------- server
const STATIC = { '/static/app.js': 'application/javascript; charset=utf-8', '/static/app.css': 'text/css; charset=utf-8' };
const staticCache = {};
async function handle(req, res) {
  const url = new URL(req.url, 'http://local');
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { p = url.pathname; }
  const hook = p.startsWith('/api/test/');
  const send = (status, body, headers = {}) => { res.writeHead(status, { 'Cache-Control': 'no-store', ...headers }); res.end(body); };
  const json = (status, obj, headers = {}) => send(status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  if (hook && !C.TEST_MODE) return json(404, { code: 'NOT_FOUND', message: 'Not Found' });
  const changed = hook ? false : D.tick();
  const sid = cookies(req).sid;
  const ctx = { req, res, path: p, query: url.searchParams, sid, session: (sid && D.sessions.get(sid)) || null, send, json, params: {}, body: {} };
  try {
    if (p.startsWith('/api/')) {
      const hits = routes.filter(r => r.re.test(p));
      const r = hits.find(x => x.method === req.method);
      if (!r) throw hits.length ? E(405, 'METHOD_NOT_ALLOWED') : E(404, 'NOT_FOUND');
      ctx.params = r.re.exec(p).groups || {};
      if (!['GET', 'HEAD'].includes(req.method)) {
        ctx.raw = await readBody(req);
        if (/json/i.test(req.headers['content-type'] || '') && ctx.raw.length) {
          try { ctx.body = JSON.parse(ctx.raw.toString('utf8')) || {}; } catch { throw E(400, 'INVALID_INPUT'); }
        }
      }
      await r.fn(ctx);
    } else if (STATIC[p]) {
      staticCache[p] ||= fs.readFileSync(path.join(__dirname, p));
      send(200, staticCache[p], { 'Content-Type': STATIC[p] });
    } else {
      await P.page(ctx);
    }
  } catch (e) {
    if (e instanceof D.ApiError) {
      const { message, ...extra } = e.extra || {};
      json(e.status, { code: e.code, message: message || C.MSG[e.code] || e.code, ...extra });
    } else {
      console.error(e);
      if (!res.headersSent) json(500, { code: 'INTERNAL', message: 'เกิดข้อผิดพลาดภายในระบบ' });
    }
  }
  // reset already persisted inside seed(); the clock lives outside the snapshot
  if (changed || (!['GET', 'HEAD'].includes(req.method) && p !== '/api/test/reset' && p !== '/api/test/clock')) {
    try { C.persist(); } catch (e) { console.error('persist failed:', e.message); } // state stays in memory; keep serving
  }
}

C.seed();
http.createServer((req, res) => { handle(req, res).catch(e => console.error('request failed:', e)); }).listen(PORT, () => {
  console.log(`e-Service listening on http://localhost:${PORT} TEST_MODE=${C.TEST_MODE ? 1 : 0} BUG_MODE=${[...C.BUGS].join(',') || '(none)'} DB_PATH=${C.DB_PATH}`);
});
