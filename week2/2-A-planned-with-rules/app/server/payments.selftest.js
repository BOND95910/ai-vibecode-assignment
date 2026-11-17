// B06 selftest: node server/payments.selftest.js   (ลอง BUG_MODE=B05 ได้ · ไม่ตั้ง = ต้องผ่านทั้งหมด)
// express ชั่วคราวพอร์ตสุ่ม โหลด routes/drafts.js + routes/payments.js + testhook (ธนาคารจำลอง) · ฐาน :memory: ที่ seed จริง · session จริง (util.sessions)
// ไม่หยุดที่ข้อแรกที่ล้ม: นับทุกข้อแล้วสรุป เพื่อให้เห็นว่าบั๊กทำให้ข้อไหนล้ม
process.env.DB_PATH = ':memory:';
const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const { initSchema, db, resetAll } = require('./db');
const util = require('./util');
const clock = require('./clock');

initSchema();
const app = express();
app.use(express.json({ limit: '8mb' }));
app.use((req, res, next) => { req.cookies = util.parseCookies(req); next(); });
require('./testhook')(app);
require('./routes/drafts')(app);
require('./routes/payments')(app);
const { payByRef } = require('./routes/payments');
app.use((err, req, res, next) => { console.error('UNEXPECTED', err); res.status(500).json({ code: 'INTERNAL', message: String(err) }); }); // eslint-disable-line

let base;
const M = {
  expired: 'QR หมดอายุ กรุณาสร้าง QR ใหม่', amount: 'ยอดเงินไม่ตรงกับค่าธรรมเนียม', nf: 'ไม่พบคำขอ',
  state: 'สถานะคำขอไม่ถูกต้องสำหรับรายการนี้',
};
const PDF = Buffer.from('%PDF-1.4\n' + 'x'.repeat(200) + '\n%%EOF\n', 'latin1');
const DOCS = { 'SV-01': ['id-card'], 'SV-02': ['id-card', 'map'], 'SV-03': ['id-card', 'plan', 'deed'] };

async function raw(method, path, { sid, json, form } = {}) {
  const headers = sid ? { cookie: 'sid=' + sid } : {};
  let body;
  if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form;
  const r = await fetch(base + path, { method, headers, body });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch (e) { /* 204 */ }
  return { status: r.status, body: j };
}
const api = (m, p, sid, json) => raw(m, p, { sid, json });
const upload = (id, sid, docKey, name = docKey + '.pdf') => {
  const form = new FormData();
  form.append('docKey', docKey);
  form.append('file', new Blob([PDF], { type: 'application/pdf' }), name);
  return raw('POST', `/api/drafts/${id}/files`, { sid, form });
};
const bankPay = (ref, amount) => api('POST', `/api/test/payments/${ref}/pay`, undefined, { amount });

