// B08 selftest: node server/cases.selftest.js   (ลอง BUG_MODE=B06|B07|B08|B09|B11|B12 · ไม่ตั้ง = ต้องผ่านทั้งหมด)
// express ชั่วคราวพอร์ตสุ่ม โหลด server/routes/*.js ทุกไฟล์ + testhook + hook ต่อ request แบบเดียวกับ index.js · ฐาน :memory: ที่ seed จริง · session จริง (util.sessions)
// ไม่หยุดที่ข้อแรกที่ล้ม: นับทุกข้อแล้วสรุป เพื่อให้เห็นว่าบั๊กทำให้ข้อไหนล้ม
process.env.DB_PATH = ':memory:';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { initSchema, db, resetAll } = require('./db');
const util = require('./util');
const clock = require('./clock');

initSchema();
const app = express();
app.use(express.json({ limit: '8mb' }));
app.use((req, res, next) => { req.cookies = util.parseCookies(req); next(); });
require('./testhook')(app);
app.use((req, res, next) => { // เหมือน index.js
  if (!req.path.startsWith('/api/test/')) for (const hk of util.requestHooks) hk(req);
  next();
});
for (const f of fs.readdirSync(path.join(__dirname, 'routes')).filter((n) => n.endsWith('.js')).sort()) {
  const mod = require(path.join(__dirname, 'routes', f));
  if (typeof mod === 'function') mod(app);
}
app.use((err, req, res, next) => { console.error('UNEXPECTED', err); res.status(500).json({ code: 'INTERNAL', message: String(err) }); }); // eslint-disable-line
const { payByRef } = require('./routes/payments');

let base;
const NO = (n) => 'EG-2569-' + String(n).padStart(6, '0');
const T = (s) => '2026-12-01T' + s + '+07:00';
const M = {
  nf: 'ไม่พบคำขอ', state: 'สถานะคำขอไม่ถูกต้องสำหรับรายการนี้', forbidden: 'ไม่มีสิทธิ์ทำรายการนี้', cancel: 'ยกเลิกไม่ได้ คำขอมีเจ้าหน้าที่รับเรื่องแล้ว',
  claimed: 'มีเจ้าหน้าที่รับเรื่องนี้แล้ว', workload: 'รับงานได้สูงสุด 10 เรื่อง', retLimit: 'ตีกลับได้สูงสุด 2 ครั้ง',
  short: 'กรุณากรอกเหตุผลอย่างน้อย 10 ตัวอักษร', reqd: 'กรุณากรอกเหตุผล', unauth: 'กรุณาเข้าสู่ระบบ', fix: 'หมดเวลาแก้ไขแล้ว คำขอถูกยกเลิก',
};
const PDF = Buffer.from('%PDF-1.4\n' + 'x'.repeat(200) + '\n%%EOF\n', 'latin1');

async function raw(method, p, { sid, json, form } = {}) {
  const headers = sid ? { cookie: 'sid=' + sid } : {};
  let body;
  if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form;
  const r = await fetch(base + p, { method, headers, body });
  const buf = Buffer.from(await r.arrayBuffer());
  let j = null; try { j = JSON.parse(buf.toString('utf8')); } catch (e) { /* ไม่ใช่ JSON */ }
  return { status: r.status, body: j, buf, text: buf.toString('latin1'), headers: r.headers };
}
const api = (m, p, sid, json) => raw(m, p, { sid, json });
const get = (p, sid) => api('GET', p, sid);
const post = (p, sid, json) => api('POST', p, sid, json);

function login(where) {
  const u = db.prepare(`SELECT * FROM users WHERE ${where}`).get();
  const sid = crypto.randomBytes(16).toString('hex');
  util.sessions.set(sid, { sid, userId: u.id, username: u.username, role: u.role, dept: u.dept, name: u.display_name, registered: !!u.registered, createdAt: T('09:00:00') });
  return sid;
}
// reset ล้าง session + นาฬิกากลับ 09:00:00 + ไม่มี request ใด ๆ -> ล็อกอินใหม่ทุกบทบาท
function fresh() {
  resetAll();
  const U = (n) => login(`username='${n}'`), C = (n) => login(`display_name LIKE '${n}%'`);
  return { sc: C('สมชาย'), sy: C('สมหญิง'), pt: C('ปิติ'), reg1: U('off.reg1'), reg2: U('off.reg2'), works: U('off.works1'), head: U('head1'), exec: U('exec1'), aud: U('audit1'), adm: U('admin1') };
}
const ok = (r, body) => { assert.strictEqual(r.status, 200, JSON.stringify(r.body)); if (body) assert.deepStrictEqual(r.body, body); return r.body; };
const err = (r, status, code, message) => { assert.strictEqual(r.status, status, JSON.stringify(r.body)); assert.deepStrictEqual(r.body, { code, message }); };
const eq = assert.strictEqual;
const dbCase = (n) => db.prepare('SELECT * FROM cases WHERE case_no=?').get(NO(n));
const auditCount = (event, caseNo) => db.prepare('SELECT COUNT(*) n FROM audit WHERE event=?' + (caseNo ? ' AND case_no=?' : '')).get(...(caseNo ? [event, caseNo] : [event])).n;
const bell = async (sid) => (await get('/api/notifications', sid)).body.items;
const pairs = (items) => items.map((i) => i.caseNo.slice(-6) + ':' + i.level).sort();
const seq = (rows) => rows.map((r) => r.caseNo.slice(-6));
const upload = (draftId, sid, docKey) => {
  const form = new FormData();
  form.append('docKey', docKey);
  form.append('file', new Blob([PDF], { type: 'application/pdf' }), docKey + '.pdf');
  return raw('POST', `/api/drafts/${draftId}/files`, { sid, form });
};
const DOCS = { 'SV-01': ['id-card'], 'SV-02': ['id-card', 'map'], 'SV-03': ['id-card', 'plan', 'deed'] };
// ชำระใหม่ผ่าน API จริง (ร่าง → ไฟล์ → QR → ธนาคารจำลอง) ที่นาฬิกาปัจจุบัน -> caseNo
async function newPaid(sid, body = { serviceId: 'SV-01', qty: 1 }) {
  const d = await post('/api/drafts', sid, body); eq(d.status, 201, JSON.stringify(d.body));
  for (const k of DOCS[body.serviceId]) eq((await upload(d.body.draftId, sid, k)).status, 201);
  const q = await post(`/api/drafts/${d.body.draftId}/payment`, sid); eq(q.status, 201, JSON.stringify(q.body));
  return payByRef(q.body.ref, q.body.amount).caseNo;
}
const deepKeys = (o, out = []) => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { out.push(k); deepKeys(v, out); } return out; };

let pass = 0; const failed = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok  ', name); } catch (e) { failed.push(name); console.log('  FAIL', name, '\n       ', String(e.message).split('\n').slice(0, 12).join('\n        ')); }
}

