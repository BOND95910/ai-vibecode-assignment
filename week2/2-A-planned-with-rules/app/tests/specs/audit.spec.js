// หมวด AUDIT · TC-AUDIT-01 (จับ B11) · TC-AUDIT-02 · TC-AUDIT-03
const fs = require('node:fs');
const { test, expect } = require('../helpers/world');
const { eq, ok, status, err, tid, text, attr, count, contains } = require('../helpers/check');
const { get, post, put, patch, del, call } = require('../helpers/http');
const { CASE, DASH } = require('../helpers/thai');
const { auditReady, clickDownload } = require('../helpers/ui');
const { parseCsv } = require('../helpers/csv');

const T0 = '2026-12-01T09:00:00+07:00';
const nz = (s) => (s == null || s === DASH || s === '-' ? '' : String(s).trim());
const idNum = (id) => Number(String(id).replace(/\D/g, ''));

// แปลงแถวจาก API → รูปเดียวกับตารางที่คาดหวัง
const fromApi = (i) => ({
  event: i.event, actor: i.username, role: i.role, caseNo: nz(i.caseNo),
  tr: i.fromStatus && i.toStatus ? `${i.fromStatus} → ${i.toStatus}` : DASH, detail: nz(i.detail), time: i.time,
});
async function fromUi(page) {
  return page.getByTestId('audit-row').evaluateAll((els) => els.map((e) => {
    const q = (id) => (e.querySelector(`[data-testid="${id}"]`)?.textContent || '').trim();
    return {
      id: e.dataset.id, event: e.dataset.event, actor: e.dataset.actor, caseNoAttr: e.dataset.caseNo || '',
      role: q('audit-role'), caseNo: q('audit-case-no'), tr: q('audit-transition'), detail: q('audit-detail'),
      time: e.querySelector('[data-testid="audit-time"]')?.getAttribute('data-iso') || '',
    };
  })).then((rows) => rows.map((r) => ({ ...r, caseNo: nz(r.caseNo), tr: nz(r.tr) === '' ? DASH : r.tr })));
}

// ตารางคาดหวัง 16 แถว (TEST-PLAN ข้อ 14 TC-AUDIT-01)
const login = (actor, role) => ({ event: 'STAFF_LOGIN', actor, role, caseNo: '', tr: DASH, detail: [] });
const EXPECTED = [
  login('off.reg2', 'officer'), login('off.reg1', 'officer'), login('head1', 'head'),
  login('exec1', 'executive'), login('admin1', 'admin'), login('audit1', 'auditor'),
  { event: 'CLAIM', actor: 'off.reg2', role: 'officer', caseNo: CASE(28), tr: 'SUBMITTED → IN_REVIEW', detail: [] },
  { event: 'RETURN', actor: 'off.reg1', role: 'officer', caseNo: CASE(20), tr: 'IN_REVIEW → NEED_FIX', detail: ['xxxxxxxxxx'] },
  { event: 'FORWARD', actor: 'off.reg2', role: 'officer', caseNo: CASE(13), tr: 'IN_REVIEW → PENDING_APPROVAL', detail: [] },
  { event: 'APPROVE', actor: 'head1', role: 'head', caseNo: CASE(13), tr: 'PENDING_APPROVAL → APPROVED', detail: [] },
  { event: 'APPROVE', actor: 'off.reg2', role: 'officer', caseNo: CASE(25), tr: 'IN_REVIEW → APPROVED', detail: [] },
  { event: 'ISSUE', actor: 'off.reg2', role: 'officer', caseNo: CASE(25), tr: 'APPROVED → COMPLETED', detail: ['DOC-2569-000002'] },
  { event: 'REJECT', actor: 'off.reg2', role: 'officer', caseNo: CASE(26), tr: 'IN_REVIEW → REJECTED', detail: ['xxxxxxxxxx'] },
  { event: 'UNMASK', actor: 'off.reg2', role: 'officer', caseNo: CASE(25), tr: DASH, detail: ['ตรวจสอบตัวตนซ้ำ'] },
  { event: 'EXPORT', actor: 'exec1', role: 'executive', caseNo: '', tr: DASH, detail: ['xlsx', '2026-12'] },
  { event: 'ADMIN_CHANGE', actor: 'admin1', role: 'admin', caseNo: '', tr: DASH, detail: ['SV-01 fee 20 → 25'] },
];
const show = (r) => `${r.event}/${r.actor}/${r.role}/${r.caseNo || '–'}/${r.tr}/${JSON.stringify(r.detail)}`;

