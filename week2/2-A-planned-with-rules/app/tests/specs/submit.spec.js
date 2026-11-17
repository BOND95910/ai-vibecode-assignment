// หมวด SUBMIT · TC-SUBMIT-01 ถึง 03
const { test, expect } = require('../helpers/world');
const { eq, ok, status, err, tid, text, attr, count, hidden, contains, notContains } = require('../helpers/check');
const { get, post, del } = require('../helpers/http');
const { CASE } = require('../helpers/thai');
const { queueRow, queueReady, rowAttr, attach, caseReady } = require('../helpers/ui');
const { testFile } = require('../helpers/files');

test('TC-SUBMIT-01 ยื่นคำขอ SV-01 ครบวงจร', async ({ w }) => {
  await w.reset();
  const { page } = await w.session('somchai');

  // 1 เริ่มบริการ
  await page.goto('/citizen');
  await tid(page, 'start-service-SV-01').click();
  await text(page, 'wizard-step', '1/3 กรอกข้อมูล', 'ขั้น 1 wizard-step');
  await tid(page, 'qty-input').fill('2');
  await text(page, 'fee-total', '฿40', 'ขั้น 1 fee-total (2 ฉบับ × ฿20)');
  await tid(page, 'to-upload-btn').click();

  // 2 แนบเอกสาร
  await text(page, 'wizard-step', '2/3 แนบเอกสาร', 'ขั้น 2 wizard-step');
  await expect(tid(page, 'to-payment-btn'), 'ยังไม่แนบไฟล์ to-payment-btn ต้อง disabled').toBeDisabled();
  await attach(page, 'upload-input-id-card', 'id-card.pdf');
  await count(tid(page, 'file-item'), 1, 'หลังแนบ id-card.pdf');
  await attr(tid(page, 'file-item'), 'data-doc-key', 'id-card', 'file-item data-doc-key');
  await expect(tid(page, 'to-payment-btn'), 'แนบบัตรประชาชนแล้ว to-payment-btn ต้องใช้ได้').toBeEnabled();
  await tid(page, 'to-payment-btn').click();

  // 3 ชำระเงิน
  await text(page, 'wizard-step', '3/3 ชำระเงิน', 'ขั้น 3 wizard-step');
  await text(page, 'payment-amount', '฿40', 'payment-amount');
  await tid(page, 'create-qr-btn').click();
  await text(page, 'qr-ref', 'PP-0002', 'qr-ref');
  await attr(tid(page, 'qr-expires'), 'data-iso', '2026-12-01T09:15:00+07:00', 'qr-expires');
  await text(page, 'payment-status', 'รอชำระ', 'payment-status ก่อนจ่าย');

  // 4 ธนาคารจำลองยิง callback
  const p = await w.pay('PP-0002', 40);
  status(p, 200, 'pay PP-0002');
  eq(p.body, { status: 'PAID', caseNo: 'EG-2569-000031', receiptNo: 'RC-2569-000031', duplicate: false }, 'pay PP-0002 body');
  await tid(page, 'refresh-payment-btn').click();
  await text(page, 'payment-status', 'ชำระแล้ว', 'payment-status หลังจ่าย');
  await text(page, 'submitted-case-no', 'EG-2569-000031', 'submitted-case-no');
  await text(page, 'receipt-no', 'RC-2569-000031', 'receipt-no');
  await text(page, 'receipt-amount', '฿40', 'receipt-amount');
  await attr(tid(page, 'receipt-paid-at'), 'data-iso', '2026-12-01T09:00:00+07:00', 'receipt-paid-at');

  // 5 หน้าคำขอ
  await tid(page, 'go-case-btn').click();
  await expect(page).toHaveURL(/\/citizen\/cases\/EG-2569-000031$/);
  await caseReady(page, 'EG-2569-000031');
  await text(page, 'case-status', 'ส่งคำขอแล้ว', 'case-status');
  await attr(tid(page, 'case-status'), 'data-status', 'SUBMITTED', 'case-status data-status');
  await text(page, 'case-fee', '฿40', 'case-fee');
  await text(page, 'sla-due', '4 ธ.ค. 2569 16:30', 'sla-due');
  await attr(tid(page, 'sla-due'), 'data-iso', '2026-12-04T16:30:00+07:00', 'sla-due data-iso (D0 อ.1 + 3 วันทำการ)');
  await text(page, 'sla-level', 'ปกติ', 'sla-level');
  await count(tid(page, 'cancel-case-btn'), 1, 'cancel-case-btn');
  await count(tid(page, 'case-step'), 0, 'case-step ต้องไม่มี (ไม่ใช่ SV-03)');

  // คิวเจ้าหน้าที่
  const off = await w.session('off.reg1');
  await off.page.goto('/officer/queue');
  await queueReady(off.page);
  const row = queueRow(off.page, 'EG-2569-000031');
  await count(row, 1, 'แถว EG-2569-000031 ในคิว');
  await count(row.getByTestId('claim-btn'), 1, 'claim-btn ของ EG-2569-000031');
  eq(((await row.getByTestId('row-owner').textContent()) || '').trim(), '', 'row-owner ต้องว่าง');
  const nos = await rowAttr(off.page, 'queue-row', 'data-case-no');
  const i31 = nos.indexOf('EG-2569-000031');
  eq(nos[i31 - 1], 'EG-2569-000030', 'แถวก่อนหน้า EG-2569-000031 (ท้ายกลุ่มกำหนด 4 ธ.ค.)');
});

