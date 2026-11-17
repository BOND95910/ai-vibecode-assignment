// หมวด RBAC · TC-RBAC-01 (B06) · 02 (B07) · 03 · 04 · 05 · 06
const { test, expect } = require('../helpers/world');
const { eq, ok, status, err, tid, text, attr, count, hidden, contains, notContains } = require('../helpers/check');
const { get, post, put, call, loginS } = require('../helpers/http');
const { CASE, baht } = require('../helpers/thai');
const { officerCase, citizenCase, caseReady, auditReady } = require('../helpers/ui');

// ---------------------------------------------------------------- RBAC-01
test('TC-RBAC-01 ประชาชนเปิดคำขอคนอื่นไม่ได้ (IDOR)', async ({ w }) => {
  await w.reset();
  const { page, api } = await w.session('somying');
  const NF = { code: 'NOT_FOUND', message: 'ไม่พบคำขอ' };

  // UI /citizen/cases/…000005 (ของสมชาย)
  const res = await page.goto(`/citizen/cases/${CASE(5)}`);
  eq(res.status(), 404, 'UI HTTP ของ /citizen/cases/…000005 (ของสมชาย)');
  await text(page, 'not-found-msg', 'ไม่พบคำขอ', 'UI not-found-msg');
  await count(tid(page, 'case-no'), 0, 'UI ต้องไม่มี case-no');
  await count(tid(page, 'case-status'), 0, 'UI ต้องไม่มี case-status');
  notContains(await page.content(), 'สมชาย', 'UI HTML ต้องไม่มีชื่อ สมชาย');

  // API
  const other = await get(api, `/api/cases/${CASE(5)}`);
  status(other, 404, 'GET คำขอของสมชาย');
  eq(other.body, NF, 'GET คำขอของสมชาย body');
  const none = await get(api, '/api/cases/EG-2569-999999');
  status(none, 404, 'GET คำขอที่ไม่มีจริง');
  eq(none.text, other.text, 'คำขอที่ไม่มีจริงต้องตอบเหมือนคำขอของคนอื่นทุกตัวอักษร (แยกไม่ออกว่าเลขมีอยู่)');
  status(await get(api, '/api/documents/DOC-2569-000001/pdf'), 404, 'GET เอกสารของสมชาย');
  status(await get(api, '/api/drafts/DR-0001'), 404, 'GET ร่างของสมชาย');
  status(await post(api, `/api/cases/${CASE(30)}/cancel`), 404, 'POST cancel คำขอของสมชาย');

  // ของตัวเอง
  const mine = await page.goto(`/citizen/cases/${CASE(7)}`);
  eq(mine.status(), 200, 'UI HTTP ของ …000007 (ของตัวเอง)');
  await text(page, 'case-no', CASE(7), 'UI case-no ของตัวเอง');
  const som = await w.api('somchai');
  status(await get(som, `/api/cases/${CASE(5)}`), 200, 'สมชาย GET …000005 (ของตัวเอง)');
});

