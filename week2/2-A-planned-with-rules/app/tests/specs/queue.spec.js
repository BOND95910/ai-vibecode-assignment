// หมวด QUEUE · TC-QUEUE-01 ถึง 03 (QUEUE-02 จับ B08)
const { test, expect } = require('../helpers/world');
const { eq, ok, status, err, tid, text, attr, count, hidden, match } = require('../helpers/check');
const { get, post } = require('../helpers/http');
const { CASE } = require('../helpers/thai');
const { queueRow, queueReady, rowAttr, rowCellTexts, lastDigits, doApprove, doReturn, officerCase, doClaimRow, citizenCase } = require('../helpers/ui');

const nos = (arr) => arr.map(CASE);

test('TC-QUEUE-01 ลำดับคิวและขอบเขตแผนก', async ({ w }) => {
  await w.reset();
  const REG = [20, 22, 24, 23, 25, 26, 13, 15, 27, 28, 29, 30, 16, 18, 19, 12, 21];
  const reg1 = await w.session('off.reg1');
  const page = reg1.page;
  await page.goto('/officer/queue');
  await queueReady(page);
  await expect(tid(page, 'queue-filter'), 'queue-filter ค่าเริ่มต้น').toHaveValue('all');

  // 17 แถว ลำดับตาม BR-16
  await count(page.getByTestId('queue-row'), 17, 'off.reg1 queue-row');
  eq(lastDigits(await rowAttr(page, 'queue-row', 'data-case-no')), REG.map((n) => String(n).padStart(6, '0')), 'ลำดับ data-case-no (6 หลักท้าย)');
  const levels = await rowCellTexts(page, 'queue-row', 'row-sla-level');
  eq(levels.slice(0, 3), ['เกินกำหนด', 'ใกล้ครบกำหนด', 'ใกล้ครบกำหนด'], 'row-sla-level 3 แถวแรก');
  for (const t of await rowCellTexts(page, 'queue-row', 'row-id-masked')) match(t, /^X-XXXX-XXXXX-\d{2}-\d$/, 'row-id-masked');

  // claim-btn 4 ปุ่ม (000024 000028 000029 000030)
  await count(page.getByTestId('claim-btn'), 4, 'claim-btn ทั้งหน้า');
  for (const n of [24, 28, 29, 30]) await count(queueRow(page, CASE(n)).getByTestId('claim-btn'), 1, `claim-btn ของ …${n}`);
  await count(queueRow(page, CASE(19)).getByTestId('claim-btn'), 0, 'แถว APPROVED …000019 ต้องไม่มี claim-btn');

  // ตัวกรอง
  await tid(page, 'queue-filter').selectOption('unclaimed');
  await count(page.getByTestId('queue-row'), 4, 'filter unclaimed');
  eq(lastDigits(await rowAttr(page, 'queue-row', 'data-case-no')), ['000024', '000028', '000029', '000030'], 'unclaimed ลำดับ');
  await tid(page, 'queue-filter').selectOption('mine');
  await count(page.getByTestId('queue-row'), 3, 'filter mine ของ off.reg1');
  eq(lastDigits(await rowAttr(page, 'queue-row', 'data-case-no')), ['000020', '000022', '000023'], 'mine ลำดับ');
  await text(page, 'workload-count', '3', 'workload-count ของ off.reg1');

  // ไม่อยู่ในคิว: 000017 NEED_FIX · 000011 000014 PENDING_APPROVAL
  await tid(page, 'queue-filter').selectOption('all');
  await count(page.getByTestId('queue-row'), 17, 'กลับ filter all');
  for (const n of [17, 11, 14]) await count(queueRow(page, CASE(n)), 0, `…${n} ต้องไม่อยู่ในคิว`);

  // off.reg2
  const reg2 = await w.session('off.reg2');
  await reg2.page.goto('/officer/queue');
  await queueReady(reg2.page);
  await tid(reg2.page, 'queue-filter').selectOption('mine');
  await count(reg2.page.getByTestId('queue-row'), 9, 'off.reg2 mine');
  eq(lastDigits(await rowAttr(reg2.page, 'queue-row', 'data-case-no')), ['000025', '000026', '000013', '000015', '000027', '000016', '000018', '000012', '000021'], 'off.reg2 mine ลำดับ');
  await text(reg2.page, 'workload-count', '9', 'workload-count ของ off.reg2');

  // off.works1 เห็นเฉพาะ …000010
  const wk = await w.session('off.works1');
  await wk.page.goto('/officer/queue');
  await queueReady(wk.page);
  await count(wk.page.getByTestId('queue-row'), 1, 'off.works1 queue-row');
  eq(await rowAttr(wk.page, 'queue-row', 'data-case-no'), [CASE(10)], 'off.works1 เห็นเฉพาะ …000010');

  // head1 เห็น 18 แถว (ทะเบียน 17 + โยธา 1) และไม่มี claim-btn
  const hd = await w.session('head1');
  await hd.page.goto('/officer/queue');
  await queueReady(hd.page);
  await count(hd.page.getByTestId('queue-row'), 18, 'head1 queue-row');
  const headOrder = [20, 22, 24, 10, 23, 25, 26, 13, 15, 27, 28, 29, 30, 16, 18, 19, 12, 21];
  eq(lastDigits(await rowAttr(hd.page, 'queue-row', 'data-case-no')), headOrder.map((n) => String(n).padStart(6, '0')), 'head1 ลำดับ (กลุ่ม 3 ธ.ค.: 000010 → 000023 → 000025 → 000026)');
  await count(hd.page.getByTestId('claim-btn'), 0, 'head1 ต้องไม่มี claim-btn เลย');
});