test('TC-SUBMIT-02 เอกสารบังคับครบก่อนชำระ', async ({ w }) => {
  await w.reset();
  const { page, api } = await w.session('somchai');
  const MISS = (s) => `ยังขาดเอกสาร: ${s}`;
  const removeBtn = (key) => page.locator(`[data-testid="file-item"][data-doc-key="${key}"]`).getByTestId('file-remove-btn');

  // ---- SV-02 ----
  await page.goto('/citizen/new/SV-02');
  await tid(page, 'to-upload-btn').click();
  await text(page, 'wizard-step', '2/3 แนบเอกสาร', 'SV-02 ขั้น 2');
  await attach(page, 'upload-input-id-card', 'id-card.pdf');
  await count(tid(page, 'file-item'), 1, 'SV-02 หลังแนบ id-card');
  await expect(tid(page, 'to-payment-btn'), 'SV-02 id-card อย่างเดียว to-payment-btn ต้อง disabled').toBeDisabled();
  await text(page, 'missing-docs', MISS('แผนที่ตั้ง'), 'SV-02 id-card อย่างเดียว');

  await attach(page, 'upload-input-map', 'map.pdf');
  await expect(tid(page, 'to-payment-btn'), 'SV-02 + map.pdf to-payment-btn ต้องใช้ได้ (ภาพสถานที่ไม่บังคับ)').toBeEnabled();
  await count(tid(page, 'missing-docs'), 0, 'SV-02 + map.pdf ต้องไม่แสดง missing-docs');

  await removeBtn('map').click();
  await expect(tid(page, 'to-payment-btn'), 'SV-02 ลบ map.pdf to-payment-btn ต้อง disabled อีกครั้ง').toBeDisabled();
  await text(page, 'missing-docs', MISS('แผนที่ตั้ง'), 'SV-02 ลบ map.pdf');

  // ---- SV-03 พื้นที่ 100 ----
  await page.goto('/citizen/new/SV-03');
  await tid(page, 'area-input').fill('100');
  await tid(page, 'to-upload-btn').click();
  await text(page, 'wizard-step', '2/3 แนบเอกสาร', 'SV-03 ขั้น 2');
  await attach(page, 'upload-input-id-card', 'id-card.pdf');
  await expect(tid(page, 'to-payment-btn')).toBeDisabled();
  await text(page, 'missing-docs', MISS('แบบแปลน, โฉนด'), 'SV-03 id-card อย่างเดียว');

  await attach(page, 'upload-input-deed', 'deed.pdf');
  await expect(tid(page, 'to-payment-btn'), 'SV-03 + deed.pdf ต้องยัง disabled').toBeDisabled();
  await text(page, 'missing-docs', MISS('แบบแปลน'), 'SV-03 + deed.pdf');
  await count(tid(page, 'file-item'), 2, 'SV-03 ก่อนลองแนบแบบแปลนเป็น jpg');

  await attach(page, 'upload-input-plan', 'plan-as-jpg.jpg');
  await text(page, 'upload-error', 'แบบแปลนต้องเป็นไฟล์ PDF เท่านั้น', 'SV-03 plan-as-jpg.jpg upload-error');
  await count(tid(page, 'file-item'), 2, 'SV-03 ไฟล์แบบแปลนที่ถูกปฏิเสธต้องไม่เพิ่ม file-item');
  await expect(tid(page, 'to-payment-btn')).toBeDisabled();
  await text(page, 'missing-docs', MISS('แบบแปลน'), 'SV-03 หลัง plan-as-jpg.jpg ยังขาดแบบแปลน');

  await attach(page, 'upload-input-plan', 'plan.pdf');
  await expect(tid(page, 'to-payment-btn'), 'SV-03 + plan.pdf to-payment-btn ต้องใช้ได้').toBeEnabled();
  await count(tid(page, 'missing-docs'), 0, 'SV-03 ครบแล้วต้องไม่แสดง missing-docs');

  // ---- API: SV-03 ขาดแบบแปลน ----
  const d = await w.draft(api, 'SV-03', { areaSqm: 100 });
  await w.upload(api, d.draftId, 'id-card', 'id-card.pdf');
  await w.upload(api, d.draftId, 'deed', 'deed.pdf');
  let r = await post(api, `/api/drafts/${d.draftId}/payment`);
  err(r, 409, 'MISSING_DOCS', 'ยังขาดเอกสาร: แบบแปลน', 'API payment SV-03 ขาดแบบแปลน');
  eq(r.body.missing, ['แบบแปลน'], 'API MISSING_DOCS missing');
  await w.upload(api, d.draftId, 'plan', 'plan.pdf');
  r = await post(api, `/api/drafts/${d.draftId}/payment`);
  status(r, 201, 'API payment SV-03 หลังแนบครบ');
});

