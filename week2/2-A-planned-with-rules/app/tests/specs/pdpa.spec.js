// หมวด PDPA · TC-PDPA-01 · TC-PDPA-02 (จับ B09) · TC-PDPA-03 (จับ B11)
const { test, expect } = require('../helpers/world');
const { eq, ok, status, err, tid, text, attr, count, hidden, match, contains, notContains } = require('../helpers/check');
const { get, post } = require('../helpers/http');
const { CASE } = require('../helpers/thai');
const { officerCase, citizenCase, queueReady, rowCellTexts, queueRow, doUnmask, auditReady } = require('../helpers/ui');

const MASK_RE = /^X-XXXX-XXXXX-\d{2}-\d$/;

test('TC-PDPA-01 ปิดบังเลขบัตรบนจอ', async ({ w }) => {
  await w.reset();
  const FULL = '3100600987659';
  const DASHED = '3-1006-00987-65-9';
  const off = await w.session('off.reg2');

  // คิว
  await off.page.goto('/officer/queue');
  await queueReady(off.page);
  for (const t of await rowCellTexts(off.page, 'queue-row', 'row-id-masked')) match(t, MASK_RE, 'row-id-masked ทุกแถว');
  await expect(queueRow(off.page, CASE(25)).getByTestId('row-id-masked'), 'แถว …000025').toHaveText('X-XXXX-XXXXX-65-9');
  await expect(queueRow(off.page, CASE(26)).getByTestId('row-id-masked'), 'แถว …000026 (สมชาย)').toHaveText('X-XXXX-XXXXX-45-6');

  // หน้าคำขอ (เจ้าหน้าที่) HTML ต้องไม่มีเลขเต็ม
  await officerCase(off.page, CASE(25));
  await text(off.page, 'applicant-id', 'X-XXXX-XXXXX-65-9', 'off.reg2 applicant-id');
  const html = await off.page.content();
  notContains(html, FULL, 'HTML หน้าคำขอ (off.reg2) ต้องไม่มีเลขบัตรเต็ม');
  notContains(html, DASHED, 'HTML หน้าคำขอ (off.reg2) ต้องไม่มีเลขบัตรเต็มแบบมีขีด');

  // หัวหน้า
  const hd = await w.session('head1');
  await officerCase(hd.page, CASE(25));
  await text(hd.page, 'applicant-id', 'X-XXXX-XXXXX-65-9', 'head1 applicant-id (ทุกบทบาทเจ้าหน้าที่ปิดบังเหมือนกัน)');

  // ประชาชนเห็นของตัวเองเต็ม
  const sy = await w.session('somying');
  await citizenCase(sy.page, CASE(25));
  await text(sy.page, 'case-id-full', DASHED, 'สมหญิง case-id-full');
  const sc = await w.session('somchai');
  await citizenCase(sc.page, CASE(20));
  await text(sc.page, 'case-id-full', '1-1017-00123-45-6', 'สมชาย case-id-full');
});

// ค้นลึกหา key ชื่อ idNo
function hasKey(o, k) {
  if (Array.isArray(o)) return o.some((x) => hasKey(x, k));
  if (o && typeof o === 'object') return Object.keys(o).some((key) => key === k || hasKey(o[key], k));
  return false;
}

test('TC-PDPA-02 API (JSON) ไม่ส่งเลขบัตรเต็ม', async ({ w }) => {
  await w.reset();
  const urls = [
    '/api/officer/queue?filter=all',
    `/api/cases/${CASE(25)}`,
    `/api/cases/${CASE(26)}`,
    `/api/cases/${CASE(20)}`,
    '/api/notifications',
    `/api/cases/${CASE(25)}/files`,
  ];
  for (const who of ['off.reg1', 'head1']) {
    const api = await w.api(who);
    for (const url of urls) {
      const label = `${who} GET ${url}`;
      const r = await get(api, url);
      status(r, 200, label);
      contains(r.headers['content-type'] || '', 'application/json', `${label} Content-Type`);
      ok(r.body !== null, `${label} ต้องเป็น JSON ที่แยกได้`, `body=${r.text.slice(0, 120)}`);
      const s = JSON.stringify(r.body);
      ok(!/\d{13}/.test(s), `${label}: ต้องไม่พบเลข 13 หลักติดกัน`, `พบ ${(/\d{13}/.exec(s) || [])[0]}`);
      ok(!/\d-\d{4}-\d{5}-\d{2}-\d/.test(s), `${label}: ต้องไม่พบรูปแบบ d-dddd-ddddd-dd-d`, `พบ ${(/\d-\d{4}-\d{5}-\d{2}-\d/.exec(s) || [])[0]}`);
      ok(!hasKey(r.body, 'idNo'), `${label}: ต้องไม่มี key ชื่อ idNo (ลึกทุกชั้น)`);
      for (const id of ['3100600987659', '1101700123456', '1909900555015']) notContains(s, id, `${label} ต้องไม่พบ ${id}`);
      const masked = [];
      if (Array.isArray(r.body.items)) r.body.items.forEach((i) => { if ('idMasked' in i) masked.push(i.idMasked); });
      if ('idMasked' in r.body) masked.push(r.body.idMasked);
      if (url.startsWith('/api/officer/queue')) ok(masked.length > 0, `${label}: items[].idMasked ต้องมี`, 'ไม่พบ idMasked สักแถว');
      masked.forEach((m) => match(m, MASK_RE, `${label} idMasked`));
    }
  }
});

