const { test, expect } = require('./helpers');

test('TC-RBAC-01 ประชาชนเปิดคำขอคนอื่นไม่ได้ (IDOR)', async ({ h }) => {
  await h.reset();
  const p = await h.pageC('somying');
  const resp = await p.goto('/citizen/cases/EG-2569-000005');
  expect(resp.status(), 'UI other citizen case HTTP').toBe(404);
  await expect(p.getByTestId('not-found-msg')).toHaveText('ไม่พบคำขอ');
  await expect(p.getByTestId('case-no')).toHaveCount(0);
  await expect(p.getByTestId('case-status')).toHaveCount(0);
  expect(await p.content()).not.toContain('สมชาย');
  const api = p.request;
  const other = await api.get('/api/cases/EG-2569-000005');
  const ghost = await api.get('/api/cases/EG-2569-999999');
  expect({ status: other.status(), body: await other.text() }).toEqual({ status: 404, body: JSON.stringify({ code: 'NOT_FOUND', message: 'ไม่พบคำขอ' }) });
  expect({ status: ghost.status(), body: await ghost.text() }, 'non-existent case looks identical').toEqual({ status: 404, body: await other.text() });
  for (const [m, url] of [['get', '/api/documents/DOC-2569-000001/pdf'], ['get', '/api/drafts/DR-0001'], ['post', '/api/cases/EG-2569-000030/cancel']]) {
    expect((await api[m](url)).status(), `${m.toUpperCase()} ${url}`).toBe(404);
  }
  const own = await p.goto('/citizen/cases/EG-2569-000007');
  expect(own.status()).toBe(200);
  await expect(p.getByTestId('case-no')).toHaveText('EG-2569-000007');
  const sc = await h.loginC('somchai');
  expect((await sc.get('/api/cases/EG-2569-000005')).status()).toBe(200);
});

test('TC-RBAC-02 เจ้าหน้าที่อนุมัติ SV-02 ไม่ได้ (ตรวจที่ API)', async ({ h }) => {
  await h.reset();
  const reg2 = await h.loginS('off.reg2');
  await h.expectErr(await reg2.post('/api/cases/EG-2569-000014/approve'), 403, 'FORBIDDEN', 'off.reg2 approves SV-02 PENDING_APPROVAL');
  expect((await h.caseOf(reg2, 'EG-2569-000014')).status).toBe('PENDING_APPROVAL');
  await h.expectErr(await reg2.post('/api/cases/EG-2569-000013/approve'), 403, 'FORBIDDEN', 'off.reg2 approves own SV-02 IN_REVIEW');
  expect((await h.caseOf(reg2, 'EG-2569-000013')).status).toBe('IN_REVIEW');
  await h.expectErr(await reg2.post('/api/cases/EG-2569-000014/reject', { data: { reason: 'xxxxxxxxxx' } }), 403, 'FORBIDDEN', 'off.reg2 rejects SV-02');
  expect((await h.caseOf(reg2, 'EG-2569-000014')).status).toBe('PENDING_APPROVAL');
  const p = await h.pageS('off.reg2');
  for (const no of ['EG-2569-000013', 'EG-2569-000014']) {
    await p.goto(`/officer/cases/${no}`);
    await expect(p.getByTestId('approve-btn'), no).toHaveCount(0);
  }
  const head = await h.loginS('head1');
  await h.expectErr(await head.post('/api/cases/EG-2569-000025/approve'), 403, 'FORBIDDEN', 'head approves SV-01');
  const ok = await head.post('/api/cases/EG-2569-000014/approve');
  expect({ status: ok.status(), body: await ok.json() }).toEqual({ status: 200, body: { status: 'APPROVED' } });
  const au = await h.pageS('audit1');
  await au.goto('/audit?event=APPROVE');
  await expect(au.getByTestId('audit-count')).toHaveText('1');
  await expect(au.getByTestId('audit-row')).toHaveAttribute('data-actor', 'head1');
});

const ROLES = { citizen: ['C', 'somchai'], officer: ['S', 'off.reg1'], head: ['S', 'head1'], executive: ['S', 'exec1'], auditor: ['S', 'audit1'], admin: ['S', 'admin1'] };
const PAGES = { '/citizen': ['citizen'], '/officer/queue': ['officer', 'head'], '/head/approvals': ['head'], '/dashboard': ['executive'], '/audit': ['auditor'],
  '/admin/services': ['admin'], '/admin/holidays': ['admin'], '/admin/users': ['admin'], '/notifications': ['officer', 'head'] };