// ---------------------------------------------------------------- RBAC-02
test('TC-RBAC-02 เจ้าหน้าที่อนุมัติ SV-02 ไม่ได้ (API)', async ({ w }) => {
  await w.reset();
  const off = await w.session('off.reg2');
  const statusOf = async (api, n) => (await get(api, `/api/cases/${CASE(n)}`)).body.status;

  // 1-3 ยิง API ตรง ๆ (ไม่เชื่อว่าปุ่มซ่อน = ปลอดภัย)
  err(await post(off.api, `/api/cases/${CASE(14)}/approve`), 403, 'FORBIDDEN', null, '1 off.reg2 approve …000014 (SV-02 PENDING_APPROVAL)');
  eq(await statusOf(off.api, 14), 'PENDING_APPROVAL', '1 สถานะ …000014 ต้องยัง PENDING_APPROVAL');
  err(await post(off.api, `/api/cases/${CASE(13)}/approve`), 403, 'FORBIDDEN', null, '2 off.reg2 approve …000013 (SV-02 ที่ตัวเองถือ)');
  eq(await statusOf(off.api, 13), 'IN_REVIEW', '2 สถานะ …000013 ต้องยัง IN_REVIEW');
  const rj = await post(off.api, `/api/cases/${CASE(14)}/reject`, { reason: 'xxxxxxxxxx' });
  status(rj, 403, '3 off.reg2 reject …000014');
  eq(await statusOf(off.api, 14), 'PENDING_APPROVAL', '3 สถานะ …000014 ต้องเดิม');

  // 4 UI ไม่มีปุ่มอนุมัติ
  for (const n of [13, 14]) {
    await officerCase(off.page, CASE(n));
    await count(tid(off.page, 'approve-btn'), 0, `4 UI …${n} approve-btn`);
  }

  // 5-6 หัวหน้า
  const hd = await w.api('head1');
  status(await post(hd, `/api/cases/${CASE(25)}/approve`), 403, '5 head1 approve SV-01 …000025 (หัวหน้าไม่อนุมัติแทน SV-01)');
  const ok6 = await post(hd, `/api/cases/${CASE(14)}/approve`);
  status(ok6, 200, '6 head1 approve …000014 (ตัวควบคุมบวก)');
  eq(ok6.body.status, 'APPROVED', '6 status');

  // 7 Audit APPROVE เหลือแถวเดียว
  const a = (await w.auditItems('event=APPROVE')).items;
  eq(a.length, 1, '7 Audit APPROVE ต้อง 1 แถวเท่านั้น');
  eq([a[0].username, a[0].caseNo], ['head1', CASE(14)], '7 Audit APPROVE ของ head1 …000014');
  const au = await w.session('audit1');
  await au.page.goto('/audit');
  await auditReady(au.page);
  await tid(au.page, 'audit-filter-event').selectOption('APPROVE');
  await tid(au.page, 'audit-apply-btn').click();
  await text(au.page, 'audit-count', '1', '7 UI audit-count (APPROVE)');
  await attr(au.page.getByTestId('audit-row'), 'data-actor', 'head1', '7 UI data-actor');
});

// ---------------------------------------------------------------- RBAC-03
const WHO = { citizen: 'somchai', officer: 'off.reg1', head: 'head1', executive: 'exec1', auditor: 'audit1', admin: 'admin1' };
const ROLES = ['anon', 'citizen', 'officer', 'head', 'executive', 'auditor', 'admin'];
const only = (...ok_) => Object.fromEntries(ROLES.map((r) => [r, r === 'anon' ? 'redir' : ok_.includes(r) ? 200 : 403]));
const PAGES = [
  ['/citizen', only('citizen')],
  ['/officer/queue', only('officer', 'head')],
  ['/head/approvals', only('head')],
  ['/dashboard', only('executive')],
  ['/audit', only('auditor')],
  ['/admin/services', only('admin')],
  ['/admin/holidays', only('admin')],
  ['/admin/users', only('admin')],
  ['/notifications', only('officer', 'head')],
  ['/verify/K7M2Q9XA', Object.fromEntries(ROLES.map((r) => [r, 200]))],
];
const apiOnly = (okCode, ...okRoles) => Object.fromEntries(ROLES.map((r) => [r, r === 'anon' ? 401 : okRoles.includes(r) ? okCode : 403]));
const APIS = [
  ['GET', '/api/officer/queue?filter=all', undefined, apiOnly(200, 'officer', 'head')],
  ['GET', '/api/notifications', undefined, apiOnly(200, 'officer', 'head')],
  ['GET', '/api/dashboard?period=2026-12&service=ALL', undefined, apiOnly(200, 'executive')],
  ['GET', '/api/audit', undefined, apiOnly(200, 'auditor')],
  ['GET', '/api/admin/services', undefined, apiOnly(200, 'admin')],
  ['POST', '/api/drafts', { serviceId: 'SV-01', qty: 1 }, apiOnly(201, 'citizen')],
  ['GET', `/api/cases/${CASE(25)}`, undefined, apiOnly(200, 'citizen', 'officer', 'head'), 'somying'],
  ['POST', `/api/officer/cases/${CASE(28)}/claim`, undefined, apiOnly(200, 'officer')], // ต้องเป็นแถวสุดท้าย
];
const NAV_ALL = ['nav-my-cases', 'nav-queue', 'nav-approvals', 'nav-dashboard', 'nav-audit', 'nav-admin-services', 'nav-admin-holidays', 'nav-admin-users', 'nav-bell'];
const NAV_OK = {
  citizen: ['nav-my-cases'], officer: ['nav-queue', 'nav-bell'], head: ['nav-queue', 'nav-approvals', 'nav-bell'],
  executive: ['nav-dashboard'], auditor: ['nav-audit'], admin: ['nav-admin-services', 'nav-admin-holidays', 'nav-admin-users'],
};
const LANDING = { citizen: '/citizen', officer: '/officer/queue', head: '/head/approvals', executive: '/dashboard', auditor: '/audit', admin: '/admin/services' };

