// หมวด SLA · TC-SLA-01 (จับ B03) · TC-SLA-02 (จับ B03 B04) · TC-SLA-03
const { test, expect } = require('../helpers/world');
const { eq, ok, status, err, tid, text, attr, count } = require('../helpers/check');
const { get, post } = require('../helpers/http');
const { CASE, thaiDateTime, LEVEL_TH } = require('../helpers/thai');
const { citizenCase, queueReady, rowAttr, rowCellTexts, queueRow, doReturn } = require('../helpers/ui');

const C31 = CASE(31);
const STEP = (n) => `ส่วนที่ ${n}`;

// ตรวจ dueAt ทั้งจาก API และบนจอ
async function expectDue(page, api, caseNo, iso, label) {
  const g = await get(api, `/api/cases/${caseNo}`);
  status(g, 200, `${label} GET ${caseNo}`);
  eq(g.body.dueAt, iso, `${label} dueAt`);
  await citizenCase(page, caseNo);
  await attr(tid(page, 'sla-due'), 'data-iso', iso, `${label} sla-due data-iso`);
  await text(page, 'sla-due', thaiDateTime(iso), `${label} sla-due ข้อความ`);
}
async function expectLevel(page, api, caseNo, level, label) {
  const g = await get(api, `/api/cases/${caseNo}`);
  status(g, 200, `${label} GET ${caseNo}`);
  eq(g.body.slaLevel, level, `${label} slaLevel (API)`);
  await citizenCase(page, caseNo);
  await text(page, 'sla-level', LEVEL_TH[level], `${label} sla-level`);
  await attr(tid(page, 'sla-level'), 'data-level', level, `${label} sla-level data-level`);
}

test('TC-SLA-01 กำหนดเสร็จตามตารางวันที่', async ({ w }) => {
  const rows = [
    { id: 'a', service: 'SV-01', at: '2026-12-01T09:00:00+07:00', due: '2026-12-04T16:30:00+07:00' },
    { id: 'b', service: 'SV-01', at: '2026-12-01T16:29:00+07:00', due: '2026-12-04T16:30:00+07:00' },
    { id: 'c', service: 'SV-01', at: '2026-12-01T16:30:00+07:00', due: '2026-12-08T16:30:00+07:00' },
    { id: 'd', service: 'SV-01', at: '2026-12-04T10:00:00+07:00', due: '2026-12-11T16:30:00+07:00' },
    { id: 'e', service: 'SV-01', at: '2026-12-05T10:00:00+07:00', due: '2026-12-14T16:30:00+07:00' },
    { id: 'f', service: 'SV-02', at: '2026-12-01T09:00:00+07:00', due: '2026-12-17T16:30:00+07:00' },
    { id: 'g', service: 'SV-03', at: '2026-12-01T09:00:00+07:00', due: '2026-12-24T16:30:00+07:00' },
    { id: 'h', service: 'SV-01', at: '2026-12-29T10:00:00+07:00', due: '2027-01-05T16:30:00+07:00' },
    { id: 'i', service: 'SV-01', at: '2026-12-31T23:59:00+07:00', due: '2027-01-07T16:30:00+07:00' },
  ];
  for (const row of rows) {
    await w.reset();
    const s = await w.session('somchai');
    const p = await w.newPaid({ r: s.api, service: row.service, at: row.at, qty: 1, areaSqm: 100 });
    const label = `แถว ${row.id} (${row.service} ชำระ ${row.at})`;
    eq(p.caseNo, C31, `${label} caseNo (RESET แล้วต้องได้ …000031)`);
    await expectDue(s.page, s.api, C31, row.due, label);
  }
});