const NAV = { citizen: ['nav-my-cases'], officer: ['nav-queue', 'nav-bell'], head: ['nav-queue', 'nav-approvals', 'nav-bell'], executive: ['nav-dashboard'], auditor: ['nav-audit'],
  admin: ['nav-admin-services', 'nav-admin-holidays', 'nav-admin-users'] };
const ALL_NAV = ['nav-my-cases', 'nav-queue', 'nav-approvals', 'nav-bell', 'nav-dashboard', 'nav-audit', 'nav-admin-services', 'nav-admin-holidays', 'nav-admin-users'];

test('TC-RBAC-03 ตารางสิทธิ์หน้า/API ตามบทบาท', async ({ h }) => {
  // A + D: pages and menus
  for (const role of ['anon', ...Object.keys(ROLES)]) {
    await h.reset();
    const p = role === 'anon' ? await h.page() : ROLES[role][0] === 'C' ? await h.pageC(ROLES[role][1]) : await h.pageS(ROLES[role][1]);
    for (const [url, allowed] of Object.entries(PAGES)) {
      const r = await p.goto(url);
      if (role === 'anon') { expect.soft(new URL(p.url()).pathname, `anon ${url}`).toBe('/login'); continue; }
      if (allowed.includes(role)) {
        expect.soft(r.status(), `${role} ${url}`).toBe(200);
        await expect.soft(p.getByTestId('forbidden-msg'), `${role} ${url}`).toHaveCount(0);
      } else {
        expect.soft(r.status(), `${role} ${url}`).toBe(403);
        await expect.soft(p.getByTestId('forbidden-msg'), `${role} ${url}`).toHaveText('ไม่มีสิทธิ์เข้าถึงหน้านี้');
      }
    }
    const v = await p.goto('/verify/K7M2Q9XA');
    expect.soft(v.status(), `${role} /verify`).toBe(200);
    if (role !== 'anon') {
      await p.goto('/');
      for (const id of ALL_NAV) await expect.soft(p.getByTestId(id), `${role} menu ${id}`).toHaveCount(NAV[role].includes(id) ? 1 : 0);
    }
  }
  // B: API matrix (citizen representative = สมหญิง, owner of …000025)
  const API = [
    ['get', '/api/officer/queue', { anon: 401, citizen: 403, officer: 200, head: 200, executive: 403, auditor: 403, admin: 403 }],
    ['get', '/api/notifications', { anon: 401, citizen: 403, officer: 200, head: 200, executive: 403, auditor: 403, admin: 403 }],
    ['get', '/api/dashboard?period=2026-12&service=ALL', { anon: 401, citizen: 403, officer: 403, head: 403, executive: 200, auditor: 403, admin: 403 }],
    ['get', '/api/audit', { anon: 401, citizen: 403, officer: 403, head: 403, executive: 403, auditor: 200, admin: 403 }],
    ['get', '/api/admin/services', { anon: 401, citizen: 403, officer: 403, head: 403, executive: 403, auditor: 403, admin: 200 }],
    ['post', '/api/drafts', { anon: 401, citizen: 201, officer: 403, head: 403, executive: 403, auditor: 403, admin: 403 }, { serviceId: 'SV-01', qty: 1 }],
    ['get', '/api/cases/EG-2569-000025', { anon: 401, citizen: 200, officer: 200, head: 200, executive: 403, auditor: 403, admin: 403 }],
    ['post', '/api/officer/cases/EG-2569-000028/claim', { anon: 401, citizen: 403, officer: 200, head: 403, executive: 403, auditor: 403, admin: 403 }],
  ];
  for (const role of ['anon', ...Object.keys(ROLES)]) {
    await h.reset();
    const ctx = role === 'anon' ? await h.api() : role === 'citizen' ? await h.loginC('somying') : await h.loginS(ROLES[role][1]);
    for (const [m, url, want, data] of API) {
      const r = await ctx[m](url, data ? { data } : undefined);
      expect.soft(r.status(), `${role} ${m.toUpperCase()} ${url}`).toBe(want[role]);
    }
  }
  // C: department scope
  await h.reset();
  const works = await h.loginS('off.works1'), reg1 = await h.loginS('off.reg1');
  await h.expectErr(await works.post('/api/officer/cases/EG-2569-000028/claim'), 403, 'FORBIDDEN', 'works claims registry case');
  await h.expectErr(await reg1.post('/api/officer/cases/EG-2569-000010/claim'), 403, 'FORBIDDEN', 'registry claims works case');
  expect((await (await works.get('/api/officer/queue')).json()).items.map(i => i.caseNo)).toEqual(['EG-2569-000010']);
});

