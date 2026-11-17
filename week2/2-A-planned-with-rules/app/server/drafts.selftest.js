// B05 selftest: node server/drafts.selftest.js   (ลอง BUG_MODE=B01 หรือ BUG_MODE=B02 ได้ · ไม่ตั้ง = ต้องผ่านทั้งหมด)
// express ชั่วคราวพอร์ตสุ่ม โหลดเฉพาะ routes/drafts.js + ฐาน :memory: ที่ seed จริง + session จริง (util.sessions)
// ไม่หยุดที่ข้อแรกที่ล้ม: นับทุกข้อแล้วสรุป เพื่อให้เห็นว่าบั๊กทำให้ข้อไหนล้ม
process.env.DB_PATH = ':memory:';
const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const { initSchema, db, resetAll } = require('./db');
const util = require('./util');
const { computeFee, requiredDocs, missingDocs } = require('./fees');

initSchema();
const app = express();
app.use(express.json({ limit: '8mb' }));
app.use((req, res, next) => { req.cookies = util.parseCookies(req); next(); });
require('./routes/drafts')(app);
app.use((err, req, res, next) => { console.error('UNEXPECTED', err); res.status(500).json({ code: 'INTERNAL', message: String(err) }); }); // eslint-disable-line

let base;
const EN = '–';
const M = {
  qty: `จำนวนฉบับต้อง 1${EN}5 ฉบับ`, area: `กรุณาระบุพื้นที่ 1${EN}500 ตร.ม.`, big: 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน',
  tooLarge: 'ไฟล์ใหญ่เกิน 5 MB', type: 'รองรับเฉพาะไฟล์ PDF, JPG, PNG', count: 'แนบได้สูงสุด 5 ไฟล์ต่อคำขอ',
  plan: 'แบบแปลนต้องเป็นไฟล์ PDF เท่านั้น', nf: 'ไม่พบคำขอ',
};

// ---- ไฟล์ทดสอบตาม TEST-DATA ข้อ 11 (ขนาดตรงไบต์) ----
function pdf(n) {
  const head = '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n', tail = '\ntrailer<</Root 1 0 R>>\n%%EOF\n';
  return Buffer.from(head + ' '.repeat(n - head.length - tail.length) + tail, 'latin1');
}
function jpg(n) {
  const soi = Buffer.from([0xff, 0xd8]), app0 = Buffer.from('ffe000104a46494600010100000100010000', 'hex');
  const pad = n - soi.length - app0.length - 2 - 4;
  const com = Buffer.concat([Buffer.from([0xff, 0xfe, (pad + 2) >> 8, (pad + 2) & 255]), Buffer.alloc(pad, 0x78)]);
  return Buffer.concat([soi, app0, com, Buffer.from([0xff, 0xd9])]);
}
function png(n) {
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  const head = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', Buffer.from('789c6360f8cf00000301010018dd8db0', 'hex'))]);
  const pad = n - head.length - 12 - 12;
  return Buffer.concat([head, chunk('tEXt', Buffer.concat([Buffer.from('k\0'), Buffer.alloc(pad - 2, 0x78)])), chunk('IEND', Buffer.alloc(0))]);
}
const F = {
  ok: pdf(1024), jpg: jpg(1024), png: png(1024), text: Buffer.from('hello'), exe: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(1022)]),
};

// ---- HTTP ----
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
function up(id, sid, docKey, buf, name, mime) {
  const form = new FormData();
  if (docKey !== undefined) form.append('docKey', docKey);
  if (buf) form.append('file', new Blob([buf], { type: mime || 'application/octet-stream' }), name);
  return raw('POST', `/api/drafts/${id}/files`, { sid, form });
}

