const { test, expect, BASE, pdfText, MASK } = require('./helpers');

async function uiReturn(page, reason) {
  await page.getByTestId('return-btn').click();
  await page.getByTestId('return-reason').fill(reason);
  await page.getByTestId('return-submit').click();
}
async function issueVia(h, user, caseNo) {
  const ctx = await h.loginS(user);
  const r = await ctx.post(`/api/officer/cases/${caseNo}/issue`);
  expect(r.status(), `${user} issue ${caseNo}`).toBe(200);
  return r.json();
}

test('TC-WORKFLOW-01 SV-01 อนุมัติ + ออกเอกสาร', async ({ h }) => {
  await h.reset();
  const p = await h.pageS('off.reg2');
  await p.goto('/officer/cases/EG-2569-000025');
  await expect(p.getByTestId('case-status')).toHaveText('กำลังตรวจสอบ');
  for (const [id, n] of [['approve-btn', 1], ['return-btn', 1], ['reject-btn', 1], ['forward-btn', 0], ['issue-btn', 0]]) await expect(p.getByTestId(id), id).toHaveCount(n);
  await expect(p.getByTestId('case-fee')).toHaveText('฿60');
  const reg1 = await h.loginS('off.reg1');
  await h.expectErr(await reg1.post('/api/cases/EG-2569-000026/approve'), 403, 'FORBIDDEN', 'off.reg1 approves case owned by off.reg2');
  await p.getByTestId('approve-btn').click();
  await expect(p.getByTestId('case-status')).toHaveText('อนุมัติ');
  await expect(p.getByTestId('case-status')).toHaveAttribute('data-status', 'APPROVED');
  await expect(p.getByTestId('issue-btn')).toHaveCount(1);
  await expect(p.getByTestId('approve-btn')).toHaveCount(0);
  await p.getByTestId('issue-btn').click();
  await expect(p.getByTestId('case-status')).toHaveText('เสร็จสิ้น');
  await expect(p.getByTestId('case-status')).toHaveAttribute('data-status', 'COMPLETED');
  await expect(p.getByTestId('doc-no')).toHaveText('DOC-2569-000002');
  await expect(p.getByTestId('verify-code')).toHaveText(/^[A-Z0-9]{8}$/);
  await expect(p.getByTestId('closed-at')).toHaveAttribute('data-iso', '2026-12-01T09:00:00+07:00');
  await expect(p.getByTestId('sla-level')).toHaveText('ปิดแล้ว');
  const sy = await h.pageC('somying');
  await sy.goto('/citizen/cases/EG-2569-000025');
  await expect(sy.getByTestId('case-status')).toHaveText('เสร็จสิ้น');
  await expect(sy.getByTestId('download-doc-btn')).toHaveCount(1);
  const [dl] = await Promise.all([sy.waitForEvent('download'), sy.getByTestId('download-doc-btn').click()]);
  expect(dl.suggestedFilename()).toBe('DOC-2569-000002.pdf');
  const bytes = require('node:fs').readFileSync(await dl.path());
  expect(pdfText(bytes)).toContain('docNo=DOC-2569-000002 caseNo=EG-2569-000025');
  const r = await sy.request.get('/api/documents/DOC-2569-000002/pdf');
  expect(r.headers()['content-type']).toBe('application/pdf');
  expect(r.headers()['content-disposition']).toContain('DOC-2569-000002.pdf');
  const exec = await h.loginS('exec1');
  const d = await (await exec.get('/api/dashboard?period=2026-12&service=ALL')).json();
  expect({ closed: d.closed, onTime: d.onTime, received: d.received, backlog: d.backlog }).toEqual({ closed: 1, onTime: 1, received: 3, backlog: 20 });
});

