const fs = require('node:fs');
const ExcelJS = require('exceljs');
const { test, expect, pdfText } = require('./helpers');

const PII = [/\d{13}/, /0\d{9}/, /สมชาย/, /สมหญิง/, /ปิติ/, /มานะ/];
const noPii = (text, label) => { for (const re of PII) expect.soft(re.test(text), `${label} must not match ${re}`).toBe(false); };
const pct = (onTime, closed) => (closed ? `${(Math.round((onTime * 1000) / closed) / 10).toFixed(1)}%` : '–'); // BR-25 oracle
const kpis = async page => Object.fromEntries(await Promise.all(['received', 'closed', 'ontime-pct', 'backlog', 'overdue'].map(async k => [k, await page.getByTestId(`kpi-${k}`).innerText()])));
async function pick(page, period, service) {
  await page.getByTestId('period-select').selectOption(period);
  await page.waitForURL(u => u.searchParams.get('period') === period);
  await page.getByTestId('service-select').selectOption(service);
  await page.waitForURL(u => u.searchParams.get('period') === period && u.searchParams.get('service') === service);
}

test('TC-DASH-01 Dashboard ตัวเลขเริ่มต้น', async ({ h }) => {
  await h.reset();
  const p = await h.pageS('exec1');
  await p.goto('/dashboard');
  await expect(p.getByTestId('period-select')).toHaveValue('2026-12');
  await expect(p.getByTestId('service-select')).toHaveValue('ALL');
  expect(await kpis(p)).toEqual({ received: '3', closed: '0', 'ontime-pct': '–', backlog: '21', overdue: '1' });
  const wl = await p.getByTestId('workload-row').evaluateAll(rs => rs.map(r => [r.dataset.username, r.querySelector('[data-testid=workload-value]').textContent.trim()]));
  expect(wl).toEqual([['off.reg1', '3'], ['off.reg2', '9'], ['off.works1', '0']]);
  const api = await (await p.request.get('/api/dashboard?period=2026-12&service=ALL')).json();
  expect({ ...api, workload: undefined }).toEqual({ received: 3, closed: 0, onTime: 0, ontimePct: null, backlog: 21, overdue: 1, workload: undefined });
  noPii(await p.locator('body').innerText(), '/dashboard text');
  for (const [svc, rec, bl, od] of [['SV-01', 3, 11, 1], ['SV-02', 0, 7, 0], ['SV-03', 0, 3, 0]]) {
    await pick(p, '2026-12', svc);
    expect.soft(await kpis(p), svc).toEqual({ received: String(rec), closed: '0', 'ontime-pct': '–', backlog: String(bl), overdue: String(od) });
  }
});

test('TC-DASH-02 Dashboard ย้อนหลัง พ.ย. ต.ค. รายปี', async ({ h }) => {
  await h.reset();
  const p = await h.pageS('exec1');
  await p.goto('/dashboard');
  const NOW = { ALL: [21, 1], 'SV-01': [11, 1], 'SV-02': [7, 0], 'SV-03': [3, 0] }; // backlog/overdue are "as of now"
  const rows = [['2026-10', 'ALL', 1, 1, 1], ['2026-11', 'ALL', 26, 7, 6], ['2026-11', 'SV-01', 12, 3, 3], ['2026-11', 'SV-02', 10, 3, 2], ['2026-11', 'SV-03', 4, 1, 1],
    ['2026', 'ALL', 30, 8, 7], ['2026', 'SV-01', 16, 4, 4], ['2026', 'SV-02', 10, 3, 2], ['2026', 'SV-03', 4, 1, 1]];
  for (const [period, svc, rec, closed, onTime] of rows) {
    await pick(p, period, svc);
    const want = { received: String(rec), closed: String(closed), 'ontime-pct': pct(onTime, closed), backlog: String(NOW[svc][0]), overdue: String(NOW[svc][1]) };
    expect.soft(await kpis(p), `${period} ${svc}`).toEqual(want);
    const a = await (await p.request.get(`/api/dashboard?period=${period}&service=${svc}`)).json();
    expect.soft({ received: a.received, closed: a.closed, onTime: a.onTime, ontimePct: a.ontimePct }, `API ${period} ${svc}`)
      .toEqual({ received: rec, closed, onTime, ontimePct: Number(pct(onTime, closed).replace('%', '')) });
  }
});