test('TC-SUBMIT-03 ร่าง การลบร่าง และการยกเลิก', async ({ w }) => {
  // ---- ส่วน A ร่าง ----
  await w.reset();
  let s = await w.session('somchai');
  await s.page.goto('/citizen');
  await count(s.page.getByTestId('my-case-row'), 10, 'A: my-case-row');
  await count(s.page.getByTestId('my-draft-row'), 2, 'A: my-draft-row');
  const d1 = s.page.locator('[data-testid="my-draft-row"][data-draft-id="DR-0001"]');
  const d2 = s.page.locator('[data-testid="my-draft-row"][data-draft-id="DR-0002"]');
  await attr(d1, 'data-status', 'DRAFT', 'A: DR-0001 สถานะ');
  await attr(d2, 'data-status', 'PENDING_PAYMENT', 'A: DR-0002 สถานะ');
  await expect(d1, 'A: แถวร่างต้องไม่มีเลข EG-').not.toContainText('EG-');
  await expect(d2, 'A: แถวร่างต้องไม่มีเลข EG-').not.toContainText('EG-');
  await d1.getByTestId('open-draft-btn').click();
  await expect(tid(s.page, 'qty-input'), 'A: เปิด DR-0001 qty-input').toHaveValue('2');
  await text(s.page, 'fee-total', '฿40', 'A: เปิด DR-0001 fee-total');

  await s.page.goto('/citizen/new/SV-01');
  await tid(s.page, 'qty-input').fill('3');
  await tid(s.page, 'save-draft-btn').click();
  await text(s.page, 'draft-id', 'DR-0003', 'A: draft-id หลังบันทึกร่างใหม่');
  await s.page.goto('/citizen');
  await count(s.page.getByTestId('my-case-row'), 10, 'A: my-case-row ยัง 10 หลังมีร่างใหม่');
  const cases = await get(s.api, '/api/cases');
  status(cases, 200, 'A: GET /api/cases');
  eq(cases.body.items.length, 10, 'A: GET /api/cases items.length');
  const drafts = await get(s.api, '/api/drafts');
  status(drafts, 200, 'A: GET /api/drafts');
  eq(drafts.body.items.length, 3, 'A: GET /api/drafts items.length');

  // ---- ส่วน B ยกเลิก ----
  await w.reset();
  s = await w.session('somchai');
  await s.page.goto('/citizen/cases/EG-2569-000030');
  await caseReady(s.page, 'EG-2569-000030');
  await count(tid(s.page, 'cancel-case-btn'), 1, 'B: cancel-case-btn');
  await tid(s.page, 'cancel-case-btn').click();
  await text(s.page, 'cancel-confirm-text', 'ค่าธรรมเนียมที่ชำระแล้วไม่คืน', 'B: cancel-confirm-text');
  await tid(s.page, 'confirm-cancel-btn').click();
  await text(s.page, 'case-status', 'ยกเลิก', 'B: case-status หลังยกเลิก');
  await attr(tid(s.page, 'case-status'), 'data-status', 'CANCELLED', 'B: data-status');
  await text(s.page, 'no-refund-note', 'ค่าธรรมเนียมที่ชำระแล้วไม่คืน', 'B: no-refund-note');
  await count(tid(s.page, 'cancel-case-btn'), 0, 'B: cancel-case-btn หายหลังยกเลิก');
  const off = await w.session('off.reg1');
  await off.page.goto('/officer/queue');
  await queueReady(off.page);
  await count(off.page.getByTestId('queue-row'), 16, 'B: queue-row ของ off.reg1 หลังยกเลิก');
  await count(queueRow(off.page, 'EG-2569-000030'), 0, 'B: ไม่มี …000030 ในคิว');
  const ex = await w.session('exec1');
  await ex.page.goto('/dashboard');
  await text(ex.page, 'kpi-backlog', '20', 'B: kpi-backlog');
  await text(ex.page, 'kpi-received', '3', 'B: kpi-received (ธ.ค.) ต้องยัง 3');

  // ---- ส่วน C ยกเลิกไม่ได้เมื่อมีผู้รับ ----
  await w.reset();
  const reg1 = await w.api('off.reg1');
  const cl = await post(reg1, '/api/officer/cases/EG-2569-000030/claim');
  status(cl, 200, 'C: off.reg1 claim …000030');
  s = await w.session('somchai');
  await s.page.goto('/citizen/cases/EG-2569-000030');
  await caseReady(s.page, 'EG-2569-000030');
  await text(s.page, 'case-status', 'กำลังตรวจสอบ', 'C: case-status');
  await count(tid(s.page, 'cancel-case-btn'), 0, 'C: cancel-case-btn ต้องไม่มี');
  let r = await post(s.api, '/api/cases/EG-2569-000030/cancel');
  err(r, 409, 'CANNOT_CANCEL', 'ยกเลิกไม่ได้ คำขอมีเจ้าหน้าที่รับเรื่องแล้ว', 'C: cancel …000030');
  r = await post(s.api, '/api/cases/EG-2569-000013/cancel');
  status(r, 409, 'C: cancel …000013 (IN_REVIEW)');

  // ---- ส่วน E ลบร่าง ----
  await w.reset();
  s = await w.session('somchai');
  r = await del(s.api, '/api/drafts/DR-0001');
  status(r, 204, 'E: DELETE DR-0001');
  r = await get(s.api, '/api/drafts/DR-0001');
  status(r, 404, 'E: GET DR-0001 หลังลบ');
  await s.page.goto('/citizen');
  await count(s.page.getByTestId('my-draft-row'), 1, 'E: my-draft-row เหลือ 1');
  await attr(s.page.getByTestId('my-draft-row'), 'data-draft-id', 'DR-0002', 'E: แถวที่เหลือ');
  r = await del(s.api, '/api/drafts/DR-0002');
  status(r, 204, 'E: DELETE DR-0002 (PENDING_PAYMENT ยังไม่ชำระ)');
  r = await get(s.api, '/api/payments/PP-0001');
  status(r, 404, 'E: GET PP-0001 หลังลบร่าง');
  r = await w.pay('PP-0001', 500);
  status(r, 404, 'E: pay PP-0001 หลังลบร่าง (ต้องไม่เกิดเลขคำขอ)');

  // ---- ส่วน F ยกเลิกชนกับรับเรื่อง (ทำ 3 รอบเพื่อให้ race มีโอกาสแสดงตัว) ----
  for (let round = 1; round <= 3; round++) {
    await w.reset();
    const somchai = await w.api('somchai');
    const reg = await w.api('off.reg1');
    const exec = await w.api('exec1');
    const [rc, rl] = await Promise.all([
      post(somchai, '/api/cases/EG-2569-000030/cancel'),
      post(reg, '/api/officer/cases/EG-2569-000030/claim'),
    ]);
    const tag = `F รอบ ${round}: cancel=${rc.status} claim=${rl.status}`;
    const cancelWon = rc.status === 200 && rl.status === 409;
    const claimWon = rl.status === 200 && rc.status === 409;
    ok(cancelWon || claimWon, `${tag} · ต้องสำเร็จฝั่งเดียว (ห้ามได้ 200 ทั้งสองฝั่ง) body cancel=${rc.text} claim=${rl.text}`);
    const c = await get(reg, '/api/cases/EG-2569-000030');
    status(c, 200, `${tag} GET case`);
    const dash = await get(exec, '/api/dashboard?period=2026-12&service=ALL');
    const w1 = dash.body.workload.find((x) => x.username === 'off.reg1');
    if (cancelWon) {
      err(rl, 409, 'INVALID_STATE', null, `${tag} claim ที่แพ้`);
      eq(c.body.status, 'CANCELLED', `${tag} สถานะสุดท้าย`);
      ok(!c.body.owner, `${tag} ยกเลิกชนะ ต้องไม่มีผู้ถือ`, `owner=${c.body.owner}`);
      eq(w1.count, 3, `${tag} งานในมือ off.reg1`);
    } else {
      err(rc, 409, 'CANNOT_CANCEL', null, `${tag} cancel ที่แพ้`);
      eq(c.body.status, 'IN_REVIEW', `${tag} สถานะสุดท้าย`);
      eq(c.body.owner, 'off.reg1', `${tag} ผู้ถือ`);
      eq(w1.count, 4, `${tag} งานในมือ off.reg1`);
    }
  }
});