test('TC-WORKFLOW-02 SV-02 ผ่านหัวหน้า', async ({ h }) => {
  await h.reset();
  const p = await h.pageS('off.reg2');
  await p.goto('/officer/cases/EG-2569-000013');
  await expect(p.getByTestId('approve-btn')).toHaveCount(0);
  await expect(p.getByTestId('forward-btn')).toHaveCount(1);
  await expect(p.getByTestId('forward-target')).toHaveCount(0);
  await expect(p.locator('select')).toHaveCount(0); // no destination picker
  await p.getByTestId('forward-btn').click();
  await expect(p.getByTestId('case-status')).toHaveText('รออนุมัติ');
  await expect(p.getByTestId('case-status')).toHaveAttribute('data-status', 'PENDING_APPROVAL');
  await p.goto('/officer/queue');
  await expect(p.getByTestId('workload-count')).toHaveText('8');
  await expect(p.locator('[data-testid=queue-row][data-case-no="EG-2569-000013"]')).toHaveCount(0);
  const hd = await h.pageS('head1');
  await hd.goto('/head/approvals');
  await expect(hd.getByTestId('approval-row')).toHaveCount(3);
  expect(await hd.getByTestId('approval-row').evaluateAll(rs => rs.map(r => r.dataset.caseNo))).toEqual(['EG-2569-000013', 'EG-2569-000014', 'EG-2569-000011']);
  await hd.locator('[data-testid=approval-row][data-case-no="EG-2569-000013"]').getByTestId('approval-open').click();
  await expect(hd).toHaveURL(/\/officer\/cases\/EG-2569-000013$/);
  await expect(hd.getByTestId('approve-btn')).toHaveCount(1);
  await expect(hd.getByTestId('reject-btn')).toHaveCount(1);
  await expect(hd.getByTestId('issue-btn')).toHaveCount(0);
  await hd.getByTestId('approve-btn').click();
  await expect(hd.getByTestId('case-status')).toHaveText('อนุมัติ');
  await expect(hd.getByTestId('issue-btn')).toHaveCount(0);
  const r1 = await h.pageS('off.reg1');
  await r1.goto('/officer/cases/EG-2569-000013');
  await expect(r1.getByTestId('issue-btn')).toHaveCount(0);
  await h.expectErr(await r1.request.post('/api/officer/cases/EG-2569-000013/issue'), 403, 'FORBIDDEN', 'off.reg1 is not the issuer');
  await p.goto('/officer/cases/EG-2569-000013');
  await p.getByTestId('issue-btn').click();
  await expect(p.getByTestId('case-status')).toHaveText('เสร็จสิ้น');
  await expect(p.getByTestId('doc-no')).toHaveText('DOC-2569-000002');
  const code = await p.getByTestId('verify-code').innerText();
  const anon = await h.page();
  await anon.goto(`/verify/${code}`);
  await expect(anon.getByTestId('verify-signer')).toHaveText('หัวหน้าฝ่าย');
  // 8: seed …000019 APPROVED by head1, issuer off.reg1
  await h.reset();
  const q = await h.pageS('off.reg1');
  await q.goto('/officer/cases/EG-2569-000019');
  await q.getByTestId('issue-btn').click();
  await expect(q.getByTestId('case-status')).toHaveAttribute('data-status', 'COMPLETED');
  await expect(q.getByTestId('doc-no')).toHaveText('DOC-2569-000002');
  const code2 = await q.getByTestId('verify-code').innerText();
  const anon2 = await h.page();
  await anon2.goto(`/verify/${code2}`);
  await expect(anon2.getByTestId('verify-signer')).toHaveText('หัวหน้าฝ่าย');
});

test('TC-WORKFLOW-03 SV-03 สามขั้นตอน', async ({ h }) => {
  await h.reset();
  const reg2 = await h.pageS('off.reg2');
  await reg2.goto('/officer/cases/EG-2569-000012');
  await expect(reg2.getByTestId('case-step')).toHaveText('ขั้นตอน 1/3 · ฝ่ายทะเบียน');
  await expect(reg2.getByTestId('case-fee')).toHaveText('฿1,010');
  await expect(reg2.getByTestId('forward-btn')).toHaveCount(1);
  await reg2.getByTestId('forward-btn').click();
  await expect(reg2.getByTestId('case-step')).toHaveText('ขั้นตอน 2/3 · ฝ่ายโยธา');
  await expect(reg2.getByTestId('case-status')).toHaveText('กำลังตรวจสอบ');
  await expect(reg2.getByTestId('case-owner')).toHaveText('ยังไม่มีผู้รับ');
  await reg2.goto('/officer/queue');
  await expect(reg2.getByTestId('workload-count')).toHaveText('8');
  await expect(reg2.getByTestId('queue-row')).toHaveCount(16);
  await expect(reg2.locator('[data-testid=queue-row][data-case-no="EG-2569-000012"]')).toHaveCount(0);
  const works = await h.pageS('off.works1');
  await works.goto('/officer/queue');
  await expect(works.getByTestId('queue-row')).toHaveCount(2);
  expect(await h.queueNos(works)).toEqual(['EG-2569-000010', 'EG-2569-000012']);
  await expect(works.getByTestId('claim-btn')).toHaveCount(2);
  const reg1 = await h.loginS('off.reg1');
  await h.expectErr(await reg1.post('/api/officer/cases/EG-2569-000012/claim'), 403, 'FORBIDDEN', 'cross-department claim');
  await works.goto('/officer/cases/EG-2569-000012');
  await works.getByTestId('claim-btn').click();
  await expect(works.getByTestId('case-owner')).toHaveText('off.works1');
  await works.getByTestId('forward-btn').click();
  await expect(works.getByTestId('case-status')).toHaveText('รออนุมัติ');
  await expect(works.getByTestId('case-step')).toHaveText('ขั้นตอน 3/3 · หัวหน้าฝ่าย');
  const hd = await h.pageS('head1');
  await hd.goto('/head/approvals');
  await expect(hd.getByTestId('approval-row')).toHaveCount(3);
  await hd.locator('[data-testid=approval-row][data-case-no="EG-2569-000012"]').getByTestId('approval-open').click();
  await hd.getByTestId('approve-btn').click();
  await expect(hd.getByTestId('case-status')).toHaveText('อนุมัติ');
  await works.goto('/officer/cases/EG-2569-000012');
  await expect(works.getByTestId('issue-btn')).toHaveCount(0);
  await reg2.goto('/officer/cases/EG-2569-000012');
  await expect(reg2.getByTestId('issue-btn')).toHaveCount(1);
  await reg2.getByTestId('issue-btn').click();
  await expect(reg2.getByTestId('case-status')).toHaveText('เสร็จสิ้น');
  const code = await reg2.getByTestId('verify-code').innerText();
  const anon = await h.page();
  await anon.goto(`/verify/${code}`);
  await expect(anon.getByTestId('verify-signer')).toHaveText('หัวหน้าฝ่าย');
});