function login(where, role = 'citizen') {
  const u = db.prepare(`SELECT * FROM users WHERE ${where}`).get();
  const sid = crypto.randomBytes(16).toString('hex');
  util.sessions.set(sid, { sid, userId: u.id, username: u.username, role: u.role, dept: u.dept, name: u.display_name, registered: !!u.registered, createdAt: '2026-12-01T09:00:00+07:00' });
  return sid;
}
function fresh() { // reset ล้าง session + นาฬิกากลับ 09:00:00 -> ล็อกอินใหม่
  resetAll();
  return { sc: login("display_name LIKE 'สมชาย%'"), sy: login("display_name LIKE 'สมหญิง%'"), off: login("username='off.reg1'") };
}
// ร่างพร้อมเอกสารบังคับครบ (ผ่าน API จริงของ drafts.js) -> draftId
async function mkDraft(sid, body = { serviceId: 'SV-01', qty: 1 }, docs = DOCS[body.serviceId]) {
  const r = await api('POST', '/api/drafts', sid, body);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  for (const k of docs) assert.strictEqual((await upload(r.body.draftId, sid, k)).status, 201);
  return r.body.draftId;
}
const qr = async (sid, draftId) => { const r = await api('POST', `/api/drafts/${draftId}/payment`, sid); assert.strictEqual(r.status, 201, JSON.stringify(r.body)); return r.body; };
// สร้างร่าง + QR + จ่ายตรงยอด ที่นาฬิกาปัจจุบัน -> ผลของ payByRef
async function payNew(sid, body, docs) { const q = await qr(sid, await mkDraft(sid, body, docs)); return { q, r: payByRef(q.ref, q.amount) }; }
const casesOf = (uid) => db.prepare('SELECT COUNT(*) n FROM cases WHERE user_id=?').get(uid).n;
const ok = (r, body) => { assert.strictEqual(r.status, 200, JSON.stringify(r.body)); if (body) assert.deepStrictEqual(r.body, body); };
const err = (r, status, code, message) => { assert.strictEqual(r.status, status, JSON.stringify(r.body)); assert.deepStrictEqual(r.body, { code, message }); };
const thrown = (fn) => { try { fn(); } catch (e) { return e; } return null; };
const rejects = (e, status, code, message) => { assert.ok(e, 'ต้อง throw'); assert.deepStrictEqual([e.status, e.code, e.message], [status, code, message]); };
const T = (s) => '2026-12-01T' + s + '+07:00';

let pass = 0; const failed = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok  ', name); } catch (e) { failed.push(name); console.log('  FAIL', name, '\n       ', String(e.message).split('\n').slice(0, 14).join('\n        ')); }
}