test('TC-QUEUE-02 รับเรื่องซ้อน (พร้อมกันและต่อกัน)', async ({ w }) => {
  const claimsOf = (items, caseNo) => items.filter((i) => i.event === 'CLAIM' && i.caseNo === caseNo);
  const NAME = { 'off.reg1': 'เจ้าหน้าที่ทะเบียน 1', 'off.reg2': 'เจ้าหน้าที่ทะเบียน 2' };

  // ---- ส่วน 1 พร้อมกัน (UI) ----
  await w.reset();
  const A = await w.session('off.reg1');
  const B = await w.session('off.reg2');
  for (const s of [A, B]) {
    await s.page.goto('/officer/queue');
    await queueReady(s.page);
    await count(queueRow(s.page, CASE(28)), 1, 'เห็นแถว …000028');
    await count(queueRow(s.page, CASE(28)).getByTestId('claim-btn'), 1, 'claim-btn ของ …000028');
  }
  await Promise.all([doClaimRow(A.page, CASE(28)), doClaimRow(B.page, CASE(28))]);
  const c28 = await get(A.api, `/api/cases/${CASE(28)}`);
  status(c28, 200, 'ส่วน 1 GET …000028');
  const winner = c28.body.owner;
  ok(['off.reg1', 'off.reg2'].includes(winner), `ส่วน 1 ต้องมีผู้ชนะ 1 คน แต่ owner = ${JSON.stringify(winner)}`);
  eq(c28.body.status, 'IN_REVIEW', 'ส่วน 1 status หลังรับเรื่อง');
  const [winP, loseP] = winner === 'off.reg1' ? [A.page, B.page] : [B.page, A.page];
  await expect(queueRow(winP, CASE(28)).getByTestId('row-owner'), `ส่วน 1 row-owner ของผู้ชนะ (${winner})`)
    .toHaveText(new RegExp(`${winner.replace('.', '\\.')}|${NAME[winner]}`));
  // ตรวจค่าจริงก่อน (Audit CLAIM) แล้วค่อยดูข้อความบนจอ: ถ้ารับซ้อนได้ จะล้มด้วย "expected 1 received 2" ไม่ใช่หา element ไม่เจอ
  let audit = await w.auditItems('event=CLAIM');
  eq(claimsOf(audit.items, CASE(28)).length, 1, 'ส่วน 1 Audit CLAIM ของ …000028 ต้องมี 1 แถวเท่านั้น');
  await text(loseP, 'action-error', 'มีเจ้าหน้าที่รับเรื่องนี้แล้ว', 'ส่วน 1 action-error ของคนที่แพ้');

  // ---- ส่วน 2 พร้อมกัน (API ยิง 10 ครั้ง) ----
  await w.reset();
  const r1 = await w.api('off.reg1');
  const r2 = await w.api('off.reg2');
  const calls = [];
  for (let i = 0; i < 5; i++) {
    calls.push(['off.reg1', post(r1, `/api/officer/cases/${CASE(29)}/claim`)]);
    calls.push(['off.reg2', post(r2, `/api/officer/cases/${CASE(29)}/claim`)]);
  }
  const res = await Promise.all(calls.map(([, p]) => p));
  const statuses = res.map((r) => r.status);
  const wins = res.map((r, i) => [calls[i][0], r]).filter(([, r]) => r.status === 200);
  eq(wins.length, 1, `ส่วน 2 ต้องตอบ 200 ครั้งเดียว (สถานะที่ได้ ${JSON.stringify(statuses)})`);
  res.filter((r) => r.status !== 200).forEach((r, i) => err(r, 409, 'ALREADY_CLAIMED', null, `ส่วน 2 คำขอที่แพ้ #${i + 1}`));
  const c29 = await get(r1, `/api/cases/${CASE(29)}`);
  eq(c29.body.owner, wins[0][0], 'ส่วน 2 owner = ผู้ชนะคนเดียว');
  eq(wins[0][1].body.owner, wins[0][0], 'ส่วน 2 body ของผู้ชนะ owner');
  audit = await w.auditItems('event=CLAIM');
  eq(claimsOf(audit.items, CASE(29)).length, 1, 'ส่วน 2 Audit CLAIM ของ …000029 ต้องมี 1 แถว');

  // ---- ส่วน 3 ต่อกัน (กำหนดได้ ไม่พึ่ง race) ----
  await w.reset();
  const a = await w.api('off.reg1');
  const b = await w.api('off.reg2');
  let r = await post(a, `/api/officer/cases/${CASE(29)}/claim`);
  status(r, 200, 'ส่วน 3 off.reg1 claim');
  eq(r.body.owner, 'off.reg1', 'ส่วน 3 owner หลัง off.reg1 รับ');
  r = await post(b, `/api/officer/cases/${CASE(29)}/claim`);
  err(r, 409, 'ALREADY_CLAIMED', 'มีเจ้าหน้าที่รับเรื่องนี้แล้ว', 'ส่วน 3 off.reg2 claim ซ้อน (B08: คนที่ 2 ต้องไม่ได้ 200)');
  const g = await get(a, `/api/cases/${CASE(29)}`);
  eq(g.body.owner, 'off.reg1', 'ส่วน 3 owner ต้องยังเป็น off.reg1');
  const dash = await w.dashboard();
  eq(dash.workload.find((x) => x.username === 'off.reg2').count, 9, 'ส่วน 3 งานในมือ off.reg2 ยัง 9');
  const q2 = await w.session('off.reg2');
  await q2.page.goto('/officer/queue');
  await queueReady(q2.page);
  await text(q2.page, 'workload-count', '9', 'ส่วน 3 workload-count ของ off.reg2');
  r = await post(a, `/api/officer/cases/${CASE(29)}/claim`);
  status(r, 409, 'ส่วน 3 off.reg1 claim ซ้ำเอง');
  audit = await w.auditItems('event=CLAIM');
  eq(claimsOf(audit.items, CASE(29)).length, 1, 'ส่วน 3 Audit CLAIM ของ …000029 ต้องมี 1 แถว');
});

