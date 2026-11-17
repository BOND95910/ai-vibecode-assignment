// หมวด PAY · TC-PAY-01 (จับ B05) ถึง 04
const { test, expect } = require('../helpers/world');
const { eq, ok, status, err, tid, text, attr, count } = require('../helpers/check');
const { get, post } = require('../helpers/http');
const { uiToQr } = require('../helpers/ui');

test('TC-PAY-01 อายุ QR 15:00', async ({ w }) => {
  // อายุ = เวลาชำระ − 08:55:00 (QR ของ PP-0001 สร้าง 08:55:00 หมดอายุ 09:10:00)
  const rounds = [
    { n: 1, clock: null, age: '5:00', http: 200 },
    { n: 2, clock: '2026-12-01T09:09:59+07:00', age: '14:59', http: 200 },
    { n: 3, clock: '2026-12-01T09:10:00+07:00', age: '15:00', http: 410 },
    { n: 4, clock: '2026-12-01T09:10:01+07:00', age: '15:01', http: 410 },
  ];
  for (const rd of rounds) {
    await w.reset();
    if (rd.clock) await w.clock(rd.clock);
    const label = `รอบ ${rd.n} (อายุ ${rd.age})`;
    const r = await w.pay('PP-0001', 500);
    if (rd.http === 200) {
      status(r, 200, `${label} pay PP-0001`);
      eq(r.body.status, 'PAID', `${label} status`);
      eq(r.body.caseNo, 'EG-2569-000031', `${label} caseNo`);
    } else {
      err(r, 410, 'QR_EXPIRED', 'QR หมดอายุ กรุณาสร้าง QR ใหม่', `${label} pay PP-0001 (ต้องหมดอายุ ไม่ใช่จ่ายได้)`);
    }

    if (rd.n === 3) {
      const { page, api } = await w.session('somchai');
      const g = await get(api, '/api/payments/PP-0001');
      status(g, 200, `${label} GET payment`);
      eq(g.body.status, 'EXPIRED', `${label} สถานะ PP-0001`);
      const cases = await get(api, '/api/cases');
      eq(cases.body.items.length, 10, `${label} GET /api/cases (ไม่ออกเลข)`);

      // บนจอ
      await page.goto('/citizen/new/SV-02?draft=DR-0002');
      await text(page, 'qr-expired-msg', 'QR หมดอายุ กรุณาสร้าง QR ใหม่', `${label} qr-expired-msg`);
      await text(page, 'payment-status', 'QR หมดอายุ', `${label} payment-status`);
      await attr(tid(page, 'payment-status'), 'data-status', 'EXPIRED', `${label} payment-status data-status`);
      await count(tid(page, 'regenerate-qr-btn'), 1, `${label} regenerate-qr-btn`);
      await tid(page, 'regenerate-qr-btn').click();
      await text(page, 'qr-ref', 'PP-0002', `${label} qr-ref ใหม่`);
      await attr(tid(page, 'qr-expires'), 'data-iso', '2026-12-01T09:25:00+07:00', `${label} qr-expires ใหม่`);
      const p2 = await w.pay('PP-0002', 500);
      status(p2, 200, `${label} pay PP-0002`);
      eq(p2.body.caseNo, 'EG-2569-000031', `${label} caseNo ของ QR ใหม่`);
    }
  }
});

test('TC-PAY-02 ยอดเงินและ callback ซ้ำ', async ({ w }) => {
  await w.reset();
  const api = await w.api('somchai');
  const cases = async () => (await get(api, '/api/cases')).body.items.length;
  const pending = await w.newPaid({ service: 'SV-01', qty: 1, unpaid: true });
  eq(pending.ref, 'PP-0002', 'ref ของ QR ใหม่');
  eq(pending.fee, 20, 'ค่าธรรมเนียม SV-01 qty 1');
  const MSG = 'ยอดเงินไม่ตรงกับค่าธรรมเนียม';

  // 1-2 ยอดขาด/เกิน ฿1
  for (const [step, amt] of [[1, 19], [2, 21]]) {
    const r = await w.pay('PP-0002', amt);
    err(r, 422, 'AMOUNT_MISMATCH', MSG, `ขั้น ${step} pay ${amt}`);
    const g = await get(api, '/api/payments/PP-0002');
    eq(g.body.status, 'PENDING', `ขั้น ${step} สถานะ PP-0002`);
    eq(await cases(), 10, `ขั้น ${step} GET /api/cases`);
  }
  // 3 ยอดถูก
  let r = await w.pay('PP-0002', 20);
  status(r, 200, 'ขั้น 3 pay 20');
  eq(r.body.status, 'PAID', 'ขั้น 3 status');
  eq(r.body.caseNo, 'EG-2569-000031', 'ขั้น 3 caseNo');
  eq(r.body.receiptNo, 'RC-2569-000031', 'ขั้น 3 receiptNo');
  eq(await cases(), 11, 'ขั้น 3 GET /api/cases');
  // 4 callback ซ้ำ
  r = await w.pay('PP-0002', 20);
  status(r, 200, 'ขั้น 4 pay ซ้ำ');
  eq(r.body.duplicate, true, 'ขั้น 4 duplicate');
  eq(r.body.caseNo, 'EG-2569-000031', 'ขั้น 4 caseNo เดิม');
  eq(r.body.receiptNo, 'RC-2569-000031', 'ขั้น 4 receiptNo เดิม');
  eq(await cases(), 11, 'ขั้น 4 GET /api/cases ยัง 11');
  // 5 ใบถัดไปไม่ข้ามเลข
  const next = await w.newPaid({ service: 'SV-01', qty: 1 });
  eq(next.caseNo, 'EG-2569-000032', 'ขั้น 5 caseNo (ไม่มีเลขข้ามเพราะ callback ซ้ำ)');
  eq(next.receiptNo, 'RC-2569-000032', 'ขั้น 5 receiptNo');
});