// จับคู่แถวคาดหวังกับแถวจริงแบบ 1 ต่อ 1 (ไม่สนลำดับ) แล้วรายงานแถวที่ขาด/เกิน
function matchRows(actual, expected, label) {
  const pool = [...actual];
  const missing = [];
  for (const e of expected) {
    const k = pool.findIndex((a) => a.event === e.event && a.actor === e.actor && a.role === e.role && a.caseNo === e.caseNo && a.tr === e.tr
      && e.detail.every((d) => a.detail.includes(d)));
    if (k < 0) missing.push(show(e)); else pool.splice(k, 1);
  }
  ok(missing.length === 0 && pool.length === 0,
    `${label}: แถวที่คาดหวังแต่ไม่พบ = ${JSON.stringify(missing)} · แถวจริงที่เกิน = ${JSON.stringify(pool.map(show))}`);
}

test('TC-AUDIT-01 เหตุการณ์และฟิลด์ใน Audit', async ({ w }) => {
  await w.reset();
  // ล็อกอินครั้งเดียวต่อบัญชี เก็บ request context ไว้ใช้ซ้ำ
  const reg2 = await w.api('off.reg2');
  status(await post(reg2, `/api/officer/cases/${CASE(28)}/claim`), 200, '1 claim …000028');
  const reg1 = await w.api('off.reg1');
  status(await post(reg1, `/api/officer/cases/${CASE(20)}/return`, { reason: 'xxxxxxxxxx' }), 200, '2 return …000020');
  status(await post(reg2, `/api/officer/cases/${CASE(13)}/forward`), 200, '3 forward …000013');
  const head = await w.api('head1');
  status(await post(head, `/api/cases/${CASE(13)}/approve`), 200, '4 head1 approve …000013');
  status(await post(reg2, `/api/cases/${CASE(25)}/approve`), 200, '5 approve …000025');
  status(await post(reg2, `/api/officer/cases/${CASE(25)}/issue`), 200, '5 issue …000025');
  status(await post(reg2, `/api/cases/${CASE(26)}/reject`, { reason: 'xxxxxxxxxx' }), 200, '5 reject …000026');
  status(await post(reg2, `/api/officer/cases/${CASE(25)}/unmask`, { reason: 'ตรวจสอบตัวตนซ้ำ' }), 200, '5 unmask …000025');
  const exec = await w.api('exec1');
  status(await get(exec, '/api/dashboard/export?format=xlsx&period=2026-12&service=ALL'), 200, '6 export xlsx');
  const admin = await w.api('admin1');
  status(await put(admin, '/api/admin/services/SV-01', { fee: 25, sla: 3 }), 200, '7 admin แก้ SV-01');
  const audit = await w.api('audit1');

  // ---- API ----
  const all = await get(audit, '/api/audit');
  status(all, 200, '8 GET /api/audit');
  eq(all.body.count, 16, 'audit count (ไม่กรอง)');
  eq(all.body.items.length, 16, 'audit items.length');
  matchRows(all.body.items.map(fromApi), EXPECTED, 'API audit');
  for (const i of all.body.items) eq(fromApi(i).time, T0, `API audit time ของ ${i.event}/${i.username}`);
  for (let k = 1; k < all.body.items.length; k++) {
    const a = all.body.items[k - 1], b = all.body.items[k];
    ok(a.time > b.time || (a.time === b.time && idNum(a.id) > idNum(b.id)), `ลำดับ ใหม่ → เก่า (เวลาเท่ากันเรียง id มาก → น้อย): แถว ${k - 1} id=${a.id} ก่อนแถว ${k} id=${b.id}`);
  }
  const apiOrder = all.body.items.map((i) => `${i.username}|${i.event}|${nz(i.caseNo)}`);

  // ---- หน้าจอ (ใช้ cookie เดียวกับ audit1 ไม่ล็อกอินซ้ำ) ----
  const ui = await w.pageFor(audit);
  const page = ui.page;
  await page.goto('/audit');
  await auditReady(page);
  await text(page, 'audit-count', '16', 'UI audit-count');
  const rows = await fromUi(page);
  eq(rows.length, 16, 'UI audit-row');
  matchRows(rows, EXPECTED, 'UI audit');
  rows.forEach((r) => eq(r.time, T0, `UI audit-time ของ ${r.event}/${r.actor}`));
  for (let k = 1; k < rows.length; k++) ok(idNum(rows[k - 1].id) > idNum(rows[k].id), `UI ลำดับ id มาก → น้อย: ${rows[k - 1].id} ก่อน ${rows[k].id}`);

  // ---- กรอง ----
  const f1 = await get(audit, '/api/audit?actor=off.reg2');
  eq(f1.body.count, 7, 'API กรอง actor=off.reg2 (STAFF_LOGIN CLAIM FORWARD APPROVE ISSUE REJECT UNMASK)');
  const f2 = await get(audit, '/api/audit?event=APPROVE');
  eq(f2.body.count, 2, 'API กรอง event=APPROVE');
  eq(f2.body.items.map((i) => i.username).sort(), ['head1', 'off.reg2'], 'API APPROVE ผู้ทำ');
  const f3 = await get(audit, '/api/audit?actor=off.reg2&event=APPROVE');
  eq(f3.body.count, 1, 'API กรอง actor + event');

  await tid(page, 'audit-filter-actor').fill('off.reg2');
  await tid(page, 'audit-apply-btn').click();
  await text(page, 'audit-count', '7', 'UI กรอง actor=off.reg2');
  await tid(page, 'audit-filter-actor').fill('');
  await tid(page, 'audit-filter-event').selectOption('APPROVE');
  await tid(page, 'audit-apply-btn').click();
  await text(page, 'audit-count', '2', 'UI กรอง event=APPROVE');
  await tid(page, 'audit-filter-actor').fill('off.reg2');
  await tid(page, 'audit-apply-btn').click();
  await text(page, 'audit-count', '1', 'UI กรอง actor + event');

  // ---- CSV ----
  await tid(page, 'audit-filter-actor').fill('');
  await tid(page, 'audit-filter-event').selectOption('');
  await tid(page, 'audit-apply-btn').click();
  await text(page, 'audit-count', '16', 'UI ล้างตัวกรองก่อนส่งออก CSV');
  const { download } = await clickDownload(page, tid(page, 'audit-export-csv-btn'));
  const csv = parseCsv(fs.readFileSync(await download.path(), 'utf8'));
  eq(csv[0], ['time', 'username', 'role', 'event', 'caseNo', 'fromStatus', 'toStatus', 'detail'], 'CSV แถวแรก');
  eq(csv.length - 1, 16, 'CSV จำนวนแถวข้อมูล (เท่าหน้าจอ)');
  eq(csv.slice(1).map((r) => `${r[1]}|${r[3]}|${nz(r[4])}`), apiOrder, 'CSV ลำดับเดียวกับหน้าจอ (ใหม่ → เก่า)');
  await page.reload();
  await auditReady(page);
  await text(page, 'audit-count', '17', 'หลังส่งออก CSV audit-count (เพิ่ม EXPORT ของ audit1)');
  const ex = (await get(audit, '/api/audit?event=EXPORT&actor=audit1')).body;
  eq(ex.count, 1, 'EXPORT ของ audit1');
  contains(ex.items[0].detail, 'audit-csv', 'EXPORT ของ audit1 detail');
});

