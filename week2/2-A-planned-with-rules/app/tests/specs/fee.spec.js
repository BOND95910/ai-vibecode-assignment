// หมวด FEE · TC-FEE-01 (จับ B01)
const { test, expect } = require('../helpers/world');
const { eq, err, status, tid, text, count, hidden } = require('../helpers/check');
const { post } = require('../helpers/http');
const { baht, DASH } = require('../helpers/thai');

test('TC-FEE-01 ค่าธรรมเนียม SV-01/SV-02/SV-03', async ({ w }) => {
  await w.reset();
  const { page, api } = await w.session('somchai');
  const E_AREA = 'กรุณาระบุพื้นที่ 1–500 ตร.ม.';
  const E_BIG = 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน';
  const E_QTY = 'จำนวนฉบับต้อง 1–5 ฉบับ';

  // ผลคาดหวังคิดจากสูตร: ≤100 ตร.ม. = 1,000 · 101–500 = 1,000 + 10 × (พื้นที่ − 100)
  const sv03Fee = (a) => (a <= 100 ? 1000 : 1000 + 10 * (a - 100));
  const validAreas = [1, 100, 101, 102, 250, 300, 499, 500];
  const invalidAreas = [[0, 'INVALID_AREA', E_AREA], [-1, 'INVALID_AREA', E_AREA], [501, 'AREA_TOO_LARGE', E_BIG]];

  // ---- API ----
  for (const a of validAreas) {
    const r = await post(api, '/api/drafts', { serviceId: 'SV-03', areaSqm: a });
    status(r, 201, `API SV-03 พื้นที่ ${a}`);
    eq(r.body.fee, sv03Fee(a), `API SV-03 พื้นที่ ${a} fee`);
  }
  for (const [a, code, msg] of invalidAreas) {
    const r = await post(api, '/api/drafts', { serviceId: 'SV-03', areaSqm: a });
    err(r, 400, code, msg, `API SV-03 พื้นที่ ${a}`);
  }
  for (const q of [1, 2, 3, 4, 5]) {
    const r = await post(api, '/api/drafts', { serviceId: 'SV-01', qty: q });
    status(r, 201, `API SV-01 qty ${q}`);
    eq(r.body.fee, 20 * q, `API SV-01 qty ${q} fee`);
  }
  for (const q of [0, 6]) {
    const r = await post(api, '/api/drafts', { serviceId: 'SV-01', qty: q });
    err(r, 400, 'INVALID_QTY', E_QTY, `API SV-01 qty ${q}`);
  }
  const r2 = await post(api, '/api/drafts', { serviceId: 'SV-02' });
  status(r2, 201, 'API SV-02');
  eq(r2.body.fee, 500, 'API SV-02 fee');

  // ---- หน้าจอ SV-03 ----
  await page.goto('/citizen/new/SV-03');
  for (const [a, , msg] of invalidAreas) {
    await tid(page, 'area-input').fill(String(a));
    await text(page, 'fee-total', DASH, `SV-03 พื้นที่ ${a} fee-total`);
    await text(page, 'fee-error', msg, `SV-03 พื้นที่ ${a} fee-error`);
    await expect(tid(page, 'to-upload-btn'), `SV-03 พื้นที่ ${a} to-upload-btn ต้อง disabled`).toBeDisabled();
  }
  for (const a of validAreas) {
    await tid(page, 'area-input').fill(String(a));
    await text(page, 'fee-total', baht(sv03Fee(a)), `SV-03 พื้นที่ ${a} fee-total (สูตร ${sv03Fee(a)})`);
    await hidden(tid(page, 'fee-error'), `SV-03 พื้นที่ ${a} ต้องไม่มี fee-error`);
    await expect(tid(page, 'to-upload-btn'), `SV-03 พื้นที่ ${a} to-upload-btn ต้องใช้ได้`).toBeEnabled();
  }

  // ---- หน้าจอ SV-01 ----
  await page.goto('/citizen/new/SV-01');
  for (const q of [0, 6]) {
    await tid(page, 'qty-input').fill(String(q));
    await text(page, 'fee-error', E_QTY, `SV-01 qty ${q} fee-error`);
    await expect(tid(page, 'to-upload-btn'), `SV-01 qty ${q} to-upload-btn ต้อง disabled`).toBeDisabled();
  }
  for (const q of [1, 2, 3, 4, 5]) {
    await tid(page, 'qty-input').fill(String(q));
    await text(page, 'fee-total', baht(20 * q), `SV-01 qty ${q} fee-total`);
    await hidden(tid(page, 'fee-error'), `SV-01 qty ${q} ต้องไม่มี fee-error`);
  }

  // ---- หน้าจอ SV-02 (ไม่มีช่องกรอก) ----
  await page.goto('/citizen/new/SV-02');
  await text(page, 'fee-total', '฿500', 'SV-02 fee-total');
  await count(tid(page, 'qty-input'), 0, 'SV-02 ไม่มี qty-input');
  await count(tid(page, 'area-input'), 0, 'SV-02 ไม่มี area-input');
});
