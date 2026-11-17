// หมวด NOTI · TC-NOTI-01 · TC-NOTI-02
const { test, expect } = require('../helpers/world');
const { eq, ok, status, tid, text, attr, count } = require('../helpers/check');
const { get } = require('../helpers/http');
const { CASE } = require('../helpers/thai');

const K = (n, level) => `${CASE(n)}|${level}`;
const sortK = (a) => [...a].sort();
const keysOf = (items) => items.map((i) => `${i.caseNo}|${i.level}`).sort();
const TEXT = { near: 'ใกล้ครบกำหนด', overdue: 'เกินกำหนด' };

async function notis(api) {
  const r = await get(api, '/api/notifications');
  status(r, 200, 'GET /api/notifications');
  return r.body.items;
}
// ตรวจทั้ง API และหน้า /notifications (รายการ + bell-count + ข้อความ)
async function expectNotis(w, who, expected, label) {
  const items = await notis(await w.api(who));
  eq(keysOf(items), sortK(expected), `${label} ${who} API items (caseNo|level)`);
  for (const i of items) eq(i.text, `คำขอ ${i.caseNo} ${TEXT[i.level]}`, `${label} ${who} ข้อความ ${i.caseNo}`);
  const { page } = await w.session(who);
  await page.goto('/notifications');
  if (expected.length === 0) {
    await text(page, 'noti-empty', 'ไม่มีแจ้งเตือน', `${label} ${who} noti-empty`);
    await count(tid(page, 'noti-item'), 0, `${label} ${who} noti-item`);
  } else {
    await count(tid(page, 'noti-item'), expected.length, `${label} ${who} noti-item`);
    const got = await page.getByTestId('noti-item').evaluateAll((els) => els.map((e) => `${e.dataset.caseNo}|${e.dataset.level}`));
    eq(sortK(got), sortK(expected), `${label} ${who} UI noti-item (data-case-no|data-level)`);
  }
  await text(page, 'bell-count', String(expected.length), `${label} ${who} bell-count`);
  return page;
}

test('TC-NOTI-01 ผู้รับแจ้งเตือนตามระดับ', async ({ w }) => {
  await w.reset(); // ยังไม่มี request ใดหลัง reset: request แรก = ล็อกอิน off.reg1 ที่ 09:00
  await w.api('off.reg1');
  const base = {
    'off.reg1': [K(24, 'near'), K(22, 'near'), K(20, 'overdue')],
    'off.reg2': [K(24, 'near')],
    head1: [K(20, 'overdue')],
    'off.works1': [],
  };
  for (const [who, exp] of Object.entries(base)) await expectNotis(w, who, exp, 'ที่ 09:00');

  // 000024 ไม่แจ้ง off.works1/head1 (ใกล้ครบกำหนดไม่แจ้งหัวหน้า)
  eq((await notis(await w.api('head1'))).filter((i) => i.caseNo === CASE(24)).length, 0, 'head1 ต้องไม่ได้แจ้ง 000024 (near)');
  eq((await notis(await w.api('off.works1'))).length, 0, 'off.works1 ต้องไม่ได้แจ้งอะไร');

  // ต่อ: 16:31 มี request ใด ๆ
  await w.clock('2026-12-01T16:31:00+07:00');
  await get(await w.api('off.reg1'), '/api/me');
  await expectNotis(w, 'off.reg1', [...base['off.reg1'], K(22, 'overdue')], 'ที่ 16:31');
  await expectNotis(w, 'head1', [K(20, 'overdue'), K(22, 'overdue')], 'ที่ 16:31');
  await expectNotis(w, 'off.reg2', [K(24, 'near')], 'ที่ 16:31');
});

