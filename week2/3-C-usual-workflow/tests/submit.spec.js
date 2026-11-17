const fs = require('node:fs');
const { test, expect, file, baht } = require('./helpers');

// BR-04 / BR-05 oracle
const feeSv03 = a => (a <= 100 ? 1000 : 1000 + 10 * (a - 100));

test('TC-FEE-01 ค่าธรรมเนียม SV-01 / SV-02 / SV-03', async ({ h }) => {
  await h.reset();
  const page = await h.pageC('somchai');
  const api = page.request;
  await page.goto('/citizen/new/SV-03');
  await expect(page.getByTestId('service-name')).toHaveText('ขออนุญาตก่อสร้าง/ต่อเติมอาคาร');
  const AREA_ERR = 'กรุณาระบุพื้นที่ 1–500 ตร.ม.', BIG = 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน';
  const rows = [[0, AREA_ERR, 'INVALID_AREA'], [-1, AREA_ERR, 'INVALID_AREA'], [1], [100], [101], [102], [250], [300], [499], [500], [501, BIG, 'AREA_TOO_LARGE']];
  for (const [a, err, code] of rows) {
    await page.getByTestId('area-input').fill(String(a));
    if (err) {
      await expect.soft(page.getByTestId('fee-total'), `area ${a}`).toHaveText('–');
      await expect.soft(page.getByTestId('fee-error'), `area ${a}`).toHaveText(err);
      await expect.soft(page.getByTestId('to-upload-btn'), `area ${a}`).toBeDisabled();
      const r = await api.post('/api/drafts', { data: { serviceId: 'SV-03', areaSqm: a } });
      expect.soft({ status: r.status(), code: (await r.json()).code }, `API area ${a}`).toEqual({ status: 400, code });
    } else {
      await expect.soft(page.getByTestId('fee-total'), `area ${a}`).toHaveText(baht(feeSv03(a)));
      await expect.soft(page.getByTestId('fee-error'), `area ${a}`).toHaveCount(0);
      await expect.soft(page.getByTestId('to-upload-btn'), `area ${a}`).toBeEnabled();
      const r = await api.post('/api/drafts', { data: { serviceId: 'SV-03', areaSqm: a } });
      expect.soft({ status: r.status(), fee: (await r.json()).fee }, `API area ${a}`).toEqual({ status: 201, fee: feeSv03(a) });
    }
  }
  await page.goto('/citizen/new/SV-01');
  await expect(page.getByTestId('qty-input')).toHaveValue('1'); // A-56
  for (const q of [0, 1, 2, 3, 4, 5, 6]) {
    await page.getByTestId('qty-input').fill(String(q));
    const ok = q >= 1 && q <= 5;
    await expect.soft(page.getByTestId('fee-total'), `qty ${q}`).toHaveText(ok ? baht(20 * q) : '–');
    if (ok) await expect.soft(page.getByTestId('fee-error'), `qty ${q}`).toHaveCount(0);
    else await expect.soft(page.getByTestId('fee-error'), `qty ${q}`).toHaveText('จำนวนฉบับต้อง 1–5 ฉบับ');
    const r = await api.post('/api/drafts', { data: { serviceId: 'SV-01', qty: q } });
    const b = await r.json();
    expect.soft(ok ? { s: r.status(), v: b.fee } : { s: r.status(), v: b.code }, `API qty ${q}`).toEqual(ok ? { s: 201, v: 20 * q } : { s: 400, v: 'INVALID_QTY' });
  }
  await page.goto('/citizen/new/SV-02');
  await expect(page.getByTestId('fee-total')).toHaveText('฿500');
  const r = await api.post('/api/drafts', { data: { serviceId: 'SV-02' } });
  expect((await r.json()).fee).toBe(500);
});