test('TC-PAY-03 ชำระพร้อมกัน เลขไม่ซ้ำ', async ({ w }) => {
  await w.reset();
  const somchai = await w.api('somchai');
  const somying = await w.api('somying');
  const refs = [];
  for (const r of [somchai, somchai, somchai, somying, somying, somying]) {
    const p = await w.newPaid({ r, service: 'SV-01', qty: 1, unpaid: true });
    refs.push(p.ref);
  }
  eq([...refs].sort(), ['PP-0002', 'PP-0003', 'PP-0004', 'PP-0005', 'PP-0006', 'PP-0007'], 'ref ที่สร้างได้');

  const results = await Promise.all(refs.map((ref) => w.pay(ref, 20)));
  results.forEach((r, i) => status(r, 200, `pay ${refs[i]} พร้อมกัน`));
  const cs = results.map((r) => r.body.caseNo);
  const rc = results.map((r) => r.body.receiptNo);
  const wantC = [31, 32, 33, 34, 35, 36].map((n) => `EG-2569-0000${n}`);
  const wantR = [31, 32, 33, 34, 35, 36].map((n) => `RC-2569-0000${n}`);
  eq(new Set(cs).size, 6, `caseNo ต้องไม่ซ้ำ 6 ค่า (ได้ ${JSON.stringify(cs)})`);
  eq([...cs].sort(), wantC, 'ชุด caseNo');
  eq([...rc].sort(), wantR, 'ชุด receiptNo');

  const fresh = (items) => items.filter((i) => Number(i.caseNo.slice(-6)) >= 31).length;
  eq(fresh((await get(somchai, '/api/cases')).body.items), 3, 'GET /api/cases ของสมชาย: เลขใหม่');
  eq(fresh((await get(somying, '/api/cases')).body.items), 3, 'GET /api/cases ของสมหญิง: เลขใหม่');

  const next = await w.newPaid({ r: somchai, service: 'SV-01', qty: 1 });
  eq(next.caseNo, 'EG-2569-000037', 'การชำระรายการถัดไป');
});

test('TC-PAY-04 เลขคำขอข้ามปี 2569 → 2570', async ({ w }) => {
  await w.reset();
  const { page, api } = await w.session('somchai');

  // 1 ก่อนเที่ยงคืน: สร้างร่าง + QR ผ่านหน้าจอ ยังไม่มีเลขคำขอ
  await w.clock('2026-12-31T23:58:00+07:00');
  const ref = await uiToQr(page, 'SV-01', { qty: 1 });
  eq((await get(api, '/api/cases')).body.items.length, 10, 'ขั้น 1 ยังไม่มีเลขคำขอใหม่');

  // 2 ชำระ 23:59
  await w.clock('2026-12-31T23:59:00+07:00');
  const p = await w.pay(ref, 20);
  status(p, 200, 'ขั้น 2 pay');
  eq(p.body.caseNo, 'EG-2569-000031', 'ขั้น 2 caseNo');
  eq(p.body.receiptNo, 'RC-2569-000031', 'ขั้น 2 receiptNo');
  await tid(page, 'refresh-payment-btn').click();
  await text(page, 'payment-status', 'ชำระแล้ว', 'ขั้น 2 payment-status');
  await attr(tid(page, 'receipt-paid-at'), 'data-iso', '2026-12-31T23:59:00+07:00', 'ขั้น 2 receipt-paid-at');

  // 3-4 ข้ามปี
  await w.clock('2027-01-01T00:00:00+07:00');
  const a = await w.newPaid({ service: 'SV-01', qty: 1 });
  eq(a.caseNo, 'EG-2570-000001', 'ขั้น 3 caseNo ปี 2570');
  eq(a.receiptNo, 'RC-2570-000001', 'ขั้น 3 receiptNo ปี 2570');
  const b = await w.newPaid({ service: 'SV-01', qty: 1 });
  eq(b.caseNo, 'EG-2570-000002', 'ขั้น 4 caseNo ใบที่ 2 ของปี 2570');

  // 5 เลขเดิมไม่ถูกแก้
  const g = await get(api, '/api/cases/EG-2569-000031');
  status(g, 200, 'ขั้น 5 GET EG-2569-000031');
  eq(g.body.caseNo, 'EG-2569-000031', 'ขั้น 5 เลขเดิม');
});