test('TC-RBAC-04 ผู้ดูแลระบบ: บริการ วันหยุด ผู้ใช้ และยอดที่ล็อก', async ({ h }) => {
  await h.reset();
  const ad = await h.pageS('admin1');
  await ad.goto('/admin/holidays');
  expect(await ad.getByTestId('holiday-row').evaluateAll(rs => rs.map(r => r.dataset.date))).toEqual(['2026-12-07', '2026-12-10', '2026-12-31', '2027-01-01']);
  // 2: before any change
  const c31 = await h.newPaid({ at: '2026-12-01T09:00:00+07:00', qty: 1 });
  expect({ caseNo: c31.caseNo, dueAt: (await h.caseOf(c31.ctx, c31.caseNo)).dueAt }).toEqual({ caseNo: 'EG-2569-000031', dueAt: '2026-12-04T16:30:00+07:00' });
  // 3
  await ad.goto('/admin/services');
  await ad.getByTestId('svc-fee-SV-01').fill('25');
  await ad.getByTestId('svc-save-SV-01').click();
  await expect(ad.getByTestId('action-success')).toContainText('SV-01');
  await ad.getByTestId('svc-fee-SV-02').fill('600');
  await ad.getByTestId('svc-save-SV-02').click();
  await expect(ad.getByTestId('action-success')).toContainText('SV-02');
  // 4: new drafts use the new fee; existing case keeps its fee
  const sc = await h.pageC('somchai');
  await sc.goto('/citizen/new/SV-01');
  await sc.getByTestId('qty-input').fill('5');
  await expect(sc.getByTestId('fee-total')).toHaveText('฿125');
  await sc.getByTestId('qty-input').fill('1');
  await expect(sc.getByTestId('fee-total')).toHaveText('฿25');
  await sc.goto('/citizen/new/SV-02');
  await expect(sc.getByTestId('fee-total')).toHaveText('฿600');
  await sc.goto('/citizen/cases/EG-2569-000030');
  await expect(sc.getByTestId('case-fee')).toHaveText('฿20');
  // 5: PP-0001 amount locked at ฿500
  await sc.goto('/citizen/new/SV-02?draft=DR-0002');
  await expect(sc.getByTestId('payment-amount')).toHaveText('฿500');
  await h.expectErr(await h.pay('PP-0001', 600), 422, 'AMOUNT_MISMATCH', 'pay 600 on locked 500');
  const p5 = await h.pay('PP-0001', 500);
  expect({ status: p5.status(), caseNo: (await p5.json()).caseNo }).toEqual({ status: 200, caseNo: 'EG-2569-000032' });
  // 6: add holiday; existing due date is not recomputed
  await ad.goto('/admin/holidays');
  await ad.getByTestId('holiday-date-input').fill('2026-12-02');
  await ad.getByTestId('holiday-name-input').fill('วันหยุดทดสอบ');
  await ad.getByTestId('holiday-add-btn').click();
  await expect(ad.getByTestId('holiday-row')).toHaveCount(5);
  expect((await h.caseOf(c31.ctx, 'EG-2569-000031')).dueAt).toBe('2026-12-04T16:30:00+07:00');
  // 7: new payment uses the new holiday (Wed 2 off → Thu 3, Fri 4, Tue 8)
  const c33 = await h.newPaid({ ctx: c31.ctx, at: '2026-12-01T09:00:00+07:00', qty: 1 });
  expect(c33.fee).toBe(25);
  expect.soft({ caseNo: c33.caseNo, dueAt: (await h.caseOf(c31.ctx, c33.caseNo)).dueAt }, 'step 7').toEqual({ caseNo: 'EG-2569-000033', dueAt: '2026-12-08T16:30:00+07:00' });
  // 8: role change applies at next login
  const put = await ad.request.put('/api/admin/users/exec1', { data: { role: 'auditor', dept: '' } });
  expect(put.status()).toBe(200);
  const ex = await h.page();
  await h.uiLoginS(ex, 'exec1');
  await expect(ex).toHaveURL(/\/audit$/);
  expect((await ex.goto('/dashboard')).status()).toBe(403);
  // 9
  await ex.goto('/audit?event=ADMIN_CHANGE');
  await expect(ex.getByTestId('audit-count')).toHaveText('4');
  const details = await ex.getByTestId('audit-detail').allInnerTexts();
  expect(details.sort()).toEqual(['SV-01 fee 20 → 25', 'SV-02 fee 500 → 600', 'exec1 role executive → auditor', 'holiday add 2026-12-02'].sort());
  for (const r of await ex.getByTestId('audit-role').allInnerTexts()) expect(r).toBe('admin');
  for (const a of await ex.getByTestId('audit-actor').allInnerTexts()) expect(a).toBe('admin1');
  // 10
  expect((await ad.request.post('/api/drafts', { data: { serviceId: 'SV-01', qty: 1 } })).status()).toBe(403);
  // 11
  await ad.goto('/admin/holidays');
  await ad.locator('[data-testid=holiday-row][data-date="2026-12-02"]').getByTestId('holiday-delete-btn').click();
  await expect(ad.getByTestId('holiday-row')).toHaveCount(4);
  await ex.goto('/audit?event=ADMIN_CHANGE');
  await expect(ex.getByTestId('audit-count')).toHaveText('5');
  await expect(ex.getByTestId('audit-row').first().getByTestId('audit-detail')).toHaveText('holiday delete 2026-12-02');
});