test('TC-WORKFLOW-04 ตีกลับสูงสุด 2 ครั้ง และผลหลังครบ', async ({ h }) => {
  const resubmit = async (no) => { const sc = await h.loginC('somchai'); expect((await sc.post(`/api/cases/${no}/resubmit`)).status(), `resubmit ${no}`).toBe(200); };
  const third = async (ctx, no) => {
    const r = await ctx.post(`/api/officer/cases/${no}/return`, { data: { reason: 'xxxxxxxxxx' } });
    const b = await r.json();
    expect.soft({ status: r.status(), code: b.code, message: b.message }, `3rd return ${no}`).toEqual({ status: 409, code: 'RETURN_LIMIT', message: 'ตีกลับได้สูงสุด 2 ครั้ง' });
    const c = await h.caseOf(ctx, no);
    expect.soft({ status: c.status, returnCount: c.returnCount }, `${no} after 3rd return`).toEqual({ status: 'IN_REVIEW', returnCount: 2 });
  };
  // A
  await h.reset();
  const p = await h.pageS('off.reg1');
  await p.goto('/officer/cases/EG-2569-000020');
  await expect(p.getByTestId('return-count')).toHaveText('0');
  await uiReturn(p, 'xxxxxxxxxx');
  await expect(p.getByTestId('case-status')).toHaveText('รอแก้ไขเอกสาร');
  await expect(p.getByTestId('return-count')).toHaveText('1');
  await resubmit('EG-2569-000020');
  await p.reload();
  await expect(p.getByTestId('case-status')).toHaveText('กำลังตรวจสอบ');
  await expect(p.getByTestId('case-owner')).toHaveText('off.reg1');
  await uiReturn(p, 'xxxxxxxxxx');
  await expect(p.getByTestId('return-count')).toHaveText('2');
  await resubmit('EG-2569-000020');
  await p.reload();
  await expect(p.getByTestId('case-status')).toHaveText('กำลังตรวจสอบ');
  await third(p.request, 'EG-2569-000020');
  await p.reload();
  await expect.soft(p.getByTestId('return-btn'), 'A return-btn').toHaveCount(0);
  await expect.soft(p.getByTestId('approve-btn'), 'A approve-btn').toHaveCount(1);
  await expect.soft(p.getByTestId('reject-btn'), 'A reject-btn').toHaveCount(1);
  // B: seed …000023 already returned twice
  await h.reset();
  const b = await h.pageS('off.reg1');
  await b.goto('/officer/cases/EG-2569-000023');
  await expect(b.getByTestId('return-count')).toHaveText('2');
  await third(b.request, 'EG-2569-000023');
  await b.reload();
  await expect.soft(b.getByTestId('return-btn'), 'B return-btn').toHaveCount(0);
  await expect.soft(b.getByTestId('approve-btn'), 'B approve-btn').toHaveCount(1);
  await expect.soft(b.getByTestId('reject-btn'), 'B reject-btn').toHaveCount(1);
  // C: SV-02 after two returns → only forward
  await h.reset();
  const c = await h.pageS('off.reg2');
  await c.goto('/officer/cases/EG-2569-000013');
  for (let i = 1; i <= 2; i++) {
    await uiReturn(c, 'xxxxxxxxxx');
    await expect(c.getByTestId('return-count')).toHaveText(String(i));
    await resubmit('EG-2569-000013');
    await c.reload();
  }
  await expect(c.getByTestId('case-status')).toHaveText('กำลังตรวจสอบ');
  for (const [id, n] of [['return-btn', 0], ['approve-btn', 0], ['reject-btn', 0], ['forward-btn', 1]]) await expect.soft(c.getByTestId(id), `C ${id}`).toHaveCount(n);
  await h.expectErr(await c.request.post('/api/cases/EG-2569-000013/reject', { data: { reason: 'xxxxxxxxxx' } }), 403, 'FORBIDDEN', 'officer rejects SV-02');
  await c.getByTestId('forward-note').fill('ส่งต่อให้หัวหน้าพิจารณา');
  await c.getByTestId('forward-btn').click();
  await expect(c.getByTestId('case-status')).toHaveText('รออนุมัติ');
  const au = await h.pageS('audit1');
  await au.goto('/audit?event=FORWARD');
  await expect(au.locator('[data-testid=audit-row][data-case-no="EG-2569-000013"]').getByTestId('audit-detail')).toContainText('ส่งต่อให้หัวหน้าพิจารณา');
  const hd = await h.pageS('head1');
  await hd.goto('/officer/cases/EG-2569-000013');
  await expect(hd.getByTestId('reject-btn')).toHaveCount(1);
  await expect(hd.getByTestId('approve-btn')).toHaveCount(1);
});