test('TC-SUBMIT-01 ยื่นคำขอ SV-01 ครบวงจร', async ({ h }) => {
  await h.reset();
  const page = await h.pageC('somchai');
  await page.goto('/citizen');
  await page.getByTestId('start-service-SV-01').click();
  await expect(page).toHaveURL(/\/citizen\/new\/SV-01/);
  await expect(page.getByTestId('wizard-step')).toHaveText('1/3 กรอกข้อมูล');
  await page.getByTestId('qty-input').fill('2');
  await expect(page.getByTestId('fee-total')).toHaveText('฿40');
  await page.getByTestId('to-upload-btn').click();
  await expect(page.getByTestId('wizard-step')).toHaveText('2/3 แนบเอกสาร');
  await expect(page.getByTestId('to-payment-btn')).toBeDisabled();
  await page.getByTestId('upload-input-id-card').setInputFiles(file('id-card.pdf'));
  await expect(page.getByTestId('file-item')).toHaveCount(1);
  await expect(page.getByTestId('file-item')).toHaveAttribute('data-doc-key', 'id-card');
  await expect(page.getByTestId('to-payment-btn')).toBeEnabled();
  await page.getByTestId('to-payment-btn').click();
  await expect(page.getByTestId('wizard-step')).toHaveText('3/3 ชำระเงิน');
  await expect(page.getByTestId('payment-amount')).toHaveText('฿40');
  await page.getByTestId('create-qr-btn').click();
  await expect(page.getByTestId('qr-ref')).toHaveText('PP-0002');
  await expect(page.getByTestId('qr-expires')).toHaveAttribute('data-iso', '2026-12-01T09:15:00+07:00');
  await expect(page.getByTestId('qr-image')).toBeVisible();
  await expect(page.getByTestId('payment-status')).toHaveText('รอชำระ');
  const paid = await h.pay('PP-0002', 40);
  expect({ status: paid.status(), body: await paid.json() }).toEqual({ status: 200, body: { status: 'PAID', caseNo: 'EG-2569-000031', receiptNo: 'RC-2569-000031', duplicate: false } });
  await page.getByTestId('refresh-payment-btn').click();
  await expect(page.getByTestId('payment-status')).toHaveText('ชำระแล้ว');
  await expect(page.getByTestId('submitted-case-no')).toHaveText('EG-2569-000031');
  await expect(page.getByTestId('receipt-no')).toHaveText('RC-2569-000031');
  await expect(page.getByTestId('receipt-amount')).toHaveText('฿40');
  await expect(page.getByTestId('receipt-paid-at')).toHaveAttribute('data-iso', '2026-12-01T09:00:00+07:00');
  await page.getByTestId('go-case-btn').click();
  await expect(page).toHaveURL(/\/citizen\/cases\/EG-2569-000031$/);
  await expect(page.getByTestId('case-status')).toHaveText('ส่งคำขอแล้ว');
  await expect(page.getByTestId('case-status')).toHaveAttribute('data-status', 'SUBMITTED');
  await expect(page.getByTestId('case-fee')).toHaveText('฿40');
  // D0 = Tue 1 Dec (before 16:30) + 3 working days = Fri 4 Dec 16:30
  await expect(page.getByTestId('sla-due')).toHaveText('4 ธ.ค. 2569 16:30');
  await expect(page.getByTestId('sla-due')).toHaveAttribute('data-iso', '2026-12-04T16:30:00+07:00');
  await expect(page.getByTestId('sla-level')).toHaveText('ปกติ');
  await expect(page.getByTestId('cancel-case-btn')).toHaveCount(1);
  await expect(page.getByTestId('case-step')).toHaveCount(0);
  const off = await h.pageS('off.reg1');
  await off.goto('/officer/queue');
  const nos = await h.queueNos(off);
  const row = off.locator('[data-testid=queue-row][data-case-no="EG-2569-000031"]');
  await expect(row.getByTestId('row-owner')).toHaveText('');
  await expect(row.getByTestId('claim-btn')).toHaveCount(1);
  expect(nos.indexOf('EG-2569-000031'), 'right after …000030 (same due, larger number)').toBe(nos.indexOf('EG-2569-000030') + 1);
});