test('TC-RBAC-05 สิทธิ์เปิด/ดาวน์โหลดไฟล์แนบ', async ({ h }) => {
  await h.reset();
  const head = await h.loginS('head1');
  const ids = {};
  for (const no of ['000025', '000010', '000012', '000011']) ids[no] = (await (await head.get(`/api/cases/EG-2569-${no}/files`)).json()).items;
  const ctxs = { 'off.reg1': await h.loginS('off.reg1'), 'off.reg2': await h.loginS('off.reg2'), 'off.works1': await h.loginS('off.works1'), head1: head,
    somying: await h.loginC('somying'), somchai: await h.loginC('somchai'), exec1: await h.loginS('exec1'), audit1: await h.loginS('audit1'), admin1: await h.loginS('admin1'), anon: await h.api() };
  const SV03 = ['deed.pdf', 'id-card.pdf', 'plan.pdf'];
  const rows = [
    ['off.reg1', '000025', 200, ['id-card.pdf']], ['off.works1', '000025', 403], ['off.reg2', '000012', 200, SV03], ['off.works1', '000012', 403],
    ['off.works1', '000010', 200, SV03], ['off.reg1', '000010', 200, SV03], ['off.works1', '000011', 200, SV03],
    ['head1', '000025', 200, ['id-card.pdf']], ['head1', '000010', 200, SV03], ['head1', '000012', 200, SV03],
    ['somying', '000025', 200, ['id-card.pdf']], ['somchai', '000025', 404], ['exec1', '000025', 403], ['audit1', '000025', 403], ['admin1', '000025', 403], ['anon', '000025', 401],
  ];
  for (const [who, no, want, names] of rows) {
    const ctx = ctxs[who];
    const list = await ctx.get(`/api/cases/EG-2569-${no}/files`);
    expect.soft(list.status(), `${who} list …${no}`).toBe(want);
    if (want === 200) expect.soft((await list.json()).items.map(f => f.name).sort(), `${who} list …${no}`).toEqual(names);
    const f = await ctx.get(`/api/files/${ids[no][0].fileId}`);
    expect.soft(f.status(), `${who} file …${no}`).toBe(want);
    if (want === 200) {
      expect.soft(f.headers()['content-type'], `${who} file …${no}`).toBe('application/pdf');
      expect.soft((await f.body()).subarray(0, 4).toString(), `${who} file …${no}`).toBe('%PDF');
    }
  }
  expect((await ctxs['off.reg1'].get('/api/files/F-999999')).status()).toBe(404);
  const r1 = await h.pageS('off.reg1');
  await r1.goto('/officer/cases/EG-2569-000025');
  await expect(r1.getByTestId('doc-item')).toHaveCount(1);
  await expect(r1.getByTestId('doc-item')).toHaveAttribute('data-name', 'id-card.pdf');
  const [dl] = await Promise.all([r1.waitForEvent('download'), r1.getByTestId('doc-download-link').click()]);
  expect(require('node:fs').statSync(await dl.path()).size).toBeGreaterThan(0);
  const r2 = await h.pageS('off.reg2');
  await r2.goto('/officer/cases/EG-2569-000012');
  await expect(r2.getByTestId('doc-item')).toHaveCount(3);
  const sy = await h.pageC('somying');
  await sy.goto('/citizen/cases/EG-2569-000025');
  await expect(sy.getByTestId('doc-item')).toHaveCount(1);
});