test('TC-WORKFLOW-05 เหตุผล ≥ 10 ตัวอักษร (ตีกลับ / ไม่อนุมัติ)', async ({ h }) => {
  const MSG = 'กรุณากรอกเหตุผลอย่างน้อย 10 ตัวอักษร';
  // A: return
  await h.reset();
  const p = await h.pageS('off.reg1');
  await p.goto('/officer/cases/EG-2569-000020');
  await p.getByTestId('return-btn').click();
  for (const reason of ['xxxxxxxxx', ' '.repeat(10)]) {
    await p.getByTestId('return-reason').fill(reason);
    await p.getByTestId('return-submit').click();
    await expect(p.getByTestId('return-reason-error'), JSON.stringify(reason)).toHaveText(MSG);
    await h.expectErr(await p.request.post('/api/officer/cases/EG-2569-000020/return', { data: { reason } }), 400, 'REASON_TOO_SHORT', JSON.stringify(reason));
    await expect(p.getByTestId('case-status')).toHaveText('กำลังตรวจสอบ');
  }
  await p.getByTestId('return-reason').fill('xxxxxxxxxx');
  await p.getByTestId('return-submit').click();
  await expect(p.getByTestId('case-status')).toHaveText('รอแก้ไขเอกสาร');
  const sc = await h.pageC('somchai');
  await sc.goto('/citizen/cases/EG-2569-000020');
  await expect(sc.getByTestId('return-reason-display')).toHaveText('xxxxxxxxxx');
  // B: officer rejects SV-01
  await h.reset();
  const q = await h.pageS('off.reg2');
  await q.goto('/officer/cases/EG-2569-000026');
  await q.getByTestId('reject-btn').click();
  await q.getByTestId('reject-reason').fill('xxxxxxxxx');
  await q.getByTestId('reject-submit').click();
  await expect(q.getByTestId('reject-reason-error')).toHaveText(MSG);
  await h.expectErr(await q.request.post('/api/cases/EG-2569-000026/reject', { data: { reason: 'xxxxxxxxx' } }), 400, 'REASON_TOO_SHORT');
  await q.getByTestId('reject-reason').fill('xxxxxxxxxx');
  await q.getByTestId('reject-submit').click();
  await expect(q.getByTestId('case-status')).toHaveText('ไม่อนุมัติ');
  await expect(q.getByTestId('case-status')).toHaveAttribute('data-status', 'REJECTED');
  await expect(q.getByTestId('closed-at')).toHaveAttribute('data-iso', '2026-12-01T09:00:00+07:00');
  await expect(q.getByTestId('sla-level')).toHaveText('ปิดแล้ว');
  const sc2 = await h.pageC('somchai');
  await sc2.goto('/citizen/cases/EG-2569-000026');
  await expect(sc2.getByTestId('no-refund-note')).toHaveText('ค่าธรรมเนียมที่ชำระแล้วไม่คืน');
  const ex = await h.loginS('exec1');
  const d = await (await ex.get('/api/dashboard?period=2026-12&service=ALL')).json();
  expect({ closed: d.closed, onTime: d.onTime }).toEqual({ closed: 1, onTime: 1 });
  // C: head rejects …000011
  await h.reset();
  const hd = await h.loginS('head1');
  await h.expectErr(await hd.post('/api/cases/EG-2569-000011/reject', { data: { reason: 'xxxxxxxxx' } }), 400, 'REASON_TOO_SHORT');
  const ok = await hd.post('/api/cases/EG-2569-000011/reject', { data: { reason: 'xxxxxxxxxx' } });
  expect({ status: ok.status(), st: (await ok.json()).status }).toEqual({ status: 200, st: 'REJECTED' });
});

