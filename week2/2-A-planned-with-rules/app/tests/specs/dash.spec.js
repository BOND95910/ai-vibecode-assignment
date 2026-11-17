// หมวด DASH · TC-DASH-01 ถึง 04 (DASH-02 จับ B10)
const fs = require('node:fs');
const { test, expect } = require('../helpers/world');
const { eq, ok, status, tid, text, attr, count, hidden, notContains, contains } = require('../helpers/check');
const { get } = require('../helpers/http');
const { CASE, DASH } = require('../helpers/thai');
const { dashReady, officerCase, doApprove, doIssue, doReject, clickDownload } = require('../helpers/ui');

const PII_NAMES = ['สมชาย', 'สมหญิง', 'ปิติ', 'มานะ'];
const noPii = (s, label) => {
  ok(!/\d{13}/.test(s), `${label}: ต้องไม่พบเลข 13 หลัก`, `พบ ${(/\d{13}/.exec(s) || [])[0]}`);
  ok(!/0\d{9}/.test(s), `${label}: ต้องไม่พบเบอร์โทร 0 ตามด้วย 9 หลัก`, `พบ ${(/0\d{9}/.exec(s) || [])[0]}`);
  for (const n of PII_NAMES) ok(!s.includes(n), `${label}: ต้องไม่พบชื่อ ${n}`);
};

// เลือกช่วงและบริการบนจอ แล้วคืนค่า 5 ช่อง kpi
async function selectKpis(page, period, service) {
  await tid(page, 'period-select').selectOption(period);
  await tid(page, 'service-select').selectOption(service);
}
async function readKpis(page) {
  const t = async (id) => ((await tid(page, id).textContent()) || '').trim();
  return {
    received: await t('kpi-received'), closed: await t('kpi-closed'), ontime: await t('kpi-ontime-pct'),
    backlog: await t('kpi-backlog'), overdue: await t('kpi-overdue'),
  };
}
async function expectKpis(page, exp, label) {
  await text(page, 'kpi-received', exp.received, `${label} kpi-received`);
  await text(page, 'kpi-closed', exp.closed, `${label} kpi-closed`);
  await text(page, 'kpi-ontime-pct', exp.ontime, `${label} kpi-ontime-pct`);
  await text(page, 'kpi-backlog', exp.backlog, `${label} kpi-backlog`);
  await text(page, 'kpi-overdue', exp.overdue, `${label} kpi-overdue`);
}

test('TC-DASH-01 Dashboard ตัวเลขเริ่มต้น', async ({ w }) => {
  await w.reset();
  const { page } = await w.session('exec1');
  await page.goto('/dashboard');
  await dashReady(page);
  await expect(tid(page, 'period-select'), 'period-select ค่าเริ่มต้น').toHaveValue('2026-12');
  await expect(tid(page, 'service-select'), 'service-select ค่าเริ่มต้น').toHaveValue('ALL');
  await expectKpis(page, { received: '3', closed: '0', ontime: DASH, backlog: '21', overdue: '1' }, 'ALL ธ.ค.');
  const ontimeText = ((await tid(page, 'kpi-ontime-pct').textContent()) || '').trim();
  ok(!/NaN|^0%$|^0\.0%$/.test(ontimeText), 'kpi-ontime-pct ต้องไม่ใช่ NaN / 0% / 0.0%', `received ${ontimeText}`);

  // API
  const d = await w.dashboard('2026-12', 'ALL');
  eq({ received: d.received, closed: d.closed, ontimePct: d.ontimePct, backlog: d.backlog, overdue: d.overdue },
    { received: 3, closed: 0, ontimePct: null, backlog: 21, overdue: 1 }, 'API ALL ธ.ค.');

  // งานในมือ
  await count(page.getByTestId('workload-row'), 3, 'workload-row');
  const rows = await page.getByTestId('workload-row').evaluateAll((els) => els.map((e) => [e.dataset.username, (e.querySelector('[data-testid="workload-value"]')?.textContent || '').trim()]));
  eq(Object.fromEntries(rows), { 'off.reg1': '3', 'off.reg2': '9', 'off.works1': '0' }, 'workload-row');
  eq(Object.fromEntries(d.workload.map((x) => [x.username, x.count])), { 'off.reg1': 3, 'off.reg2': 9, 'off.works1': 0 }, 'API workload');

  // ไม่มีข้อมูลส่วนบุคคล
  noPii(await page.locator('body').innerText(), 'innerText /dashboard');

  // ตัวกรองบริการ
  const svc = {
    'SV-01': { received: '3', closed: '0', ontime: DASH, backlog: '11', overdue: '1' },
    'SV-02': { received: '0', closed: '0', ontime: DASH, backlog: '7', overdue: '0' },
    'SV-03': { received: '0', closed: '0', ontime: DASH, backlog: '3', overdue: '0' },
  };
  for (const [s, exp] of Object.entries(svc)) {
    await tid(page, 'service-select').selectOption(s);
    await expectKpis(page, exp, `บริการ ${s}`);
    const a = await w.dashboard('2026-12', s);
    eq({ received: String(a.received), closed: String(a.closed), backlog: String(a.backlog), overdue: String(a.overdue) },
      { received: exp.received, closed: exp.closed, backlog: exp.backlog, overdue: exp.overdue }, `API บริการ ${s}`);
  }
});