// ---- session จริง: ใส่ใน util.sessions แบบเดียวกับที่ B04 ออก ----
function login(where, role = 'citizen') {
  const u = db.prepare(`SELECT * FROM users WHERE ${where}`).get();
  const sid = crypto.randomBytes(16).toString('hex');
  util.sessions.set(sid, { sid, userId: u.id, username: u.username, role: u.role, dept: u.dept, name: u.display_name, registered: !!u.registered, createdAt: '2026-12-01T09:00:00+07:00' });
  return sid;
}
function fresh() { // reset ล้าง session ทุกคน -> ล็อกอินใหม่
  resetAll();
  return { sc: login("display_name LIKE 'สมชาย%'"), sy: login("display_name LIKE 'สมหญิง%'"), mana: login("display_name LIKE 'มานะ%'"), off: login("username='off.reg1'") };
}
const fileCount = (id) => db.prepare('SELECT COUNT(*) n FROM files WHERE draft_id=?').get(id).n;
const err = (r, status, code, message) => { assert.strictEqual(r.status, status, JSON.stringify(r.body)); assert.deepStrictEqual(r.body, { code, message }); };

// ---- ตัวรัน ----
let pass = 0; const failed = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok  ', name); } catch (e) { failed.push(name); console.log('  FAIL', name, '\n       ', String(e.message).split('\n').slice(0, 4).join('\n        ')); }
}
const thrown = (fn) => { try { fn(); } catch (e) { return e; } return null; };

