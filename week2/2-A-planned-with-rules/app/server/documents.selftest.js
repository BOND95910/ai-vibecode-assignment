// รัน: node server/documents.selftest.js · DB ในหน่วยความจำ · ตัวเลขมาจาก BR-23 / TC-DOC-01..03 / TEST-DATA ข้อ 5
// ล้ม = แสดงแถวที่ล้มแล้ว exit 1
process.env.DB_PATH = ':memory:';
const http = require('http');
const express = require('express');
const { db, initSchema, resetAll } = require('./db');
const clock = require('./clock');
const { sessions, hashId } = require('./util');
const documents = require('./documents');

initSchema();
resetAll(); // seed (B02) ใส่ผู้ใช้ + เอกสาร DOC-2569-000001 รหัส K7M2Q9XA ที่เซ็นด้วย SIGN_KEY

const fails = [];
let total = 0;
function eq(name, actual, expected) {
  total += 1;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { fails.push(name); console.log(`FAIL ${name}\n     expected ${e}\n     received ${a}`); }
}
const ok = (name, cond) => eq(name, !!cond, true);

const user = (like) => db.prepare('SELECT * FROM users WHERE display_name LIKE ?').get(like + '%');
const mong = user('สมหญิง'), chai = user('สมชาย');
let n = 0;
const mkCase = (service, owner = mong, extra = {}) => {
  const row = { case_no: `EG-9999-${String(++n).padStart(6, '0')}`, user_id: owner.id, service_id: service, ...extra };
  db.prepare(`INSERT INTO cases (case_no,user_id,service_id,status,fee,paid_at,due_at,created_at,updated_at)
              VALUES (?,?,?,?,0,'x','x','x','x')`).run(row.case_no, row.user_id, row.service_id, 'APPROVED');
  return row;
};
const at = (iso) => clock.set(iso);

// ---- seed ใช้คีย์เดียวกับ B07 ----
eq('seed K7M2Q9XA VALID', documents.verify('K7M2Q9XA'), {
  result: 'VALID', docNo: 'DOC-2569-000001', applicantMasked: 'สมชาย ใ***', serviceId: 'SV-01',
  issuedAt: '2026-11-05T10:00:00+07:00', validUntil: '2027-02-02', signer: 'เจ้าหน้าที่ทะเบียน 1',
});
at('2027-02-02T23:59:59+07:00'); eq('seed วันสุดท้าย 2 ก.พ. 70 ยังใช้ได้', documents.verify('K7M2Q9XA').result, 'VALID');
at('2027-02-03T00:00:00+07:00'); eq('seed 3 ก.พ. 70 00:00 หมดอายุ', documents.verify('K7M2Q9XA').result, 'EXPIRED');
clock.reset();

// ---- ออกเอกสาร + อายุ SV-01 (ออก 1 ธ.ค. 69) ----
const c1 = mkCase('SV-01', mong, { approver: 'off.reg2' });
const d1 = documents.issue(c1, 'เจ้าหน้าที่ทะเบียน 2', 'off.reg2');
eq('เลขเอกสารแรกหลัง seed', d1.docNo, 'DOC-2569-000002');
ok('รหัสตรวจ 8 ตัว', /^[A-Z0-9]{8}$/.test(d1.verifyCode));
eq('วันออก = clock', d1.issuedAt, '2026-12-01T09:00:00+07:00');
eq('SV-01 ออก 1 ธ.ค. 69 -> 28 ก.พ. 70', d1.validUntil, '2027-02-28');
eq('verify ฟิลด์', documents.verify(d1.verifyCode), {
  result: 'VALID', docNo: 'DOC-2569-000002', applicantMasked: 'สมหญิง ร***', serviceId: 'SV-01',
  issuedAt: '2026-12-01T09:00:00+07:00', validUntil: '2027-02-28', signer: 'เจ้าหน้าที่ทะเบียน 2',
});
at('2027-02-28T23:59:59+07:00'); eq('SV-01 28 ก.พ. 70 23:59:59', documents.verify(d1.verifyCode).result, 'VALID');
at('2027-03-01T00:00:00+07:00'); eq('SV-01 1 มี.ค. 70 00:00', documents.verify(d1.verifyCode).result, 'EXPIRED');
ok('EXPIRED ยังมี validUntil เดิม', documents.verify(d1.verifyCode).validUntil === '2027-02-28');
clock.reset();

// signer จาก cases.approver เมื่อไม่ส่งชื่อ
const cs = mkCase('SV-01', mong, { approver: 'head1' });
eq('signer ดึงจาก approver', documents.issue(cs).signer, db.prepare("SELECT display_name d FROM users WHERE username='head1'").get().d);

// ---- SV-02/03 (ออก 1 ธ.ค. 69) ----
const d2 = documents.issue(mkCase('SV-02'), 'หัวหน้าฝ่าย');
eq('SV-02 -> 30 พ.ย. 70', d2.validUntil, '2027-11-30');
eq('SV-03 -> 30 พ.ย. 70', documents.issue(mkCase('SV-03'), 'หัวหน้าฝ่าย').validUntil, '2027-11-30');
at('2027-11-30T23:59:59+07:00'); eq('SV-02 30 พ.ย. 70 23:59:59', documents.verify(d2.verifyCode).result, 'VALID');
at('2027-12-01T00:00:00+07:00'); eq('SV-02 1 ธ.ค. 70 00:00', documents.verify(d2.verifyCode).result, 'EXPIRED');

