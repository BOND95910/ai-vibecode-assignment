// หมวด WORKFLOW · TC-WORKFLOW-01 ถึง 06 (WORKFLOW-04 จับ B12)
const { test, expect } = require('../helpers/world');
const { eq, ok, status, err, tid, text, attr, count, hidden, match, contains } = require('../helpers/check');
const { get, post } = require('../helpers/http');
const { CASE } = require('../helpers/thai');
const {
  officerCase, citizenCase, queueReady, rowAttr, queueRow, doApprove, doIssue, doForward, doReturn, doReject, doClaimRow,
} = require('../helpers/ui');

const R10 = 'xxxxxxxxxx';

async function workload(page) {
  await page.goto('/officer/queue');
  await queueReady(page);
}
// เปิด /verify/<code> แบบไม่ล็อกอิน แล้วอ่านผู้ลงนาม
async function verifySigner(w, code, expected, label) {
  const anon = await w.session('anon');
  await anon.page.goto(`/verify/${code}`);
  await text(anon.page, 'verify-signer', expected, `${label} verify-signer`);
}

test('TC-WORKFLOW-01 SV-01 อนุมัติ + ออกเอกสาร', async ({ w }) => {
  await w.reset();
  const off = await w.session('off.reg2');
  const page = off.page;
  const N = CASE(25);
  await officerCase(page, N);

  // 1 ตรวจปุ่ม
  await text(page, 'case-status', 'กำลังตรวจสอบ', 'ขั้น 1 case-status');
  await count(tid(page, 'approve-btn'), 1, 'ขั้น 1 approve-btn');
  await count(tid(page, 'return-btn'), 1, 'ขั้น 1 return-btn');
  await count(tid(page, 'reject-btn'), 1, 'ขั้น 1 reject-btn');
  await count(tid(page, 'forward-btn'), 0, 'ขั้น 1 forward-btn ต้อง 0');
  await count(tid(page, 'issue-btn'), 0, 'ขั้น 1 issue-btn ต้อง 0');
  await text(page, 'case-fee', '฿60', 'ขั้น 1 case-fee');

  // 2 off.reg1 ไม่ใช่ผู้ถือ …000026
  const reg1 = await w.api('off.reg1');
  err(await post(reg1, `/api/cases/${CASE(26)}/approve`), 403, 'FORBIDDEN', null, 'ขั้น 2 off.reg1 approve …000026 (ผู้ถือคือ off.reg2)');

  // 3 อนุมัติ
  await doApprove(page);
  await text(page, 'case-status', 'อนุมัติ', 'ขั้น 3 case-status');
  await attr(tid(page, 'case-status'), 'data-status', 'APPROVED', 'ขั้น 3 data-status');
  await count(tid(page, 'issue-btn'), 1, 'ขั้น 3 issue-btn');
  await count(tid(page, 'approve-btn'), 0, 'ขั้น 3 approve-btn');

  // 4 ออกเอกสาร
  await doIssue(page);
  await text(page, 'case-status', 'เสร็จสิ้น', 'ขั้น 4 case-status');
  await attr(tid(page, 'case-status'), 'data-status', 'COMPLETED', 'ขั้น 4 data-status');
  await text(page, 'doc-no', 'DOC-2569-000002', 'ขั้น 4 doc-no');
  await expect(tid(page, 'verify-code'), 'ขั้น 4 verify-code ต้องเป็น [A-Z0-9]{8}').toHaveText(/^[A-Z0-9]{8}$/);
  await attr(tid(page, 'closed-at'), 'data-iso', '2026-12-01T09:00:00+07:00', 'ขั้น 4 closed-at');
  await text(page, 'sla-level', 'ปิดแล้ว', 'ขั้น 4 sla-level');

  // 5 ประชาชนเห็นและดาวน์โหลด
  const cit = await w.session('somying');
  await citizenCase(cit.page, N);
  await text(cit.page, 'case-status', 'เสร็จสิ้น', 'ขั้น 5 case-status');
  await count(tid(cit.page, 'download-doc-btn'), 1, 'ขั้น 5 download-doc-btn');
  const pdf = await get(cit.api, '/api/documents/DOC-2569-000002/pdf');
  status(pdf, 200, 'ขั้น 5 GET pdf');
  contains(pdf.headers['content-type'], 'application/pdf', 'ขั้น 5 Content-Type');
  contains(pdf.headers['content-disposition'], 'DOC-2569-000002.pdf', 'ขั้น 5 Content-Disposition');
  contains(pdf.buf.toString('latin1'), `docNo=DOC-2569-000002 caseNo=${N}`, 'ขั้น 5 เนื้อไฟล์');

  // 6 Dashboard
  const d = await w.dashboard('2026-12', 'ALL');
  eq({ closed: d.closed, onTime: d.onTime, received: d.received, backlog: d.backlog }, { closed: 1, onTime: 1, received: 3, backlog: 20 }, 'ขั้น 6 Dashboard');
});