test('TC-SLA-02 หยุดนับ SLA ระหว่างรอแก้ไข', async ({ w }) => {
  const reasons = 'xxxxxxxxxx';

  // ---- ส่วน 1 (DECISIONS ข้อ 8 แถว 6) ----
  await w.reset();
  const s = await w.session('somchai');
  const p = await w.newPaid({ r: s.api, service: 'SV-01', at: '2026-12-01T09:00:00+07:00' });
  eq(p.caseNo, C31, 'ส่วน 1 caseNo');
  const first = await get(s.api, `/api/cases/${C31}`);
  eq(first.body.dueAt, '2026-12-04T16:30:00+07:00', 'ส่วน 1 dueAt เริ่มต้น');
  await w.clock('2026-12-02T11:00:00+07:00');
  const reg1 = await w.api('off.reg1');
  status(await post(reg1, `/api/officer/cases/${C31}/claim`), 200, 'ส่วน 1 claim');
  const ret = await post(reg1, `/api/officer/cases/${C31}/return`, { reason: reasons });
  status(ret, 200, 'ส่วน 1 return');
  await citizenCase(s.page, C31);
  await text(s.page, 'case-status', 'รอแก้ไขเอกสาร', 'ส่วน 1 case-status');
  await text(s.page, 'sla-level', 'หยุดนับ', 'ส่วน 1 sla-level');
  await attr(tid(s.page, 'sla-level'), 'data-level', 'paused', 'ส่วน 1 data-level');
  await attr(tid(s.page, 'fix-deadline'), 'data-iso', '2026-12-09T11:00:00+07:00', 'ส่วน 1 fix-deadline');
  await w.clock('2026-12-03T10:00:00+07:00');
  await s.page.reload();
  await tid(s.page, 'submit-fix-btn').click();
  await text(s.page, 'case-status', 'กำลังตรวจสอบ', 'ส่วน 1 case-status หลังส่งแก้');
  const after = await get(reg1, `/api/cases/${C31}`);
  eq(after.body.owner, 'off.reg1', 'ส่วน 1 ผู้ถือเรื่องเดิม');
  eq(after.body.dueAt, '2026-12-08T16:30:00+07:00', 'ส่วน 1 dueAt หลังหยุดนับ 1 วันทำการ (พฤ.3) = ศ.4 + 1 วันทำการ');
  await expectLevel(s.page, s.api, C31, 'normal', 'ส่วน 1 หลังส่งแก้');
  await text(s.page, 'sla-due', '8 ธ.ค. 2569 16:30', 'ส่วน 1 sla-due');

  // ---- ส่วน 2 seed …000017 ส่งแก้ 1 ธ.ค. 09:00 ----
  await w.reset();
  const s2 = await w.session('somchai');
  await citizenCase(s2.page, CASE(17));
  await text(s2.page, 'sla-level', 'หยุดนับ', 'ส่วน 2 sla-level ก่อนส่ง');
  await attr(tid(s2.page, 'sla-due'), 'data-iso', '2026-11-27T16:30:00+07:00', 'ส่วน 2 sla-due ก่อนส่ง');
  await tid(s2.page, 'submit-fix-btn').click();
  await text(s2.page, 'case-status', 'กำลังตรวจสอบ', 'ส่วน 2 case-status หลังส่งแก้');
  const g2 = await get(await w.api('off.reg1'), `/api/cases/${CASE(17)}`);
  eq(g2.body.dueAt, '2026-12-01T16:30:00+07:00', 'ส่วน 2 dueAt (หยุดนับ 2 วันทำการ: 30 พ.ย., 1 ธ.ค.)');
  eq(g2.body.owner, 'off.reg1', 'ส่วน 2 ผู้ถือเรื่อง');
  await expectLevel(s2.page, s2.api, CASE(17), 'near', 'ส่วน 2 หลังส่งแก้ (เหลือ 0)');

  // ---- ส่วน 3 ส่งแก้ 4 ธ.ค. 10:00 ----
  await w.reset();
  await w.clock('2026-12-04T10:00:00+07:00');
  const s3 = await w.session('somchai');
  await citizenCase(s3.page, CASE(17));
  await tid(s3.page, 'submit-fix-btn').click();
  await text(s3.page, 'case-status', 'กำลังตรวจสอบ', 'ส่วน 3 case-status');
  const g3 = await get(s3.api, `/api/cases/${CASE(17)}`);
  eq(g3.body.dueAt, '2026-12-04T16:30:00+07:00', 'ส่วน 3 dueAt (หยุดนับ 5 วันทำการ: 30 พ.ย., 1, 2, 3, 4 ธ.ค.)');
  await expectLevel(s3.page, s3.api, CASE(17), 'near', 'ส่วน 3');

  // ---- ส่วน 4 ตีกลับและส่งแก้วันเดียวกัน ----
  await w.reset();
  const s4 = await w.session('somchai');
  const p4 = await w.newPaid({ r: s4.api, service: 'SV-01', at: '2026-12-01T09:00:00+07:00' });
  eq(p4.caseNo, C31, 'ส่วน 4 caseNo');
  await w.clock('2026-12-02T09:00:00+07:00');
  const r4 = await w.api('off.reg1');
  status(await post(r4, `/api/officer/cases/${C31}/claim`), 200, 'ส่วน 4 claim');
  status(await post(r4, `/api/officer/cases/${C31}/return`, { reason: reasons }), 200, 'ส่วน 4 return');
  await w.clock('2026-12-02T15:00:00+07:00');
  const rs4 = await post(s4.api, `/api/cases/${C31}/resubmit`);
  status(rs4, 200, 'ส่วน 4 resubmit');
  const g4 = await get(s4.api, `/api/cases/${C31}`);
  eq(g4.body.dueAt, '2026-12-04T16:30:00+07:00', 'ส่วน 4 dueAt ต้องยังเดิม (หยุด 0 วัน เพราะ (2 ธ.ค., 2 ธ.ค.] ไม่มีวัน)');

  // ---- ส่วน 5 คร่อมสุดสัปดาห์/วันหยุด และส่งแก้หลัง 16:30 ----
  await w.reset();
  const s5 = await w.session('somchai');
  const p5 = await w.newPaid({ r: s5.api, service: 'SV-01', at: '2026-12-01T09:00:00+07:00' });
  eq(p5.caseNo, C31, 'ส่วน 5 caseNo');
  await w.clock('2026-12-04T10:00:00+07:00');
  const r5 = await w.api('off.reg1');
  status(await post(r5, `/api/officer/cases/${C31}/claim`), 200, 'ส่วน 5 claim');
  status(await post(r5, `/api/officer/cases/${C31}/return`, { reason: reasons }), 200, 'ส่วน 5 return');
  await w.clock('2026-12-08T17:00:00+07:00');
  const rs5 = await post(s5.api, `/api/cases/${C31}/resubmit`);
  status(rs5, 200, 'ส่วน 5 resubmit (เส้นตายแก้ไข 11 ธ.ค. 10:00 ยังไม่ถึง)');
  const g5 = await get(s5.api, `/api/cases/${C31}`);
  eq(g5.body.dueAt, '2026-12-08T16:30:00+07:00', 'ส่วน 5 dueAt (หยุดนับ 1 วันทำการ อ.8 เท่านั้น)');
  await expectLevel(s5.page, s5.api, C31, 'overdue', 'ส่วน 5 (ส่งแก้หลัง 16:30 จึงเกินกำหนดทันที)');
});