test('TC-RBAC-03 ตารางสิทธิ์หน้า/API ตามบทบาท', async ({ w }) => {
  for (const role of ROLES) {
    await w.reset(); // RESET ก่อนแต่ละบทบาท
    const s = await w.session(role === 'anon' ? 'anon' : WHO[role]);

    // ส่วน D เมนู (หน้าตั้งต้นของบทบาท)
    if (role !== 'anon') {
      await s.page.goto(LANDING[role]);
      await expect(tid(s.page, 'user-name'), `${role} หลังล็อกอินต้องเห็น user-name`).toBeVisible();
      for (const n of NAV_ALL) {
        if (NAV_OK[role].includes(n)) await expect(tid(s.page, n).first(), `${role} ต้องมี ${n}`).toBeVisible();
        else await count(tid(s.page, n), 0, `${role} ต้องไม่มี ${n}`);
      }
    }

    // ส่วน A หน้า
    for (const [url, byRole] of PAGES) {
      const exp = byRole[role];
      const label = `ส่วน A ${role} เปิด ${url}`;
      const res = await s.page.goto(url);
      if (exp === 'redir') {
        await expect(s.page, `${label}: expected redirect /login`).toHaveURL(/\/login/);
      } else if (exp === 200) {
        eq(res.status(), 200, `${label} HTTP`);
        await count(tid(s.page, 'forbidden-msg'), 0, `${label} ต้องไม่มี forbidden-msg`);
      } else {
        eq(res.status(), 403, `${label} HTTP`);
        await text(s.page, 'forbidden-msg', 'ไม่มีสิทธิ์เข้าถึงหน้านี้', `${label} forbidden-msg`);
      }
    }

    // ส่วน B API (claim เป็นลำดับสุดท้าย)
    for (const [m, url, body, byRole, asWho] of APIS) {
      let api = s.api;
      if (role === 'citizen' && asWho) api = await w.api(asWho);
      const r = await call(api, m, url, { data: body });
      status(r, byRole[role], `ส่วน B ${role} ${m} ${url}`);
    }
  }

  // ส่วน C ขอบเขตแผนก
  await w.reset();
  const works = await w.api('off.works1');
  const reg = await w.api('off.reg1');
  err(await post(works, `/api/officer/cases/${CASE(28)}/claim`), 403, 'FORBIDDEN', null, 'ส่วน C off.works1 claim คำขอทะเบียน');
  err(await post(reg, `/api/officer/cases/${CASE(10)}/claim`), 403, 'FORBIDDEN', null, 'ส่วน C off.reg1 claim คำขอฝ่ายโยธา');
  const q = await get(works, '/api/officer/queue?filter=all');
  eq(q.body.items.map((i) => i.caseNo), [CASE(10)], 'ส่วน C คิวของ off.works1');
});