test('TC-WORKFLOW-02 SV-02 ผ่านหัวหน้า', async ({ w }) => {
  await w.reset();
  const N = CASE(13);
  const off2 = await w.session('off.reg2');
  await officerCase(off2.page, N);

  // 1
  await count(tid(off2.page, 'approve-btn'), 0, 'ขั้น 1 approve-btn ต้อง 0');
  await count(tid(off2.page, 'forward-btn'), 1, 'ขั้น 1 forward-btn');
  await count(tid(off2.page, 'forward-target'), 0, 'ขั้น 1 ไม่มีช่องเลือกปลายทาง forward-target');

  // 2
  await doForward(off2.page);
  await text(off2.page, 'case-status', 'รออนุมัติ', 'ขั้น 2 case-status');
  await attr(tid(off2.page, 'case-status'), 'data-status', 'PENDING_APPROVAL', 'ขั้น 2 data-status');
  await workload(off2.page);
  await text(off2.page, 'workload-count', '8', 'ขั้น 2 workload-count');
  await count(queueRow(off2.page, N), 0, 'ขั้น 2 …000013 ต้องหายจากคิวทะเบียน');

  // 3 หัวหน้า
  const hd = await w.session('head1');
  await hd.page.goto('/head/approvals');
  await expect(hd.page.getByTestId('approval-row').first()).toBeVisible();
  await count(hd.page.getByTestId('approval-row'), 3, 'ขั้น 3 approval-row');
  eq(await rowAttr(hd.page, 'approval-row', 'data-case-no'), [CASE(13), CASE(14), CASE(11)], 'ขั้น 3 ลำดับ');

  // 4
  await hd.page.locator(`[data-testid="approval-row"][data-case-no="${N}"]`).getByTestId('approval-open').click();
  await expect(hd.page).toHaveURL(new RegExp(`/officer/cases/${N}$`));
  await caseReadyCount(hd.page, N, { approve: 1, reject: 1, issue: 0 }, 'ขั้น 4');

  // 5
  await doApprove(hd.page);
  await text(hd.page, 'case-status', 'อนุมัติ', 'ขั้น 5 case-status');
  await attr(tid(hd.page, 'case-status'), 'data-status', 'APPROVED', 'ขั้น 5 data-status');
  await count(tid(hd.page, 'issue-btn'), 0, 'ขั้น 5 หัวหน้าไม่มี issue-btn (A-27)');

  // 6 off.reg1 ไม่ใช่ผู้รับเรื่อง
  const off1 = await w.session('off.reg1');
  await officerCase(off1.page, N);
  await count(tid(off1.page, 'issue-btn'), 0, 'ขั้น 6 off.reg1 issue-btn');
  err(await post(off1.api, `/api/officer/cases/${N}/issue`), 403, 'FORBIDDEN', null, 'ขั้น 6 off.reg1 issue API');

  // 7 off.reg2 ออกเอกสาร
  await officerCase(off2.page, N);
  await doIssue(off2.page);
  await text(off2.page, 'case-status', 'เสร็จสิ้น', 'ขั้น 7 case-status');
  await text(off2.page, 'doc-no', 'DOC-2569-000002', 'ขั้น 7 doc-no');
  const code = (await tid(off2.page, 'verify-code').textContent()).trim();
  match(code, /^[A-Z0-9]{8}$/, 'ขั้น 7 verify-code');
  await verifySigner(w, code, 'หัวหน้าฝ่าย', 'ขั้น 7');

  // 8 seed …000019 (APPROVED โดย head1) ออกเอกสารโดย off.reg1
  await w.reset();
  const o1 = await w.session('off.reg1');
  await officerCase(o1.page, CASE(19));
  await doIssue(o1.page);
  await text(o1.page, 'case-status', 'เสร็จสิ้น', 'ขั้น 8 case-status');
  await text(o1.page, 'doc-no', 'DOC-2569-000002', 'ขั้น 8 doc-no');
  const code2 = (await tid(o1.page, 'verify-code').textContent()).trim();
  await verifySigner(w, code2, 'หัวหน้าฝ่าย', 'ขั้น 8');
});