test('TC-SLA-03 ระดับเตือน ปกติ/ใกล้/เกิน', async ({ w }) => {
  // ---- ส่วน A คำขอใหม่ …000031 กำหนด ศ. 4 ธ.ค. 16:30 ----
  await w.reset();
  const s = await w.session('somchai');
  const p = await w.newPaid({ r: s.api, service: 'SV-01', at: '2026-12-01T09:00:00+07:00' });
  eq(p.caseNo, C31, 'ส่วน A caseNo');
  const rowsA = [
    ['2026-12-01T09:00:00+07:00', 3, 'normal'],
    ['2026-12-02T09:00:00+07:00', 2, 'normal'],
    ['2026-12-03T09:00:00+07:00', 1, 'near'],
    ['2026-12-04T16:30:00+07:00', 0, 'near'],
    ['2026-12-04T16:30:01+07:00', null, 'overdue'],
    ['2026-12-04T16:31:00+07:00', null, 'overdue'],
    ['2026-12-05T10:00:00+07:00', null, 'overdue'],
  ];
  for (const [clock, left, level] of rowsA) {
    await w.clock(clock);
    await expectLevel(s.page, s.api, C31, level, `ส่วน A นาฬิกา ${clock} (เหลือ ${left ?? '–'})`);
  }

  // ---- ส่วน B seed …000016 (ของปิติ) กำหนด อ. 8 ธ.ค. 16:30 ----
  await w.reset();
  const pt = await w.session('piti');
  const rowsB = [
    ['2026-12-03T09:00:00+07:00', 2, 'normal'],
    ['2026-12-04T09:00:00+07:00', 1, 'near'],
    ['2026-12-08T16:30:00+07:00', 0, 'near'],
    ['2026-12-08T16:31:00+07:00', null, 'overdue'],
  ];
  for (const [clock, left, level] of rowsB) {
    await w.clock(clock);
    await expectLevel(pt.page, pt.api, CASE(16), level, `ส่วน B นาฬิกา ${clock} (เหลือ ${left ?? '–'})`);
  }

  // ---- ส่วน C seed ที่ 09:00 ผ่านคิวและหน้าเคส ----
  await w.reset();
  const off = await w.session('off.reg1');
  await off.page.goto('/officer/queue');
  await queueReady(off.page);
  const expectC = [[20, 'overdue'], [22, 'near'], [24, 'near'], [25, 'normal']];
  for (const [n, level] of expectC) {
    const row = queueRow(off.page, CASE(n));
    await attr(row, 'data-sla-level', level, `ส่วน C …${n} data-sla-level`);
    await expect(row.getByTestId('row-sla-level'), `ส่วน C …${n} row-sla-level`).toHaveText(LEVEL_TH[level]);
  }
  const sc = await w.session('somchai');
  await expectLevel(sc.page, sc.api, CASE(17), 'paused', 'ส่วน C …000017 (NEED_FIX)');
  const sy = await w.session('somying');
  await expectLevel(sy.page, sy.api, CASE(1), 'closed', 'ส่วน C …000001 (COMPLETED)');

  const levelOf22 = async () => {
    const q = await get(off.api, '/api/officer/queue?filter=all');
    status(q, 200, 'ส่วน C GET queue');
    return q.body.items.find((i) => i.caseNo === CASE(22)).slaLevel;
  };
  await w.clock('2026-12-01T16:30:00+07:00');
  eq(await levelOf22(), 'near', 'ส่วน C …000022 ที่ 16:30:00 (API)');
  await off.page.reload();
  await queueReady(off.page);
  await expect(queueRow(off.page, CASE(22)).getByTestId('row-sla-level'), 'ส่วน C …000022 ที่ 16:30:00').toHaveText('ใกล้ครบกำหนด');
  await w.clock('2026-12-01T16:31:00+07:00');
  eq(await levelOf22(), 'overdue', 'ส่วน C …000022 ที่ 16:31:00 (API)');
  await off.page.reload();
  await queueReady(off.page);
  await expect(queueRow(off.page, CASE(22)).getByTestId('row-sla-level'), 'ส่วน C …000022 ที่ 16:31:00').toHaveText('เกินกำหนด');
});