test('TC-DASH-03 ส่งออก Excel/PDF เท่าหน้าจอ และไม่มีข้อมูลส่วนบุคคล', async ({ h }) => {
  await h.reset();
  const p = await h.pageS('exec1');
  await p.goto('/dashboard');
  const download = async id => {
    const [dl] = await Promise.all([p.waitForEvent('download'), p.getByTestId(id).click()]);
    return { buf: fs.readFileSync(await dl.path()), name: dl.suggestedFilename() };
  };
  const sheet = async buf => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets[0];
    return [1, 2, 3, 4, 5, 6].map(r => [String(ws.getCell(`A${r}`).value ?? ''), String(ws.getCell(`B${r}`).value ?? '')]);
  };
  const LABELS = ['รับเรื่อง', 'ปิดงาน', 'ทันกำหนด %', 'งานคงค้าง', 'เกินกำหนดคงค้าง'];
  await pick(p, '2026-11', 'ALL');
  const screen = await kpis(p);
  expect(screen).toEqual({ received: '26', closed: '7', 'ontime-pct': pct(6, 7), backlog: '21', overdue: '1' });
  const x1 = await download('export-xlsx-btn');
  const s1 = await sheet(x1.buf);
  expect(s1).toEqual([['ตัวชี้วัด', 'ค่า'], ...LABELS.map((l, i) => [l, Object.values(screen)[i]])]);
  noPii(s1.flat().join('\n'), 'xlsx 2026-11');
  const p1 = await download('export-pdf-btn');
  expect(p1.name).toMatch(/\.pdf$/);
  expect(p1.buf.subarray(0, 5).toString()).toBe('%PDF-');
  const t1 = pdfText(p1.buf);
  expect(t1.split('\n')).toContain('kpi received=26 closed=7 ontime=85.7% backlog=21 overdue=1');
  noPii(t1, 'pdf 2026-11');
  await pick(p, '2026-12', 'ALL');
  const s2 = await sheet((await download('export-xlsx-btn')).buf);
  expect(s2.slice(1).map(r => r[1])).toEqual(['3', '0', '–', '21', '1']);
  noPii(s2.flat().join('\n'), 'xlsx 2026-12');
  const au = await h.loginS('audit1');
  const ex = (await (await au.get('/api/audit?event=EXPORT')).json()).items;
  expect(ex.length).toBe(3);
  for (const e of ex) expect({ u: e.username, r: e.role }).toEqual({ u: 'exec1', r: 'executive' });
  expect(ex.map(e => e.detail).sort()).toEqual(['pdf 2026-11 ALL', 'xlsx 2026-11 ALL', 'xlsx 2026-12 ALL']);
  // Content-Type checked after the audit assertion (browser downloads expose no headers; this call adds a 4th EXPORT row)
  const ct = await p.request.get('/api/dashboard/export?format=pdf&period=2026-11&service=ALL');
  expect(ct.headers()['content-type']).toBe('application/pdf');
});

test('TC-DASH-04 ค่าขอบ "ทันกำหนด" 16:29:59 / 16:30:00 / 16:30:01', async ({ h }) => {
  await h.reset();
  await h.clock('2026-12-03T16:00:00+07:00');
  const reg1 = await h.loginS('off.reg1'), reg2 = await h.pageS('off.reg2'), exec = await h.pageS('exec1');
  expect((await reg2.request.post('/api/cases/EG-2569-000025/approve')).status()).toBe(200);
  expect((await reg1.post('/api/cases/EG-2569-000023/approve')).status()).toBe(200);
  const steps = [
    ['2026-12-03T16:29:59+07:00', 'EG-2569-000025', () => reg2.request.post('/api/officer/cases/EG-2569-000025/issue'), 1, 1],
    ['2026-12-03T16:30:00+07:00', 'EG-2569-000026', () => reg2.request.post('/api/cases/EG-2569-000026/reject', { data: { reason: 'xxxxxxxxxx' } }), 2, 2],
    ['2026-12-03T16:30:01+07:00', 'EG-2569-000023', () => reg1.post('/api/officer/cases/EG-2569-000023/issue'), 3, 2],
  ];
  for (const [at, no, act, closed, onTime] of steps) {
    await h.clock(at);
    expect((await act()).status(), `${no} @${at}`).toBe(200);
    await reg2.goto(`/officer/cases/${no}`);
    await expect.soft(reg2.getByTestId('closed-at'), `${no} closed-at`).toHaveAttribute('data-iso', at);
    const d = await (await exec.request.get('/api/dashboard?period=2026-12&service=ALL')).json();
    expect.soft({ closed: d.closed, onTime: d.onTime }, `after close @${at}`).toEqual({ closed, onTime });
    await exec.goto('/dashboard?period=2026-12&service=ALL');
    await expect.soft(exec.getByTestId('kpi-closed'), `kpi-closed @${at}`).toHaveText(String(closed));
  }
  await expect(exec.getByTestId('kpi-backlog')).toHaveText('18');
});