// ---------------------------------------------------------------- RBAC-04
test('TC-RBAC-04 ผู้ดูแลระบบ: บริการ วันหยุด ผู้ใช้ และยอดที่ล็อก', async ({ w }) => {
  await w.reset();
  const admin = await w.session('admin1');
  const svcFee = async (id) => (await get(admin.api, '/api/admin/services')).body.items.find((i) => i.id === id).fee;

  // 1
  await admin.page.goto('/admin/holidays');
  await count(admin.page.getByTestId('holiday-row'), 4, '1 holiday-row');
  eq((await admin.page.getByTestId('holiday-row').evaluateAll((els) => els.map((e) => e.dataset.date))).sort(), ['2026-12-07', '2026-12-10', '2026-12-31', '2027-01-01'], '1 data-date');

  // 2 ก่อนแก้ใด ๆ
  const som = await w.session('somchai');
  const p1 = await w.newPaid({ r: som.api, service: 'SV-01', qty: 1 });
  eq(p1.caseNo, CASE(31), '2 caseNo');
  eq((await get(som.api, `/api/cases/${p1.caseNo}`)).body.dueAt, '2026-12-04T16:30:00+07:00', '2 dueAt');

  // 3 แก้ค่าธรรมเนียม
  await admin.page.goto('/admin/services');
  await tid(admin.page, 'svc-fee-SV-01').fill('25');
  await tid(admin.page, 'svc-save-SV-01').click();
  await expect(tid(admin.page, 'action-success'), '3 action-success หลังบันทึก SV-01').toBeVisible();
  await expect.poll(() => svcFee('SV-01'), { message: '3 fee SV-01 ที่เก็บ: expected 25' }).toBe(25);
  await tid(admin.page, 'svc-fee-SV-02').fill('600');
  await tid(admin.page, 'svc-save-SV-02').click();
  await expect(tid(admin.page, 'action-success'), '3 action-success หลังบันทึก SV-02').toBeVisible();
  await expect.poll(() => svcFee('SV-02'), { message: '3 fee SV-02 ที่เก็บ: expected 600' }).toBe(600);

  // 4 ประชาชนร่างใหม่ ใช้ค่าใหม่ คำขอเดิมไม่เปลี่ยน
  await som.page.goto('/citizen/new/SV-01');
  await tid(som.page, 'qty-input').fill('5');
  await text(som.page, 'fee-total', '฿125', '4 SV-01 qty 5');
  await tid(som.page, 'qty-input').fill('1');
  await text(som.page, 'fee-total', '฿25', '4 SV-01 qty 1');
  await som.page.goto('/citizen/new/SV-02');
  await text(som.page, 'fee-total', '฿600', '4 SV-02');
  await citizenCase(som.page, CASE(30));
  await text(som.page, 'case-fee', '฿20', '4 …000030 case-fee ต้องยัง ฿20');

  // 5 ยอดที่ล็อกของ seed PP-0001
  await som.page.goto('/citizen/new/SV-02?draft=DR-0002');
  await text(som.page, 'payment-amount', '฿500', '5 payment-amount ของ DR-0002 (ล็อกที่ ฿500 ก่อนแก้)');
  err(await w.pay('PP-0001', 600), 422, 'AMOUNT_MISMATCH', null, '5 pay 600');
  const pp = await w.pay('PP-0001', 500);
  status(pp, 200, '5 pay 500');
  eq(pp.body.caseNo, CASE(32), '5 caseNo');

  // 6 เพิ่มวันหยุด 2 ธ.ค. ไม่คำนวณใหม่
  await admin.page.goto('/admin/holidays');
  await tid(admin.page, 'holiday-date-input').fill('2026-12-02');
  await tid(admin.page, 'holiday-name-input').fill('วันหยุดทดสอบ');
  await tid(admin.page, 'holiday-add-btn').click();
  await count(admin.page.getByTestId('holiday-row'), 5, '6 holiday-row');
  eq((await get(som.api, `/api/cases/${CASE(31)}`)).body.dueAt, '2026-12-04T16:30:00+07:00', '6 dueAt ของ …000031 ต้องไม่ถูกคำนวณใหม่');

  // 7 หลังเพิ่มวันหยุด
  const p2 = await w.newPaid({ r: som.api, service: 'SV-01', qty: 1 });
  eq(p2.caseNo, CASE(33), '7 caseNo');
  eq(p2.fee, 25, '7 ค่าธรรมเนียม SV-01 ใหม่');
  eq((await get(som.api, `/api/cases/${p2.caseNo}`)).body.dueAt, '2026-12-08T16:30:00+07:00', '7 dueAt (พ.2 หยุด → พฤ.3 ศ.4 อ.8)');

  // 8 เปลี่ยนบทบาท exec1
  const ch = await put(admin.api, '/api/admin/users/exec1', { role: 'auditor', dept: '' });
  status(ch, 200, '8 PUT users/exec1');
  const exec = await w.fresh('anon');
  const lg = await loginS(exec, 'exec1');
  eq(lg.landing, '/audit', '8 หน้าตั้งต้นของ exec1 (บทบาทใหม่ auditor)');
  const ex = await w.pageFor(exec);
  await ex.page.goto('/');
  await expect(ex.page, '8 หน้าตั้งต้น').toHaveURL(/\/audit$/);
  const dres = await ex.page.goto('/dashboard');
  eq(dres.status(), 403, '8 exec1 (เป็น auditor แล้ว) เปิด /dashboard');

  // 9 Audit ADMIN_CHANGE
  await ex.page.goto('/audit');
  await auditReady(ex.page);
  await tid(ex.page, 'audit-filter-event').selectOption('ADMIN_CHANGE');
  await tid(ex.page, 'audit-apply-btn').click();
  await text(ex.page, 'audit-count', '4', '9 UI audit-count');
  const ac = await get(exec, '/api/audit?event=ADMIN_CHANGE');
  status(ac, 200, '9 GET audit (exec1 ในบทบาท auditor)');
  eq(ac.body.count, 4, '9 API count');
  ac.body.items.forEach((i) => eq([i.username, i.role], ['admin1', 'admin'], '9 ผู้ทำ'));
  const det = ac.body.items.map((i) => i.detail).join(' | ');
  for (const d of ['SV-01 fee 20 → 25', 'SV-02 fee 500 → 600', 'holiday add 2026-12-02', 'exec1 role executive → auditor']) contains(det, d, '9 detail');

  // 10 admin ทำรายการคำขอไม่ได้
  status(await post(admin.api, '/api/drafts', { serviceId: 'SV-01', qty: 1 }), 403, '10 admin POST /api/drafts');

  // 11 ลบวันหยุด
  await admin.page.goto('/admin/holidays');
  await admin.page.locator('[data-testid="holiday-row"][data-date="2026-12-02"]').getByTestId('holiday-delete-btn').click();
  await count(admin.page.getByTestId('holiday-row'), 4, '11 holiday-row');
  const ac2 = await get(exec, '/api/audit?event=ADMIN_CHANGE');
  eq(ac2.body.count, 5, '11 ADMIN_CHANGE รวม');
  contains(ac2.body.items.map((i) => i.detail).join(' | '), 'holiday delete 2026-12-02', '11 detail');
});