test('TC-DASH-02 Dashboard ย้อนหลัง พ.ย. ต.ค. รายปี', async ({ w }) => {
  await w.reset();
  const { page } = await w.session('exec1');
  await page.goto('/dashboard');
  await dashReady(page);
  // [period, service, received, closed, ontime% (ตัวเลขสำหรับ API · ข้อความสำหรับจอ)]
  const table = [
    ['2026-10', 'ALL', 1, 1, 100.0],
    ['2026-11', 'ALL', 26, 7, 85.7],
    ['2026-11', 'SV-01', 12, 3, 100.0],
    ['2026-11', 'SV-02', 10, 3, 66.7],
    ['2026-11', 'SV-03', 4, 1, 100.0],
    ['2026', 'ALL', 30, 8, 87.5],
    ['2026', 'SV-01', 16, 4, 100.0],
    ['2026', 'SV-02', 10, 3, 66.7],
    ['2026', 'SV-03', 4, 1, 100.0],
  ];
  const backlog = { ALL: ['21', '1'], 'SV-01': ['11', '1'], 'SV-02': ['7', '0'], 'SV-03': ['3', '0'] };
  for (const [period, service, rec, closed, pct] of table) {
    const label = `${period} ${service}`;
    // API
    const a = await w.dashboard(period, service);
    eq({ received: a.received, closed: a.closed }, { received: rec, closed }, `API ${label} รับเรื่อง/ปิดงาน`);
    ok(typeof a.ontimePct === 'number' && Math.abs(a.ontimePct - pct) < 0.05, `API ${label} ontimePct: expected ${pct} but received ${a.ontimePct}`);
    eq([String(a.backlog), String(a.overdue)], backlog[service], `API ${label} backlog/overdue (ค่า "ณ ตอนนี้" ไม่ขึ้นกับช่วง)`);
    // หน้าจอ
    await selectKpis(page, period, service);
    await expectKpis(page, { received: String(rec), closed: String(closed), ontime: pct.toFixed(1) + '%', backlog: backlog[service][0], overdue: backlog[service][1] }, label);
  }
});