// รอหน้าคำขอโหลด แล้วตรวจจำนวนปุ่ม {approve, reject, issue ...}
async function caseReadyCount(page, caseNo, counts, label) {
  await expect(tid(page, 'case-no')).toHaveText(caseNo);
  await expect(tid(page, 'case-status')).toHaveAttribute('data-status', /\S/);
  for (const [k, n] of Object.entries(counts)) await count(tid(page, `${k}-btn`), n, `${label} ${k}-btn`);
}

test('TC-WORKFLOW-03 SV-03 สามขั้นตอน', async ({ w }) => {
  await w.reset();
  const N = CASE(12);
  const off2 = await w.session('off.reg2');
  await officerCase(off2.page, N);

  // 1
  await text(off2.page, 'case-step', 'ขั้นตอน 1/3 · ฝ่ายทะเบียน', 'ขั้น 1 case-step');
  await text(off2.page, 'case-fee', '฿1,010', 'ขั้น 1 case-fee');
  await count(tid(off2.page, 'forward-btn'), 1, 'ขั้น 1 forward-btn');

  // 2
  await doForward(off2.page);
  await text(off2.page, 'case-status', 'กำลังตรวจสอบ', 'ขั้น 2 case-status (ยัง IN_REVIEW)');
  await text(off2.page, 'case-step', 'ขั้นตอน 2/3 · ฝ่ายโยธา', 'ขั้น 2 case-step');
  await text(off2.page, 'case-owner', 'ยังไม่มีผู้รับ', 'ขั้น 2 case-owner');
  await workload(off2.page);
  await text(off2.page, 'workload-count', '8', 'ขั้น 2 workload-count');

  // 3
  await count(queueRow(off2.page, N), 0, 'ขั้น 3 off.reg2 ไม่เห็น …000012');
  await count(off2.page.getByTestId('queue-row'), 16, 'ขั้น 3 queue-row เหลือ 16');

  // 4
  const wk = await w.session('off.works1');
  await wk.page.goto('/officer/queue');
  await queueReady(wk.page);
  await count(wk.page.getByTestId('queue-row'), 2, 'ขั้น 4 queue-row ของ off.works1');
  eq(await rowAttr(wk.page, 'queue-row', 'data-case-no'), [CASE(10), N], 'ขั้น 4 ลำดับ (000010 → 000012)');
  await count(wk.page.getByTestId('claim-btn'), 2, 'ขั้น 4 claim-btn');

  // 5
  const off1 = await w.api('off.reg1');
  err(await post(off1, `/api/officer/cases/${N}/claim`), 403, 'FORBIDDEN', null, 'ขั้น 5 off.reg1 claim ข้ามแผนก');

  // 6
  await doClaimRow(wk.page, N);
  await officerCase(wk.page, N);
  await text(wk.page, 'case-owner', 'off.works1', 'ขั้น 6 case-owner ก่อนส่งต่อ');
  await doForward(wk.page);
  await text(wk.page, 'case-status', 'รออนุมัติ', 'ขั้น 6 case-status');
  await text(wk.page, 'case-step', 'ขั้นตอน 3/3 · หัวหน้าฝ่าย', 'ขั้น 6 case-step');

  // 7
  const hd = await w.session('head1');
  await hd.page.goto('/head/approvals');
  await expect(hd.page.getByTestId('approval-row').first()).toBeVisible();
  await count(hd.page.getByTestId('approval-row'), 3, 'ขั้น 7 approval-row');
  await count(hd.page.locator(`[data-testid="approval-row"][data-case-no="${N}"]`), 1, 'ขั้น 7 มีแถว …000012');
  await hd.page.locator(`[data-testid="approval-row"][data-case-no="${N}"]`).getByTestId('approval-open').click();
  await caseReadyCount(hd.page, N, { approve: 1 }, 'ขั้น 7');
  await doApprove(hd.page);
  await text(hd.page, 'case-status', 'อนุมัติ', 'ขั้น 7 case-status');

  // 8
  await officerCase(wk.page, N);
  await count(tid(wk.page, 'issue-btn'), 0, 'ขั้น 8 off.works1 issue-btn');
  await officerCase(off2.page, N);
  await count(tid(off2.page, 'issue-btn'), 1, 'ขั้น 8 off.reg2 (ทะเบียนขั้นแรก) issue-btn');
  await doIssue(off2.page);
  await text(off2.page, 'case-status', 'เสร็จสิ้น', 'ขั้น 8 case-status');
  const code = (await tid(off2.page, 'verify-code').textContent()).trim();
  await verifySigner(w, code, 'หัวหน้าฝ่าย', 'ขั้น 8');
});

