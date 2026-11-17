// หมวด DOC · TC-DOC-01 ถึง 03
const { test, expect } = require('../helpers/world');
const { eq, ok, status, err, tid, text, attr, count, hidden, match, contains, notContains } = require('../helpers/check');
const { get, post } = require('../helpers/http');
const { CASE } = require('../helpers/thai');
const { BASE_URL } = require('../helpers/env');
const { citizenCase } = require('../helpers/ui');

const RESULT = {
  VALID: 'เอกสารถูกต้อง',
  EXPIRED: 'เอกสารหมดอายุ',
  TAMPERED: 'ลายเซ็นไม่ถูกต้อง',
  NOT_FOUND: 'ไม่พบเอกสาร',
};

// approve + issue ผ่าน API: SV-01 โดยผู้ถือเรื่อง (off.reg2) → { docNo, verifyCode }
async function approveIssue(api, caseNo) {
  const a = await post(api, `/api/cases/${caseNo}/approve`);
  status(a, 200, `approve ${caseNo}`);
  return issue(api, caseNo);
}
async function issue(api, caseNo) {
  const i = await post(api, `/api/officer/cases/${caseNo}/issue`);
  status(i, 200, `issue ${caseNo}`);
  eq(i.body.status, 'COMPLETED', `issue ${caseNo} status`);
  return i.body;
}
async function verifyPage(page, code, result, label) {
  const res = await page.goto(`/verify/${code}`);
  eq(res.status(), result === 'NOT_FOUND' ? 404 : 200, `${label} HTTP ของหน้า /verify/${code}`);
  await text(page, 'verify-result', RESULT[result], `${label} verify-result`);
  await attr(tid(page, 'verify-result'), 'data-result', result, `${label} data-result`);
}

test('TC-DOC-01 ออกเอกสารและข้อมูลใน PDF', async ({ w }) => {
  await w.reset();
  const N = CASE(25);
  const reg2 = await w.api('off.reg2');
  const a = await post(reg2, `/api/cases/${N}/approve`);
  status(a, 200, 'approve …000025');
  const i = await post(reg2, `/api/officer/cases/${N}/issue`);
  status(i, 200, 'issue …000025');
  eq({ docNo: i.body.docNo, status: i.body.status }, { docNo: 'DOC-2569-000002', status: 'COMPLETED' }, 'issue body');
  match(i.body.verifyCode, /^[A-Z0-9]{8}$/, 'verifyCode');
  const code = i.body.verifyCode;

  // PDF ของผู้ยื่น
  const som = await w.session('somying');
  const pdf = await get(som.api, '/api/documents/DOC-2569-000002/pdf');
  status(pdf, 200, 'สมหญิง GET pdf');
  contains(pdf.headers['content-type'], 'application/pdf', 'Content-Type');
  contains(pdf.headers['content-disposition'], 'DOC-2569-000002.pdf', 'Content-Disposition');
  contains(pdf.buf.toString('latin1'), `docNo=DOC-2569-000002 caseNo=${N} verify=${code} validUntil=2027-02-28`, 'บรรทัด ASCII ใน PDF');

  // เนื้อหาเอกสารผ่านหน้า /verify (ไม่ล็อกอิน)
  const anon = await w.session('anon');
  await verifyPage(anon.page, code, 'VALID', 'DOC-01');
  await text(anon.page, 'verify-doc-no', 'DOC-2569-000002', 'verify-doc-no');
  await text(anon.page, 'verify-applicant', 'สมหญิง ร***', 'verify-applicant');
  await text(anon.page, 'verify-service', 'SV-01 ขอหนังสือรับรอง', 'verify-service');
  await attr(tid(anon.page, 'verify-issued'), 'data-iso', '2026-12-01T09:00:00+07:00', 'verify-issued');
  await attr(tid(anon.page, 'verify-expires'), 'data-iso', '2027-02-28', 'verify-expires (ออก + 89 วัน)');
  await text(anon.page, 'verify-signer', 'เจ้าหน้าที่ทะเบียน 2', 'verify-signer');

  // QR บนหน้าเคส
  await citizenCase(som.page, N);
  await attr(tid(som.page, 'doc-qr'), 'data-url', `${BASE_URL}/verify/${code}`, 'doc-qr data-url');

  // API verify
  const v = await get(await w.anon(), `/api/verify/${code}`);
  status(v, 200, 'GET /api/verify');
  eq({ result: v.body.result, validUntil: v.body.validUntil, issuedAt: v.body.issuedAt }, { result: 'VALID', validUntil: '2027-02-28', issuedAt: '2026-12-01T09:00:00+07:00' }, 'API verify');

  // สมชาย (ไม่ใช่ผู้ยื่น) → 404
  status(await get(await w.api('somchai'), '/api/documents/DOC-2569-000002/pdf'), 404, 'สมชาย GET pdf ของสมหญิง');

  // issue ซ้ำ → 409 ไม่เกิดเอกสารที่ 2
  err(await post(reg2, `/api/officer/cases/${N}/issue`), 409, 'INVALID_STATE', null, 'issue ซ้ำ');
  const next = await issue(await w.api('off.reg1'), CASE(19));
  eq(next.docNo, 'DOC-2569-000003', 'เอกสารถัดไปในระบบ');
});