test('TC-DASH-03 ส่งออก Excel/PDF เท่าหน้าจอ และไม่มีข้อมูลส่วนบุคคล', async ({ w }) => {
  const ExcelJS = require('exceljs');
  const pdfParse = require('pdf-parse/lib/pdf-parse.js');
  await w.reset();
  const ex = await w.session('exec1');
  const page = ex.page;
  await page.goto('/dashboard');
  await dashReady(page);
  const allText = [];

  const readXlsx = async (download) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(await download.path());
    const sh = wb.worksheets[0];
    const cell = (r, c) => { const v = sh.getRow(r).getCell(c).value; return v == null ? '' : String(typeof v === 'object' && v.result !== undefined ? v.result : v); };
    const map = {};
    for (let r = 2; r <= 6; r++) map[cell(r, 1)] = cell(r, 2);
    const flat = [];
    sh.eachRow((row) => row.eachCell((c) => flat.push(String(c.value))));
    allText.push(flat.join('\n'));
    return { header: [cell(1, 1), cell(1, 2)], map };
  };

  // พ.ย. ALL
  await selectKpis(page, '2026-11', 'ALL');
  await expectKpis(page, { received: '26', closed: '7', ontime: '85.7%', backlog: '21', overdue: '1' }, 'หน้าจอ พ.ย.');
  const screen = await readKpis(page);
  const { download: dx } = await clickDownload(page, tid(page, 'export-xlsx-btn'));
  const x1 = await readXlsx(dx);
  eq(x1.header, ['ตัวชี้วัด', 'ค่า'], 'xlsx พ.ย. หัวตาราง');
  eq(x1.map, { 'รับเรื่อง': '26', 'ปิดงาน': '7', 'ทันกำหนด %': '85.7%', 'งานคงค้าง': '21', 'เกินกำหนดคงค้าง': '1' }, 'xlsx พ.ย. ค่าในชีตแรก');
  eq(x1.map, { 'รับเรื่อง': screen.received, 'ปิดงาน': screen.closed, 'ทันกำหนด %': screen.ontime, 'งานคงค้าง': screen.backlog, 'เกินกำหนดคงค้าง': screen.overdue }, 'xlsx พ.ย. เท่ากับ 5 ช่อง kpi-* บนจอ');

  const { download: dp, response } = await clickDownload(page, tid(page, 'export-pdf-btn'), '/api/dashboard/export');
  if (response) contains(response.headers()['content-type'] || '', 'application/pdf', 'pdf พ.ย. Content-Type');
  const pdfBuf = fs.readFileSync(await dp.path());
  eq(pdfBuf.subarray(0, 4).toString('latin1'), '%PDF', 'pdf พ.ย. ขึ้นต้นด้วย %PDF');
  const pdfText = (await pdfParse(pdfBuf)).text;
  allText.push(pdfText);
  contains(pdfText, 'kpi received=26 closed=7 ontime=85.7% backlog=21 overdue=1', 'pdf พ.ย. บรรทัด ASCII');

  // ธ.ค. ALL
  await selectKpis(page, '2026-12', 'ALL');
  await expectKpis(page, { received: '3', closed: '0', ontime: DASH, backlog: '21', overdue: '1' }, 'หน้าจอ ธ.ค.');
  const { download: d3 } = await clickDownload(page, tid(page, 'export-xlsx-btn'));
  const x3 = await readXlsx(d3);
  eq(x3.map, { 'รับเรื่อง': '3', 'ปิดงาน': '0', 'ทันกำหนด %': DASH, 'งานคงค้าง': '21', 'เกินกำหนดคงค้าง': '1' }, 'xlsx ธ.ค. ค่าในชีตแรก');

  // ไม่มีข้อมูลส่วนบุคคลในทุกไฟล์ (ตรวจบนข้อความที่ดึงออกมา)
  allText.forEach((t, i) => noPii(t, `ไฟล์ส่งออกที่ ${i + 1}`));

  // Audit EXPORT 3 แถว
  const items = (await w.auditItems('event=EXPORT')).items;
  eq(items.length, 3, 'Audit EXPORT ต้อง 3 แถว (xlsx พ.ย., pdf พ.ย., xlsx ธ.ค.)');
  for (const i of items) {
    eq([i.username, i.role], ['exec1', 'executive'], 'Audit EXPORT ผู้ทำ/บทบาท');
    ok(/xlsx|pdf/.test(i.detail) && /2026-1[12]/.test(i.detail), 'Audit EXPORT detail ต้องมีรูปแบบไฟล์และช่วง', `received ${JSON.stringify(i.detail)}`);
  }
  const details = items.map((i) => i.detail).join(' | ');
  for (const need of ['xlsx', 'pdf', '2026-11', '2026-12']) contains(details, need, 'Audit EXPORT detail รวม');
  const au = await w.session('audit1');
  await au.page.goto('/audit');
  await tid(au.page, 'audit-filter-event').selectOption('EXPORT');
  await tid(au.page, 'audit-apply-btn').click();
  await text(au.page, 'audit-count', '3', 'UI audit-count (EXPORT)');
  const actors = await au.page.getByTestId('audit-row').evaluateAll((els) => els.map((e) => e.dataset.actor));
  eq(actors, ['exec1', 'exec1', 'exec1'], 'UI data-actor');
});