async function main() {
  await new Promise((done) => { const s = app.listen(0, () => { base = 'http://127.0.0.1:' + s.address().port; main.server = s; done(); }); });
  console.log(`BUG_MODE=${process.env.BUG_MODE || '(ไม่ตั้ง)'}`);
  let s;

  // ------------------------------------------------------------------ QUEUE
  console.log('TC-QUEUE-01 ลำดับคิวและขอบเขตแผนก');
  await t('off.reg1 all = 17 แถวตามลำดับ TEST-DATA 9.1 · sla 3 แถวแรก · idMasked · claim 4 ปุ่ม', async () => {
    s = fresh();
    const q = ok(await get('/api/officer/queue?filter=all', s.reg1)); // ค่าตั้งต้น = all
    eq(q.items.length, 17);
    assert.deepStrictEqual(seq(q.items), ['000020', '000022', '000024', '000023', '000025', '000026', '000013', '000015', '000027', '000028', '000029', '000030', '000016', '000018', '000019', '000012', '000021']);
    assert.deepStrictEqual(q.items.slice(0, 3).map((r) => r.slaLevel), ['overdue', 'near', 'near']);
    assert.ok(q.items.every((r) => /^X-XXXX-XXXXX-\d{2}-\d$/.test(r.idMasked)));
    assert.deepStrictEqual(q.items.filter((r) => r.can.claim).map((r) => r.caseNo.slice(-6)), ['000024', '000028', '000029', '000030']);
    const r19 = q.items.find((r) => r.caseNo === NO(19)); eq(r19.owner, null); eq(r19.status, 'APPROVED');
    assert.deepStrictEqual(Object.keys(q.items[0]).filter((k) => ['caseNo', 'serviceId', 'applicantName', 'idMasked', 'status', 'step', 'owner', 'dueAt', 'slaLevel'].includes(k)).length, 9);
    eq((await get('/api/officer/queue', s.reg1)).body.items.length, 17); // ไม่ส่ง filter
  });
  await t('filter unclaimed=4 · mine=3 (workload 3) · reg2 mine=9 ลำดับ · works1 = 1 แถว 000010', async () => {
    s = fresh();
    assert.deepStrictEqual(seq((await get('/api/officer/queue?filter=unclaimed', s.reg1)).body.items), ['000024', '000028', '000029', '000030']);
    const m = (await get('/api/officer/queue?filter=mine', s.reg1)).body;
    assert.deepStrictEqual(seq(m.items), ['000020', '000022', '000023']); eq(m.workload, 3);
    const m2 = (await get('/api/officer/queue?filter=mine', s.reg2)).body;
    assert.deepStrictEqual(seq(m2.items), ['000025', '000026', '000013', '000015', '000027', '000016', '000018', '000012', '000021']); eq(m2.workload, 9);
    assert.deepStrictEqual(seq((await get('/api/officer/queue', s.works)).body.items), ['000010']);
  });
  await t('head เห็น 18 แถว (กลุ่ม 3 ธ.ค.: 000010 → 000023 → 000025 → 000026) ไม่มีปุ่ม claim · ไม่มี NEED_FIX/PENDING_APPROVAL/ปิดแล้ว', async () => {
    s = fresh();
    const q = (await get('/api/officer/queue', s.head)).body;
    eq(q.items.length, 18);
    const i = seq(q.items).indexOf('000010');
    assert.deepStrictEqual(seq(q.items).slice(i, i + 4), ['000010', '000023', '000025', '000026']);
    assert.ok(q.items.every((r) => !r.can.claim));
    for (const n of ['000017', '000011', '000014']) assert.ok(!seq(q.items).includes(n), n);
    eq(q.workload, null);
  });
  await t('/api/head/approvals = 2 แถว 000014 → 000011 · เจ้าหน้าที่ 403', async () => {
    s = fresh();
    assert.deepStrictEqual(seq((await get('/api/head/approvals', s.head)).body.items), ['000014', '000011']);
    eq((await get('/api/head/approvals', s.reg1)).status, 403);
  });

  console.log('TC-QUEUE-02 รับเรื่องซ้อน (ต่อกัน · พร้อมกัน) [B08]');
  await t('ต่อกัน: reg1 claim 000029 → 200 · reg2 claim → 409 ALREADY_CLAIMED · owner ยัง reg1 · workload reg2 ยัง 9 · reg1 ซ้ำ 409 · CLAIM 1 แถว', async () => {
    s = fresh();
    ok(await post(`/api/officer/cases/${NO(29)}/claim`, s.reg1), { owner: 'off.reg1' });
    err(await post(`/api/officer/cases/${NO(29)}/claim`, s.reg2), 409, 'ALREADY_CLAIMED', M.claimed);
    eq(dbCase(29).owner, 'off.reg1'); eq(dbCase(29).status, 'IN_REVIEW');
    eq((await get('/api/officer/queue?filter=mine', s.reg2)).body.workload, 9);
    err(await post(`/api/officer/cases/${NO(29)}/claim`, s.reg1), 409, 'ALREADY_CLAIMED', M.claimed);
    eq(auditCount('CLAIM', NO(29)), 1);
  });
  await t('พร้อมกัน 10 ครั้ง (5 reg1 + 5 reg2) → 200 ครั้งเดียว · อีก 9 = 409 ALREADY_CLAIMED · CLAIM 1 แถว', async () => {
    s = fresh();
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => post(`/api/officer/cases/${NO(29)}/claim`, i % 2 ? s.reg1 : s.reg2)));
    eq(rs.filter((r) => r.status === 200).length, 1, rs.map((r) => r.status).join(','));
    eq(rs.filter((r) => r.status === 409 && r.body.code === 'ALREADY_CLAIMED').length, 9);
    eq(auditCount('CLAIM', NO(29)), 1);
    const w = rs.find((r) => r.status === 200).body.owner;
    eq(dbCase(29).owner, w);
  });
  await t('สิทธิ์ก่อน: works1 claim คำขอทะเบียน 403 · reg1 claim 000010 (โยธา) 403 · head/exec/aud/adm/citizen 403 · anon 401', async () => {
    s = fresh();
    err(await post(`/api/officer/cases/${NO(28)}/claim`, s.works), 403, 'FORBIDDEN', M.forbidden);
    err(await post(`/api/officer/cases/${NO(10)}/claim`, s.reg1), 403, 'FORBIDDEN', M.forbidden);
    for (const k of ['head', 'exec', 'aud', 'adm', 'sc']) eq((await post(`/api/officer/cases/${NO(28)}/claim`, s[k])).status, 403, k);
    err(await post(`/api/officer/cases/${NO(28)}/claim`), 401, 'UNAUTHENTICATED', M.unauth);
    err(await post(`/api/officer/cases/${NO(999)}/claim`, s.reg1), 404, 'NOT_FOUND', M.nf);
    // ALREADY_CLAIMED ก่อน WORKLOAD_LIMIT: reg2 (9) ถือครบ 10 แล้วกดเรื่องที่มีผู้ถือ → ALREADY_CLAIMED
    ok(await post(`/api/officer/cases/${NO(28)}/claim`, s.reg2));
    err(await post(`/api/officer/cases/${NO(30)}/claim`, s.reg2), 409, 'WORKLOAD_LIMIT', M.workload);
    err(await post(`/api/officer/cases/${NO(13)}/claim`, s.reg2), 409, 'ALREADY_CLAIMED', M.claimed);
    err(await post(`/api/officer/cases/${NO(19)}/claim`, s.reg1), 409, 'INVALID_STATE', M.state); // APPROVED ไม่มีผู้ถือ
  });

  console.log('TC-QUEUE-03 งานในมือสูงสุด 10');
  await t('9 → 10 → 11 ✗ (409 WORKLOAD_LIMIT) · อนุมัติ 000025 → 9 · รับได้อีก · reg1 (3) รับได้', async () => {
    s = fresh();
    const wl = async () => (await get('/api/officer/queue?filter=mine', s.reg2)).body.workload;
    eq(await wl(), 9);
    ok(await post(`/api/officer/cases/${NO(28)}/claim`, s.reg2)); eq(await wl(), 10);
    err(await post(`/api/officer/cases/${NO(29)}/claim`, s.reg2), 409, 'WORKLOAD_LIMIT', M.workload);
    eq(dbCase(29).status, 'SUBMITTED'); eq(dbCase(29).owner, null); eq(await wl(), 10);
    ok(await post(`/api/cases/${NO(25)}/approve`, s.reg2), { status: 'APPROVED' }); eq(await wl(), 9);
    ok(await post(`/api/officer/cases/${NO(29)}/claim`, s.reg2)); eq(await wl(), 10);
    ok(await post(`/api/officer/cases/${NO(30)}/claim`, s.reg1));
  });
  await t('ตีกลับ → 8 · รับ 28 29 → 10 · ส่งแก้คืน → 11 (ไม่ error) · รับ 30 → 409', async () => {
    s = fresh();
    const wl = async () => (await get('/api/officer/queue?filter=mine', s.reg2)).body.workload;
    ok(await post(`/api/officer/cases/${NO(25)}/return`, s.reg2, { reason: 'xxxxxxxxxx' }), { status: 'NEED_FIX', returnCount: 1 });
    eq(await wl(), 8);
    ok(await post(`/api/officer/cases/${NO(28)}/claim`, s.reg2)); ok(await post(`/api/officer/cases/${NO(29)}/claim`, s.reg2)); eq(await wl(), 10);
    const r = ok(await post(`/api/cases/${NO(25)}/resubmit`, s.sy)); eq(r.status, 'IN_REVIEW');
    eq(dbCase(25).owner, 'off.reg2'); eq(await wl(), 11);
    err(await post(`/api/officer/cases/${NO(30)}/claim`, s.reg2), 409, 'WORKLOAD_LIMIT', M.workload); eq(await wl(), 11);
  });

  // ------------------------------------------------------------------ WORKFLOW
  console.log('TC-WORKFLOW-01 SV-01 อนุมัติ + ออกเอกสาร');
  await t('flags · reg1 อนุมัติของ reg2 = 403 · อนุมัติ → issue → DOC-2569-000002 · closedAt · slaLevel closed · สมหญิงโหลด PDF · dashboard', async () => {
    s = fresh();
    let v = (await get(`/api/cases/${NO(25)}`, s.reg2)).body;
    assert.deepStrictEqual(v.can, { claim: false, return: true, forward: false, approve: true, reject: true, issue: false, unmask: true, cancel: false, resubmit: false });
    eq(v.fee, 60);
    err(await post(`/api/cases/${NO(26)}/approve`, s.reg1), 403, 'FORBIDDEN', M.forbidden);
    ok(await post(`/api/cases/${NO(25)}/approve`, s.reg2), { status: 'APPROVED' });
    v = (await get(`/api/cases/${NO(25)}`, s.reg2)).body;
    eq(v.status, 'APPROVED'); eq(v.can.issue, true); eq(v.can.approve, false);
    err(await post(`/api/officer/cases/${NO(25)}/issue`, s.reg1), 403, 'FORBIDDEN', M.forbidden);
    err(await post(`/api/officer/cases/${NO(25)}/issue`, s.head), 403, 'FORBIDDEN', M.forbidden);
    const i = ok(await post(`/api/officer/cases/${NO(25)}/issue`, s.reg2));
    eq(i.docNo, 'DOC-2569-000002'); eq(i.status, 'COMPLETED'); assert.match(i.verifyCode, /^[A-Z0-9]{8}$/);
    v = (await get(`/api/cases/${NO(25)}`, s.reg2)).body;
    eq(v.status, 'COMPLETED'); eq(v.closedAt, T('09:00:00')); eq(v.slaLevel, 'closed'); eq(v.docNo, 'DOC-2569-000002'); eq(v.verifyCode, i.verifyCode);
    err(await post(`/api/officer/cases/${NO(25)}/issue`, s.reg2), 409, 'INVALID_STATE', M.state);
    const p = await get('/api/documents/DOC-2569-000002/pdf', s.sy);
    eq(p.status, 200); assert.match(p.headers.get('content-type'), /application\/pdf/);
    assert.ok(p.text.includes(`docNo=DOC-2569-000002 caseNo=${NO(25)}`));
    const sv = (await get(`/api/verify/${i.verifyCode}`)).body; eq(sv.signer, 'เจ้าหน้าที่ทะเบียน 2'); // ผู้ลงนาม SV-01 = เจ้าหน้าที่ผู้อนุมัติ
    const d = ok(await get('/api/dashboard?period=2026-12&service=ALL', s.exec));
    eq(d.closed, 1); eq(d.onTime, 1); eq(d.received, 3); eq(d.backlog, 20);
    assert.deepStrictEqual(db.prepare("SELECT event FROM audit WHERE case_no=? ORDER BY id").all(NO(25)).map((r) => r.event), ['APPROVE', 'ISSUE']);
    eq(db.prepare("SELECT detail FROM audit WHERE event='ISSUE'").get().detail, 'DOC-2569-000002');
  });

  console.log('TC-WORKFLOW-02 SV-02 ผ่านหัวหน้า');
  await t('forward → PENDING_APPROVAL · head 3 แถว · approve → ไม่มี issue ของ head · reg1 issue 403 · reg2 issue → verify signer หัวหน้าฝ่าย', async () => {
    s = fresh();
    let v = (await get(`/api/cases/${NO(13)}`, s.reg2)).body;
    eq(v.can.approve, false); eq(v.can.forward, true); eq(v.can.reject, false);
    ok(await post(`/api/officer/cases/${NO(13)}/forward`, s.reg2), { status: 'PENDING_APPROVAL' });
    eq((await get('/api/officer/queue?filter=mine', s.reg2)).body.workload, 8);
    assert.ok(!seq((await get('/api/officer/queue', s.reg2)).body.items).includes('000013'));
    assert.deepStrictEqual(seq((await get('/api/head/approvals', s.head)).body.items), ['000013', '000014', '000011']);
    v = (await get(`/api/cases/${NO(13)}`, s.head)).body;
    eq(v.can.approve, true); eq(v.can.reject, true); eq(v.can.issue, false);
    ok(await post(`/api/cases/${NO(13)}/approve`, s.head), { status: 'APPROVED' });
    v = (await get(`/api/cases/${NO(13)}`, s.head)).body; eq(v.status, 'APPROVED'); eq(v.can.issue, false);
    err(await post(`/api/officer/cases/${NO(13)}/issue`, s.reg1), 403, 'FORBIDDEN', M.forbidden);
    eq((await get(`/api/cases/${NO(13)}`, s.reg1)).body.can.issue, false);
    const i = ok(await post(`/api/officer/cases/${NO(13)}/issue`, s.reg2));
    eq(i.docNo, 'DOC-2569-000002');
    eq((await get(`/api/verify/${i.verifyCode}`)).body.signer, 'หัวหน้าฝ่าย');
  });
  await t('seed 000019 APPROVED: reg1 issue → COMPLETED DOC-2569-000002 signer หัวหน้าฝ่าย · reg2 issue 403', async () => {
    s = fresh();
    err(await post(`/api/officer/cases/${NO(19)}/issue`, s.reg2), 403, 'FORBIDDEN', M.forbidden);
    const i = ok(await post(`/api/officer/cases/${NO(19)}/issue`, s.reg1));
    eq(i.docNo, 'DOC-2569-000002'); eq(dbCase(19).status, 'COMPLETED'); eq(dbCase(19).doc_no, 'DOC-2569-000002');
    eq((await get(`/api/verify/${i.verifyCode}`)).body.signer, 'หัวหน้าฝ่าย');
  });

  console.log('TC-WORKFLOW-03 SV-03 สามขั้นตอน');
  await t('000012: ขั้น 1 → forward → ขั้น 2 โยธา ไม่มีผู้ถือ → works1 claim/forward → ขั้น 3 → head approve → reg2 issue (works1 ไม่ได้)', async () => {
    s = fresh();
    let v = (await get(`/api/cases/${NO(12)}`, s.reg2)).body;
    eq(v.stepLabel, 'ขั้นตอน 1/3 · ฝ่ายทะเบียน'); eq(v.fee, 1010); eq(v.can.forward, true);
    assert.deepStrictEqual(ok(await post(`/api/officer/cases/${NO(12)}/forward`, s.reg2, { note: 'ผ่านขั้นทะเบียน' })), { status: 'IN_REVIEW', step: 2 });
    v = (await get(`/api/cases/${NO(12)}`, s.reg2)).body;
    eq(v.status, 'IN_REVIEW'); eq(v.stepLabel, 'ขั้นตอน 2/3 · ฝ่ายโยธา'); eq(v.owner, null);
    eq((await get('/api/officer/queue?filter=mine', s.reg2)).body.workload, 8);
    eq((await get('/api/officer/queue', s.reg2)).body.items.length, 16);
    const wq = (await get('/api/officer/queue', s.works)).body;
    assert.deepStrictEqual(seq(wq.items), ['000010', '000012']); eq(wq.items.filter((r) => r.can.claim).length, 2);
    err(await post(`/api/officer/cases/${NO(12)}/claim`, s.reg1), 403, 'FORBIDDEN', M.forbidden);
    ok(await post(`/api/officer/cases/${NO(12)}/claim`, s.works), { owner: 'off.works1' });
    eq((await get(`/api/cases/${NO(12)}`, s.works)).body.owner, 'off.works1');
    assert.deepStrictEqual(ok(await post(`/api/officer/cases/${NO(12)}/forward`, s.works)), { status: 'PENDING_APPROVAL', step: 3 });
    v = (await get(`/api/cases/${NO(12)}`, s.head)).body; eq(v.status, 'PENDING_APPROVAL'); eq(v.stepLabel, 'ขั้นตอน 3/3 · หัวหน้าฝ่าย');
    assert.ok(seq((await get('/api/head/approvals', s.head)).body.items).includes('000012'));
    ok(await post(`/api/cases/${NO(12)}/approve`, s.head), { status: 'APPROVED' });
    eq((await get(`/api/cases/${NO(12)}`, s.works)).body.can.issue, false);
    err(await post(`/api/officer/cases/${NO(12)}/issue`, s.works), 403, 'FORBIDDEN', M.forbidden);
    eq((await get(`/api/cases/${NO(12)}`, s.reg2)).body.can.issue, true);
    const i = ok(await post(`/api/officer/cases/${NO(12)}/issue`, s.reg2));
    eq((await get(`/api/verify/${i.verifyCode}`)).body.signer, 'หัวหน้าฝ่าย');
    assert.deepStrictEqual(db.prepare("SELECT event,detail FROM audit WHERE case_no=? AND event='FORWARD'").all(NO(12)).map((r) => r.detail), ['ผ่านขั้นทะเบียน', '']);
  });
  await t('SV-01 forward → 409 INVALID_STATE · ผู้ไม่ใช่ผู้ถือ 403', async () => {
    s = fresh();
    err(await post(`/api/officer/cases/${NO(25)}/forward`, s.reg2), 409, 'INVALID_STATE', M.state);
    err(await post(`/api/officer/cases/${NO(13)}/forward`, s.reg1), 403, 'FORBIDDEN', M.forbidden);
    err(await post(`/api/officer/cases/${NO(13)}/forward`, s.head), 403, 'FORBIDDEN', M.forbidden);
  });

  console.log('TC-WORKFLOW-04 ตีกลับสูงสุด 2 ครั้ง [B12]');
  await t('A SV-01 000020: ครั้ง 1,2 ✓ ครั้ง 3 → 409 RETURN_LIMIT · returnCount 2 · approve/reject ยังได้', async () => {
    s = fresh();
    ok(await post(`/api/officer/cases/${NO(20)}/return`, s.reg1, { reason: 'xxxxxxxxxx' }), { status: 'NEED_FIX', returnCount: 1 });
    let v = (await get(`/api/cases/${NO(20)}`, s.sc)).body; eq(v.status, 'NEED_FIX'); eq(v.returnCount, 1); eq(v.returnReason, 'xxxxxxxxxx'); eq(v.slaLevel, 'paused');
    ok(await post(`/api/cases/${NO(20)}/resubmit`, s.sc));
    eq(dbCase(20).owner, 'off.reg1'); eq(dbCase(20).status, 'IN_REVIEW');
    ok(await post(`/api/officer/cases/${NO(20)}/return`, s.reg1, { reason: 'xxxxxxxxxx' }), { status: 'NEED_FIX', returnCount: 2 });
    ok(await post(`/api/cases/${NO(20)}/resubmit`, s.sc));
    v = (await get(`/api/cases/${NO(20)}`, s.reg1)).body;
    eq(v.can.return, false); eq(v.can.approve, true); eq(v.can.reject, true); eq(v.returnCount, 2);
    err(await post(`/api/officer/cases/${NO(20)}/return`, s.reg1, { reason: 'xxxxxxxxxx' }), 409, 'RETURN_LIMIT', M.retLimit);
    eq(dbCase(20).status, 'IN_REVIEW'); eq(dbCase(20).return_count, 2);
  });
  await t('B seed 000023 (ตีกลับแล้ว 2): return-btn flag ปิด · API 409 · สถานะ/ count เดิม · approve/reject ได้', async () => {
    s = fresh();
    const v = (await get(`/api/cases/${NO(23)}`, s.reg1)).body;
    eq(v.returnCount, 2); eq(v.can.return, false); eq(v.can.approve, true); eq(v.can.reject, true);
    err(await post(`/api/officer/cases/${NO(23)}/return`, s.reg1, { reason: 'xxxxxxxxxx' }), 409, 'RETURN_LIMIT', M.retLimit);
    eq(dbCase(23).status, 'IN_REVIEW'); eq(dbCase(23).return_count, 2);
  });
  await t('C SV-02 000013 ตีกลับครบ 2: ไม่มี return/approve/reject · reject API 403 · forward note → Audit · head approve/reject ได้', async () => {
    s = fresh();
    for (let i = 0; i < 2; i++) {
      ok(await post(`/api/officer/cases/${NO(13)}/return`, s.reg2, { reason: 'xxxxxxxxxx' }));
      ok(await post(`/api/cases/${NO(13)}/resubmit`, s.sc));
    }
    let v = (await get(`/api/cases/${NO(13)}`, s.reg2)).body;
    assert.deepStrictEqual([v.can.return, v.can.approve, v.can.reject, v.can.forward], [false, false, false, true]);
    err(await post(`/api/cases/${NO(13)}/reject`, s.reg2, { reason: 'xxxxxxxxxx' }), 403, 'FORBIDDEN', M.forbidden);
    ok(await post(`/api/officer/cases/${NO(13)}/forward`, s.reg2, { note: 'ส่งต่อให้หัวหน้าพิจารณา' }), { status: 'PENDING_APPROVAL' });
    eq(db.prepare("SELECT detail FROM audit WHERE event='FORWARD' AND case_no=?").get(NO(13)).detail, 'ส่งต่อให้หัวหน้าพิจารณา');
    v = (await get(`/api/cases/${NO(13)}`, s.head)).body; eq(v.can.approve, true); eq(v.can.reject, true);
  });

  console.log('TC-WORKFLOW-05 เหตุผล >= 10 ตัวอักษร');
  await t('ตีกลับ 000020: 9 ✗ 400 · เว้นวรรค 10 ✗ · 10 ✓ · สมชายเห็น returnReason', async () => {
    s = fresh();
    for (const reason of ['xxxxxxxxx', '          ', '  xxxxxxxxx  ', undefined, 123]) {
      err(await post(`/api/officer/cases/${NO(20)}/return`, s.reg1, { reason }), 400, 'REASON_TOO_SHORT', M.short);
      eq(dbCase(20).status, 'IN_REVIEW');
    }
    ok(await post(`/api/officer/cases/${NO(20)}/return`, s.reg1, { reason: '  xxxxxxxxxx  ' }));
    eq((await get(`/api/cases/${NO(20)}`, s.sc)).body.returnReason, 'xxxxxxxxxx'); // ตัดช่องว่างหัวท้าย
    eq(db.prepare("SELECT detail FROM audit WHERE event='RETURN'").get().detail, 'xxxxxxxxxx');
  });
  await t('ไม่อนุมัติ SV-01 000026 (reg2): 9 ✗ · 10 ✓ REJECTED closedAt · slaLevel closed · exec closed=1 onTime=1', async () => {
    s = fresh();
    err(await post(`/api/cases/${NO(26)}/reject`, s.reg2, { reason: 'xxxxxxxxx' }), 400, 'REASON_TOO_SHORT', M.short);
    eq(dbCase(26).status, 'IN_REVIEW');
    ok(await post(`/api/cases/${NO(26)}/reject`, s.reg2, { reason: 'xxxxxxxxxx' }), { status: 'REJECTED', closedAt: T('09:00:00') });
    const v = (await get(`/api/cases/${NO(26)}`, s.sc)).body;
    eq(v.status, 'REJECTED'); eq(v.closedAt, T('09:00:00')); eq(v.slaLevel, 'closed'); eq(v.rejectReason, 'xxxxxxxxxx');
    const d = ok(await get('/api/dashboard?period=2026-12&service=ALL', s.exec)); eq(d.closed, 1); eq(d.onTime, 1);
    eq(auditCount('REJECT', NO(26)), 1);
  });
  await t('หัวหน้าไม่อนุมัติ 000011: 9 ✗ 400 · 10 ✓ REJECTED · head ใช้กับ SV-01 → 403', async () => {
    s = fresh();
    err(await post(`/api/cases/${NO(11)}/reject`, s.head, { reason: 'xxxxxxxxx' }), 400, 'REASON_TOO_SHORT', M.short);
    eq(dbCase(11).status, 'PENDING_APPROVAL');
    ok(await post(`/api/cases/${NO(11)}/reject`, s.head, { reason: 'xxxxxxxxxx' }));
    eq(dbCase(11).status, 'REJECTED');
    err(await post(`/api/cases/${NO(26)}/reject`, s.head, { reason: 'xxxxxxxxxx' }), 403, 'FORBIDDEN', M.forbidden);
    err(await post(`/api/cases/${NO(11)}/approve`, s.head), 409, 'INVALID_STATE', M.state);
  });

  console.log('TC-WORKFLOW-06 เวลาแก้ไข 168 ชั่วโมง');
  await t('seed 000017: ก่อนส่ง = NEED_FIX fixDeadline 4 ธ.ค. 14:00 · 167:59 (13:59) ส่งแก้ → 200 IN_REVIEW', async () => {
    s = fresh();
    const v = (await get(`/api/cases/${NO(17)}`, s.sc)).body;
    eq(v.status, 'NEED_FIX'); eq(v.fixDeadline, '2026-12-04T14:00:00+07:00'); eq(v.returnReason, 'ชื่อในเอกสารไม่ตรงกับบัตร กรุณาแก้ไข'); eq(v.can.resubmit, true);
    clock.set('2026-12-04T13:59:00+07:00');
    const r = ok(await post(`/api/cases/${NO(17)}/resubmit`, s.sc)); eq(r.status, 'IN_REVIEW');
  });
  await t('168:00 (14:00) → ยกเลิกอัตโนมัติ · resubmit → 409 FIX_WINDOW_EXPIRED · timeline 14:00 · ไม่มีปุ่ม · backlog 20', async () => {
    s = fresh(); clock.set('2026-12-04T14:00:00+07:00');
    err(await post(`/api/cases/${NO(17)}/resubmit`, s.sc), 409, 'FIX_WINDOW_EXPIRED', M.fix); // request แรกเลยก็ได้
    const v = (await get(`/api/cases/${NO(17)}`, s.sc)).body;
    eq(v.status, 'CANCELLED'); eq(v.can.resubmit, false); eq(v.slaLevel, 'closed');
    assert.ok(v.timeline.some((x) => x.time === '2026-12-04T14:00:00+07:00' && x.kind === 'AUTO_CANCEL'));
    err(await post(`/api/cases/${NO(17)}/resubmit`, s.sc), 409, 'FIX_WINDOW_EXPIRED', M.fix);
    eq(ok(await get('/api/dashboard?period=2026-12&service=ALL', s.exec)).backlog, 20);
  });
  await t('ส่งแก้ในขณะที่ยังไม่ NEED_FIX → 409 INVALID_STATE · ของคนอื่น 404', async () => {
    s = fresh();
    err(await post(`/api/cases/${NO(30)}/resubmit`, s.sc), 409, 'INVALID_STATE', M.state);
    err(await post(`/api/cases/${NO(17)}/resubmit`, s.sy), 404, 'NOT_FOUND', M.nf);
  });

  console.log('TC-SLA-02 หยุดนับ SLA (API) · TC-SLA-03 ระดับเตือน');
  await t('ส่วน 1: ชำระ 1 ธ.ค. 09:00 → ตีกลับ 2 ธ.ค. 11:00 (paused · fixDeadline 9 ธ.ค. 11:00) → ส่งแก้ 3 ธ.ค. 10:00 → dueAt 8 ธ.ค. 16:30 · normal', async () => {
    s = fresh();
    const no = await newPaid(s.sc); eq(no, NO(31)); eq((await get(`/api/cases/${no}`, s.sc)).body.dueAt, '2026-12-04T16:30:00+07:00');
    clock.set('2026-12-02T11:00:00+07:00');
    ok(await post(`/api/officer/cases/${no}/claim`, s.reg1)); ok(await post(`/api/officer/cases/${no}/return`, s.reg1, { reason: 'xxxxxxxxxx' }));
    let v = (await get(`/api/cases/${no}`, s.sc)).body; eq(v.slaLevel, 'paused'); eq(v.fixDeadline, '2026-12-09T11:00:00+07:00');
    clock.set('2026-12-03T10:00:00+07:00');
    const r = ok(await post(`/api/cases/${no}/resubmit`, s.sc)); eq(r.dueAt, '2026-12-08T16:30:00+07:00');
    v = (await get(`/api/cases/${no}`, s.reg1)).body; eq(v.status, 'IN_REVIEW'); eq(v.owner, 'off.reg1'); eq(v.slaLevel, 'normal'); eq(v.fixDeadline, null);
    eq(db.prepare('SELECT paused_days FROM case_returns WHERE case_no=?').get(no).paused_days, 1);
  });
  await t('ส่วน 2/3: seed 000017 ส่งแก้ 1 ธ.ค. 09:00 → 1 ธ.ค. 16:30 near · 4 ธ.ค. 10:00 → 4 ธ.ค. 16:30', async () => {
    s = fresh();
    eq((await get(`/api/cases/${NO(17)}`, s.sc)).body.dueAt, '2026-11-27T16:30:00+07:00');
    eq(ok(await post(`/api/cases/${NO(17)}/resubmit`, s.sc)).dueAt, '2026-12-01T16:30:00+07:00');
    eq((await get(`/api/cases/${NO(17)}`, s.sc)).body.slaLevel, 'near'); eq(dbCase(17).owner, 'off.reg1');
    s = fresh(); clock.set('2026-12-04T10:00:00+07:00');
    eq(ok(await post(`/api/cases/${NO(17)}/resubmit`, s.sc)).dueAt, '2026-12-04T16:30:00+07:00');
    eq((await get(`/api/cases/${NO(17)}`, s.sc)).body.slaLevel, 'near');
  });
  await t('ส่วน 4/5: วันเดียวกัน → หยุด 0 วัน · คร่อมสุดสัปดาห์ ส่งแก้ 8 ธ.ค. 17:00 → 8 ธ.ค. 16:30 overdue', async () => {
    s = fresh();
    let no = await newPaid(s.sc); clock.set('2026-12-02T09:00:00+07:00');
    ok(await post(`/api/officer/cases/${no}/claim`, s.reg1)); ok(await post(`/api/officer/cases/${no}/return`, s.reg1, { reason: 'xxxxxxxxxx' }));
    clock.set('2026-12-02T15:00:00+07:00'); eq(ok(await post(`/api/cases/${no}/resubmit`, s.sc)).dueAt, '2026-12-04T16:30:00+07:00');
    s = fresh(); no = await newPaid(s.sc); clock.set('2026-12-04T10:00:00+07:00');
    ok(await post(`/api/officer/cases/${no}/claim`, s.reg1)); ok(await post(`/api/officer/cases/${no}/return`, s.reg1, { reason: 'xxxxxxxxxx' }));
    clock.set('2026-12-08T17:00:00+07:00');
    eq(ok(await post(`/api/cases/${no}/resubmit`, s.sc)).dueAt, '2026-12-08T16:30:00+07:00');
    eq((await get(`/api/cases/${no}`, s.sc)).body.slaLevel, 'overdue');
  });
  await t('TC-SLA-03 ส่วน A: slaLevel ใน API ตามนาฬิกา (ศ.4 ธ.ค. 16:30:00 near · 16:30:01 overdue)', async () => {
    s = fresh();
    const no = await newPaid(s.sc);
    for (const [clk, lv] of [['2026-12-01T09:00:00', 'normal'], ['2026-12-02T09:00:00', 'normal'], ['2026-12-03T09:00:00', 'near'], ['2026-12-04T16:30:00', 'near'], ['2026-12-04T16:30:01', 'overdue']]) {
      clock.set(clk + '+07:00'); eq((await get(`/api/cases/${no}`, s.sc)).body.slaLevel, lv, clk);
    }
  });

  // ------------------------------------------------------------------ NOTI
  console.log('TC-NOTI-01 / 02 แจ้งเตือน');
  await t('NOTI-01: request แรกที่ 09:00 → reg1 3 · reg2 1 · head 1 · works1 0 · ข้อความ · ต่อ 16:31 → reg1 4 head 2 reg2 1', async () => {
    s = fresh();
    eq(db.prepare('SELECT COUNT(*) n FROM notifications').get().n, 0);
    const r1 = await bell(s.reg1);
    assert.deepStrictEqual(pairs(r1), ['000020:overdue', '000022:near', '000024:near']);
    assert.deepStrictEqual(pairs(await bell(s.reg2)), ['000024:near']);
    assert.deepStrictEqual(pairs(await bell(s.head)), ['000020:overdue']);
    eq((await bell(s.works)).length, 0);
    eq(r1.find((i) => i.caseNo === NO(24)).text, `คำขอ ${NO(24)} ใกล้ครบกำหนด`);
    eq(r1.find((i) => i.caseNo === NO(20)).text, `คำขอ ${NO(20)} เกินกำหนด`);
    clock.set('2026-12-01T16:31:00+07:00');
    assert.deepStrictEqual(pairs(await bell(s.reg1)), ['000020:overdue', '000022:near', '000022:overdue', '000024:near']);
    assert.deepStrictEqual(pairs(await bell(s.head)), ['000020:overdue', '000022:overdue']);
    eq((await bell(s.reg2)).length, 1);
    // ส่วน A ไม่แจ้งซ้ำ
    for (let i = 0; i < 3; i++) { await bell(s.reg1); await bell(s.head); }
    await get('/api/officer/queue', s.reg1); await get('/api/officer/queue', s.reg1);
    eq((await bell(s.reg1)).length, 4); eq((await bell(s.head)).length, 2);
  });
  await t('NOTI-02 ส่วน B: ข้ามระดับที่ ส. 5 ธ.ค. 10:00 → reg1 7 · reg2 10 · works1 1 · head 15 (ไม่มี near ย้อนหลัง)', async () => {
    s = fresh(); clock.set('2026-12-05T10:00:00+07:00');
    const a = await bell(s.reg1);
    assert.deepStrictEqual(pairs(a), ['000020:overdue', '000022:overdue', '000023:overdue', '000024:overdue', '000028:overdue', '000029:overdue', '000030:overdue']);
    eq((await bell(s.reg2)).length, 10); eq((await bell(s.works)).length, 1); eq((await bell(s.head)).length, 15);
    assert.deepStrictEqual(pairs(await bell(s.works)), ['000010:overdue']);
    assert.ok(pairs(await bell(s.head)).includes('000011:near'));
    assert.ok(pairs(await bell(s.reg2)).includes('000016:near'));
  });
  await t('NOTI-02 ส่วน C: PENDING_APPROVAL (000014) → head เท่านั้น · APPROVED (000019) → ผู้ออกเอกสาร reg1 (+head เมื่อ overdue)', async () => {
    s = fresh(); clock.set('2026-12-04T09:00:00+07:00');
    const of = (items, n) => pairs(items).filter((x) => x.startsWith(String(n)));
    assert.deepStrictEqual(of(await bell(s.head), '000014'), ['000014:near']);
    eq(of(await bell(s.reg1), '000014').length, 0); eq(of(await bell(s.reg2), '000014').length, 0);
    clock.set('2026-12-04T16:31:00+07:00');
    assert.deepStrictEqual(of(await bell(s.head), '000014'), ['000014:near', '000014:overdue']);
    eq(of(await bell(s.reg1), '000014').length, 0); eq(of(await bell(s.reg2), '000014').length, 0);
    clock.set('2026-12-08T09:00:00+07:00');
    assert.deepStrictEqual(of(await bell(s.reg1), '000019'), ['000019:near']);
    eq(of(await bell(s.reg2), '000019').length, 0); eq(of(await bell(s.head), '000019').length, 0);
    clock.set('2026-12-09T16:31:00+07:00');
    assert.deepStrictEqual(of(await bell(s.reg1), '000019'), ['000019:near', '000019:overdue']);
    assert.deepStrictEqual(of(await bell(s.head), '000019'), ['000019:overdue']);
  });
  await t('NEED_FIX ไม่ประเมิน (000017) · /api/test/* ไม่กระตุ้น · สิทธิ์ GET /api/notifications', async () => {
    s = fresh();
    await raw('GET', '/api/test/clock'); // ไม่ผ่าน hook
    eq(db.prepare('SELECT COUNT(*) n FROM notifications').get().n, 0);
    await bell(s.reg1);
    eq(db.prepare("SELECT COUNT(*) n FROM notifications WHERE case_no=?").get(NO(17)).n, 0);
    err(await get('/api/notifications'), 401, 'UNAUTHENTICATED', M.unauth);
    for (const k of ['sc', 'exec', 'aud', 'adm']) eq((await get('/api/notifications', s[k])).status, 403, k);
  });

  // ------------------------------------------------------------------ PDPA
  console.log('TC-PDPA-01..03');
  await t('PDPA-01: คิว/รายละเอียดของ officer+head = idMasked (สมหญิง …65-9 · สมชาย …45-6) · citizen เจ้าของได้ idNo เต็ม ไม่มี idMasked', async () => {
    s = fresh();
    const q = (await get('/api/officer/queue', s.reg2)).body.items;
    eq(q.find((r) => r.caseNo === NO(25)).idMasked, 'X-XXXX-XXXXX-65-9'); eq(q.find((r) => r.caseNo === NO(26)).idMasked, 'X-XXXX-XXXXX-45-6');
    eq((await get(`/api/cases/${NO(25)}`, s.reg2)).body.idMasked, 'X-XXXX-XXXXX-65-9');
    eq((await get(`/api/cases/${NO(25)}`, s.head)).body.idMasked, 'X-XXXX-XXXXX-65-9');
    const c = (await get(`/api/cases/${NO(25)}`, s.sy)).body; eq(c.idNo, '3100600987659'); eq(c.idFormatted, '3-1006-00987-65-9'); assert.ok(!('idMasked' in c));
    eq((await get(`/api/cases/${NO(20)}`, s.sc)).body.idFormatted, '1-1017-00123-45-6');
  });
  await t('PDPA-02: ทุก response JSON ของ officer/head ไม่มี \\d{13} · d-dddd-ddddd-dd-d · key idNo · เลขบัตร seed [B09]', async () => {
    for (const who of ['reg1', 'head']) {
      s = fresh();
      for (const p of ['/api/officer/queue?filter=all', `/api/cases/${NO(25)}`, `/api/cases/${NO(26)}`, `/api/cases/${NO(20)}`, '/api/notifications', `/api/cases/${NO(25)}/files`, ...(who === 'head' ? ['/api/head/approvals'] : [])]) {
        const r = await get(p, s[who]);
        if (r.status !== 200) { assert.fail(`${who} ${p} -> ${r.status}`); }
        const txt = JSON.stringify(r.body);
        assert.ok(!/\d{13}/.test(txt) && !/\d-\d{4}-\d{5}-\d{2}-\d/.test(txt), `${who} ${p} มีเลขบัตร`);
        assert.ok(!deepKeys(r.body).includes('idNo'), `${who} ${p} มี key idNo`);
        for (const id of ['3100600987659', '1101700123456', '1909900555015']) assert.ok(!txt.includes(id), `${who} ${p} มี ${id}`);
      }
      assert.ok((await get('/api/officer/queue', s[who])).body.items.every((r) => /^X-XXXX-XXXXX-\d{2}-\d$/.test(r.idMasked)));
    }
  });
  await t('PDPA-03: unmask เหตุผลว่าง/เว้นวรรค 400 REASON_REQUIRED ไม่บันทึก · มีเหตุผล → {idNo} + Audit UNMASK 1 แถว · exec/aud/citizen 403 [B11]', async () => {
    s = fresh();
    for (const reason of [undefined, '', '   ', 5]) err(await post(`/api/officer/cases/${NO(25)}/unmask`, s.reg2, { reason }), 400, 'REASON_REQUIRED', M.reqd);
    ok(await post(`/api/officer/cases/${NO(25)}/unmask`, s.reg2, { reason: 'ตรวจสอบตัวตนซ้ำ' }), { idNo: '3100600987659' });
    eq((await get(`/api/cases/${NO(25)}`, s.reg2)).body.idMasked, 'X-XXXX-XXXXX-65-9'); // เห็นเต็มเฉพาะใน response นั้น
    const a = db.prepare("SELECT * FROM audit WHERE event='UNMASK'").all();
    eq(a.length, 1, 'audit UNMASK ต้องมี 1 แถว'); eq(a[0].username, 'off.reg2'); eq(a[0].role, 'officer'); eq(a[0].case_no, NO(25)); eq(a[0].detail, 'ตรวจสอบตัวตนซ้ำ'); eq(a[0].time, T('09:00:00'));
    for (const k of ['exec', 'aud', 'sy']) err(await post(`/api/officer/cases/${NO(25)}/unmask`, s[k], { reason: 'x' }), 403, 'FORBIDDEN', M.forbidden);
    err(await post(`/api/officer/cases/${NO(25)}/unmask`, undefined, { reason: 'x' }), 401, 'UNAUTHENTICATED', M.unauth);
    ok(await post(`/api/officer/cases/${NO(25)}/unmask`, s.head, { reason: 'x' }));
  });

  // ------------------------------------------------------------------ RBAC
  console.log('TC-RBAC-01..03 · 05 · TC-SUBMIT-03');
  await t('RBAC-01 (IDOR): สมหญิงเปิด/ยกเลิก/ไฟล์ของสมชาย = 404 เหมือนเลขไม่มีจริงทุกตัวอักษร · ของตัวเอง 200 [B06]', async () => {
    s = fresh();
    const a = await get(`/api/cases/${NO(5)}`, s.sy), b = await get('/api/cases/EG-2569-999999', s.sy);
    err(a, 404, 'NOT_FOUND', M.nf); assert.deepStrictEqual(a.body, b.body);
    err(await post(`/api/cases/${NO(30)}/cancel`, s.sy), 404, 'NOT_FOUND', M.nf);
    err(await get(`/api/cases/${NO(5)}/files`, s.sy), 404, 'NOT_FOUND', M.nf);
    eq((await get(`/api/cases/${NO(7)}`, s.sy)).status, 200); eq((await get(`/api/cases/${NO(5)}`, s.sc)).status, 200);
    const list = (await get('/api/cases', s.sc)).body.items; eq(list.length, 10);
    assert.ok(list.every((i) => ['000005', '000004', '000009', '000011', '000013', '000017', '000018', '000020', '000026', '000030'].includes(i.caseNo.slice(-6))));
    eq(list[0].caseNo, NO(30)); // เรียงมาก → น้อย
  });
  await t('RBAC-02: reg2 approve/reject SV-02 → 403 สถานะเดิม · head approve SV-01 403 · head approve 000014 200 · Audit APPROVE 1 แถวของ head [B07]', async () => {
    s = fresh();
    err(await post(`/api/cases/${NO(14)}/approve`, s.reg2), 403, 'FORBIDDEN', M.forbidden); eq(dbCase(14).status, 'PENDING_APPROVAL');
    err(await post(`/api/cases/${NO(13)}/approve`, s.reg2), 403, 'FORBIDDEN', M.forbidden); eq(dbCase(13).status, 'IN_REVIEW');
    err(await post(`/api/cases/${NO(14)}/reject`, s.reg2, { reason: 'xxxxxxxxxx' }), 403, 'FORBIDDEN', M.forbidden); eq(dbCase(14).status, 'PENDING_APPROVAL');
    eq((await get(`/api/cases/${NO(13)}`, s.reg2)).body.can.approve, false); eq((await get(`/api/cases/${NO(14)}`, s.reg2)).body.can.approve, false);
    err(await post(`/api/cases/${NO(25)}/approve`, s.head), 403, 'FORBIDDEN', M.forbidden);
    ok(await post(`/api/cases/${NO(14)}/approve`, s.head), { status: 'APPROVED' });
    const a = db.prepare("SELECT username FROM audit WHERE event='APPROVE'").all();
    assert.deepStrictEqual(a.map((r) => r.username), ['head1']);
  });
  await t('RBAC-03 ส่วน B: ตารางสิทธิ์ API (queue · notifications · cases/:no · claim) ครบทุกบทบาท', async () => {
    const roles = ['anon', 'sc', 'reg1', 'head', 'exec', 'aud', 'adm'];
    const want = {
      queue: [401, 403, 200, 200, 403, 403, 403], noti: [401, 403, 200, 200, 403, 403, 403], cases: [401, 200, 200, 200, 403, 403, 403],
    };
    s = fresh(); s.anon = undefined; s.sc = s.sy; // บทบาทประชาชน: สมหญิง (เจ้าของ …000025)
    for (let i = 0; i < roles.length; i++) {
      eq((await get('/api/officer/queue', s[roles[i]])).status, want.queue[i], 'queue ' + roles[i]);
      eq((await get('/api/notifications', s[roles[i]])).status, want.noti[i], 'noti ' + roles[i]);
      eq((await get(`/api/cases/${NO(25)}`, s[roles[i]])).status, want.cases[i], 'case ' + roles[i]);
    }
    s = fresh();
    const claim = [401, 403, 200, 403, 403, 403, 403];
    for (let i = 0; i < roles.length; i++) { // claim เป็นลำดับสุดท้ายหลัง reset ของแต่ละบทบาท (ไม่เปลี่ยนผู้ถือก่อน)
      s = fresh(); s.anon = undefined;
      eq((await post(`/api/officer/cases/${NO(28)}/claim`, s[roles[i]])).status, claim[i], 'claim ' + roles[i]);
    }
    // GET /api/cases (รายการของฉัน) เฉพาะ citizen
    s = fresh();
    eq((await get('/api/cases', s.reg1)).status, 403); eq((await get('/api/cases')).status, 401);
  });
  await t('RBAC-05: สิทธิ์ไฟล์แนบ — ทุกแถวของตาราง + เนื้อไฟล์ %PDF + Content-Type', async () => {
    s = fresh();
    const files = async (who, no) => get(`/api/cases/${NO(no)}/files`, s[who]);
    const fileId = async (no) => (await get(`/api/cases/${NO(no)}/files`, s.head)).body.items[0].fileId;
    const f25 = await fileId(25), f10 = await fileId(10), f12 = await fileId(12), f11 = await fileId(11);
    const row = async (who, no, fid, st, n) => {
      const l = await files(who, no); eq(l.status, st, `${who} ${no} list`);
      if (st === 200) eq(l.body.items.length, n, `${who} ${no} count`);
      const f = await get(`/api/files/${fid}`, s[who]); eq(f.status, st, `${who} ${no} file`);
      if (st === 200) { assert.ok(f.text.startsWith('%PDF')); assert.match(f.headers.get('content-type'), /application\/pdf/); }
    };
    await row('reg1', 25, f25, 200, 1); await row('works', 25, f25, 403);
    await row('reg2', 12, f12, 200, 3); await row('works', 12, f12, 403);
    await row('works', 10, f10, 200, 3); await row('reg1', 10, f10, 200, 3);
    await row('works', 11, f11, 200, 3);
    for (const n of [25, 10, 12]) await row('head', n, await fileId(n), 200, n === 25 ? 1 : 3);
    await row('sy', 25, f25, 200, 1); await row('sc', 25, f25, 404);
    for (const w of ['exec', 'aud', 'adm']) await row(w, 25, f25, 403);
    eq((await get(`/api/cases/${NO(25)}/files`)).status, 401); eq((await get(`/api/files/${f25}`)).status, 401);
    eq((await get('/api/files/F-9999', s.reg1)).status, 404);
    eq((await get(`/api/cases/${NO(999)}/files`, s.reg1)).status, 404);
    // ชื่อไฟล์ใน list ตรง seed
    assert.deepStrictEqual((await files('reg2', 12)).body.items.map((i) => i.name).sort(), ['deed.pdf', 'id-card.pdf', 'plan.pdf']);
    eq((await get(`/api/cases/${NO(25)}`, s.reg1)).body.files.length, 1); // case view มี files/docs ให้ UI
    eq((await get(`/api/cases/${NO(25)}`, s.works)).body.files.length, 0); // นอกขอบเขต: ดูคำขอได้แต่ไม่มีไฟล์
  });
  await t('SUBMIT-03 B/C: ยกเลิก 000030 → CANCELLED · คิว 16 แถว · backlog 20 · ไม่มีผู้รับแล้ว claim 409 INVALID_STATE · มีผู้รับแล้วยกเลิก 409 CANNOT_CANCEL', async () => {
    s = fresh();
    eq((await get(`/api/cases/${NO(30)}`, s.sc)).body.can.cancel, true);
    ok(await post(`/api/cases/${NO(30)}/cancel`, s.sc), { status: 'CANCELLED' });
    const v = (await get(`/api/cases/${NO(30)}`, s.sc)).body; eq(v.status, 'CANCELLED'); eq(v.can.cancel, false); eq(v.slaLevel, 'closed');
    eq((await get('/api/officer/queue', s.reg1)).body.items.length, 16); assert.ok(!seq((await get('/api/officer/queue', s.reg1)).body.items).includes('000030'));
    eq(ok(await get('/api/dashboard?period=2026-12&service=ALL', s.exec)).backlog, 20);
    err(await post(`/api/officer/cases/${NO(30)}/claim`, s.reg1), 409, 'INVALID_STATE', M.state);
    err(await post(`/api/cases/${NO(30)}/cancel`, s.sc), 409, 'INVALID_STATE', M.state);
    s = fresh();
    ok(await post(`/api/officer/cases/${NO(30)}/claim`, s.reg1));
    eq((await get(`/api/cases/${NO(30)}`, s.sc)).body.can.cancel, false);
    err(await post(`/api/cases/${NO(30)}/cancel`, s.sc), 409, 'CANNOT_CANCEL', M.cancel);
    err(await post(`/api/cases/${NO(13)}/cancel`, s.sc), 409, 'CANNOT_CANCEL', M.cancel);
    eq(dbCase(30).status, 'IN_REVIEW');
  });
  await t('SUBMIT-03 F: ยกเลิกชนรับเรื่อง (พร้อมกัน ×20 รอบ) → ฝั่งเดียวสำเร็จ · สถานะสอดคล้อง · reg1 งานในมือ 3 หรือ 4', async () => {
    for (let k = 0; k < 20; k++) {
      s = fresh();
      const cancel = () => post(`/api/cases/${NO(30)}/cancel`, s.sc), claim = () => post(`/api/officer/cases/${NO(30)}/claim`, s.reg1);
      const [c, l] = k % 2 ? [cancel(), claim()] : [claim(), cancel()].reverse();
      const [rc, rl] = await Promise.all([c, l]);
      const row = dbCase(30);
      if (rc.status === 200) { eq(rl.status, 409); eq(rl.body.code, 'INVALID_STATE'); eq(row.status, 'CANCELLED'); eq(row.owner, null); eq(db.prepare("SELECT COUNT(*) n FROM cases WHERE owner='off.reg1' AND status='IN_REVIEW'").get().n, 3); }
      else { eq(rl.status, 200); eq(rc.status, 409); eq(rc.body.code, 'CANNOT_CANCEL'); eq(row.status, 'IN_REVIEW'); eq(row.owner, 'off.reg1'); eq(db.prepare("SELECT COUNT(*) n FROM cases WHERE owner='off.reg1' AND status='IN_REVIEW'").get().n, 4); }
    }
  });
  await t('resubmit พร้อมไฟล์: PDF ใหม่ถูกเก็บ (F-0 ต่อจากเดิม) · ไฟล์ผิดชนิด/ใหญ่/เกิน 5 → 400 ไม่เก็บ · plan ไม่ใช่ PDF 400', async () => {
    s = fresh();
    const fd = (parts, docKey) => { const f = new FormData(); if (docKey) f.append('docKey', docKey); for (const [buf, name] of parts) f.append('file', new Blob([buf]), name); return f; };
    const before = db.prepare('SELECT COUNT(*) n FROM files WHERE case_no=?').get(NO(17)).n;
    const bad = [
      [[[Buffer.from('plain text'), 'a.pdf']], 'extra', 'FILE_TYPE'],
      [[[Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)]), 'big.pdf']], 'extra', 'FILE_TOO_LARGE'],
      [Array.from({ length: 5 }, (_, i) => [PDF, `p${i}.pdf`]), 'extra', 'FILE_COUNT'], // เดิม 1 + 5 = 6
    ];
    for (const [parts, dk, code] of bad) {
      const r = await raw('POST', `/api/cases/${NO(17)}/resubmit`, { sid: s.sc, form: fd(parts, dk) });
      eq(r.status, 400, code); eq(r.body.code, code);
      eq(dbCase(17).status, 'NEED_FIX'); eq(db.prepare('SELECT COUNT(*) n FROM files WHERE case_no=?').get(NO(17)).n, before);
    }
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
    const ok1 = await raw('POST', `/api/cases/${NO(17)}/resubmit`, { sid: s.sc, form: fd([[png, 'id.png']], 'id-card') });
    eq(ok1.status, 200, JSON.stringify(ok1.body)); eq(db.prepare('SELECT COUNT(*) n FROM files WHERE case_no=?').get(NO(17)).n, before + 1);
    const nf = db.prepare("SELECT * FROM files WHERE case_no=? AND name='id.png'").get(NO(17)); eq(nf.mime, 'image/png'); eq(nf.file_id, 'F-' + String(db.prepare("SELECT COUNT(*) n FROM files").get().n).padStart(4, '0'));
    // plan ต้อง PDF: SV-03 000012 ตีกลับแล้วส่งแบบแปลน PNG
    ok(await post(`/api/officer/cases/${NO(12)}/return`, s.reg2, { reason: 'xxxxxxxxxx' }));
    const r = await raw('POST', `/api/cases/${NO(12)}/resubmit`, { sid: s.pt, form: fd([[png, 'plan.png']], 'plan') });
    eq(r.status, 400); eq(r.body.code, 'PLAN_NOT_PDF'); // 3 + 1 = 4 ไม่เกิน 5 → ตกที่กติกาแบบแปลน
  });

  // ------------------------------------------------------------------ สรุป
  main.server.close();
  console.log(`\n${pass} ผ่าน · ${failed.length} ล้ม` + (failed.length ? '\nล้ม: ' + failed.join(' | ') : ''));
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