// ---------------------------------------------------------------- RBAC-05
test('TC-RBAC-05 สิทธิ์เปิด/ดาวน์โหลดไฟล์แนบ', async ({ w }) => {
  await w.reset();
  const A = ['id-card.pdf'];
  const B = ['deed.pdf', 'id-card.pdf', 'plan.pdf'];
  // fileId จากหัวหน้า (เห็นทุกใบ)
  const head = await w.api('head1');
  const ids = {};
  for (const n of [25, 10, 11, 12]) {
    const r = await get(head, `/api/cases/${CASE(n)}/files`);
    status(r, 200, `head1 GET files …${n}`);
    ids[n] = r.body.items;
  }
  eq(ids[25].map((i) => i.name), A, 'head1 …000025 รายชื่อไฟล์');
  eq(ids[12].map((i) => i.name).sort(), B, 'head1 …000012 รายชื่อไฟล์');

  const rows = [
    ['off.reg1', 25, 200, A], ['off.works1', 25, 403], ['off.reg2', 12, 200, B], ['off.works1', 12, 403],
    ['off.works1', 10, 200, B], ['off.reg1', 10, 200, B], ['off.works1', 11, 200, B],
    ['head1', 25, 200, A], ['head1', 10, 200, B], ['head1', 12, 200, B],
    ['somying', 25, 200, A], ['somchai', 25, 404], ['exec1', 25, 403], ['audit1', 25, 403], ['admin1', 25, 403], ['anon', 25, 401],
  ];
  for (const [who, n, st, names] of rows) {
    const api = await w.api(who);
    const label = `${who} ↔ …${n}`;
    const l = await get(api, `/api/cases/${CASE(n)}/files`);
    status(l, st, `${label} GET /files`);
    const f = await get(api, `/api/files/${ids[n][0].fileId}`);
    status(f, st, `${label} GET /api/files/<fileId>`);
    if (st === 200) {
      eq(l.body.items.map((i) => i.name).sort(), names, `${label} รายชื่อไฟล์`);
      for (const it of l.body.items) {
        const d = await get(api, `/api/files/${it.fileId}`);
        status(d, 200, `${label} ดาวน์โหลด ${it.name}`);
        contains(d.headers['content-type'], 'application/pdf', `${label} ${it.name} Content-Type`);
        eq(d.buf.subarray(0, 4).toString('latin1'), '%PDF', `${label} ${it.name} เนื้อไฟล์ขึ้นต้น`);
      }
    }
  }
  status(await get(await w.api('off.reg1'), '/api/files/NOSUCHFILE'), 404, 'fileId ที่ไม่มี (off.reg1)');

  // UI
  const o1 = await w.session('off.reg1');
  await officerCase(o1.page, CASE(25));
  await count(o1.page.getByTestId('doc-item'), 1, 'UI off.reg1 …000025 doc-item');
  await attr(o1.page.getByTestId('doc-item'), 'data-name', 'id-card.pdf', 'UI doc-item data-name');
  const href = await o1.page.getByTestId('doc-download-link').first().getAttribute('href');
  ok(href, 'doc-download-link ต้องมี href');
  const dl = await get(o1.api, href);
  status(dl, 200, 'UI ดาวน์โหลดจาก doc-download-link');
  ok(dl.buf.length > 0, 'ไฟล์ที่ดาวน์โหลดต้องมีขนาด > 0 ไบต์', `ได้ ${dl.buf.length} ไบต์`);
  const o2 = await w.session('off.reg2');
  await officerCase(o2.page, CASE(12));
  await count(o2.page.getByTestId('doc-item'), 3, 'UI off.reg2 …000012 doc-item');
  const sy = await w.session('somying');
  await citizenCase(sy.page, CASE(25));
  await count(sy.page.getByTestId('doc-item'), 1, 'UI สมหญิง …000025 doc-item');
});