test('TC-AUDIT-02 Audit แก้/ลบไม่ได้ (405)', async ({ w }) => {
  await w.reset();
  const audit = await w.api('audit1'); // เกิดแถว STAFF_LOGIN 1 แถว
  const beforeRes = await get(audit, '/api/audit');
  status(beforeRes, 200, 'GET /api/audit ก่อน');
  const before = beforeRes.body.items;
  ok(before.length >= 1, 'ก่อนต้องมีแถว STAFF_LOGIN อย่างน้อย 1 แถว');
  const id = before[0].id;
  const admin = await w.api('admin1'); // เกิดแถว STAFF_LOGIN ของ admin1

  for (const [who, api] of [['admin1', admin], ['audit1', audit]]) {
    const reqs = [
      ['PUT', `/api/audit/${id}`, { detail: 'x' }],
      ['PATCH', `/api/audit/${id}`, { detail: 'x' }],
      ['DELETE', `/api/audit/${id}`],
      ['PUT', '/api/audit', {}],
      ['DELETE', '/api/audit'],
      ['DELETE', '/api/audit/999999'],
    ];
    for (const [m, url, body] of reqs) {
      const r = await call(api, m, url, { data: body });
      err(r, 405, 'METHOD_NOT_ALLOWED', null, `${who} ${m} ${url}`);
    }
  }
  const after = (await get(audit, '/api/audit')).body.items;
  const byId = new Map(after.map((i) => [String(i.id), i]));
  for (const b of before) {
    ok(byId.has(String(b.id)), `แถวเดิม id=${b.id} ต้องไม่หาย`);
    eq(byId.get(String(b.id)), b, `แถวเดิม id=${b.id} ต้องไม่ถูกแก้`);
  }
  eq(after.length, before.length + 1, 'หลังทำทั้งหมด ต้องเพิ่มเฉพาะ 1 แถว');
  const extra = after.filter((i) => !before.some((b) => String(b.id) === String(i.id)));
  eq([extra[0].event, extra[0].username], ['STAFF_LOGIN', 'admin1'], 'แถวที่เพิ่ม = STAFF_LOGIN ของ admin1');
  status(await get(admin, '/api/audit'), 403, 'admin1 GET /api/audit');

  const ui = await w.pageFor(audit);
  await ui.page.goto('/audit');
  await auditReady(ui.page);
  await count(ui.page.getByTestId('audit-edit-btn'), 0, 'audit-edit-btn');
  await count(ui.page.getByTestId('audit-delete-btn'), 0, 'audit-delete-btn');
});