test('TC-SUBMIT-02 เอกสารบังคับครบก่อนชำระ', async ({ h }) => {
  await h.reset();
  const page = await h.pageC('somchai');
  const missing = page.getByTestId('missing-docs'), toPay = page.getByTestId('to-payment-btn');
  // SV-02
  await page.goto('/citizen/new/SV-02');
  await page.getByTestId('to-upload-btn').click();
  await expect(page.getByTestId('wizard-step')).toHaveText('2/3 แนบเอกสาร');
  await page.getByTestId('upload-input-id-card').setInputFiles(file('id-card.pdf'));
  await expect(page.getByTestId('file-item')).toHaveCount(1);
  await expect(toPay).toBeDisabled();
  await expect(missing).toHaveText('ยังขาดเอกสาร: แผนที่ตั้ง');
  await page.getByTestId('upload-input-map').setInputFiles(file('map.pdf'));
  await expect(page.getByTestId('file-item')).toHaveCount(2);
  await expect(toPay).toBeEnabled();
  await expect(missing).toHaveCount(0);
  await page.locator('[data-testid=file-item][data-name="map.pdf"]').getByTestId('file-remove-btn').click();
  await expect(page.getByTestId('file-item')).toHaveCount(1);
  await expect(toPay).toBeDisabled();
  await expect(missing).toHaveText('ยังขาดเอกสาร: แผนที่ตั้ง');
  // SV-03 area 100
  await page.goto('/citizen/new/SV-03');
  await page.getByTestId('area-input').fill('100');
  await expect(page.getByTestId('fee-total')).toHaveText('฿1,000');
  await page.getByTestId('to-upload-btn').click();
  await expect(page.getByTestId('wizard-step')).toHaveText('2/3 แนบเอกสาร');
  await page.getByTestId('upload-input-id-card').setInputFiles(file('id-card.pdf'));
  await expect(missing).toHaveText('ยังขาดเอกสาร: แบบแปลน, โฉนด');
  await expect(toPay).toBeDisabled();
  await page.getByTestId('upload-input-deed').setInputFiles(file('deed.pdf'));
  await expect(missing).toHaveText('ยังขาดเอกสาร: แบบแปลน');
  await expect(toPay).toBeDisabled();
  await page.getByTestId('upload-input-plan').setInputFiles(file('plan-as-jpg.jpg'));
  await expect(page.getByTestId('upload-error')).toHaveText('แบบแปลนต้องเป็นไฟล์ PDF เท่านั้น');
  await expect(page.getByTestId('file-item')).toHaveCount(2);
  await expect(missing).toHaveText('ยังขาดเอกสาร: แบบแปลน');
  await expect(toPay).toBeDisabled();
  await page.getByTestId('upload-input-plan').setInputFiles(file('plan.pdf'));
  await expect(page.getByTestId('file-item')).toHaveCount(3);
  await expect(toPay).toBeEnabled();
  await expect(missing).toHaveCount(0);
  // API
  const api = page.request;
  const { draftId } = await (await api.post('/api/drafts', { data: { serviceId: 'SV-03', areaSqm: 100 } })).json();
  await h.upload(api, draftId, 'id-card', 'id-card.pdf');
  await h.upload(api, draftId, 'deed', 'deed.pdf');
  const r = await api.post(`/api/drafts/${draftId}/payment`);
  const b = await h.expectErr(r, 409, 'MISSING_DOCS');
  expect(b.missing).toEqual(['แบบแปลน']);
  expect((await h.upload(api, draftId, 'plan', 'plan.pdf')).status()).toBe(201);
  expect((await api.post(`/api/drafts/${draftId}/payment`)).status()).toBe(201);
});