test('TC-WORKFLOW-06 เวลาแก้ไข 168 ชั่วโมง', async ({ h }) => {
  // returned 2026-11-27T14:00 → deadline +168h = 2026-12-04T14:00
  await h.reset();
  let p = await h.pageC('somchai');
  await p.goto('/citizen/cases/EG-2569-000017');
  await expect(p.getByTestId('case-status')).toHaveText('รอแก้ไขเอกสาร');
  await expect(p.getByTestId('return-reason-display')).toHaveText('ชื่อในเอกสารไม่ตรงกับบัตร กรุณาแก้ไข');
  await expect(p.getByTestId('fix-deadline')).toHaveText('4 ธ.ค. 2569 14:00');
  await expect(p.getByTestId('fix-deadline')).toHaveAttribute('data-iso', '2026-12-04T14:00:00+07:00');
  await expect(p.getByTestId('submit-fix-btn')).toHaveCount(1);
  // A: 167:59
  await h.reset();
  await h.clock('2026-12-04T13:59:00+07:00');
  p = await h.pageC('somchai');
  await p.goto('/citizen/cases/EG-2569-000017');
  await expect(p.getByTestId('submit-fix-btn')).toBeEnabled();
  await p.getByTestId('submit-fix-btn').click();
  await expect(p.getByTestId('case-status')).toHaveText('กำลังตรวจสอบ');
  // B: 168:00 → auto-cancelled
  await h.reset();
  await h.clock('2026-12-04T14:00:00+07:00');
  p = await h.pageC('somchai');
  await p.goto('/citizen/cases/EG-2569-000017');
  await expect(p.getByTestId('case-status')).toHaveText('ยกเลิก');
  await expect(p.getByTestId('case-status')).toHaveAttribute('data-status', 'CANCELLED');
  await expect(p.getByTestId('submit-fix-btn')).toHaveCount(0);
  await expect(p.getByTestId('no-refund-note')).toHaveText('ค่าธรรมเนียมที่ชำระแล้วไม่คืน');
  const r = await p.request.post('/api/cases/EG-2569-000017/resubmit');
  expect(r.status()).toBe(409);
  await expect(p.locator('[data-testid=case-timeline] [data-testid=timeline-item][data-iso="2026-12-04T14:00:00+07:00"]')).toHaveCount(1);
  const ex = await h.loginS('exec1');
  expect((await (await ex.get('/api/dashboard?period=2026-12&service=ALL')).json()).backlog).toBe(20);
});