// ---------------------------------------------------------------- AUDIT
test('TC-AUDIT-01 เหตุการณ์และฟิลด์ใน Audit', async ({ h }) => {
  await h.reset();
  const reg2 = await h.loginS('off.reg2');
  expect((await reg2.post('/api/officer/cases/EG-2569-000028/claim')).status()).toBe(200);
  const reg1 = await h.loginS('off.reg1');
  expect((await reg1.post('/api/officer/cases/EG-2569-000020/return', { data: { reason: 'xxxxxxxxxx' } })).status()).toBe(200);
  expect((await reg2.post('/api/officer/cases/EG-2569-000013/forward')).status()).toBe(200);
  const head = await h.loginS('head1');
  expect((await head.post('/api/cases/EG-2569-000013/approve')).status()).toBe(200);
  expect((await reg2.post('/api/cases/EG-2569-000025/approve')).status()).toBe(200);
  expect((await reg2.post('/api/officer/cases/EG-2569-000025/issue')).status()).toBe(200);
  expect((await reg2.post('/api/cases/EG-2569-000026/reject', { data: { reason: 'xxxxxxxxxx' } })).status()).toBe(200);
  expect((await reg2.post('/api/officer/cases/EG-2569-000025/unmask', { data: { reason: 'ตรวจสอบตัวตนซ้ำ' } })).status()).toBe(200);
  const exec = await h.loginS('exec1');
  expect((await exec.get('/api/dashboard/export?format=xlsx&period=2026-12&service=ALL')).status()).toBe(200);
  const admin = await h.loginS('admin1');
  expect((await admin.put('/api/admin/services/SV-01', { data: { fee: 25, sla: 3 } })).status()).toBe(200);
  const p = await h.pageS('audit1');
  await p.goto('/audit');
  const rows = await p.getByTestId('audit-row').evaluateAll(rs => rs.map(r => {
    const t = id => r.querySelector(`[data-testid=${id}]`);
    return { id: Number(r.dataset.id), event: r.dataset.event, actor: t('audit-actor').textContent, role: t('audit-role').textContent,
      caseNo: t('audit-case-no').textContent, tr: t('audit-transition').textContent, detail: t('audit-detail').textContent, iso: t('audit-time').dataset.iso };
  }));
  const counts = rows.reduce((m, r) => ({ ...m, [r.event]: (m[r.event] || 0) + 1 }), {});
  expect.soft(counts).toEqual({ STAFF_LOGIN: 6, CLAIM: 1, RETURN: 1, FORWARD: 1, APPROVE: 2, ISSUE: 1, REJECT: 1, UNMASK: 1, EXPORT: 1, ADMIN_CHANGE: 1 });
  await expect(p.getByTestId('audit-count')).toHaveText('16');
  expect(rows.map(r => r.id)).toEqual([...rows.map(r => r.id)].sort((a, b) => b - a)); // same time → newest id first
  for (const r of rows) expect.soft(r.iso, `row ${r.id}`).toBe('2026-12-01T09:00:00+07:00');
  expect(rows.filter(r => r.event === 'STAFF_LOGIN').map(r => r.actor).sort()).toEqual(['admin1', 'audit1', 'exec1', 'head1', 'off.reg1', 'off.reg2']);
  const one = ev => rows.filter(r => r.event === ev);
  const pickF = r => ({ actor: r.actor, role: r.role, caseNo: r.caseNo, tr: r.tr });
  expect.soft(pickF(one('CLAIM')[0])).toEqual({ actor: 'off.reg2', role: 'officer', caseNo: 'EG-2569-000028', tr: 'SUBMITTED → IN_REVIEW' });
  expect.soft({ ...pickF(one('RETURN')[0]), d: one('RETURN')[0].detail }).toEqual({ actor: 'off.reg1', role: 'officer', caseNo: 'EG-2569-000020', tr: 'IN_REVIEW → NEED_FIX', d: 'xxxxxxxxxx' });
  expect.soft(pickF(one('FORWARD')[0])).toEqual({ actor: 'off.reg2', role: 'officer', caseNo: 'EG-2569-000013', tr: 'IN_REVIEW → PENDING_APPROVAL' });
  expect.soft(one('APPROVE').map(pickF).sort((a, b) => (a.actor < b.actor ? -1 : 1))).toEqual([
    { actor: 'head1', role: 'head', caseNo: 'EG-2569-000013', tr: 'PENDING_APPROVAL → APPROVED' },
    { actor: 'off.reg2', role: 'officer', caseNo: 'EG-2569-000025', tr: 'IN_REVIEW → APPROVED' }]);
  expect.soft({ ...pickF(one('ISSUE')[0]), d: one('ISSUE')[0].detail }).toEqual({ actor: 'off.reg2', role: 'officer', caseNo: 'EG-2569-000025', tr: 'APPROVED → COMPLETED', d: 'DOC-2569-000002' });
  expect.soft({ ...pickF(one('REJECT')[0]), d: one('REJECT')[0].detail }).toEqual({ actor: 'off.reg2', role: 'officer', caseNo: 'EG-2569-000026', tr: 'IN_REVIEW → REJECTED', d: 'xxxxxxxxxx' });
  expect.soft(one('UNMASK').map(r => ({ ...pickF(r), d: r.detail }))).toEqual([{ actor: 'off.reg2', role: 'officer', caseNo: 'EG-2569-000025', tr: '–', d: 'ตรวจสอบตัวตนซ้ำ' }]);
  expect.soft({ ...pickF(one('EXPORT')[0]), xlsx: one('EXPORT')[0].detail.includes('xlsx'), dec: one('EXPORT')[0].detail.includes('2026-12') }).toEqual({ actor: 'exec1', role: 'executive', caseNo: '–', tr: '–', xlsx: true, dec: true });
  expect.soft({ ...pickF(one('ADMIN_CHANGE')[0]), d: one('ADMIN_CHANGE')[0].detail }).toEqual({ actor: 'admin1', role: 'admin', caseNo: '–', tr: '–', d: 'SV-01 fee 20 → 25' });
  // filters
  const filt = async (actor, event, n) => {
    await p.goto('/audit');
    if (actor) await p.getByTestId('audit-filter-actor').fill(actor);
    if (event) await p.getByTestId('audit-filter-event').selectOption(event);
    await p.getByTestId('audit-apply-btn').click();
    await expect.soft(p.getByTestId('audit-count'), `filter ${actor}/${event}`).toHaveText(String(n));
  };
  await filt('off.reg2', '', 7);
  await filt('', 'APPROVE', 2);
  await filt('off.reg2', 'APPROVE', 1);
  // CSV
  await p.goto('/audit');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.getByTestId('audit-export-csv-btn').click()]);
  const lines = fs.readFileSync(await dl.path(), 'utf8').split(/\r?\n/).filter(Boolean);
  expect(lines[0]).toBe('time,username,role,event,caseNo,fromStatus,toStatus,detail');
  expect(lines.length - 1, 'CSV data rows').toBe(rows.length);
  await p.reload();
  await expect(p.getByTestId('audit-count')).toHaveText(String(rows.length + 1));
  await expect(p.getByTestId('audit-row').first()).toHaveAttribute('data-event', 'EXPORT');
  await expect(p.getByTestId('audit-row').first().getByTestId('audit-detail')).toHaveText('audit-csv');
});