test('TC-DOC-02 ตรวจเอกสาร /verify', async ({ w }) => {
  await w.reset();
  const { page } = await w.session('anon');
  const res = await page.goto('/verify/K7M2Q9XA');
  eq(res.status(), 200, 'HTTP ของ /verify/K7M2Q9XA');
  await expect(page, 'ต้องไม่ redirect ไป /login').toHaveURL(/\/verify\/K7M2Q9XA$/);
  await text(page, 'verify-result', 'เอกสารถูกต้อง', 'verify-result');
  await attr(tid(page, 'verify-result'), 'data-result', 'VALID', 'data-result');
  await text(page, 'verify-doc-no', 'DOC-2569-000001', 'verify-doc-no');
  await text(page, 'verify-applicant', 'สมชาย ใ***', 'verify-applicant');
  await text(page, 'verify-service', 'SV-01 ขอหนังสือรับรอง', 'verify-service');
  await attr(tid(page, 'verify-issued'), 'data-iso', '2026-11-05T10:00:00+07:00', 'verify-issued');
  await attr(tid(page, 'verify-expires'), 'data-iso', '2027-02-02', 'verify-expires');
  await text(page, 'verify-signer', 'เจ้าหน้าที่ทะเบียน 1', 'verify-signer');
  // PDPA: ข้อความทั้งหน้าไม่มีนามสกุลจริงและเลขบัตร
  const body = await page.locator('body').innerText();
  notContains(body, 'ใจดี', 'PDPA หน้า verify ต้องไม่มีนามสกุลเต็ม');
  notContains(body, '1101700123456', 'PDPA หน้า verify ต้องไม่มีเลขบัตร');

  await verifyPage(page, 'ZZZZZZZZ', 'NOT_FOUND', 'DOC-02');
  await count(tid(page, 'verify-applicant'), 0, 'NOT_FOUND ต้องไม่มี verify-applicant');
  await count(tid(page, 'verify-doc-no'), 0, 'NOT_FOUND ต้องไม่มี verify-doc-no');

  const anon = await w.anon();
  const ok1 = await get(anon, '/api/verify/K7M2Q9XA');
  status(ok1, 200, 'API verify K7M2Q9XA');
  eq({ result: ok1.body.result, applicantMasked: ok1.body.applicantMasked }, { result: 'VALID', applicantMasked: 'สมชาย ใ***' }, 'API verify K7M2Q9XA body');
  const nf = await get(anon, '/api/verify/ZZZZZZZZ');
  status(nf, 404, 'API verify ZZZZZZZZ');
  eq(nf.body, { result: 'NOT_FOUND' }, 'API verify ZZZZZZZZ body');
});