test('TC-SUBMIT-03 ร่าง การลบร่าง และการยกเลิก', async ({ h }) => {
  // A: drafts
  await h.reset();
  let page = await h.pageC('somchai');
  await page.goto('/citizen');
  await expect(page.getByTestId('my-case-row')).toHaveCount(10);
  const drafts = page.getByTestId('my-draft-row');
  await expect(drafts).toHaveCount(2);
  expect(await drafts.evaluateAll(rs => rs.map(r => `${r.dataset.draftId}:${r.dataset.status}`))).toEqual(['DR-0001:DRAFT', 'DR-0002:PENDING_PAYMENT']);
  for (const t of await drafts.allInnerTexts()) expect(t).not.toContain('EG-');
  await page.locator('[data-testid=my-draft-row][data-draft-id="DR-0001"]').getByTestId('open-draft-btn').click();
  await expect(page.getByTestId('qty-input')).toHaveValue('2');
  await expect(page.getByTestId('fee-total')).toHaveText('฿40');
  await page.goto('/citizen/new/SV-01');
  await page.getByTestId('qty-input').fill('3');
  await page.getByTestId('save-draft-btn').click();
  await expect(page.getByTestId('draft-id')).toHaveText('DR-0003');
  await page.goto('/citizen');
  await expect(page.getByTestId('my-case-row')).toHaveCount(10);
  expect((await (await page.request.get('/api/cases')).json()).items.length).toBe(10);
  expect((await (await page.request.get('/api/drafts')).json()).items.length).toBe(3);

  // B: cancel SUBMITTED without owner
  await h.reset();
  page = await h.pageC('somchai');
  await page.goto('/citizen/cases/EG-2569-000030');
  await expect(page.getByTestId('cancel-case-btn')).toHaveCount(1);
  await page.getByTestId('cancel-case-btn').click();
  await expect(page.getByTestId('cancel-confirm-text')).toHaveText('ค่าธรรมเนียมที่ชำระแล้วไม่คืน');
  await page.getByTestId('confirm-cancel-btn').click();
  await expect(page.getByTestId('case-status')).toHaveText('ยกเลิก');
  await expect(page.getByTestId('case-status')).toHaveAttribute('data-status', 'CANCELLED');
  await expect(page.getByTestId('no-refund-note')).toHaveText('ค่าธรรมเนียมที่ชำระแล้วไม่คืน');
  await expect(page.getByTestId('cancel-case-btn')).toHaveCount(0);
  const off = await h.pageS('off.reg1');
  await off.goto('/officer/queue');
  await expect(off.getByTestId('queue-row')).toHaveCount(16);
  await expect(off.locator('[data-testid=queue-row][data-case-no="EG-2569-000030"]')).toHaveCount(0);
  const exec = await h.pageS('exec1');
  await exec.goto('/dashboard');
  await expect(exec.getByTestId('kpi-backlog')).toHaveText('20');
  await expect(exec.getByTestId('kpi-received')).toHaveText('3');

  // C: cannot cancel once claimed
  await h.reset();
  const reg1 = await h.loginS('off.reg1');
  expect((await reg1.post('/api/officer/cases/EG-2569-000030/claim')).status()).toBe(200);
  page = await h.pageC('somchai');
  await page.goto('/citizen/cases/EG-2569-000030');
  await expect(page.getByTestId('case-status')).toHaveText('กำลังตรวจสอบ');
  await expect(page.getByTestId('cancel-case-btn')).toHaveCount(0);
  const b = await h.expectErr(await page.request.post('/api/cases/EG-2569-000030/cancel'), 409, 'CANNOT_CANCEL');
  expect(b.message).toBe('ยกเลิกไม่ได้ คำขอมีเจ้าหน้าที่รับเรื่องแล้ว');
  await h.expectErr(await page.request.post('/api/cases/EG-2569-000013/cancel'), 409, 'CANNOT_CANCEL', '…000013 IN_REVIEW');

  // E: delete drafts
  await h.reset();
  page = await h.pageC('somchai');
  const api = page.request;
  expect((await api.delete('/api/drafts/DR-0001')).status()).toBe(204);
  expect((await api.get('/api/drafts/DR-0001')).status()).toBe(404);
  await page.goto('/citizen');
  await expect(page.getByTestId('my-draft-row')).toHaveCount(1);
  await expect(page.getByTestId('my-draft-row')).toHaveAttribute('data-draft-id', 'DR-0002');
  expect((await api.delete('/api/drafts/DR-0002')).status()).toBe(204);
  expect((await api.get('/api/payments/PP-0001')).status()).toBe(404);
  expect((await h.pay('PP-0001', 500)).status()).toBe(404);

  // F: cancel vs claim at the same time
  await h.reset();
  const sc = await h.loginC('somchai');
  const r1 = await h.loginS('off.reg1');
  const [cancel, claim] = await Promise.all([sc.post('/api/cases/EG-2569-000030/cancel'), r1.post('/api/officer/cases/EG-2569-000030/claim')]);
  const outcome = { cancel: cancel.status(), cancelCode: (await cancel.json()).code ?? null, claim: claim.status(), claimCode: (await claim.json()).code ?? null };
  const c = await h.caseOf(sc, 'EG-2569-000030');
  const mine = (await (await r1.get('/api/officer/queue?filter=mine')).json()).items.length;
  if (outcome.cancel === 200) {
    expect(outcome).toEqual({ cancel: 200, cancelCode: null, claim: 409, claimCode: 'INVALID_STATE' });
    expect({ status: c.status, owner: c.owner, workload: mine }).toEqual({ status: 'CANCELLED', owner: null, workload: 3 });
  } else {
    expect(outcome).toEqual({ cancel: 409, cancelCode: 'CANNOT_CANCEL', claim: 200, claimCode: null });
    expect({ status: c.status, owner: c.owner, workload: mine }).toEqual({ status: 'IN_REVIEW', owner: 'off.reg1', workload: 4 });
  }
});