test('TC-WORKFLOW-04 ตีกลับสูงสุด 2 ครั้ง และผลหลังครบ', async ({ w }) => {
  const E_LIMIT = 'ตีกลับได้สูงสุด 2 ครั้ง';

  // ---- ส่วน A SV-01 …000020 ----
  await w.reset();
  const N = CASE(20);
  const off = await w.session('off.reg1');
  const som = await w.api('somchai');
  await officerCase(off.page, N);
  await text(off.page, 'return-count', '0', 'A: return-count เริ่มต้น');
  await doReturn(off.page, R10);
  await text(off.page, 'case-status', 'รอแก้ไขเอกสาร', 'A.1 case-status');
  await text(off.page, 'return-count', '1', 'A.1 return-count');
  let r = await post(som, `/api/cases/${N}/resubmit`);
  status(r, 200, 'A.2 สมชายส่งแก้');
  eq(r.body.status, 'IN_REVIEW', 'A.2 status');
  await officerCase(off.page, N);
  await text(off.page, 'case-status', 'กำลังตรวจสอบ', 'A.2 case-status');
  eq((await get(off.api, `/api/cases/${N}`)).body.owner, 'off.reg1', 'A.2 ผู้ถือเดิม');
  await doReturn(off.page, R10);
  await text(off.page, 'case-status', 'รอแก้ไขเอกสาร', 'A.3 case-status');
  await text(off.page, 'return-count', '2', 'A.3 return-count');
  r = await post(som, `/api/cases/${N}/resubmit`);
  status(r, 200, 'A.4 สมชายส่งแก้');
  await officerCase(off.page, N);
  await text(off.page, 'case-status', 'กำลังตรวจสอบ', 'A.4 case-status');
  // A.5
  await count(tid(off.page, 'return-btn'), 0, 'A.5 return-btn ต้อง 0 (B12: ตีกลับครั้งที่ 3 ต้องไม่ได้)');
  r = await post(off.api, `/api/officer/cases/${N}/return`, { reason: R10 });
  err(r, 409, 'RETURN_LIMIT', E_LIMIT, 'A.5 API return ครั้งที่ 3');
  const g = await get(off.api, `/api/cases/${N}`);
  eq(g.body.status, 'IN_REVIEW', 'A.5 สถานะยัง IN_REVIEW');
  eq(g.body.returnCount, 2, 'A.5 returnCount ยัง 2');
  await officerCase(off.page, N);
  await text(off.page, 'return-count', '2', 'A.5 return-count');
  await count(tid(off.page, 'approve-btn'), 1, 'A.5 SV-01 ยังอนุมัติได้ approve-btn');
  await count(tid(off.page, 'reject-btn'), 1, 'A.5 SV-01 ยังไม่อนุมัติได้ reject-btn');

  // ---- ส่วน B seed …000023 ----
  await w.reset();
  const b = await w.session('off.reg1');
  await officerCase(b.page, CASE(23));
  await text(b.page, 'return-count', '2', 'B: return-count');
  await count(tid(b.page, 'return-btn'), 0, 'B: return-btn ต้อง 0');
  r = await post(b.api, `/api/officer/cases/${CASE(23)}/return`, { reason: R10 });
  err(r, 409, 'RETURN_LIMIT', E_LIMIT, 'B: API return');
  eq((await get(b.api, `/api/cases/${CASE(23)}`)).body.status, 'IN_REVIEW', 'B: สถานะยัง IN_REVIEW');
  await count(tid(b.page, 'approve-btn'), 1, 'B: approve-btn');
  await count(tid(b.page, 'reject-btn'), 1, 'B: reject-btn');

  // ---- ส่วน C SV-02 …000013 หลังตีกลับครบ 2 ครั้ง ----
  await w.reset();
  const C = CASE(13);
  const o2 = await w.session('off.reg2');
  const s2 = await w.api('somchai');
  for (let i = 1; i <= 2; i++) {
    r = await post(o2.api, `/api/officer/cases/${C}/return`, { reason: R10 });
    status(r, 200, `C: ตีกลับครั้งที่ ${i}`);
    r = await post(s2, `/api/cases/${C}/resubmit`);
    status(r, 200, `C: สมชายส่งแก้ครั้งที่ ${i}`);
  }
  await officerCase(o2.page, C);
  await count(tid(o2.page, 'return-btn'), 0, 'C: return-btn');
  await count(tid(o2.page, 'approve-btn'), 0, 'C: approve-btn');
  await count(tid(o2.page, 'reject-btn'), 0, 'C: reject-btn (เจ้าหน้าที่ขั้นแผนกของ SV-02 ไม่ตัดสินไม่อนุมัติ)');
  await count(tid(o2.page, 'forward-btn'), 1, 'C: forward-btn');
  err(await post(o2.api, `/api/cases/${C}/reject`, { reason: R10 }), 403, 'FORBIDDEN', null, 'C: off.reg2 reject API');
  await doForward(o2.page, 'ส่งต่อให้หัวหน้าพิจารณา');
  await text(o2.page, 'case-status', 'รออนุมัติ', 'C: case-status หลังส่งต่อ');
  const fw = (await w.auditItems('event=FORWARD')).items.filter((i) => i.caseNo === C);
  eq(fw.length, 1, 'C: Audit FORWARD ของ …000013');
  contains(fw[0].detail, 'ส่งต่อให้หัวหน้าพิจารณา', 'C: Audit FORWARD detail (API)');
  const au = await w.session('audit1');
  await au.page.goto('/audit');
  await tid(au.page, 'audit-filter-event').selectOption('FORWARD');
  await tid(au.page, 'audit-apply-btn').click();
  await count(au.page.getByTestId('audit-row'), 1, 'C: audit-row FORWARD');
  await expect(au.page.getByTestId('audit-detail').first(), 'C: audit-detail ต้องมีหมายเหตุส่งต่อ').toContainText('ส่งต่อให้หัวหน้าพิจารณา');
  const hd = await w.session('head1');
  await officerCase(hd.page, C);
  await count(tid(hd.page, 'reject-btn'), 1, 'C: head1 reject-btn');
  await count(tid(hd.page, 'approve-btn'), 1, 'C: head1 approve-btn');
});