test('TC-DOC-03 เอกสารหมดอายุและลายเซ็นไม่ตรง', async ({ w }) => {
  // ---- ส่วน A SV-01 ออก 1 ธ.ค. 69 · 90 วัน ----
  await w.reset();
  let anon = (await w.session('anon')).page;
  const c1 = (await approveIssue(await w.api('off.reg2'), CASE(25))).verifyCode;
  await w.clock('2027-02-28T23:59:00+07:00');
  await verifyPage(anon, c1, 'VALID', 'A 28 ก.พ. 23:59');
  await attr(tid(anon, 'verify-expires'), 'data-iso', '2027-02-28', 'A verify-expires (วันสุดท้ายที่ใช้ได้)');
  await w.clock('2027-03-01T00:00:00+07:00');
  await verifyPage(anon, c1, 'EXPIRED', 'A 1 มี.ค. 00:00');
  await attr(tid(anon, 'verify-expires'), 'data-iso', '2027-02-28', 'A หมดอายุแล้วยังแสดง verify-expires เดิม');

  // ---- ส่วน B SV-02 ออก 1 ธ.ค. 69 · 1 ปี ----
  await w.reset();
  anon = (await w.session('anon')).page;
  const c2 = (await issue(await w.api('off.reg1'), CASE(19))).verifyCode;
  await w.clock('2027-11-30T23:59:00+07:00');
  await verifyPage(anon, c2, 'VALID', 'B 30 พ.ย. 70 23:59');
  await attr(tid(anon, 'verify-expires'), 'data-iso', '2027-11-30', 'B verify-expires');
  await w.clock('2027-12-01T00:00:00+07:00');
  await verifyPage(anon, c2, 'EXPIRED', 'B 1 ธ.ค. 70 00:00');

  // ---- ส่วน C seed K7M2Q9XA ----
  await w.reset();
  anon = (await w.session('anon')).page;
  await w.clock('2027-02-02T23:59:00+07:00');
  await verifyPage(anon, 'K7M2Q9XA', 'VALID', 'C 2 ก.พ. 70 23:59');
  await w.clock('2027-02-03T00:00:00+07:00');
  await verifyPage(anon, 'K7M2Q9XA', 'EXPIRED', 'C 3 ก.พ. 70 00:00');

  // ---- ส่วน E ออกเอกสารวันที่ 29 ก.พ. 2571 ----
  await w.reset();
  anon = (await w.session('anon')).page;
  await w.clock('2028-02-29T10:00:00+07:00');
  const e1 = await approveIssue(await w.api('off.reg2'), CASE(25));
  const e2 = await issue(await w.api('off.reg1'), CASE(19));
  eq(e1.docNo, 'DOC-2571-000001', 'E เลขเอกสาร SV-01 (ปีใหม่เริ่ม 000001)');
  eq(e2.docNo, 'DOC-2571-000002', 'E เลขเอกสาร SV-02');
  await verifyPage(anon, e1.verifyCode, 'VALID', 'E SV-01 ที่ 29 ก.พ.');
  await attr(tid(anon, 'verify-expires'), 'data-iso', '2028-05-28', 'E SV-01 verify-expires (ออก + 89 วัน)');
  await verifyPage(anon, e2.verifyCode, 'VALID', 'E SV-02 ที่ 29 ก.พ.');
  await attr(tid(anon, 'verify-expires'), 'data-iso', '2029-02-27', 'E SV-02 verify-expires (ครบรอบ 28 ก.พ. 2572 − 1 วัน)');
  await w.clock('2028-05-28T23:59:00+07:00');
  await verifyPage(anon, e1.verifyCode, 'VALID', 'E SV-01 28 พ.ค. 23:59');
  await w.clock('2028-05-29T00:00:00+07:00');
  await verifyPage(anon, e1.verifyCode, 'EXPIRED', 'E SV-01 29 พ.ค. 00:00');
  await w.clock('2029-02-27T23:59:00+07:00');
  await verifyPage(anon, e2.verifyCode, 'VALID', 'E SV-02 27 ก.พ. 72 23:59');
  await w.clock('2029-02-28T00:00:00+07:00');
  await verifyPage(anon, e2.verifyCode, 'EXPIRED', 'E SV-02 28 ก.พ. 72 00:00');

  // ---- ส่วน D ลายเซ็นไม่ตรง ----
  await w.reset();
  anon = (await w.session('anon')).page;
  const t = await w.tamper('DOC-2569-000001');
  status(t, 200, 'D tamper');
  eq(t.body, { ok: true }, 'D tamper body');
  await verifyPage(anon, 'K7M2Q9XA', 'TAMPERED', 'D');
  await count(tid(anon, 'verify-doc-no'), 0, 'D TAMPERED ต้องไม่มี verify-doc-no');
  await count(tid(anon, 'verify-applicant'), 0, 'D TAMPERED ต้องไม่มี verify-applicant');
  await w.clock('2027-03-01T00:00:00+07:00');
  await verifyPage(anon, 'K7M2Q9XA', 'TAMPERED', 'D หมดอายุด้วย ลำดับตรวจ A-43 ต้องยัง TAMPERED');
});