test('TC-UPLOAD-01 ขนาดและจำนวนไฟล์', async ({ h }) => {
  await h.reset();
  const page = await h.pageC('somchai');
  await page.goto('/citizen/new/SV-01');
  await page.getByTestId('qty-input').fill('1');
  await page.getByTestId('to-upload-btn').click();
  await expect(page.getByTestId('wizard-step')).toHaveText('2/3 แนบเอกสาร');
  const items = page.getByTestId('file-item');
  const MAX = 5 * 1024 * 1024; // BR-07: accepted iff size <= 5,242,880
  for (const size of [5242879, 5242880, 5242881]) {
    expect(fs.statSync(file(`size-${size}.pdf`)).size).toBe(size);
    await page.getByTestId('upload-input-id-card').setInputFiles(file(`size-${size}.pdf`));
    if (size <= MAX) {
      await expect(items, `size ${size} accepted`).toHaveCount(1);
      await expect(page.getByTestId('upload-error'), `size ${size}`).toHaveCount(0);
      await items.getByTestId('file-remove-btn').click();
      await expect(items).toHaveCount(0);
    } else {
      await expect(page.getByTestId('upload-error'), `size ${size}`).toHaveText('ไฟล์ใหญ่เกิน 5 MB');
      await expect(items).toHaveCount(0);
    }
  }
  const api = page.request;
  const { draftId } = await (await api.post('/api/drafts', { data: { serviceId: 'SV-01', qty: 1 } })).json();
  for (const size of [5242879, 5242880, 5242881]) {
    const r = await h.upload(api, draftId, 'id-card', `size-${size}.pdf`);
    const body = await r.json();
    expect({ size, status: r.status(), code: body.code ?? null }).toEqual(size <= MAX ? { size, status: 201, code: null } : { size, status: 400, code: 'FILE_TOO_LARGE' });
  }
  // count: 1 + 4 = 5 accepted, 6th rejected
  await page.getByTestId('upload-input-id-card').setInputFiles(file('id-card.pdf'));
  await expect(items).toHaveCount(1);
  await page.getByTestId('upload-input-extra').setInputFiles([1, 2, 3, 4].map(i => file(`multi-${i}.pdf`)));
  await expect(items).toHaveCount(5);
  await page.getByTestId('upload-input-extra').setInputFiles(file('multi-5.pdf'));
  await expect(page.getByTestId('upload-error')).toHaveText('แนบได้สูงสุด 5 ไฟล์ต่อคำขอ');
  await expect(items).toHaveCount(5);
  await page.locator('[data-testid=file-item][data-name="multi-4.pdf"]').getByTestId('file-remove-btn').click();
  await expect(items).toHaveCount(4);
  await page.getByTestId('upload-input-extra').setInputFiles(file('multi-5.pdf'));
  await expect(items).toHaveCount(5);
  await expect(page.locator('[data-testid=file-item][data-name="multi-5.pdf"]')).toHaveCount(1);
  const d2 = (await (await api.post('/api/drafts', { data: { serviceId: 'SV-01', qty: 1 } })).json()).draftId;
  for (const n of ['id-card.pdf', 'multi-1.pdf', 'multi-2.pdf', 'multi-3.pdf', 'multi-4.pdf']) expect((await h.upload(api, d2, n === 'id-card.pdf' ? 'id-card' : 'extra', n)).status()).toBe(201);
  await h.expectErr(await h.upload(api, d2, 'extra', 'multi-5.pdf'), 400, 'FILE_COUNT');
});