// ---------------------------------------------------------------- DOC
test('TC-DOC-01 ออกเอกสารและข้อมูลในเอกสาร', async ({ h }) => {
  await h.reset();
  const reg2 = await h.loginS('off.reg2');
  expect((await reg2.post('/api/cases/EG-2569-000025/approve')).status()).toBe(200);
  const ir = await reg2.post('/api/officer/cases/EG-2569-000025/issue');
  const issued = await ir.json();
  expect({ status: ir.status(), docNo: issued.docNo, st: issued.status }).toEqual({ status: 200, docNo: 'DOC-2569-000002', st: 'COMPLETED' });
  expect(issued.verifyCode).toMatch(/^[A-Z0-9]{8}$/);
  const code = issued.verifyCode;
  // SV-01 issued 2026-12-01 → valid until issue + 89 days = 2027-02-28
  const sy = await h.pageC('somying');
  const pdf = await sy.request.get('/api/documents/DOC-2569-000002/pdf');
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  expect(pdf.headers()['content-disposition']).toContain('DOC-2569-000002.pdf');
  expect(pdfText(await pdf.body()).split('\n')).toContain(`docNo=DOC-2569-000002 caseNo=EG-2569-000025 verify=${code} validUntil=2027-02-28`);
  const anon = await h.page();
  await anon.goto(`/verify/${code}`);
  const want = { 'verify-result': 'เอกสารถูกต้อง', 'verify-doc-no': 'DOC-2569-000002', 'verify-applicant': 'สมหญิง ร***', 'verify-service': 'SV-01 ขอหนังสือรับรอง', 'verify-signer': 'เจ้าหน้าที่ทะเบียน 2' };
  for (const [id, v] of Object.entries(want)) await expect(anon.getByTestId(id), id).toHaveText(v);
  await expect(anon.getByTestId('verify-issued')).toHaveAttribute('data-iso', '2026-12-01T09:00:00+07:00');
  await expect(anon.getByTestId('verify-expires')).toHaveAttribute('data-iso', '2027-02-28');
  await sy.goto('/citizen/cases/EG-2569-000025');
  await expect(sy.getByTestId('doc-qr')).toHaveAttribute('data-url', `${BASE}/verify/${code}`);
  const v = await (await (await h.api()).get(`/api/verify/${code}`)).json();
  expect({ result: v.result, validUntil: v.validUntil, issuedAt: v.issuedAt }).toEqual({ result: 'VALID', validUntil: '2027-02-28', issuedAt: '2026-12-01T09:00:00+07:00' });
  const sc = await h.loginC('somchai');
  expect((await sc.get('/api/documents/DOC-2569-000002/pdf')).status()).toBe(404);
  await h.expectErr(await reg2.post('/api/officer/cases/EG-2569-000025/issue'), 409, 'INVALID_STATE', 'issue twice');
  expect((await issueVia(h, 'off.reg1', 'EG-2569-000019')).docNo, 'next document number').toBe('DOC-2569-000003');
});

test('TC-DOC-02 ตรวจเอกสาร /verify', async ({ h }) => {
  await h.reset();
  const p = await h.page();
  const ok = await p.goto('/verify/K7M2Q9XA');
  expect(ok.status()).toBe(200);
  await expect(p).toHaveURL(/\/verify\/K7M2Q9XA$/);
  await expect(p.getByTestId('verify-result')).toHaveText('เอกสารถูกต้อง');
  await expect(p.getByTestId('verify-result')).toHaveAttribute('data-result', 'VALID');
  for (const [id, v] of Object.entries({ 'verify-doc-no': 'DOC-2569-000001', 'verify-applicant': 'สมชาย ใ***', 'verify-service': 'SV-01 ขอหนังสือรับรอง', 'verify-signer': 'เจ้าหน้าที่ทะเบียน 1' })) await expect(p.getByTestId(id), id).toHaveText(v);
  await expect(p.getByTestId('verify-issued')).toHaveAttribute('data-iso', '2026-11-05T10:00:00+07:00');
  await expect(p.getByTestId('verify-expires')).toHaveAttribute('data-iso', '2027-02-02');
  const text = await p.locator('body').innerText();
  expect(text).not.toContain('ใจดี');
  expect(text).not.toContain('1101700123456');
  const nf = await p.goto('/verify/ZZZZZZZZ');
  expect(nf.status()).toBe(404);
  await expect(p.getByTestId('verify-result')).toHaveText('ไม่พบเอกสาร');
  await expect(p.getByTestId('verify-result')).toHaveAttribute('data-result', 'NOT_FOUND');
  await expect(p.getByTestId('verify-applicant')).toHaveCount(0);
  await expect(p.getByTestId('verify-doc-no')).toHaveCount(0);
  const api = await h.api();
  const a = await api.get('/api/verify/K7M2Q9XA');
  expect(a.status()).toBe(200);
  expect(await a.json()).toMatchObject({ result: 'VALID', applicantMasked: 'สมชาย ใ***' });
  const b = await api.get('/api/verify/ZZZZZZZZ');
  expect({ status: b.status(), body: await b.json() }).toEqual({ status: 404, body: { result: 'NOT_FOUND' } });
});