// ---------------------------------------------------------------- RBAC-06
test('TC-RBAC-06 ผู้ดูแลระบบ: ช่วงค่าที่ยอมรับ', async ({ w }) => {
  await w.reset();
  const admin = await w.session('admin1');
  const E_FEE = 'ค่าธรรมเนียมต้องเป็นจำนวนเต็ม 0–100,000 บาท';
  const E_SLA = 'SLA ต้องเป็นจำนวนเต็ม 1–60 วันทำการ';
  const cur = { fee: 20, sla: 3 };
  const sv1 = async () => (await get(admin.api, '/api/admin/services')).body.items.find((i) => i.id === 'SV-01');
  const put1 = (fee, sla) => put(admin.api, '/api/admin/services/SV-01', { fee, sla });
  const reload = async () => { await admin.page.goto('/admin/services'); await expect(tid(admin.page, 'svc-fee-SV-01')).toBeVisible(); };

  // ค่าที่ต้องปฏิเสธ: ทั้งบนจอและ API · ค่าต้องไม่เปลี่ยน
  for (const fee of [-1, 100001]) {
    await reload();
    await tid(admin.page, 'svc-fee-SV-01').fill(String(fee));
    await tid(admin.page, 'svc-save-SV-01').click();
    await text(admin.page, 'action-error', E_FEE, `UI fee=${fee} action-error`);
    err(await put1(fee, cur.sla), 400, 'INVALID_FEE', E_FEE, `API fee=${fee}`);
    eq((await sv1()).fee, cur.fee, `fee=${fee} ค่าต้องไม่เปลี่ยน`);
  }
  for (const sla of [0, 61]) {
    await reload();
    await tid(admin.page, 'svc-sla-SV-01').fill(String(sla));
    await tid(admin.page, 'svc-save-SV-01').click();
    await text(admin.page, 'action-error', E_SLA, `UI sla=${sla} action-error`);
    err(await put1(cur.fee, sla), 400, 'INVALID_SLA', E_SLA, `API sla=${sla}`);
    eq((await sv1()).sla, cur.sla, `sla=${sla} ค่าต้องไม่เปลี่ยน`);
  }

  // ค่าที่ต้องยอมรับ (แต่ละค่าส่งครั้งเดียว เพื่อให้ Audit ADMIN_CHANGE นับได้ตรง 5)
  await reload();
  await tid(admin.page, 'svc-fee-SV-01').fill('0');
  await tid(admin.page, 'svc-save-SV-01').click();
  await expect(tid(admin.page, 'action-success'), 'UI fee=0 action-success').toBeVisible();
  await expect.poll(async () => (await sv1()).fee, { message: 'fee=0 ที่เก็บ: expected 0' }).toBe(0);
  cur.fee = 0;
  status(await put1(100000, cur.sla), 200, 'API fee=100000');
  cur.fee = 100000;
  eq((await sv1()).fee, 100000, 'fee=100000 ที่เก็บ');
  await reload();
  await tid(admin.page, 'svc-sla-SV-01').fill('1');
  await tid(admin.page, 'svc-save-SV-01').click();
  await expect(tid(admin.page, 'action-success'), 'UI sla=1 action-success').toBeVisible();
  await expect.poll(async () => (await sv1()).sla, { message: 'sla=1 ที่เก็บ: expected 1' }).toBe(1);
  cur.sla = 1;
  status(await put1(cur.fee, 60), 200, 'API sla=60');
  eq((await sv1()).sla, 60, 'sla=60 ที่เก็บ');

  // วันหยุด
  await admin.page.goto('/admin/holidays');
  await count(admin.page.getByTestId('holiday-row'), 4, 'holiday-row ก่อน');
  await tid(admin.page, 'holiday-date-input').fill('2026-12-07');
  await tid(admin.page, 'holiday-name-input').fill('ซ้ำ');
  await tid(admin.page, 'holiday-add-btn').click();
  await text(admin.page, 'action-error', 'มีวันหยุดนี้อยู่แล้ว', 'UI วันหยุดซ้ำ action-error');
  await count(admin.page.getByTestId('holiday-row'), 4, 'วันหยุดซ้ำ holiday-row ยัง 4');
  err(await post(admin.api, '/api/admin/holidays', { date: '2026-12-07', name: 'ซ้ำ' }), 409, 'DUPLICATE_HOLIDAY', 'มีวันหยุดนี้อยู่แล้ว', 'API วันหยุดซ้ำ');
  status(await post(admin.api, '/api/admin/holidays', { date: '2026-12-05', name: 'วันเสาร์' }), 201, 'API วันหยุดวันเสาร์');

  // เปลี่ยนบทบาทตัวเอง
  err(await put(admin.api, '/api/admin/users/admin1', { role: 'executive', dept: '' }), 409, 'SELF_ROLE_CHANGE', 'ไม่สามารถเปลี่ยนบทบาทของตัวเองได้', 'API เปลี่ยนบทบาทตัวเอง');
  const me = await get(admin.api, '/api/me');
  eq(me.body.role, 'admin', 'GET /api/me role ต้องยัง admin');

  // Audit: ADMIN_CHANGE = 5 (fee 0 · fee 100000 · sla 1 · sla 60 · holiday add 2026-12-05) ไม่นับคำขอที่ถูกปฏิเสธ
  const a = await w.auditItems('event=ADMIN_CHANGE');
  eq(a.count, 5, `ADMIN_CHANGE ต้อง 5 แถว (ได้ ${JSON.stringify(a.items.map((i) => i.detail))})`);
});