test('TC-UPLOAD-02 ชนิดไฟล์จากเนื้อไฟล์', async ({ h }) => {
  await h.reset();
  const page = await h.pageC('somchai');
  await page.goto('/citizen/new/SV-01');
  await page.getByTestId('to-upload-btn').click();
  await expect(page.getByTestId('wizard-step')).toHaveText('2/3 แนบเอกสาร');
  const items = page.getByTestId('file-item'), input = page.getByTestId('upload-input-id-card');
  for (const n of ['ok-id.pdf', 'real.jpg', 'real.png']) {
    await input.setInputFiles(file(n));
    await expect(items, n).toHaveCount(1);
    await items.getByTestId('file-remove-btn').click();
    await expect(items).toHaveCount(0);
  }
  const rejected = [file('fake-text.pdf'), file('fake-text.jpg'), file('exe-as.png'), file('notes.txt'),
    { name: 'fake-text.pdf', mimeType: 'application/pdf', buffer: fs.readFileSync(file('fake-text.pdf')) }];
  for (const f of rejected) {
    await input.setInputFiles(f);
    await expect(page.getByTestId('upload-error'), JSON.stringify(f.name || f)).toHaveText('รองรับเฉพาะไฟล์ PDF, JPG, PNG');
    await expect(items).toHaveCount(0);
  }
  const api = page.request;
  const { draftId } = await (await api.post('/api/drafts', { data: { serviceId: 'SV-01', qty: 1 } })).json();
  for (const n of ['ok-id.pdf', 'real.jpg', 'real.png']) expect((await h.upload(api, draftId, 'id-card', n)).status(), n).toBe(201);
  for (const n of ['fake-text.pdf', 'fake-text.jpg', 'exe-as.png', 'notes.txt']) await h.expectErr(await h.upload(api, draftId, 'id-card', n), 400, 'FILE_TYPE', n);
  const spoof = await api.post(`/api/drafts/${draftId}/files`, { multipart: { docKey: 'id-card', file: { name: 'fake-text.pdf', mimeType: 'application/pdf', buffer: Buffer.from('hello') } } });
  await h.expectErr(spoof, 400, 'FILE_TYPE', 'Content-Type application/pdf');
  expect((await (await api.get(`/api/drafts/${draftId}`)).json()).files.length).toBe(3);
});

test('TC-PAY-01 อายุ QR 15:00', async ({ h }) => {
  // QR PP-0001 created 08:55:00; valid iff age < 15:00
  for (const [round, at, ok] of [[1, null, true], [2, '2026-12-01T09:09:59+07:00', true], [3, '2026-12-01T09:10:00+07:00', false], [4, '2026-12-01T09:10:01+07:00', false]]) {
    await h.reset();
    if (at) await h.clock(at);
    const sc = await h.loginC('somchai');
    const r = await h.pay('PP-0001', 500);
    const b = await r.json();
    if (ok) expect.soft({ round, status: r.status(), caseNo: b.caseNo }).toEqual({ round, status: 200, caseNo: 'EG-2569-000031' });
    else {
      expect.soft({ round, status: r.status(), code: b.code }).toEqual({ round, status: 410, code: 'QR_EXPIRED' });
      if (round === 3) {
        expect.soft((await (await sc.get('/api/payments/PP-0001')).json()).status).toBe('EXPIRED');
        expect.soft((await (await sc.get('/api/cases')).json()).items.length).toBe(10);
        const page = await h.pageC('somchai');
        await page.goto('/citizen/new/SV-02?draft=DR-0002');
        await expect(page.getByTestId('qr-expired-msg')).toHaveText('QR หมดอายุ กรุณาสร้าง QR ใหม่');
        await expect(page.getByTestId('payment-status')).toHaveText('QR หมดอายุ');
        await expect(page.getByTestId('payment-status')).toHaveAttribute('data-status', 'EXPIRED');
        await page.getByTestId('regenerate-qr-btn').click();
        await expect(page.getByTestId('qr-ref')).toHaveText('PP-0002');
        await expect(page.getByTestId('qr-expires')).toHaveAttribute('data-iso', '2026-12-01T09:25:00+07:00');
        const p2 = await h.pay('PP-0002', 500);
        expect({ status: p2.status(), caseNo: (await p2.json()).caseNo }).toEqual({ status: 200, caseNo: 'EG-2569-000031' });
      }
    }
  }
});