test('TC-RBAC-06 ผู้ดูแลระบบ: ช่วงค่าที่ยอมรับ', async ({ h }) => {
  await h.reset();
  const ad = await h.pageS('admin1');
  const api = ad.request;
  const current = async () => (await (await api.get('/api/admin/services')).json()).items.find(s => s.id === 'SV-01');
  await ad.goto('/admin/services');
  const save = async (field, v) => {
    await ad.getByTestId(`svc-${field}-SV-01`).fill(String(v));
    await ad.getByTestId('svc-save-SV-01').click();
  };
  const FEE_MSG = 'ค่าธรรมเนียมต้องเป็นจำนวนเต็ม 0–100,000 บาท', SLA_MSG = 'SLA ต้องเป็นจำนวนเต็ม 1–60 วันทำการ';
  for (const [field, v, ok, code, msg] of [['fee', -1, false, 'INVALID_FEE', FEE_MSG], ['fee', 0, true], ['fee', 100000, true], ['fee', 100001, false, 'INVALID_FEE', FEE_MSG]]) {
    const before = await current();
    await save(field, v);
    if (ok) await expect.soft(ad.getByTestId('action-success'), `fee ${v}`).toBeVisible();
    else {
      await expect.soft(ad.getByTestId('action-error'), `fee ${v}`).toHaveText(msg);
      expect.soft(await current(), `fee ${v} not applied`).toEqual(before);
    }
    const r = await api.put('/api/admin/services/SV-01', { data: { fee: v } });
    expect.soft(ok ? r.status() : { s: r.status(), c: (await r.json()).code }, `API fee ${v}`).toEqual(ok ? 200 : { s: 400, c: code });
  }
  await ad.getByTestId('svc-fee-SV-01').fill('100000'); // back to a valid value before testing SLA
  for (const [v, ok] of [[0, false], [1, true], [60, true], [61, false]]) {
    await save('sla', v);
    if (ok) await expect.soft(ad.getByTestId('action-success'), `sla ${v}`).toBeVisible();
    else await expect.soft(ad.getByTestId('action-error'), `sla ${v}`).toHaveText(SLA_MSG);
    const r = await api.put('/api/admin/services/SV-01', { data: { sla: v } });
    expect.soft(ok ? r.status() : { s: r.status(), c: (await r.json()).code }, `API sla ${v}`).toEqual(ok ? 200 : { s: 400, c: 'INVALID_SLA' });
  }
  const dup = await h.expectErr(await api.post('/api/admin/holidays', { data: { date: '2026-12-07', name: 'ซ้ำ' } }), 409, 'DUPLICATE_HOLIDAY');
  expect(dup.message).toBe('มีวันหยุดนี้อยู่แล้ว');
  await ad.goto('/admin/holidays');
  await ad.getByTestId('holiday-date-input').fill('2026-12-07');
  await ad.getByTestId('holiday-name-input').fill('ซ้ำ');
  await ad.getByTestId('holiday-add-btn').click();
  await expect(ad.getByTestId('action-error')).toHaveText('มีวันหยุดนี้อยู่แล้ว');
  await expect(ad.getByTestId('holiday-row')).toHaveCount(4);
  expect((await api.post('/api/admin/holidays', { data: { date: '2026-12-05', name: 'วันเสาร์' } })).status()).toBe(201);
  const self = await h.expectErr(await api.put('/api/admin/users/admin1', { data: { role: 'executive', dept: '' } }), 409, 'SELF_ROLE_CHANGE');
  expect(self.message).toBe('ไม่สามารถเปลี่ยนบทบาทของตัวเองได้');
  expect((await (await api.get('/api/me')).json()).role).toBe('admin');
  const au = await h.loginS('audit1');
  const rows = (await (await au.get('/api/audit?event=ADMIN_CHANGE')).json()).items.map(i => i.detail).sort();
  expect(rows).toEqual(['SV-01 fee 0 → 100000', 'SV-01 fee 20 → 0', 'SV-01 sla 1 → 60', 'SV-01 sla 3 → 1', 'holiday add 2026-12-05'].sort());
});