// ---- ออก 29 ก.พ. 2571 (ค.ศ. 2028) ----
at('2028-02-29T09:00:00+07:00');
const d3 = documents.issue(mkCase('SV-02'), 'หัวหน้าฝ่าย');
eq('SV-02 ออก 29 ก.พ. 71 -> 27 ก.พ. 72', d3.validUntil, '2029-02-27');
eq('SV-01 ออก 29 ก.พ. 71 -> 28 พ.ค. 71', documents.issue(mkCase('SV-01'), 'x').validUntil, '2028-05-28');
eq('เลขรันรีเซ็ตตามปี พ.ศ. 2571', d3.docNo, 'DOC-2571-000001');
// ขอบปี: ออก 31 ธ.ค. -> ปีถัดไป -1 วัน = 30 ธ.ค. · ออก 1 ม.ค. 2027 (SV-02) -> 31 ธ.ค. 2027
ok('computeValidUntil 1 ม.ค. -> 31 ธ.ค.', documents.computeValidUntil('SV-02', '2027-01-01T00:00:00+07:00') === '2027-12-31');
ok('computeValidUntil ใช้วันที่ไทย (ISO UTC ก่อนเที่ยงคืนไทย)', documents.computeValidUntil('SV-01', '2026-11-30T20:00:00Z') === '2027-02-28'); // = 1 ธ.ค. ตามเวลาไทย
clock.reset();

// ---- tamper / not found ----
const d4 = documents.issue(mkCase('SV-01'), 'x');
eq('tamper คืน true', documents.tamper(d4.docNo), true);
eq('tamper แล้ว TAMPERED (มีเฉพาะ result)', documents.verify(d4.verifyCode), { result: 'TAMPERED' });
eq('tamper ไม่พบเอกสาร', documents.tamper('DOC-0000-000000'), false);
eq('NOT_FOUND (มีเฉพาะ result)', documents.verify('ZZZZZZZZ'), { result: 'NOT_FOUND' });

// ---- ปิดบังชื่อ ----
eq('mask สมชาย ใจดี', documents.maskName('สมชาย ใจดี'), 'สมชาย ใ***');
eq('mask ไม่มีนามสกุล', documents.maskName('สมชาย'), 'สมชาย ***');
eq('mask นามสกุลหลายคำ', documents.maskName('John van Dyke'), 'John v***');

// ---- เลขเอกสาร/รหัสไม่ซ้ำ + ออกซ้ำคำขอเดิมไม่ได้ ----
const docs = Array.from({ length: 40 }, () => documents.issue(mkCase('SV-01'), 'x'));
eq('docNo ไม่ซ้ำ', new Set(docs.map((d) => d.docNo)).size, 40);
eq('verifyCode ไม่ซ้ำ', new Set(docs.map((d) => d.verifyCode)).size, 40);
const nextDoc = () => db.prepare("SELECT next FROM counters WHERE kind='DOC' AND year=2569").get().next;
const before = nextDoc();
try { documents.issue(c1); ok('ออกซ้ำต้อง throw', false); } catch (e) { eq('ออกซ้ำ -> 409 INVALID_STATE', [e.status, e.code], [409, 'INVALID_STATE']); }
eq('ออกซ้ำแล้วตัวนับไม่กระโดด', nextDoc(), before);
eq('เลขต่อเนื่องไม่ข้าม (ตัวสุดท้าย = next-1)', docs[39].docNo, `DOC-2569-${String(before - 1).padStart(6, '0')}`);