test('TC-NOTI-02 ไม่แจ้งซ้ำ ข้ามระดับ และขั้นรออนุมัติ/รอออกเอกสาร', async ({ w }) => {
  // ---- ส่วน A ไม่แจ้งซ้ำ ----
  await w.reset();
  const reg1 = await w.api('off.reg1');
  const head = await w.api('head1');
  await w.clock('2026-12-01T16:31:00+07:00');
  await get(reg1, '/api/me');
  const s1 = await w.session('off.reg1');
  const sh = await w.session('head1');
  for (let i = 0; i < 3; i++) {
    await s1.page.goto('/notifications');
    await sh.page.goto('/notifications');
    await notis(reg1);
    await notis(head);
  }
  for (let i = 0; i < 2; i++) await s1.page.goto('/officer/queue');
  eq((await notis(reg1)).length, 4, 'ส่วน A off.reg1 ต้องยัง 4 รายการ');
  eq((await notis(head)).length, 2, 'ส่วน A head1 ต้องยัง 2 รายการ');
  await s1.page.goto('/notifications');
  await text(s1.page, 'bell-count', '4', 'ส่วน A off.reg1 bell-count');
  await sh.page.goto('/notifications');
  await text(sh.page, 'bell-count', '2', 'ส่วน A head1 bell-count');
  const k = keysOf(await notis(reg1));
  eq(new Set(k).size, k.length, 'ส่วน A ทุกคู่ (คำขอ, ระดับ, ผู้ใช้) ต้องมีได้ 1 รายการ');

  // ---- ส่วน B ข้ามระดับ: ประเมินครั้งแรกที่ ส. 5 ธ.ค. ----
  await w.reset();
  await w.clock('2026-12-05T10:00:00+07:00');
  await w.api('off.reg1'); // request แรก = ประเมิน
  const overdueReg1 = [20, 22, 23, 24, 28, 29, 30].map((n) => K(n, 'overdue'));
  const overdueReg2 = [13, 15, 24, 25, 26, 27, 28, 29, 30].map((n) => K(n, 'overdue')).concat(K(16, 'near'));
  const headList = [10, 13, 14, 15, 20, 22, 23, 24, 25, 26, 27, 28, 29, 30].map((n) => K(n, 'overdue')).concat(K(11, 'near'));
  await expectNotis(w, 'off.reg1', overdueReg1, 'ส่วน B');
  await expectNotis(w, 'off.reg2', overdueReg2, 'ส่วน B');
  await expectNotis(w, 'off.works1', [K(10, 'overdue')], 'ส่วน B');
  await expectNotis(w, 'head1', headList, 'ส่วน B');
  // ไม่มี near ย้อนหลังของ 000024 / 000020 / 000022
  for (const who of ['off.reg1', 'off.reg2', 'head1']) {
    const near24 = (await notis(await w.api(who))).filter((i) => i.caseNo === CASE(24) && i.level === 'near').length;
    eq(near24, 0, `ส่วน B ${who} ต้องไม่มี near ย้อนหลังของ 000024`);
  }

  // ---- ส่วน C ขั้นรออนุมัติและรอออกเอกสาร ----
  await w.reset();
  await w.clock('2026-12-04T09:00:00+07:00');
  const h = await w.api('head1');
  const r1 = await w.api('off.reg1');
  const r2 = await w.api('off.reg2');
  const of = async (api, n) => keysOf((await notis(api)).filter((i) => i.caseNo === CASE(n)));
  eq(await of(h, 14), [K(14, 'near')], 'ส่วน C ศ.4 09:00 head1 ได้ near ของ 000014');
  eq(await of(r1, 14), [], 'ส่วน C off.reg1 ต้องไม่ได้ 000014');
  eq(await of(r2, 14), [], 'ส่วน C off.reg2 ต้องไม่ได้ 000014');

  await w.clock('2026-12-04T16:31:00+07:00');
  await get(h, '/api/me');
  eq(await of(h, 14), [K(14, 'near'), K(14, 'overdue')].sort(), 'ส่วน C 1: head1 ได้ overdue เพิ่ม รวม 2 ไม่ซ้ำกัน');
  eq(await of(r1, 14), [], 'ส่วน C 1: off.reg1 ยังไม่มี 000014');
  eq(await of(r2, 14), [], 'ส่วน C 1: off.reg2 ยังไม่มี 000014');

  await w.clock('2026-12-08T09:00:00+07:00');
  await get(h, '/api/me');
  eq(await of(r1, 19), [K(19, 'near')], 'ส่วน C 2: off.reg1 (ผู้ออกเอกสาร) ได้ near ของ 000019');
  eq(await of(r2, 19), [], 'ส่วน C 2: off.reg2 ต้องไม่ได้ 000019');
  eq(await of(h, 19), [], 'ส่วน C 2: head1 ต้องไม่ได้ 000019');

  await w.clock('2026-12-09T16:31:00+07:00');
  await get(h, '/api/me');
  eq(await of(r1, 19), [K(19, 'near'), K(19, 'overdue')].sort(), 'ส่วน C 3: off.reg1 ได้ overdue เพิ่ม รวม 2');
  eq(await of(h, 19), [K(19, 'overdue')], 'ส่วน C 3: head1 ได้ overdue 1');
  eq(await of(r2, 19), [], 'ส่วน C 3: off.reg2 ยังไม่มี 000019');
});