test('TC-AUDIT-02 Audit แก้/ลบไม่ได้ (405)', async ({ h }) => {
  await h.reset();
  const au = await h.loginS('audit1');
  const before = (await (await au.get('/api/audit')).json()).items;
  const id = before[0].id;
  const admin = await h.loginS('admin1');
  for (const [who, ctx] of [['admin1', admin], ['audit1', au]]) {
    for (const [m, url, data] of [['put', `/api/audit/${id}`, { detail: 'x' }], ['patch', `/api/audit/${id}`, { detail: 'x' }], ['delete', `/api/audit/${id}`],
      ['put', '/api/audit', { detail: 'x' }], ['delete', '/api/audit'], ['delete', '/api/audit/999999']]) {
      await h.expectErr(await ctx[m](url, data ? { data } : undefined), 405, 'METHOD_NOT_ALLOWED', `${who} ${m.toUpperCase()} ${url}`);
    }
  }
  const after = (await (await au.get('/api/audit')).json()).items;
  for (const b of before) expect(after.find(a => a.id === b.id)).toEqual(b);
  const added = after.filter(a => !before.some(b => b.id === a.id));
  expect(added.map(a => `${a.event}:${a.username}`)).toEqual(['STAFF_LOGIN:admin1']);
  const p = await h.pageS('audit1');
  await p.goto('/audit');
  await expect(p.getByTestId('audit-edit-btn')).toHaveCount(0);
  await expect(p.getByTestId('audit-delete-btn')).toHaveCount(0);
  expect((await admin.get('/api/audit')).status()).toBe(403);
});