test('TC-DASH-04 ค่าขอบ "ทันกำหนด" 16:29:59 / 16:30:00 / 16:30:01', async ({ w }) => {
  await w.reset();
  await w.clock('2026-12-03T16:00:00+07:00');
  const reg1 = await w.session('off.reg1');
  const reg2 = await w.session('off.reg2');
  const exec = await w.session('exec1');
  const post = require('../helpers/http').post;
  const kpiClosed = async (label, closed, onTime) => {
    const d = await w.dashboard('2026-12', 'ALL');
    eq({ closed: d.closed, onTime: d.onTime }, { closed, onTime }, `${label} API closed/onTime`);
    await exec.page.goto('/dashboard');
    await text(exec.page, 'kpi-closed', String(closed), `${label} kpi-closed`);
  };
  const closedAt = async (page, caseNo, iso, label) => {
    await officerCase(page, caseNo);
    await attr(tid(page, 'closed-at'), 'data-iso', iso, `${label} closed-at ของ ${caseNo}`);
  };

  // 1 ที่ 16:00:00 อนุมัติ 25 (reg2) และ 23 (reg1)
  let r = await post(reg2.api, `/api/cases/${CASE(25)}/approve`);
  status(r, 200, 'ขั้น 1 reg2 approve …000025');
  eq(r.body.status, 'APPROVED', 'ขั้น 1 …000025 status');
  r = await post(reg1.api, `/api/cases/${CASE(23)}/approve`);
  status(r, 200, 'ขั้น 1 reg1 approve …000023');
  eq(r.body.status, 'APPROVED', 'ขั้น 1 …000023 status');

  // 2 16:29:59 issue 25 → ทัน
  await w.clock('2026-12-03T16:29:59+07:00');
  r = await post(reg2.api, `/api/officer/cases/${CASE(25)}/issue`);
  status(r, 200, 'ขั้น 2 issue …000025');
  await kpiClosed('ขั้น 2 (16:29:59)', 1, 1);
  await closedAt(reg2.page, CASE(25), '2026-12-03T16:29:59+07:00', 'ขั้น 2');

  // 3 16:30:00 reject 26 → ทัน (ที่ขอบ รวม REJECTED)
  await w.clock('2026-12-03T16:30:00+07:00');
  r = await post(reg2.api, `/api/cases/${CASE(26)}/reject`, { reason: 'xxxxxxxxxx' });
  status(r, 200, 'ขั้น 3 reject …000026');
  await kpiClosed('ขั้น 3 (16:30:00)', 2, 2);
  await closedAt(reg2.page, CASE(26), '2026-12-03T16:30:00+07:00', 'ขั้น 3');

  // 4 16:30:01 issue 23 → ไม่ทัน (เกินขอบ 1 วินาที)
  await w.clock('2026-12-03T16:30:01+07:00');
  r = await post(reg1.api, `/api/officer/cases/${CASE(23)}/issue`);
  status(r, 200, 'ขั้น 4 issue …000023');
  await kpiClosed('ขั้น 4 (16:30:01)', 3, 2);
  await closedAt(reg1.page, CASE(23), '2026-12-03T16:30:01+07:00', 'ขั้น 4');
  const d = await w.dashboard('2026-12', 'ALL');
  eq(d.backlog, 18, 'ขั้น 4 backlog API (21 − 3)');
  await text(exec.page, 'kpi-backlog', '18', 'ขั้น 4 kpi-backlog');
});