async function main() {
  await new Promise((ok) => { const s = app.listen(0, () => { base = 'http://127.0.0.1:' + s.address().port; main.server = s; ok(); }); });
  console.log(`BUG_MODE=${process.env.BUG_MODE || '(ไม่ตั้ง)'}`);

  console.log('BR-04 SV-01 จำนวนฉบับ (TC-FEE-01)');
  resetAll();
  await t('qty 1..5 -> 20..100', () => { for (const [q, f] of [[1, 20], [2, 40], [3, 60], [4, 80], [5, 100]]) assert.deepStrictEqual(computeFee('SV-01', { qty: q }), { fee: f }); });
  await t('qty 0, 6, -1 -> 400 INVALID_QTY + ข้อความ en dash', () => {
    for (const q of [0, 6, -1, 100]) { const e = thrown(() => computeFee('SV-01', { qty: q })); assert.ok(e, 'qty ' + q); assert.deepStrictEqual([e.status, e.code, e.message], [400, 'INVALID_QTY', M.qty]); }
    assert.ok(M.qty.includes('–') && !M.qty.includes('-'));
  });
  await t('qty ทศนิยม/ข้อความ/null/ไม่ส่ง -> INVALID_QTY', () => {
    for (const q of [1.5, '2', '', null, undefined, NaN, true]) assert.strictEqual((thrown(() => computeFee('SV-01', { qty: q })) || {}).code, 'INVALID_QTY', String(q));
  });

  console.log('BR-05 SV-03 พื้นที่ + SV-02 (TC-FEE-01)');
  await t('พื้นที่ 1,100,101,102,250,300,499,500 ตามตาราง', () => {
    for (const [a, f] of [[1, 1000], [100, 1000], [101, 1010], [102, 1020], [250, 2500], [300, 3000], [499, 4990], [500, 5000]]) {
      assert.deepStrictEqual(computeFee('SV-03', { areaSqm: a }), { fee: f }, 'area ' + a);
    }
  });
  await t('พื้นที่ 0,-1,ทศนิยม,ข้อความ,ไม่ส่ง -> INVALID_AREA', () => {
    for (const a of [0, -1, 1.5, '100', null, undefined, NaN]) { const e = thrown(() => computeFee('SV-03', { areaSqm: a })); assert.ok(e, String(a)); assert.deepStrictEqual([e.status, e.code, e.message], [400, 'INVALID_AREA', M.area], String(a)); }
  });
  await t('พื้นที่ 501, 100000 -> AREA_TOO_LARGE', () => {
    for (const a of [501, 100000]) { const e = thrown(() => computeFee('SV-03', { areaSqm: a })); assert.deepStrictEqual([e.status, e.code, e.message], [400, 'AREA_TOO_LARGE', M.big]); }
  });
  await t('SV-02 = 500 คงที่ (ไม่สน qty/area)', () => { assert.deepStrictEqual(computeFee('SV-02', {}), { fee: 500 }); assert.deepStrictEqual(computeFee('SV-02', { qty: 9, areaSqm: 9 }), { fee: 500 }); });
  await t('บริการไม่มี -> 400 INVALID_SERVICE', () => assert.strictEqual(thrown(() => computeFee('SV-99', {})).code, 'INVALID_SERVICE'));
  await t('อ่านอัตราจากตาราง services สด (admin แก้ได้)', () => {
    db.prepare("UPDATE services SET fee=25 WHERE id='SV-01'").run();
    db.prepare("UPDATE services SET fee=600 WHERE id='SV-02'").run();
    db.prepare("UPDATE services SET fee_base=1200, fee_per_sqm=20 WHERE id='SV-03'").run();
    assert.strictEqual(computeFee('SV-01', { qty: 2 }).fee, 50);
    assert.strictEqual(computeFee('SV-02', {}).fee, 600);
    assert.strictEqual(computeFee('SV-03', { areaSqm: 100 }).fee, 1200);
    assert.strictEqual(computeFee('SV-03', { areaSqm: 101 }).fee, 1220);
    assert.strictEqual(computeFee('SV-03', { areaSqm: 500 }).fee, 1200 + 20 * 400);
    resetAll();
    assert.strictEqual(computeFee('SV-01', { qty: 2 }).fee, 40);
  });

  console.log('POST /api/drafts · GET · PUT (CONTRACT 6.2)');
  let s = fresh();
  await t('สร้างร่าง -> 201 {draftId:DR-0003, fee} แล้ว DR-0004', async () => {
    let r = await api('POST', '/api/drafts', s.sc, { serviceId: 'SV-01', qty: 2 });
    assert.strictEqual(r.status, 201); assert.deepStrictEqual(r.body, { draftId: 'DR-0003', fee: 40 });
    r = await api('POST', '/api/drafts', s.sc, { serviceId: 'SV-03', areaSqm: 101 });
    assert.strictEqual(r.status, 201); assert.deepStrictEqual(r.body, { draftId: 'DR-0004', fee: 1010 });
    r = await api('POST', '/api/drafts', s.sc, { serviceId: 'SV-02' });
    assert.deepStrictEqual(r.body, { draftId: 'DR-0005', fee: 500 });
    assert.strictEqual(db.prepare("SELECT fee FROM drafts WHERE draft_id='DR-0004'").get().fee, 1010);
  });
  await t('API ค่าผิด -> 400 รหัส/ข้อความตรง (qty 0,6 · area 0,-1,501)', async () => {
    for (const [b, c, m] of [[{ serviceId: 'SV-01', qty: 0 }, 'INVALID_QTY', M.qty], [{ serviceId: 'SV-01', qty: 6 }, 'INVALID_QTY', M.qty], [{ serviceId: 'SV-01', qty: '2' }, 'INVALID_QTY', M.qty],
      [{ serviceId: 'SV-03', areaSqm: 0 }, 'INVALID_AREA', M.area], [{ serviceId: 'SV-03', areaSqm: -1 }, 'INVALID_AREA', M.area], [{ serviceId: 'SV-03', areaSqm: 501 }, 'AREA_TOO_LARGE', M.big]]) {
      err(await api('POST', '/api/drafts', s.sc, b), 400, c, m);
    }
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM drafts').get().n, 5); // ร่างที่ผิดไม่ถูกสร้าง ตัวนับไม่ขยับ
  });
  await t('B01: API พื้นที่ 101 -> 1010 และ 102 -> 1020', async () => {
    assert.strictEqual((await api('POST', '/api/drafts', s.sc, { serviceId: 'SV-03', areaSqm: 101 })).body.fee, 1010);
    assert.strictEqual((await api('POST', '/api/drafts', s.sc, { serviceId: 'SV-03', areaSqm: 102 })).body.fee, 1020);
  });
  await t('สิทธิ์: ไม่ล็อกอิน 401 · officer 403 · citizen ไม่ลงทะเบียน 403', async () => {
    err(await api('POST', '/api/drafts', undefined, { serviceId: 'SV-02' }), 401, 'UNAUTHENTICATED', 'กรุณาเข้าสู่ระบบ');
    err(await api('POST', '/api/drafts', s.off, { serviceId: 'SV-02' }), 403, 'FORBIDDEN', 'ไม่มีสิทธิ์ทำรายการนี้');
    err(await api('POST', '/api/drafts', s.mana, { serviceId: 'SV-02' }), 403, 'FORBIDDEN', 'ไม่มีสิทธิ์ทำรายการนี้');
    for (const [m, p] of [['GET', '/api/drafts'], ['GET', '/api/drafts/DR-0001'], ['DELETE', '/api/drafts/DR-0001'], ['PUT', '/api/drafts/DR-0001']]) {
      assert.strictEqual((await api(m, p, s.off)).status, 403, m + p);
      assert.strictEqual((await api(m, p)).status, 401, m + p);
    }
  });
  s = fresh();
  await t('GET /api/drafts: seed 2 ร่างของสมชาย · สมหญิง 0 · สร้างใหม่ -> 3', async () => {
    let r = await api('GET', '/api/drafts', s.sc);
    assert.deepStrictEqual(r.body.items.map((x) => [x.draftId, x.serviceId, x.status, x.fee]), [['DR-0001', 'SV-01', 'DRAFT', 40], ['DR-0002', 'SV-02', 'PENDING_PAYMENT', 500]]);
    assert.strictEqual((await api('GET', '/api/drafts', s.sy)).body.items.length, 0);
    await api('POST', '/api/drafts', s.sc, { serviceId: 'SV-01', qty: 3 });
    r = await api('GET', '/api/drafts', s.sc);
    assert.strictEqual(r.body.items.length, 3);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM cases WHERE user_id=1').get().n, 10); // ร่างไม่สร้างเลขคำขอ
  });
  await t('GET /api/drafts/:id: เจ้าของเห็น qty/ไฟล์/missing · ของคนอื่น+ไม่มี -> 404 ไม่พบคำขอ', async () => {
    let r = await api('GET', '/api/drafts/DR-0001', s.sc);
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.qty, 2); assert.strictEqual(r.body.fee, 40);
    assert.deepStrictEqual(r.body.files, []); assert.deepStrictEqual(r.body.missing, ['บัตรประชาชน']);
    r = await api('GET', '/api/drafts/DR-0002', s.sc);
    assert.deepStrictEqual(r.body.files.map((f) => f.docKey), ['id-card', 'map']); assert.deepStrictEqual(r.body.missing, []);
    err(await api('GET', '/api/drafts/DR-0001', s.sy), 404, 'NOT_FOUND', M.nf);
    err(await api('GET', '/api/drafts/DR-9999', s.sc), 404, 'NOT_FOUND', M.nf);
  });
  await t('PUT แก้ qty/พื้นที่ -> คิดใหม่ · ค่าผิด 400 · ของคนอื่น 404 · PENDING_PAYMENT 409', async () => {
    let r = await api('PUT', '/api/drafts/DR-0001', s.sc, { qty: 5 });
    assert.deepStrictEqual(r.body, { draftId: 'DR-0001', fee: 100 });
    assert.strictEqual((await api('GET', '/api/drafts/DR-0001', s.sc)).body.fee, 100);
    err(await api('PUT', '/api/drafts/DR-0001', s.sc, { qty: 6 }), 400, 'INVALID_QTY', M.qty);
    assert.strictEqual((await api('GET', '/api/drafts/DR-0001', s.sc)).body.fee, 100);
    err(await api('PUT', '/api/drafts/DR-0001', s.sy, { qty: 1 }), 404, 'NOT_FOUND', M.nf);
    err(await api('PUT', '/api/drafts/DR-0002', s.sc, {}), 409, 'INVALID_STATE', 'สถานะคำขอไม่ถูกต้องสำหรับรายการนี้');
  });

  console.log('BR-07 ขนาด/จำนวน (TC-UPLOAD-01)');
  s = fresh();
  const mk = async (b) => (await api('POST', '/api/drafts', s.sc, b)).body.draftId; // SV-01 ลบไฟล์ก่อนลองค่าถัดไป
  let d1 = await mk({ serviceId: 'SV-01', qty: 1 });
  const sizeCase = (n, ok) => t(`ไฟล์ ${n.toLocaleString('en-US')} ไบต์ -> ${ok ? '201' : '400 FILE_TOO_LARGE'}`, async () => {
    const r = await up(d1, s.sc, 'id-card', pdf(n), `size-${n}.pdf`, 'application/pdf');
    if (ok) {
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      assert.strictEqual(r.body.size, n); assert.strictEqual(r.body.docKey, 'id-card'); assert.strictEqual(r.body.name, `size-${n}.pdf`);
      assert.strictEqual(fileCount(d1), 1);
      assert.strictEqual((await api('DELETE', `/api/drafts/${d1}/files/${r.body.fileId}`, s.sc)).status, 204);
    } else { err(r, 400, 'FILE_TOO_LARGE', M.tooLarge); }
    assert.strictEqual(fileCount(d1), 0);
  });
  await sizeCase(5242879, true);
  await sizeCase(5242880, true);
  await sizeCase(5242881, false);
  await t('ไฟล์ 7 MB / 12 MB -> 400 FILE_TOO_LARGE (ไม่ใช่ 413/500 จาก multer)', async () => {
    for (const n of [7 * 1024 * 1024, 12 * 1024 * 1024]) err(await up(d1, s.sc, 'id-card', pdf(n), 'big.pdf', 'application/pdf'), 400, 'FILE_TOO_LARGE', M.tooLarge);
    assert.strictEqual(fileCount(d1), 0);
  });
  await t('จำนวน: 5 ไฟล์รับ · ไฟล์ที่ 6 -> 400 FILE_COUNT · ลบ 1 แล้วแนบได้ (ไฟล์ที่ถูกปฏิเสธไม่ถูกนับ)', async () => {
    const ids = [];
    let r = await up(d1, s.sc, 'id-card', F.ok, 'id-card.pdf', 'application/pdf'); assert.strictEqual(r.status, 201); ids.push(r.body.fileId);
    for (let i = 1; i <= 4; i++) { r = await up(d1, s.sc, 'extra', F.ok, `multi-${i}.pdf`, 'application/pdf'); assert.strictEqual(r.status, 201, JSON.stringify(r.body)); ids.push(r.body.fileId); }
    assert.strictEqual(fileCount(d1), 5);
    err(await up(d1, s.sc, 'extra', F.ok, 'multi-5.pdf', 'application/pdf'), 400, 'FILE_COUNT', M.count);
    assert.strictEqual(fileCount(d1), 5);
    assert.strictEqual((await api('DELETE', `/api/drafts/${d1}/files/${ids[4]}`, s.sc)).status, 204);
    r = await up(d1, s.sc, 'extra', F.ok, 'multi-5.pdf', 'application/pdf'); assert.strictEqual(r.status, 201);
    assert.strictEqual(fileCount(d1), 5);
    assert.strictEqual(new Set(db.prepare('SELECT file_id FROM files').all().map((x) => x.file_id)).size, db.prepare('SELECT COUNT(*) n FROM files').get().n); // file_id ไม่ซ้ำกับ seed
  });

  console.log('BR-06 ชนิดไฟล์จาก magic bytes (TC-UPLOAD-02)');
  s = fresh(); d1 = await mk({ serviceId: 'SV-01', qty: 1 });
  await t('PDF/JPG/PNG จริงผ่าน และเก็บ mime ตามเนื้อ (ไม่ตามที่ client บอก)', async () => {
    for (const [buf, name, sent, mime] of [[F.ok, 'ok-id.pdf', 'application/pdf', 'application/pdf'], [F.jpg, 'real.jpg', 'image/jpeg', 'image/jpeg'], [F.png, 'real.png', 'image/png', 'image/png'], [F.png, 'png-labelled-pdf.pdf', 'application/pdf', 'image/png']]) {
      const r = await up(d1, s.sc, 'id-card', buf, name, sent);
      assert.strictEqual(r.status, 201, name + JSON.stringify(r.body));
      const row = db.prepare('SELECT mime, size, content FROM files WHERE file_id=?').get(r.body.fileId);
      assert.strictEqual(row.mime, mime, name); assert.ok(Buffer.from(row.content).equals(buf), 'เนื้อไฟล์ที่เก็บต้องตรงต้นฉบับ');
      await api('DELETE', `/api/drafts/${d1}/files/${r.body.fileId}`, s.sc);
    }
  });
  await t('ไฟล์ปลอม -> 400 FILE_TYPE ไม่เก็บ (.txt เป็น .pdf · .exe เป็น .png · ข้อความ+Content-Type pdf · notes.txt · ว่างเปล่า)', async () => {
    for (const [buf, name, sent] of [[F.text, 'fake-text.pdf', 'application/octet-stream'], [F.text, 'fake-text.jpg', 'image/jpeg'], [F.exe, 'exe-as.png', 'image/png'], [F.text, 'notes.txt', 'text/plain'],
      [F.text, 'fake-text.pdf', 'application/pdf'], [Buffer.alloc(0), 'empty.pdf', 'application/pdf'], [Buffer.from('%PD'), 'short.pdf', 'application/pdf']]) {
      err(await up(d1, s.sc, 'id-card', buf, name, sent), 400, 'FILE_TYPE', M.type);
    }
    assert.strictEqual(fileCount(d1), 0);
  });
  await t('ชื่อไฟล์ไทยเก็บถูกต้อง · docKey ผิด/ไม่ส่งไฟล์ -> 400', async () => {
    const r = await up(d1, s.sc, 'id-card', F.ok, 'บัตรประชาชน.pdf', 'application/pdf');
    assert.strictEqual(r.body.name, 'บัตรประชาชน.pdf');
    assert.strictEqual((await up(d1, s.sc, 'passport', F.ok, 'a.pdf', 'application/pdf')).body.code, 'INVALID_DOC_KEY');
    assert.strictEqual((await up(d1, s.sc, undefined, F.ok, 'a.pdf', 'application/pdf')).body.code, 'INVALID_DOC_KEY');
    assert.strictEqual((await up(d1, s.sc, 'extra', null)).body.code, 'FILE_REQUIRED');
    assert.strictEqual(fileCount(d1), 1);
  });
  await t('สิทธิ์ไฟล์: ไม่ล็อกอิน 401 · officer 403 · ร่างของคนอื่น/ไม่มี 404 · ลบไฟล์ของร่างอื่น 404', async () => {
    assert.strictEqual((await up(d1, undefined, 'id-card', F.ok, 'a.pdf')).status, 401);
    assert.strictEqual((await up(d1, s.off, 'id-card', F.ok, 'a.pdf')).status, 403);
    err(await up(d1, s.sy, 'id-card', F.ok, 'a.pdf', 'application/pdf'), 404, 'NOT_FOUND', M.nf);
    err(await up('DR-9999', s.sc, 'id-card', F.ok, 'a.pdf', 'application/pdf'), 404, 'NOT_FOUND', M.nf);
    const fid = db.prepare('SELECT file_id FROM files WHERE draft_id=?').get(d1).file_id;
    err(await api('DELETE', `/api/drafts/${d1}/files/${fid}`, s.sy), 404, 'NOT_FOUND', M.nf);
    err(await api('DELETE', `/api/drafts/DR-0002/files/${fid}`, s.sc), 404, 'NOT_FOUND', M.nf); // ไฟล์ไม่ใช่ของร่างนี้
    assert.strictEqual(fileCount(d1), 1);
  });

  console.log('BR-08 เอกสารบังคับ / missingDocs (TC-SUBMIT-02)');
  s = fresh();
  await t('requiredDocs ตามลำดับ 4.3', () => {
    assert.deepStrictEqual(requiredDocs('SV-01').map((d) => d.docKey), ['id-card']);
    assert.deepStrictEqual(requiredDocs('SV-02').map((d) => d.docKey), ['id-card', 'map']);
    assert.deepStrictEqual(requiredDocs('SV-03').map((d) => [d.docKey, d.name, d.pdfOnly]), [['id-card', 'บัตรประชาชน', false], ['plan', 'แบบแปลน', true], ['deed', 'โฉนด', false]]);
  });
  await t('SV-02: id-card อย่างเดียว ขาด แผนที่ตั้ง · +map ครบ · ลบ map ขาดอีก (ภาพสถานที่ไม่บังคับ)', async () => {
    const id = await mk({ serviceId: 'SV-02' });
    assert.deepStrictEqual(missingDocs(id), ['บัตรประชาชน', 'แผนที่ตั้ง']);
    await up(id, s.sc, 'id-card', F.ok, 'id-card.pdf', 'application/pdf');
    assert.deepStrictEqual(missingDocs(id), ['แผนที่ตั้ง']);
    const m = await up(id, s.sc, 'map', F.ok, 'map.pdf', 'application/pdf');
    assert.deepStrictEqual(missingDocs(id), []);
    assert.deepStrictEqual((await api('GET', `/api/drafts/${id}`, s.sc)).body.missing, []);
    await api('DELETE', `/api/drafts/${id}/files/${m.body.fileId}`, s.sc);
    assert.deepStrictEqual(missingDocs(id), ['แผนที่ตั้ง']);
  });
  await t('SV-03: ขาด แบบแปลน, โฉนด -> + deed ขาด แบบแปลน · plan เป็น JPG -> 400 PLAN_NOT_PDF ไม่เก็บ · plan PDF ครบ', async () => {
    const id = await mk({ serviceId: 'SV-03', areaSqm: 100 });
    await up(id, s.sc, 'id-card', F.ok, 'id-card.pdf', 'application/pdf');
    assert.deepStrictEqual(missingDocs(id), ['แบบแปลน', 'โฉนด']);
    await up(id, s.sc, 'deed', F.ok, 'deed.pdf', 'application/pdf');
    assert.deepStrictEqual(missingDocs(id), ['แบบแปลน']);
    const n = fileCount(id);
    err(await up(id, s.sc, 'plan', F.jpg, 'plan-as-jpg.jpg', 'image/jpeg'), 400, 'PLAN_NOT_PDF', M.plan);
    err(await up(id, s.sc, 'plan', F.png, 'plan.png', 'image/png'), 400, 'PLAN_NOT_PDF', M.plan);
    assert.strictEqual(fileCount(id), n); assert.deepStrictEqual(missingDocs(id), ['แบบแปลน']);
    assert.strictEqual((await up(id, s.sc, 'plan', F.ok, 'plan.pdf', 'application/pdf')).status, 201);
    assert.deepStrictEqual(missingDocs(id), []);
    assert.strictEqual((await up(id, s.sc, 'extra', F.jpg, 'photo.jpg', 'image/jpeg')).status, 201); // JPG ช่องอื่นผ่าน
  });
  await t('missingDocs ร่างไม่มี -> null · ไฟล์ plan ที่ไม่ใช่ PDF ในฐาน (ข้อมูลเก่า) ไม่นับว่ามี', () => {
    assert.strictEqual(missingDocs('DR-9999'), null);
    const id = db.prepare("SELECT draft_id FROM drafts WHERE service_id='SV-03'").get().draft_id;
    db.prepare("UPDATE files SET mime='image/jpeg' WHERE draft_id=? AND doc_key='plan'").run(id);
    assert.deepStrictEqual(missingDocs(id), ['แบบแปลน']);
  });

  console.log('ลบร่าง (TC-SUBMIT-03 ส่วน E)');
  s = fresh();
  await t('DR-0001 (DRAFT) -> 204 แล้ว GET 404 · เหลือ 1 ร่าง', async () => {
    assert.strictEqual((await api('DELETE', '/api/drafts/DR-0001', s.sc)).status, 204);
    err(await api('GET', '/api/drafts/DR-0001', s.sc), 404, 'NOT_FOUND', M.nf);
    assert.deepStrictEqual((await api('GET', '/api/drafts', s.sc)).body.items.map((x) => x.draftId), ['DR-0002']);
  });
  await t('ของคนอื่น/ไม่มี -> 404 และไม่ถูกลบ', async () => {
    err(await api('DELETE', '/api/drafts/DR-0002', s.sy), 404, 'NOT_FOUND', M.nf);
    err(await api('DELETE', '/api/drafts/DR-9999', s.sc), 404, 'NOT_FOUND', M.nf);
    assert.ok(db.prepare("SELECT 1 FROM drafts WHERE draft_id='DR-0002'").get()); assert.ok(db.prepare("SELECT 1 FROM payments WHERE ref='PP-0001'").get());
  });
  await t('DR-0002 (PENDING_PAYMENT ยังไม่ชำระ) -> 204 · payments PP-0001 + files หายไปด้วย · ไม่เกิดคำขอใหม่', async () => {
    const cases0 = db.prepare('SELECT COUNT(*) n FROM cases').get().n;
    assert.strictEqual((await api('DELETE', '/api/drafts/DR-0002', s.sc)).status, 204);
    assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM payments WHERE ref='PP-0001' OR draft_id='DR-0002'").get().n, 0);
    assert.strictEqual(fileCount('DR-0002'), 0);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM cases').get().n, cases0);
    assert.strictEqual(db.prepare('SELECT next FROM counters WHERE kind=? AND year=0').get('DR').next, 3); // ตัวนับ DR ไม่ถอยหลัง
  });
  s = fresh();
  await t('ชำระแล้ว -> 409 INVALID_STATE ไม่ถูกลบ (สถานะ SUBMITTED และกรณี payments PAID)', async () => {
    const id = await mk({ serviceId: 'SV-01', qty: 1 });
    db.prepare("UPDATE drafts SET status='SUBMITTED', case_no='EG-2569-000031' WHERE draft_id=?").run(id);
    err(await api('DELETE', `/api/drafts/${id}`, s.sc), 409, 'INVALID_STATE', 'สถานะคำขอไม่ถูกต้องสำหรับรายการนี้');
    assert.ok(db.prepare('SELECT 1 FROM drafts WHERE draft_id=?').get(id));
    err(await up(id, s.sc, 'id-card', F.ok, 'a.pdf', 'application/pdf'), 409, 'INVALID_STATE', 'สถานะคำขอไม่ถูกต้องสำหรับรายการนี้');
    const id2 = await mk({ serviceId: 'SV-01', qty: 1 });
    db.prepare("INSERT INTO payments (ref,draft_id,amount,status,qr_created_at,qr_expires_at,paid_at,created_at) VALUES ('PP-0009',?,20,'PAID','x','x','x','x')").run(id2);
    err(await api('DELETE', `/api/drafts/${id2}`, s.sc), 409, 'INVALID_STATE', 'สถานะคำขอไม่ถูกต้องสำหรับรายการนี้');
    assert.ok(db.prepare("SELECT 1 FROM payments WHERE ref='PP-0009'").get());
  });

  main.server.close();
  console.log(`\n${pass} ผ่าน · ${failed.length} ล้ม`);
  if (failed.length) { console.log('ล้ม:\n - ' + failed.join('\n - ')); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(2); });