test('TC-AUDIT-03 กรองช่วงวันที่ตามเวลาไทย', async ({ w }) => {
  await w.reset();
  const L = [
    ['L1', '2026-11-30T23:59:59+07:00', 'off.reg1'],
    ['L2', '2026-12-01T00:00:00+07:00', 'off.reg2'],
    ['L3', '2026-12-01T23:59:59+07:00', 'off.works1'],
    ['L4', '2026-12-02T00:00:00+07:00', 'off.reg1'],
    ['L5', '2026-12-02T09:00:00+07:00', 'audit1'],
  ];
  let audit;
  for (const [, clock, who] of L) {
    await w.clock(clock);
    const ctx = await w.fresh(who);
    if (who === 'audit1') audit = ctx;
  }
  const row = (n) => { const x = L.find((l) => l[0] === n); return `${x[2]}@${x[1]}`; };
  const cases = [
    ['2026-12-01', '2026-12-01', undefined, ['L2', 'L3']],
    ['2026-11-30', '2026-11-30', undefined, ['L1']],
    ['2026-11-30', '2026-12-01', undefined, ['L1', 'L2', 'L3']],
    ['2026-12-02', '', undefined, ['L4', 'L5']],
    ['', '2026-11-30', undefined, ['L1']],
    ['2026-12-01', '2026-12-02', undefined, ['L2', 'L3', 'L4', 'L5']],
    ['2026-12-01', '2026-12-01', 'off.reg2', ['L2']],
  ];
  const ui = await w.pageFor(audit);
  await ui.page.goto('/audit');
  await auditReady(ui.page);
  for (const [from, to, actor, want] of cases) {
    const label = `from=${from || '(ว่าง)'} to=${to || '(ว่าง)'}${actor ? ' actor=' + actor : ''}`;
    const q = [from && `from=${from}`, to && `to=${to}`, actor && `actor=${actor}`].filter(Boolean).join('&');
    const r = await get(audit, `/api/audit?${q}`);
    status(r, 200, `API ${label}`);
    eq(r.body.items.map((i) => `${i.username}@${i.time}`).sort(), want.map(row).sort(), `API ${label} แถวที่ได้`);
    eq(r.body.count, want.length, `API ${label} count`);

    await tid(ui.page, 'audit-filter-from').fill(from);
    await tid(ui.page, 'audit-filter-to').fill(to);
    await tid(ui.page, 'audit-filter-actor').fill(actor || '');
    await tid(ui.page, 'audit-apply-btn').click();
    await text(ui.page, 'audit-count', String(want.length), `UI ${label} audit-count`);
    const got = await ui.page.getByTestId('audit-row').evaluateAll((els) => els.map((e) => `${e.dataset.actor}@${e.querySelector('[data-testid="audit-time"]').getAttribute('data-iso')}`));
    eq([...got].sort(), want.map(row).sort(), `UI ${label} แถวที่ได้ (data-actor@audit-time)`);
  }
});