async function main() {
  await new Promise((done) => { const s = app.listen(0, () => { base = 'http://127.0.0.1:' + s.address().port; main.server = s; done(); }); });
  console.log(`BUG_MODE=${process.env.BUG_MODE || '(ไม่ตั้ง)'}`);
  let s;

  console.log('TC-PAY-01 อายุ QR 15:00 (BR-10) · seed PP-0001 สร้าง 08:55:00 หมด 09:10:00');
  await t('PP-0001 ที่ 09:00:00 (อายุ 5:00) -> 200 PAID EG-2569-000031', async () => {
    s = fresh();
    ok(await bankPay('PP-0001', 500), { status: 'PAID', caseNo: 'EG-2569-000031', receiptNo: 'RC-2569-000031', duplicate: false });
  });
  await t('PP-0001 ที่ 09:09:59 (อายุ 14:59) -> 200 PAID EG-2569-000031', async () => {
    s = fresh(); clock.set(T('09:09:59'));
    ok(await bankPay('PP-0001', 500), { status: 'PAID', caseNo: 'EG-2569-000031', receiptNo: 'RC-2569-000031', duplicate: false });
  });
  await t('PP-0001 ที่ 09:10:00 (อายุ 15:00 พอดี) -> 410 QR_EXPIRED · GET status EXPIRED · ไม่ออกเลข (สมชายยัง 10)', async () => {
    s = fresh(); clock.set(T('09:10:00'));
    err(await bankPay('PP-0001', 500), 410, 'QR_EXPIRED', M.expired);
    assert.strictEqual((await api('GET', '/api/payments/PP-0001', s.sc)).body.status, 'EXPIRED');
    assert.strictEqual(casesOf(1), 10); assert.strictEqual(db.prepare('SELECT next FROM counters WHERE kind=? AND year=2569').get('EG').next, 31);
  });
  await t('PP-0001 ที่ 09:10:01 (อายุ 15:01) -> 410 QR_EXPIRED', async () => {
    s = fresh(); clock.set(T('09:10:01'));
    err(await bankPay('PP-0001', 500), 410, 'QR_EXPIRED', M.expired);
    assert.strictEqual((await api('GET', '/api/payments/PP-0001', s.sc)).body.status, 'EXPIRED');
  });
  await t('QR ที่สร้างผ่าน API: อายุ 14:59 -> PAID', async () => {
    s = fresh(); const q = await qr(s.sc, await mkDraft(s.sc)); // 09:00:00
    clock.set(T('09:14:59')); assert.strictEqual((await api('GET', `/api/payments/${q.ref}`, s.sc)).body.status, 'PENDING');
    assert.strictEqual(payByRef(q.ref, 20).status, 'PAID');
  });
  await t('QR ที่สร้างผ่าน API: อายุ 15:00 พอดี -> 410 QR_EXPIRED · GET EXPIRED · ร่างยัง PENDING_PAYMENT', async () => {
    s = fresh(); const d = await mkDraft(s.sc); const q = await qr(s.sc, d);
    clock.set(T('09:15:00'));
    assert.strictEqual((await api('GET', `/api/payments/${q.ref}`, s.sc)).body.status, 'EXPIRED');
    rejects(thrown(() => payByRef(q.ref, 20)), 410, 'QR_EXPIRED', M.expired);
    assert.strictEqual(db.prepare('SELECT status FROM drafts WHERE draft_id=?').get(d).status, 'PENDING_PAYMENT');
  });
  await t('QR ที่สร้างผ่าน API: อายุ 15:01 -> 410', async () => {
    s = fresh(); const q = await qr(s.sc, await mkDraft(s.sc)); clock.set(T('09:15:01'));
    rejects(thrown(() => payByRef(q.ref, 20)), 410, 'QR_EXPIRED', M.expired);
  });
  await t('รอบ 3 บนจอ: ที่ 09:10:00 สร้าง QR ใหม่ของ DR-0002 -> PP-0002 หมด 09:25:00 · ref เก่าใช้ไม่ได้ · จ่าย ฿500 -> EG-2569-000031', async () => {
    s = fresh(); clock.set(T('09:10:00'));
    const r = await api('POST', '/api/drafts/DR-0002/payment', s.sc);
    assert.strictEqual(r.status, 201);
    assert.deepStrictEqual(r.body, { ref: 'PP-0002', amount: 500, qrCreatedAt: T('09:10:00'), qrExpiresAt: T('09:25:00') });
    assert.strictEqual((await api('GET', '/api/payments/PP-0001', s.sc)).body.status, 'EXPIRED');
    rejects(thrown(() => payByRef('PP-0001', 500)), 410, 'QR_EXPIRED', M.expired); // ถูกแทนที่แล้ว
    assert.strictEqual(payByRef('PP-0002', 500).caseNo, 'EG-2569-000031');
  });
  await t('TC-SUBMIT-01 ขั้น 3: POST payment หลัง qty 2 -> PP-0002 ฿40 หมด 09:15:00 · ร่างเข้า PENDING_PAYMENT · GET PENDING', async () => {
    s = fresh();
    const d = await mkDraft(s.sc, { serviceId: 'SV-01', qty: 2 });
    const q = await qr(s.sc, d);
    assert.deepStrictEqual(q, { ref: 'PP-0002', amount: 40, qrCreatedAt: T('09:00:00'), qrExpiresAt: T('09:15:00') });
    assert.strictEqual(db.prepare('SELECT status FROM drafts WHERE draft_id=?').get(d).status, 'PENDING_PAYMENT');
    const g = await api('GET', '/api/payments/PP-0002', s.sc);
    assert.deepStrictEqual([g.body.ref, g.body.amount, g.body.status, g.body.caseNo, g.body.receiptNo], ['PP-0002', 40, 'PENDING', null, null]);
    assert.deepStrictEqual(Object.keys(g.body).filter((k) => !['draftId', 'paidAt'].includes(k)).sort(), ['amount', 'caseNo', 'qrCreatedAt', 'qrExpiresAt', 'receiptNo', 'ref', 'status']);
  });

  console.log('TC-PAY-02 ยอดเงิน · callback ซ้ำ · ยอดที่ล็อก (BR-11)');
  await t('ขาด ฿1 / เกิน ฿1 -> 422 AMOUNT_MISMATCH ยัง PENDING ไม่ออกเลข · ตรง -> PAID EG-2569-000031 RC-2569-000031', async () => {
    s = fresh(); const q = await qr(s.sc, await mkDraft(s.sc)); assert.strictEqual(q.ref, 'PP-0002');
    for (const a of [19, 21]) {
      err(await bankPay('PP-0002', a), 422, 'AMOUNT_MISMATCH', M.amount);
      assert.strictEqual((await api('GET', '/api/payments/PP-0002', s.sc)).body.status, 'PENDING');
      assert.strictEqual(casesOf(1), 10);
    }
    for (const a of [NaN, 20.5, 0, -20]) rejects(thrown(() => payByRef('PP-0002', a)), 422, 'AMOUNT_MISMATCH', M.amount);
    ok(await bankPay('PP-0002', 20), { status: 'PAID', caseNo: 'EG-2569-000031', receiptNo: 'RC-2569-000031', duplicate: false });
    assert.strictEqual(casesOf(1), 11);
  });
  await t('ซ้ำ ref เดิม -> 200 duplicate:true เลข/ใบเสร็จเดิม · คำขอไม่เพิ่ม · ใบถัดไป EG-2569-000032 ไม่ข้ามเลข', async () => {
    ok(await bankPay('PP-0002', 20), { status: 'PAID', caseNo: 'EG-2569-000031', receiptNo: 'RC-2569-000031', duplicate: true });
    assert.strictEqual(casesOf(1), 11); assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM cases').get().n, 31);
    clock.set(T('09:30:00')); // ซ้ำหลังเกิน 15 นาที ก็ยัง duplicate (ไม่ใช่ 410)
    assert.strictEqual(payByRef('PP-0002', 20).duplicate, true);
    const g = await api('GET', '/api/payments/PP-0002', s.sc);
    assert.deepStrictEqual([g.body.status, g.body.caseNo, g.body.receiptNo], ['PAID', 'EG-2569-000031', 'RC-2569-000031']);
    const n = await payNew(s.sc, { serviceId: 'SV-01', qty: 1 });
    assert.deepStrictEqual([n.r.caseNo, n.r.receiptNo], ['EG-2569-000032', 'RC-2569-000032']);
  });
  await t('ref ไม่มี -> 404 NOT_FOUND (payByRef และ hook) · GET ไม่มี/ของคนอื่น -> 404 · ไม่ล็อกอิน 401 · officer 403', async () => {
    s = fresh();
    rejects(thrown(() => payByRef('PP-9999', 20)), 404, 'NOT_FOUND', M.nf);
    err(await bankPay('PP-9999', 20), 404, 'NOT_FOUND', M.nf);
    err(await api('GET', '/api/payments/PP-9999', s.sc), 404, 'NOT_FOUND', M.nf);
    err(await api('GET', '/api/payments/PP-0001', s.sy), 404, 'NOT_FOUND', M.nf);
    assert.strictEqual((await api('GET', '/api/payments/PP-0001')).status, 401);
    assert.strictEqual((await api('GET', '/api/payments/PP-0001', s.off)).status, 403);
  });
  await t('TC-RBAC-04: admin แก้ SV-02 เป็น 600 -> PP-0001 จ่าย 600 = 422 · จ่าย 500 = PAID · คำขอ fee 500', async () => {
    s = fresh(); db.prepare("UPDATE services SET fee=600 WHERE id='SV-02'").run();
    err(await bankPay('PP-0001', 600), 422, 'AMOUNT_MISMATCH', M.amount);
    ok(await bankPay('PP-0001', 500));
    assert.strictEqual(db.prepare("SELECT fee FROM cases WHERE draft_id='DR-0002'").get().fee, 500);
  });
  await t('TC-RBAC-04: QR ใหม่ของ DR-0002 หลังแก้เป็น 600 ยังยอด 500 (ล็อกแล้ว) · จ่าย 600 ที่ ref ใหม่ 422 · 500 ผ่าน', async () => {
    s = fresh(); db.prepare("UPDATE services SET fee=600 WHERE id='SV-02'").run();
    const q = await qr(s.sc, 'DR-0002');
    assert.deepStrictEqual([q.ref, q.amount], ['PP-0002', 500]);
    assert.strictEqual(db.prepare("SELECT fee FROM drafts WHERE draft_id='DR-0002'").get().fee, 500);
    rejects(thrown(() => payByRef('PP-0002', 600)), 422, 'AMOUNT_MISMATCH', M.amount);
    assert.strictEqual(payByRef('PP-0002', 500).status, 'PAID');
  });
  await t('ล็อกตอนเข้า PENDING_PAYMENT ครั้งแรก: แก้ก่อนเข้า = ยอดใหม่ · แก้หลังเข้า = ยอดเดิม แม้สร้าง QR ซ้ำ', async () => {
    s = fresh();
    const dA = await mkDraft(s.sc); // SV-01 qty 1 ฿20 ร่างค้าง DRAFT
    const dB = await mkDraft(s.sc); const qB = await qr(s.sc, dB); assert.strictEqual(qB.amount, 20); // เข้า PENDING_PAYMENT ที่ ฿20
    db.prepare("UPDATE services SET fee=25 WHERE id='SV-01'").run();
    const qA = await qr(s.sc, dA); assert.strictEqual(qA.amount, 25); // เข้าหลังแก้ -> ยอดใหม่
    assert.strictEqual(db.prepare('SELECT fee FROM drafts WHERE draft_id=?').get(dA).fee, 25);
    const qB2 = await qr(s.sc, dB); assert.strictEqual(qB2.amount, 20); // QR ใหม่ของคำขอเดิม = ยอดที่ล็อก
    db.prepare("UPDATE services SET fee=99 WHERE id='SV-01'").run();
    assert.strictEqual((await qr(s.sc, dA)).amount, 25);
    rejects(thrown(() => payByRef(qB.ref, 20)), 410, 'QR_EXPIRED', M.expired); // ref แรกถูกแทนที่
    rejects(thrown(() => payByRef(qB2.ref, 25)), 422, 'AMOUNT_MISMATCH', M.amount);
    assert.strictEqual(payByRef(qB2.ref, 20).status, 'PAID');
    assert.strictEqual(db.prepare('SELECT fee FROM cases WHERE draft_id=?').get(dB).fee, 20);
  });

  console.log('ผลของการชำระสำเร็จ (BR-09 FR-08)');
  await t('คำขอ/ใบเสร็จ/ไฟล์/ไทม์ไลน์/ร่าง/payments ครบ · ร่างหายจากรายการร่าง', async () => {
    s = fresh();
    const d = await mkDraft(s.sc, { serviceId: 'SV-03', areaSqm: 101 });
    const q = await qr(s.sc, d); assert.deepStrictEqual([q.ref, q.amount], ['PP-0002', 1010]);
    ok(await bankPay('PP-0002', 1010), { status: 'PAID', caseNo: 'EG-2569-000031', receiptNo: 'RC-2569-000031', duplicate: false });
    const c = db.prepare("SELECT * FROM cases WHERE case_no='EG-2569-000031'").get();
    assert.deepStrictEqual([c.draft_id, c.user_id, c.service_id, c.status, c.step, c.dept, c.fee, c.qty, c.area_sqm, c.paid_at, c.receipt_no, c.owner, c.return_count],
      [d, 1, 'SV-03', 'SUBMITTED', 1, 'registry', 1010, null, 101, T('09:00:00'), 'RC-2569-000031', null, 0]);
    assert.strictEqual(c.due_at, '2026-12-24T16:30:00+07:00'); // SV-03 N=15 อ.1 ธ.ค. 09:00
    assert.deepStrictEqual(db.prepare('SELECT doc_key FROM files WHERE case_no=? ORDER BY file_id').all(c.case_no).map((f) => f.doc_key), ['id-card', 'plan', 'deed']);
    assert.deepStrictEqual(db.prepare('SELECT kind, time, actor_role, to_status FROM timeline_events WHERE case_no=? ORDER BY id').all(c.case_no).map((x) => ({ ...x })),
      [{ kind: 'PAID', time: T('09:00:00'), actor_role: 'citizen', to_status: null }, { kind: 'SUBMITTED', time: T('09:00:00'), actor_role: 'system', to_status: 'SUBMITTED' }]);
    const dr = db.prepare('SELECT status, case_no FROM drafts WHERE draft_id=?').get(d);
    assert.deepStrictEqual([dr.status, dr.case_no], ['SUBMITTED', c.case_no]);
    const p = db.prepare('SELECT * FROM payments WHERE ref=?').get('PP-0002');
    assert.deepStrictEqual([p.status, p.case_no, p.receipt_no, p.paid_at, p.amount], ['PAID', c.case_no, c.receipt_no, T('09:00:00'), 1010]);
    assert.ok(!(await api('GET', '/api/drafts', s.sc)).body.items.some((x) => x.draftId === d)); // ไม่โผล่ใน my-draft-row
    assert.deepStrictEqual((await api('GET', '/api/payments/PP-0002', s.sc)).body.paidAt, T('09:00:00'));
  });
  await t('QR หลายใบของร่างเดียว: จ่ายใบล่าสุดแล้ว ใบก่อนหน้าจ่ายไม่ได้ (ไม่เกิดคำขอซ้ำ)', async () => {
    s = fresh(); const d = await mkDraft(s.sc);
    const q1 = await qr(s.sc, d); const q2 = await qr(s.sc, d);
    assert.deepStrictEqual([q1.ref, q2.ref], ['PP-0002', 'PP-0003']);
    assert.strictEqual((await api('GET', '/api/payments/PP-0002', s.sc)).body.status, 'EXPIRED');
    assert.strictEqual(payByRef('PP-0003', 20).status, 'PAID');
    rejects(thrown(() => payByRef('PP-0002', 20)), 410, 'QR_EXPIRED', M.expired);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM cases WHERE draft_id=?').get(d).n, 1);
  });
  await t('ลบร่างที่รอชำระ -> ref เป็น 404 (GET และ pay)', async () => {
    s = fresh();
    assert.strictEqual((await api('DELETE', '/api/drafts/DR-0002', s.sc)).status, 204);
    err(await api('GET', '/api/payments/PP-0001', s.sc), 404, 'NOT_FOUND', M.nf);
    err(await bankPay('PP-0001', 500), 404, 'NOT_FOUND', M.nf);
  });

  console.log('POST /api/drafts/:id/payment · เอกสารไม่ครบ (TC-SUBMIT-02 ส่วน API)');
  await t('SV-03 ขาดแบบแปลน+โฉนด -> 409 MISSING_DOCS + missing[] · ไม่สร้าง QR/ไม่เปลี่ยนสถานะ · แนบครบ -> 201', async () => {
    s = fresh();
    const d = await mkDraft(s.sc, { serviceId: 'SV-03', areaSqm: 100 }, ['id-card']);
    let r = await api('POST', `/api/drafts/${d}/payment`, s.sc);
    assert.strictEqual(r.status, 409);
    assert.deepStrictEqual(r.body, { code: 'MISSING_DOCS', message: 'ยังขาดเอกสาร: แบบแปลน, โฉนด', missing: ['แบบแปลน', 'โฉนด'] });
    await upload(d, s.sc, 'deed');
    r = await api('POST', `/api/drafts/${d}/payment`, s.sc);
    assert.deepStrictEqual(r.body, { code: 'MISSING_DOCS', message: 'ยังขาดเอกสาร: แบบแปลน', missing: ['แบบแปลน'] });
    assert.strictEqual(db.prepare('SELECT status FROM drafts WHERE draft_id=?').get(d).status, 'DRAFT');
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM payments').get().n, 1); // มีแต่ PP-0001 ของ seed
    assert.strictEqual(db.prepare('SELECT next FROM counters WHERE kind=? AND year=0').get('PP').next, 2); // ตัวนับไม่ขยับ
    await upload(d, s.sc, 'plan');
    assert.strictEqual((await api('POST', `/api/drafts/${d}/payment`, s.sc)).status, 201);
  });
  await t('ตรวจซ้ำทุกครั้ง: ลบไฟล์หลังมี QR แล้ว สร้าง QR ใหม่ -> 409 (ร่างที่ PENDING_PAYMENT ก็ตรวจ)', async () => {
    s = fresh();
    const d = await mkDraft(s.sc, { serviceId: 'SV-02' }); await qr(s.sc, d);
    const f = db.prepare("SELECT file_id FROM files WHERE draft_id=? AND doc_key='map'").get(d).file_id;
    assert.strictEqual((await api('DELETE', `/api/drafts/${d}/files/${f}`, s.sc)).status, 204);
    const r = await api('POST', `/api/drafts/${d}/payment`, s.sc);
    assert.deepStrictEqual([r.status, r.body.code, r.body.missing], [409, 'MISSING_DOCS', ['แผนที่ตั้ง']]);
    const r1 = await api('POST', '/api/drafts/DR-0001/payment', s.sc);
    assert.deepStrictEqual([r1.status, r1.body.message], [409, 'ยังขาดเอกสาร: บัตรประชาชน']);
  });
  await t('สิทธิ์: ร่างคนอื่น/ไม่มี -> 404 · ไม่ล็อกอิน 401 · officer 403 · ร่าง SUBMITTED -> 409 INVALID_STATE', async () => {
    s = fresh();
    err(await api('POST', '/api/drafts/DR-0002/payment', s.sy), 404, 'NOT_FOUND', M.nf);
    err(await api('POST', '/api/drafts/DR-9999/payment', s.sc), 404, 'NOT_FOUND', M.nf);
    assert.strictEqual((await api('POST', '/api/drafts/DR-0002/payment')).status, 401);
    assert.strictEqual((await api('POST', '/api/drafts/DR-0002/payment', s.off)).status, 403);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM payments').get().n, 1);
    const { r } = await payNew(s.sc);
    assert.strictEqual(r.status, 'PAID');
    const d = db.prepare("SELECT draft_id FROM drafts WHERE status='SUBMITTED'").get().draft_id;
    err(await api('POST', `/api/drafts/${d}/payment`, s.sc), 409, 'INVALID_STATE', M.state);
  });

  console.log('TC-PAY-03 ชำระพร้อมกัน 6 รายการ (BR-09)');
  await t('6 ref ยิง Promise.all -> 200 ทั้งหมด · EG/RC 000031..000036 ไม่ซ้ำ · สมชาย +3 สมหญิง +3 · ถัดไป 000037', async () => {
    s = fresh();
    const refs = []; const before = [casesOf(1), casesOf(2)];
    for (const sid of [s.sc, s.sc, s.sc, s.sy, s.sy, s.sy]) refs.push((await qr(sid, await mkDraft(sid))).ref);
    assert.deepStrictEqual(refs, ['PP-0002', 'PP-0003', 'PP-0004', 'PP-0005', 'PP-0006', 'PP-0007']);
    const rs = await Promise.all(refs.map((ref) => bankPay(ref, 20)));
    assert.ok(rs.every((r) => r.status === 200 && r.body.duplicate === false), JSON.stringify(rs.map((r) => r.body)));
    const want = (p) => [31, 32, 33, 34, 35, 36].map((n) => `${p}-2569-0000${n}`);
    assert.deepStrictEqual(rs.map((r) => r.body.caseNo).sort(), want('EG'));
    assert.deepStrictEqual(rs.map((r) => r.body.receiptNo).sort(), want('RC'));
    assert.strictEqual(new Set(rs.map((r) => r.body.caseNo)).size, 6);
    assert.deepStrictEqual([casesOf(1) - before[0], casesOf(2) - before[1]], [3, 3]); // สมชาย +3 · สมหญิง +3
    assert.strictEqual((await payNew(s.sc)).r.caseNo, 'EG-2569-000037');
  });
  await t('payByRef 6 รายการพร้อมกันผ่านฟังก์ชันตรง (async รวม) ก็ไม่ซ้ำ', async () => {
    s = fresh();
    const qs = []; for (let i = 0; i < 6; i++) qs.push(await qr(s.sc, await mkDraft(s.sc)));
    const out = await Promise.all(qs.map((q) => Promise.resolve().then(() => payByRef(q.ref, q.amount))));
    assert.strictEqual(new Set(out.map((o) => o.caseNo)).size, 6); assert.strictEqual(new Set(out.map((o) => o.receiptNo)).size, 6);
  });

  console.log('TC-PAY-04 ข้ามปี พ.ศ.');
  await t('31 ธ.ค. 2569 23:59 -> EG/RC-2569-000031 · 1 ม.ค. 2570 00:00 -> EG/RC-2570-000001, 000002 · เลขเก่าไม่ถูกแก้', async () => {
    s = fresh();
    clock.set('2026-12-31T23:58:00+07:00');
    const q1 = await qr(s.sc, await mkDraft(s.sc)); assert.strictEqual(casesOf(1), 10); // ยังไม่มีเลข
    assert.strictEqual(db.prepare('SELECT case_no FROM drafts WHERE draft_id=?').get(db.prepare('SELECT draft_id FROM payments WHERE ref=?').get(q1.ref).draft_id).case_no, null);
    clock.set('2026-12-31T23:59:00+07:00');
    assert.deepStrictEqual(payByRef(q1.ref, 20), { status: 'PAID', caseNo: 'EG-2569-000031', receiptNo: 'RC-2569-000031', duplicate: false });
    assert.strictEqual((await api('GET', `/api/payments/${q1.ref}`, s.sc)).body.paidAt, '2026-12-31T23:59:00+07:00');
    clock.set('2027-01-01T00:00:00+07:00');
    const a = await payNew(s.sc); assert.deepStrictEqual([a.r.caseNo, a.r.receiptNo], ['EG-2570-000001', 'RC-2570-000001']);
    const b = await payNew(s.sc); assert.deepStrictEqual([b.r.caseNo, b.r.receiptNo], ['EG-2570-000002', 'RC-2570-000002']);
    assert.strictEqual(db.prepare("SELECT paid_at FROM cases WHERE case_no='EG-2569-000031'").get().paid_at, '2026-12-31T23:59:00+07:00');
  });

  console.log('BR-12 dueAt คำนวณครั้งเดียวตอนชำระ');
  await t('SV-01 ชำระ อ.1 ธ.ค. 16:29 -> ศ.4 ธ.ค. 16:30 · 16:30 -> อ.8 ธ.ค. 16:30 · SV-02 09:00 -> พฤ.17 · เพิ่มวันหยุดภายหลังไม่เปลี่ยน', async () => {
    s = fresh();
    clock.set(T('16:29:00')); const a = (await payNew(s.sc)).r.caseNo;
    clock.set(T('16:30:00')); const b = (await payNew(s.sc)).r.caseNo;
    clock.set(T('09:00:00')); const c = (await payNew(s.sc, { serviceId: 'SV-02' })).r.caseNo;
    const due = (n) => db.prepare('SELECT due_at FROM cases WHERE case_no=?').get(n).due_at;
    assert.deepStrictEqual([due(a), due(b), due(c)], ['2026-12-04T16:30:00+07:00', '2026-12-08T16:30:00+07:00', '2026-12-17T16:30:00+07:00']);
    db.prepare("INSERT INTO holidays (date,name) VALUES ('2026-12-03','ทดสอบ')").run();
    assert.strictEqual(due(a), '2026-12-04T16:30:00+07:00'); // เก็บค่าที่คำนวณแล้ว ไม่คำนวณใหม่
  });

  main.server.close();
  console.log(`\n${pass} ผ่าน · ${failed.length} ล้ม`);
  if (failed.length) { console.log('ล้ม:\n - ' + failed.join('\n - ')); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(2); });