test('TC-WORKFLOW-05 เหตุผล ≥ 10 ตัวอักษร (ตีกลับ/ไม่อนุมัติ)', async ({ w }) => {
  const E = 'กรุณากรอกเหตุผลอย่างน้อย 10 ตัวอักษร';
  const NINE = 'xxxxxxxxx';
  const SPACES = ' '.repeat(10);

  // ---- ส่วน A ตีกลับ …000020 ----
  await w.reset();
  const A = CASE(20);
  const off = await w.session('off.reg1');
  await officerCase(off.page, A);
  await tid(off.page, 'return-btn').click();
  for (const [reason, why] of [[NINE, '9 ตัว'], [SPACES, 'เว้นวรรคล้วน 10 ตัว']]) {
    await tid(off.page, 'return-reason').fill(reason);
    await tid(off.page, 'return-submit').click();
    await text(off.page, 'return-reason-error', E, `A: return-reason-error (${why})`);
    const r = await post(off.api, `/api/officer/cases/${A}/return`, { reason });
    err(r, 400, 'REASON_TOO_SHORT', E, `A: API return (${why})`);
  }
  eq((await get(off.api, `/api/cases/${A}`)).body.status, 'IN_REVIEW', 'A: สถานะยังกำลังตรวจสอบหลังเหตุผลสั้น');
  eq((await get(off.api, `/api/cases/${A}`)).body.returnCount, 0, 'A: returnCount ยัง 0');
  await tid(off.page, 'return-reason').fill(R10);
  await tid(off.page, 'return-submit').click();
  await text(off.page, 'case-status', 'รอแก้ไขเอกสาร', 'A: 10 ตัวสำเร็จ case-status');
  const som = await w.session('somchai');
  await citizenCase(som.page, A);
  await text(som.page, 'return-reason-display', R10, 'A: สมชายเห็น return-reason-display');

  // ---- ส่วน B ไม่อนุมัติ SV-01 …000026 ----
  await w.reset();
  const B = CASE(26);
  const o2 = await w.session('off.reg2');
  await officerCase(o2.page, B);
  await tid(o2.page, 'reject-btn').click();
  await tid(o2.page, 'reject-reason').fill(NINE);
  await tid(o2.page, 'reject-submit').click();
  await text(o2.page, 'reject-reason-error', E, 'B: reject-reason-error (9 ตัว)');
  err(await post(o2.api, `/api/cases/${B}/reject`, { reason: NINE }), 400, 'REASON_TOO_SHORT', E, 'B: API reject 9 ตัว');
  await tid(o2.page, 'reject-reason').fill(R10);
  await tid(o2.page, 'reject-submit').click();
  await text(o2.page, 'case-status', 'ไม่อนุมัติ', 'B: case-status');
  await attr(tid(o2.page, 'case-status'), 'data-status', 'REJECTED', 'B: data-status');
  await attr(tid(o2.page, 'closed-at'), 'data-iso', '2026-12-01T09:00:00+07:00', 'B: closed-at');
  await text(o2.page, 'sla-level', 'ปิดแล้ว', 'B: sla-level');
  const s = await w.session('somchai');
  await citizenCase(s.page, B);
  await count(tid(s.page, 'no-refund-note'), 1, 'B: สมชายเห็น no-refund-note');
  const d = await w.dashboard('2026-12', 'ALL');
  eq({ closed: d.closed, onTime: d.onTime }, { closed: 1, onTime: 1 }, 'B: Dashboard (REJECTED นับเป็นปิดงาน ทันกำหนด) API');
  const ex = await w.session('exec1');
  await ex.page.goto('/dashboard');
  await text(ex.page, 'kpi-closed', '1', 'B: kpi-closed');

  // ---- ส่วน C หัวหน้าไม่อนุมัติ …000011 ----
  await w.reset();
  const Cn = CASE(11);
  const hd = await w.session('head1');
  await officerCase(hd.page, Cn);
  await tid(hd.page, 'reject-btn').click();
  await tid(hd.page, 'reject-reason').fill(NINE);
  await tid(hd.page, 'reject-submit').click();
  await text(hd.page, 'reject-reason-error', E, 'C: reject-reason-error (9 ตัว)');
  err(await post(hd.api, `/api/cases/${Cn}/reject`, { reason: NINE }), 400, 'REASON_TOO_SHORT', E, 'C: API reject 9 ตัว');
  await tid(hd.page, 'reject-reason').fill(R10);
  await tid(hd.page, 'reject-submit').click();
  await text(hd.page, 'case-status', 'ไม่อนุมัติ', 'C: case-status');
  await attr(tid(hd.page, 'case-status'), 'data-status', 'REJECTED', 'C: data-status');
});