test('TC-DOC-03 เอกสารหมดอายุและลายเซ็นไม่ตรง', async ({ h }) => {
  const check = async (code, at, result, expires) => {
    await h.clock(at);
    const p = await h.page();
    const resp = await p.goto(`/verify/${code}`);
    expect.soft(resp.status(), `${code} @${at} HTTP`).toBe(200);
    await expect.soft(p.getByTestId('verify-result'), `${code} @${at}`).toHaveAttribute('data-result', result);
    if (expires) await expect.soft(p.getByTestId('verify-expires'), `${code} @${at} expires`).toHaveAttribute('data-iso', expires);
    if (result === 'TAMPERED') {
      await expect.soft(p.getByTestId('verify-result')).toHaveText('ลายเซ็นไม่ถูกต้อง');
      await expect.soft(p.getByTestId('verify-doc-no')).toHaveCount(0);
      await expect.soft(p.getByTestId('verify-applicant')).toHaveCount(0);
    } else await expect.soft(p.getByTestId('verify-result')).toHaveText(result === 'VALID' ? 'เอกสารถูกต้อง' : 'เอกสารหมดอายุ');
    await p.context().close();
  };
  const approveIssue = async (caseNo) => {
    const reg2 = await h.loginS('off.reg2');
    expect((await reg2.post(`/api/cases/${caseNo}/approve`)).status()).toBe(200);
    return (await reg2.post(`/api/officer/cases/${caseNo}/issue`)).json();
  };
  // A: SV-01 issued 2026-12-01 → valid through 2027-02-28
  await h.reset();
  const c1 = (await approveIssue('EG-2569-000025')).verifyCode;
  await check(c1, '2027-02-28T23:59:00+07:00', 'VALID', '2027-02-28');
  await check(c1, '2027-03-01T00:00:00+07:00', 'EXPIRED', '2027-02-28');
  // B: SV-02 issued 2026-12-01 → valid through 2027-11-30
  await h.reset();
  const c2 = (await issueVia(h, 'off.reg1', 'EG-2569-000019')).verifyCode;
  await check(c2, '2027-11-30T23:59:00+07:00', 'VALID', '2027-11-30');
  await check(c2, '2027-12-01T00:00:00+07:00', 'EXPIRED');
  // C: seed K7M2Q9XA valid through 2027-02-02
  await h.reset();
  await check('K7M2Q9XA', '2027-02-02T23:59:00+07:00', 'VALID', '2027-02-02');
  await check('K7M2Q9XA', '2027-02-03T00:00:00+07:00', 'EXPIRED');
  // E: issued on 29 Feb 2028 (BE 2571)
  await h.reset();
  await h.clock('2028-02-29T10:00:00+07:00');
  const e1 = await approveIssue('EG-2569-000025');
  const e2 = await issueVia(h, 'off.reg1', 'EG-2569-000019');
  expect([e1.docNo, e2.docNo]).toEqual(['DOC-2571-000001', 'DOC-2571-000002']);
  await check(e1.verifyCode, '2028-05-28T23:59:00+07:00', 'VALID', '2028-05-28');
  await check(e1.verifyCode, '2028-05-29T00:00:00+07:00', 'EXPIRED');
  await check(e2.verifyCode, '2029-02-27T23:59:00+07:00', 'VALID', '2029-02-27');
  await check(e2.verifyCode, '2029-02-28T00:00:00+07:00', 'EXPIRED');
  // D: tampered
  await h.reset();
  const t = await h.tamper('DOC-2569-000001');
  expect({ status: t.status(), body: await t.json() }).toEqual({ status: 200, body: { ok: true } });
  await check('K7M2Q9XA', '2026-12-01T09:00:00+07:00', 'TAMPERED');
  await check('K7M2Q9XA', '2027-03-01T00:00:00+07:00', 'TAMPERED');
});

// ---------------------------------------------------------------- PDPA
test('TC-PDPA-01 ปิดบังเลขบัตรบนจอ', async ({ h }) => {
  await h.reset();
  const reg2 = await h.pageS('off.reg2');
  await reg2.goto('/officer/queue');
  for (const t of await reg2.getByTestId('row-id-masked').allInnerTexts()) expect(t).toMatch(MASK);
  await expect(reg2.locator('[data-testid=queue-row][data-case-no="EG-2569-000025"]').getByTestId('row-id-masked')).toHaveText('X-XXXX-XXXXX-65-9');
  await expect(reg2.locator('[data-testid=queue-row][data-case-no="EG-2569-000026"]').getByTestId('row-id-masked')).toHaveText('X-XXXX-XXXXX-45-6');
  await reg2.goto('/officer/cases/EG-2569-000025');
  await expect(reg2.getByTestId('applicant-id')).toHaveText('X-XXXX-XXXXX-65-9');
  const html = await reg2.content();
  expect(html).not.toContain('3100600987659');
  expect(html).not.toContain('3-1006-00987-65-9');
  const hd = await h.pageS('head1');
  await hd.goto('/officer/cases/EG-2569-000025');
  await expect(hd.getByTestId('applicant-id')).toHaveText('X-XXXX-XXXXX-65-9');
  const sy = await h.pageC('somying');
  await sy.goto('/citizen/cases/EG-2569-000025');
  await expect(sy.getByTestId('case-id-full')).toHaveText('3-1006-00987-65-9');
  const sc = await h.pageC('somchai');
  await sc.goto('/citizen/cases/EG-2569-000020');
  await expect(sc.getByTestId('case-id-full')).toHaveText('1-1017-00123-45-6');
});