// ---- PDF ----
const pdf = documents.pdfBuffer(d1);
const txt = pdf.toString('latin1');
ok('PDF ASCII ล้วน', /^[\x00-\x7F]*$/.test(txt));
ok('PDF เริ่ม %PDF- จบ %%EOF', txt.startsWith('%PDF-1.4') && txt.trimEnd().endsWith('%%EOF'));
ok('PDF มีบรรทัด ASCII ตรง regex (ใน content stream)', /\(docNo=DOC-2569-000002 caseNo=EG-9999-000001 verify=[A-Z0-9]{8} validUntil=2027-02-28\) Tj/.test(txt));
eq('PDF มี "docNo=" แค่ครั้งเดียว', txt.split('docNo=').length - 1, 1);
// โครงสร้าง: startxref ชี้ถูก · offset ของแต่ละ obj ชี้ถูก · Length ของ stream ตรง
const sx = Number(/startxref\n(\d+)/.exec(txt)[1]);
ok('startxref ชี้ที่ "xref"', txt.slice(sx, sx + 4) === 'xref');
const offs = [...txt.slice(sx).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
eq('จำนวน obj', offs.length, 6);
ok('offset แต่ละ obj ชี้ที่ "N 0 obj"', offs.every((o, i) => txt.slice(o).startsWith(`${i + 1} 0 obj`)));
const sm = /<<\/Length (\d+)>>\nstream\n([\s\S]*?)endstream/.exec(txt);
eq('Length ตรงเนื้อ stream', Number(sm[1]), sm[2].length);
// ข้อความไทยใน /Subject (UTF-16BE) ถอดกลับได้
const subj = Buffer.from(/\/Subject<FEFF([0-9A-F]+)>/.exec(txt)[1], 'hex').swap16().toString('utf16le');
ok('Subject มีชื่อผู้ยื่น/ผู้ลงนาม/รหัส', subj.includes('สมหญิง รักไทย') && subj.includes('เจ้าหน้าที่ทะเบียน 2') && subj.includes(d1.verifyCode));
eq('pdfBuffer รับ docNo ได้', documents.pdfBuffer('DOC-2569-000002').equals(pdf), true);

// ---- route ผ่าน express จริง ----
(async () => {
  const app = express();
  app.use((req, res, next) => { req.cookies = require('./util').parseCookies(req); next(); });
  require('./routes/verify')(app);
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = async (p, sid) => {
    const r = await fetch(base + p, { headers: sid ? { cookie: `sid=${sid}` } : {} });
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, type: r.headers.get('content-type'), disp: r.headers.get('content-disposition'), buf };
  };
  const json = (r) => JSON.parse(r.buf.toString('utf8'));
  // รูปแบบ session ตามที่ B04 ควรเก็บ (util.js): { username, role, idNo, ... } · ประชาชนใช้ userId ได้ด้วย
  sessions.set('s-mong', { role: 'citizen', userId: mong.id });
  sessions.set('s-chai', { role: 'citizen', userId: chai.id });
  sessions.set('s-off', { role: 'officer', username: 'off.reg1' });
  sessions.set('s-head', { role: 'head', username: 'head1' });
  sessions.set('s-exec', { role: 'executive', username: 'exec1' });

  let r = await get('/api/verify/K7M2Q9XA');
  eq('GET verify seed 200', [r.status, json(r).result, json(r).applicantMasked], [200, 'VALID', 'สมชาย ใ***']);
  r = await get('/api/verify/ZZZZZZZZ');
  eq('GET verify ไม่มี 404', [r.status, json(r)], [404, { result: 'NOT_FOUND' }]);
  r = await get(`/api/verify/${d4.verifyCode}`);
  eq('GET verify tamper 200 TAMPERED', [r.status, json(r)], [200, { result: 'TAMPERED' }]);
  at('2027-03-01T00:00:00+07:00');
  r = await get(`/api/verify/${d1.verifyCode}`);
  eq('GET verify หมดอายุ 200 EXPIRED', [r.status, json(r).result, json(r).validUntil], [200, 'EXPIRED', '2027-02-28']);
  clock.reset();

  const pdfUrl = '/api/documents/DOC-2569-000002/pdf';
  r = await get(pdfUrl);
  eq('PDF ไม่ล็อกอิน 401', [r.status, json(r).code], [401, 'UNAUTHENTICATED']);
  r = await get(pdfUrl, 's-mong');
  eq('PDF เจ้าของ 200 + header', [r.status, r.type, r.disp], [200, 'application/pdf', 'attachment; filename="DOC-2569-000002.pdf"']);
  ok('PDF เนื้อไฟล์มีบรรทัดตาม CONTRACT', r.buf.toString('latin1').includes(`docNo=DOC-2569-000002 caseNo=${c1.case_no} verify=${d1.verifyCode} validUntil=2027-02-28`));
  r = await get(pdfUrl, 's-chai');
  eq('PDF citizen คนอื่น 404', r.status, 404);
  eq('PDF officer 200', (await get(pdfUrl, 's-off')).status, 200);
  eq('PDF head 200', (await get(pdfUrl, 's-head')).status, 200);
  eq('PDF executive 403', (await get(pdfUrl, 's-exec')).status, 403);
  eq('PDF ไม่มีเอกสาร 404', (await get('/api/documents/DOC-2569-999999/pdf', 's-off')).status, 404);
  // citizen ที่ session เก็บเฉพาะ idNo (รูปแบบอีกแบบที่เป็นไปได้) ต้องหาเจ้าของเจอด้วย id_hash
  const idNoOf = require('./util').decrypt(mong.id_no_enc);
  ok('hashId ตรงกับ id_hash ใน seed', hashId(idNoOf) === mong.id_hash);
  sessions.set('s-mong2', { role: 'citizen', idNo: idNoOf });
  eq('PDF citizen ผ่าน idNo 200', (await get(pdfUrl, 's-mong2')).status, 200);

  srv.closeAllConnections(); srv.close();
  console.log(fails.length ? `\nFAILED ${fails.length}/${total}: ${fails.join(' | ')}` : `\nOK ${total}/${total}`);
  process.exitCode = fails.length ? 1 : 0; // ไม่ process.exit() ทันที: Windows + fetch keep-alive ทำ libuv assert
})().catch((e) => { console.error(e); process.exitCode = 1; });