test('TC-AUDIT-03 กรองช่วงวันที่ตามเวลาไทย', async ({ h }) => {
  await h.reset();
  const L = [['L1', '2026-11-30T23:59:59+07:00', 'off.reg1'], ['L2', '2026-12-01T00:00:00+07:00', 'off.reg2'], ['L3', '2026-12-01T23:59:59+07:00', 'off.works1'],
    ['L4', '2026-12-02T00:00:00+07:00', 'off.reg1'], ['L5', '2026-12-02T09:00:00+07:00', 'audit1']];
  let p;
  for (const [, at, u] of L) { await h.clock(at); if (u === 'audit1') p = await h.pageS('audit1'); else await h.loginS(u); }
  const au = p.request; // the auditor's own login is L5
  const iso = Object.fromEntries(L.map(([k, at]) => [at, k]));
  const cases = [['2026-12-01', '2026-12-01', '', 'L2 L3'], ['2026-11-30', '2026-11-30', '', 'L1'], ['2026-11-30', '2026-12-01', '', 'L1 L2 L3'],
    ['2026-12-02', '', '', 'L4 L5'], ['', '2026-11-30', '', 'L1'], ['2026-12-01', '2026-12-02', '', 'L2 L3 L4 L5'], ['2026-12-01', '2026-12-01', 'off.reg2', 'L2']];
  for (const [from, to, actor, want] of cases) {
    const label = `from=${from} to=${to} actor=${actor}`;
    const r = await (await au.get(`/api/audit?${new URLSearchParams({ from, to, actor })}`)).json();
    expect.soft(r.items.map(i => iso[i.time] || i.time).sort().join(' '), `API ${label}`).toBe(want);
    expect.soft(r.count, `API count ${label}`).toBe(want.split(' ').length);
    await p.goto('/audit');
    await p.getByTestId('audit-filter-from').fill(from);
    await p.getByTestId('audit-filter-to').fill(to);
    await p.getByTestId('audit-filter-actor').fill(actor);
    await p.getByTestId('audit-apply-btn').click();
    await p.waitForURL(/from=/);
    await expect.soft(p.getByTestId('audit-count'), `UI count ${label}`).toHaveText(String(want.split(' ').length));
    const got = await p.getByTestId('audit-time').evaluateAll(ts => ts.map(t => t.dataset.iso));
    expect.soft(got.map(x => iso[x] || x).sort().join(' '), `UI rows ${label}`).toBe(want);
  }
  // CSV export must not hand a spreadsheet formula to the auditor (free-text reason typed by staff).
  // Uses a RETURN reason: no BUG_MODE touches RETURN auditing, so this check stays inside TC-AUDIT-03's own scope.
  const off = await h.loginS('off.reg1');
  expect((await off.post('/api/officer/cases/EG-2569-000020/return', { data: { reason: '=HYPERLINK("http://x","y")' } })).status()).toBe(200);
  const csv = await (await au.get('/api/audit/export.csv?event=RETURN')).text();
  const row = csv.split(/\r?\n/)[1];
  expect(row.endsWith(`"'=HYPERLINK(""http://x"",""y"")"`), row).toBe(true);
});