test('TC-PDPA-02 API (JSON) ไม่ส่งเลขบัตรเต็ม', async ({ h }) => {
  const hasKey = (o, k) => o && typeof o === 'object' && (Object.prototype.hasOwnProperty.call(o, k) || Object.values(o).some(v => hasKey(v, k)));
  const urls = ['/api/officer/queue?filter=all', '/api/cases/EG-2569-000025', '/api/cases/EG-2569-000026', '/api/cases/EG-2569-000020', '/api/notifications', '/api/cases/EG-2569-000025/files'];
  await h.reset();
  for (const user of ['off.reg1', 'head1']) {
    const ctx = await h.loginS(user);
    for (const url of urls) {
      const r = await ctx.get(url);
      const label = `${user} GET ${url}`;
      expect.soft(r.status(), label).toBe(200);
      expect.soft(r.headers()['content-type'], label).toContain('application/json');
      const body = await r.json();
      const s = JSON.stringify(body);
      expect.soft(s.match(/\d{13}/g), `${label}: 13-digit run`).toBeNull();
      expect.soft(s.match(/\d-\d{4}-\d{5}-\d{2}-\d/g), `${label}: formatted ID`).toBeNull();
      expect.soft(hasKey(body, 'idNo'), `${label}: has key idNo`).toBe(false);
      for (const id of ['3100600987659', '1101700123456', '1909900555015']) expect.soft(s.includes(id), `${label}: contains ${id}`).toBe(false);
      for (const m of (body.items || []).map(i => i.idMasked).filter(x => x !== undefined)) expect.soft(m, label).toMatch(MASK);
      if (url.startsWith('/api/cases/EG') && !url.endsWith('files')) expect.soft(body.idMasked, label).toMatch(MASK);
    }
  }
});

test('TC-PDPA-03 แสดงเลขเต็มต้องมีเหตุผลและบันทึก Audit', async ({ h }) => {
  await h.reset();
  const p = await h.pageS('off.reg2');
  await p.goto('/officer/cases/EG-2569-000025');
  await p.getByTestId('show-full-id-btn').click();
  for (const reason of ['', '   ']) {
    await p.getByTestId('unmask-reason').fill(reason);
    await p.getByTestId('unmask-submit').click();
    await expect(p.getByTestId('unmask-error'), JSON.stringify(reason)).toHaveText('กรุณากรอกเหตุผล');
    await expect(p.getByTestId('full-id')).toHaveCount(0);
    await h.expectErr(await p.request.post('/api/officer/cases/EG-2569-000025/unmask', { data: { reason } }), 400, 'REASON_REQUIRED', JSON.stringify(reason));
  }
  await p.getByTestId('unmask-reason').fill('ตรวจสอบตัวตนซ้ำ');
  await p.getByTestId('unmask-submit').click();
  await expect(p.getByTestId('full-id')).toHaveText('3-1006-00987-65-9');
  await p.reload();
  await expect(p.getByTestId('applicant-id')).toHaveText('X-XXXX-XXXXX-65-9');
  await expect(p.getByTestId('full-id')).toHaveCount(0);
  const au = await h.pageS('audit1');
  await au.goto('/audit');
  await au.getByTestId('audit-filter-event').selectOption('UNMASK');
  await au.getByTestId('audit-apply-btn').click();
  await expect(au.getByTestId('audit-count')).toHaveText('1');
  const row = au.getByTestId('audit-row');
  await expect(row).toHaveAttribute('data-actor', 'off.reg2');
  await expect(row.getByTestId('audit-role')).toHaveText('officer');
  await expect(row.getByTestId('audit-case-no')).toHaveText('EG-2569-000025');
  await expect(row.getByTestId('audit-event')).toHaveText('UNMASK');
  await expect(row.getByTestId('audit-detail')).toContainText('ตรวจสอบตัวตนซ้ำ');
  await expect(row.getByTestId('audit-time')).toHaveAttribute('data-iso', '2026-12-01T09:00:00+07:00');
  for (const ctx of [await h.loginS('exec1'), await h.loginS('audit1'), await h.loginC('somying')]) {
    expect((await ctx.post('/api/officer/cases/EG-2569-000025/unmask', { data: { reason: 'x' } })).status()).toBe(403);
  }
});