test('TC-QUEUE-03 งานในมือสูงสุด 10', async ({ w }) => {
  await w.reset();
  const s = await w.session('off.reg2');
  const page = s.page;
  const E_LIMIT = 'รับงานได้สูงสุด 10 เรื่อง';
  const toQueue = async () => { await page.goto('/officer/queue'); await queueReady(page); };

  // 1-2
  await toQueue();
  await text(page, 'workload-count', '9', 'ขั้น 1 workload-count');
  await doClaimRow(page, CASE(28));
  await text(page, 'workload-count', '10', 'ขั้น 2 workload-count หลังรับเรื่องที่ 10');
  // 3
  await doClaimRow(page, CASE(29));
  await text(page, 'action-error', E_LIMIT, 'ขั้น 3 action-error');
  await text(page, 'workload-count', '10', 'ขั้น 3 workload-count ยัง 10');
  const lim = await post(s.api, `/api/officer/cases/${CASE(29)}/claim`);
  err(lim, 409, 'WORKLOAD_LIMIT', E_LIMIT, 'ขั้น 3 API claim ครั้งที่ 11');
  const g = await get(s.api, `/api/cases/${CASE(29)}`);
  eq(g.body.status, 'SUBMITTED', 'ขั้น 3 …000029 ยัง SUBMITTED');
  ok(!g.body.owner, 'ขั้น 3 …000029 ต้องไม่มีผู้รับ', `owner=${g.body.owner}`);
  // 4
  await officerCase(page, CASE(25));
  await doApprove(page);
  await text(page, 'case-status', 'อนุมัติ', 'ขั้น 4 case-status');
  await toQueue();
  await text(page, 'workload-count', '9', 'ขั้น 4 workload-count (APPROVED ไม่นับ)');
  // 5
  await doClaimRow(page, CASE(29));
  await text(page, 'workload-count', '10', 'ขั้น 5 workload-count');
  // 6 off.reg1 (3) ไม่ติดเพดาน
  const reg1 = await w.api('off.reg1');
  const c = await post(reg1, `/api/officer/cases/${CASE(30)}/claim`);
  status(c, 200, 'ขั้น 6 off.reg1 claim …000030');

  // 7 RESET · ตีกลับ …000025 งานในมือลดเหลือ 8
  await w.reset();
  const s2 = await w.session('off.reg2');
  const p2 = s2.page;
  await officerCase(p2, CASE(25));
  await doReturn(p2, 'xxxxxxxxxx');
  await text(p2, 'case-status', 'รอแก้ไขเอกสาร', 'ขั้น 7 case-status');
  await p2.goto('/officer/queue');
  await queueReady(p2);
  await text(p2, 'workload-count', '8', 'ขั้น 7 workload-count (NEED_FIX ไม่นับ)');
  // 8
  await doClaimRow(p2, CASE(28));
  await text(p2, 'workload-count', '9', 'ขั้น 8 หลังรับ …000028');
  await doClaimRow(p2, CASE(29));
  await text(p2, 'workload-count', '10', 'ขั้น 8 workload-count');
  // 9 สมหญิงส่งแก้ → คืนผู้ถือเดิม แม้เกิน 10
  const fixer = await w.session('somying');
  await citizenCase(fixer.page, CASE(25));
  await tid(fixer.page, 'submit-fix-btn').click();
  await text(fixer.page, 'case-status', 'กำลังตรวจสอบ', 'ขั้น 9 case-status หลังส่งแก้ (ต้องสำเร็จไม่ error)');
  const own = await get(s2.api, `/api/cases/${CASE(25)}`);
  eq(own.body.owner, 'off.reg2', 'ขั้น 9 ผู้ถือยัง off.reg2');
  await p2.goto('/officer/queue');
  await queueReady(p2);
  await text(p2, 'workload-count', '11', 'ขั้น 9 workload-count (ส่งแก้คืนผู้ถือเดิมแม้เกิน 10 ไม่ถือว่าผิด)');
  // 10
  const l2 = await post(s2.api, `/api/officer/cases/${CASE(30)}/claim`);
  err(l2, 409, 'WORKLOAD_LIMIT', E_LIMIT, 'ขั้น 10 claim …000030');
  await p2.reload();
  await queueReady(p2);
  await text(p2, 'workload-count', '11', 'ขั้น 10 workload-count ยัง 11');
});