test('TC-PDPA-03 แสดงเลขเต็มต้องมีเหตุผลและ Audit', async ({ w }) => {
  await w.reset();
  const N = CASE(25);
  const off = await w.session('off.reg2');
  const page = off.page;
  await officerCase(page, N);

  // 1-2 เหตุผลว่าง / เว้นวรรคล้วน
  await tid(page, 'show-full-id-btn').click();
  for (const [reason, why] of [['', 'ว่าง'], ['   ', 'เว้นวรรคล้วน']]) {
    await tid(page, 'unmask-reason').fill(reason);
    await tid(page, 'unmask-submit').click();
    await text(page, 'unmask-error', 'กรุณากรอกเหตุผล', `unmask-error (เหตุผล${why})`);
    await count(tid(page, 'full-id'), 0, `full-id ต้อง 0 (เหตุผล${why})`);
    err(await post(off.api, `/api/officer/cases/${N}/unmask`, { reason }), 400, 'REASON_REQUIRED', 'กรุณากรอกเหตุผล', `API unmask (เหตุผล${why})`);
  }
  // 3 เหตุผลถูกต้อง
  await tid(page, 'unmask-reason').fill('ตรวจสอบตัวตนซ้ำ');
  await tid(page, 'unmask-submit').click();
  await text(page, 'full-id', '3-1006-00987-65-9', 'full-id หลังกรอกเหตุผล');
  // 4 โหลดหน้าซ้ำ
  await officerCase(page, N);
  await text(page, 'applicant-id', 'X-XXXX-XXXXX-65-9', 'หลังโหลดซ้ำ applicant-id ต้องปิดบังตามเดิม');
  await count(tid(page, 'full-id'), 0, 'หลังโหลดซ้ำ full-id ต้อง 0');

  // 5 Audit UNMASK (ความพยายามที่ผิดไม่ถูกบันทึก)
  const au = await w.session('audit1');
  await au.page.goto('/audit');
  await auditReady(au.page);
  await tid(au.page, 'audit-filter-event').selectOption('UNMASK');
  await tid(au.page, 'audit-apply-btn').click();
  await text(au.page, 'audit-count', '1', 'audit-count (กรอง UNMASK)');
  const row = au.page.getByTestId('audit-row');
  await count(row, 1, 'audit-row UNMASK');
  await attr(row, 'data-actor', 'off.reg2', 'data-actor');
  await text(au.page, 'audit-role', 'officer', 'audit-role');
  await text(au.page, 'audit-case-no', N, 'audit-case-no');
  await text(au.page, 'audit-event', 'UNMASK', 'audit-event');
  await expect(tid(au.page, 'audit-detail'), 'audit-detail').toContainText('ตรวจสอบตัวตนซ้ำ');
  await attr(tid(au.page, 'audit-time'), 'data-iso', '2026-12-01T09:00:00+07:00', 'audit-time');
  const a = await w.auditItems('event=UNMASK');
  eq(a.count, 1, 'API audit UNMASK count');

  // 6 บทบาทอื่นเรียกไม่ได้
  for (const who of ['exec1', 'audit1', 'somying']) {
    const r = await post(await w.api(who), `/api/officer/cases/${N}/unmask`, { reason: 'x' });
    status(r, 403, `${who} POST unmask`);
  }
});