test('TC-PAY-02 ยอดเงินและ callback ซ้ำ', async ({ h }) => {
  await h.reset();
  const sc = await h.loginC('somchai');
  const q = await h.newQr(sc, 'SV-01', { qty: 1 });
  expect(q.ref).toBe('PP-0002');
  const count = async () => (await (await sc.get('/api/cases')).json()).items.length;
  for (const amt of [19, 21]) {
    await h.expectErr(await h.pay('PP-0002', amt), 422, 'AMOUNT_MISMATCH', `amount ${amt}`);
    expect((await (await sc.get('/api/payments/PP-0002')).json()).status).toBe('PENDING');
    expect(await count()).toBe(10);
  }
  const ok = await h.pay('PP-0002', 20);
  expect(await ok.json()).toEqual({ status: 'PAID', caseNo: 'EG-2569-000031', receiptNo: 'RC-2569-000031', duplicate: false });
  expect(await count()).toBe(11);
  const dup = await h.pay('PP-0002', 20);
  expect({ status: dup.status(), body: await dup.json() }).toEqual({ status: 200, body: { status: 'PAID', caseNo: 'EG-2569-000031', receiptNo: 'RC-2569-000031', duplicate: true } });
  expect(await count()).toBe(11);
  const next = await h.newPaid({ ctx: sc });
  expect(next.caseNo).toBe('EG-2569-000032');
  expect((await (await sc.get(`/api/payments/${next.ref}`)).json()).receiptNo).toBe('RC-2569-000032');
});

test('TC-PAY-03 ชำระพร้อมกัน เลขไม่ซ้ำ', async ({ h }) => {
  await h.reset();
  const sc = await h.loginC('somchai'), sy = await h.loginC('somying');
  const refs = [];
  for (const ctx of [sc, sc, sc, sy, sy, sy]) refs.push((await h.newQr(ctx, 'SV-01', { qty: 1 })).ref);
  expect(refs).toEqual(['PP-0002', 'PP-0003', 'PP-0004', 'PP-0005', 'PP-0006', 'PP-0007']);
  const res = await Promise.all(refs.map(r => h.pay(r, 20)));
  const bodies = await Promise.all(res.map(r => r.json()));
  expect(res.map(r => r.status())).toEqual([200, 200, 200, 200, 200, 200]);
  const want = [31, 32, 33, 34, 35, 36].map(n => `0000${n}`);
  expect(bodies.map(b => b.caseNo).sort()).toEqual(want.map(n => `EG-2569-${n}`));
  expect(bodies.map(b => b.receiptNo).sort()).toEqual(want.map(n => `RC-2569-${n}`));
  const mine = async ctx => (await (await ctx.get('/api/cases')).json()).items.map(i => i.caseNo).filter(n => n >= 'EG-2569-000031');
  expect((await mine(sc)).length).toBe(3);
  expect((await mine(sy)).length).toBe(3);
  expect((await h.newPaid({ ctx: sc })).caseNo).toBe('EG-2569-000037');
});

test('TC-PAY-04 เลขคำขอข้ามปี 2569 → 2570', async ({ h }) => {
  await h.reset();
  const sc = await h.loginC('somchai');
  await h.clock('2026-12-31T23:58:00+07:00');
  const q = await h.newQr(sc, 'SV-01');
  expect((await (await sc.get(`/api/payments/${q.ref}`)).json()).caseNo).toBeNull();
  await h.clock('2026-12-31T23:59:00+07:00');
  const p = await (await h.pay(q.ref, 20)).json();
  expect({ caseNo: p.caseNo, receiptNo: p.receiptNo }).toEqual({ caseNo: 'EG-2569-000031', receiptNo: 'RC-2569-000031' });
  const page = await h.pageC('somchai');
  await page.goto(`/citizen/new/SV-01?draft=${q.draftId}`);
  await expect(page.getByTestId('receipt-paid-at')).toHaveAttribute('data-iso', '2026-12-31T23:59:00+07:00');
  const y1 = await h.newPaid({ ctx: sc, at: '2027-01-01T00:00:00+07:00' });
  expect(y1.caseNo).toBe('EG-2570-000001');
  expect((await (await sc.get(`/api/payments/${y1.ref}`)).json()).receiptNo).toBe('RC-2570-000001');
  expect((await h.newPaid({ ctx: sc })).caseNo).toBe('EG-2570-000002');
  const old = await sc.get('/api/cases/EG-2569-000031');
  expect({ status: old.status(), caseNo: (await old.json()).caseNo }).toEqual({ status: 200, caseNo: 'EG-2569-000031' });
});