test('TC-WORKFLOW-06 เวลาแก้ไข 168 ชั่วโมง', async ({ w }) => {
  const N = CASE(17);
  // ตรวจหน้าตั้งต้น
  await w.reset();
  let s = await w.session('somchai');
  await citizenCase(s.page, N);
  await text(s.page, 'case-status', 'รอแก้ไขเอกสาร', 'ตั้งต้น case-status');
  await text(s.page, 'return-reason-display', 'ชื่อในเอกสารไม่ตรงกับบัตร กรุณาแก้ไข', 'ตั้งต้น return-reason-display');
  await text(s.page, 'fix-deadline', '4 ธ.ค. 2569 14:00', 'ตั้งต้น fix-deadline');
  await attr(tid(s.page, 'fix-deadline'), 'data-iso', '2026-12-04T14:00:00+07:00', 'ตั้งต้น fix-deadline data-iso');
  await count(tid(s.page, 'submit-fix-btn'), 1, 'ตั้งต้น submit-fix-btn');

  // รอบ A 167:59
  await w.reset();
  await w.clock('2026-12-04T13:59:00+07:00');
  s = await w.session('somchai');
  await citizenCase(s.page, N);
  await expect(tid(s.page, 'submit-fix-btn'), 'รอบ A (167:59) submit-fix-btn ต้องใช้ได้').toBeEnabled();
  const [res] = await Promise.all([
    s.page.waitForResponse((r) => r.url().includes(`/api/cases/${N}/resubmit`)),
    tid(s.page, 'submit-fix-btn').click(),
  ]);
  eq(res.status(), 200, 'รอบ A resubmit HTTP');
  eq((await res.json()).status, 'IN_REVIEW', 'รอบ A resubmit status');
  await text(s.page, 'case-status', 'กำลังตรวจสอบ', 'รอบ A case-status');

  // รอบ B 168:00
  await w.reset();
  await w.clock('2026-12-04T14:00:00+07:00');
  s = await w.session('somchai');
  await citizenCase(s.page, N);
  await text(s.page, 'case-status', 'ยกเลิก', 'รอบ B case-status');
  await attr(tid(s.page, 'case-status'), 'data-status', 'CANCELLED', 'รอบ B data-status');
  await count(tid(s.page, 'submit-fix-btn'), 0, 'รอบ B submit-fix-btn ต้อง 0');
  await count(tid(s.page, 'no-refund-note'), 1, 'รอบ B no-refund-note');
  const rs = await post(s.api, `/api/cases/${N}/resubmit`);
  status(rs, 409, 'รอบ B resubmit หลังหมดเวลา');
  await count(s.page.locator('[data-testid="timeline-item"][data-iso="2026-12-04T14:00:00+07:00"]'), 1, 'รอบ B timeline-item เวลายกเลิก');
  const d = await w.dashboard('2026-12', 'ALL');
  eq(d.backlog, 20, 'รอบ B Dashboard backlog (API)');
  const ex = await w.session('exec1');
  await ex.page.goto('/dashboard');
  await text(ex.page, 'kpi-backlog', '20', 'รอบ B kpi-backlog');
});
