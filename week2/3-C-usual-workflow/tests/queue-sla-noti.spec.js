const { test, expect, thText, LEVEL_TH, MASK } = require('./helpers');

const N = s => s.split(' ').map(x => `EG-2569-${x}`);
const row = (page, no) => page.locator(`[data-testid=queue-row][data-case-no="${no}"]`);

test('TC-QUEUE-01 ลำดับคิวและขอบเขตแผนก', async ({ h }) => {
  await h.reset();
  const reg1 = await h.pageS('off.reg1');
  await reg1.goto('/officer/queue');
  await expect(reg1.getByTestId('queue-filter')).toHaveValue('all');
  await expect(reg1.getByTestId('queue-row')).toHaveCount(17);
  // BR-16: earliest due first, ties by case number ascending
  expect(await h.queueNos(reg1)).toEqual(N('000020 000022 000024 000023 000025 000026 000013 000015 000027 000028 000029 000030 000016 000018 000019 000012 000021'));
  expect((await reg1.getByTestId('row-sla-level').allInnerTexts()).slice(0, 3)).toEqual(['เกินกำหนด', 'ใกล้ครบกำหนด', 'ใกล้ครบกำหนด']);
  for (const t of await reg1.getByTestId('row-id-masked').allInnerTexts()) expect(t).toMatch(MASK);
  const withClaim = await reg1.getByTestId('queue-row').evaluateAll(rs => rs.filter(r => r.querySelector('[data-testid=claim-btn]')).map(r => r.dataset.caseNo));
  expect(withClaim).toEqual(N('000024 000028 000029 000030'));
  await expect(row(reg1, 'EG-2569-000019')).toHaveAttribute('data-owner', '');
  await reg1.getByTestId('queue-filter').selectOption('unclaimed');
  await expect(reg1.getByTestId('queue-row')).toHaveCount(4);
  expect(await h.queueNos(reg1)).toEqual(N('000024 000028 000029 000030'));
  await reg1.getByTestId('queue-filter').selectOption('mine');
  await expect(reg1.getByTestId('queue-row')).toHaveCount(3);
  expect(await h.queueNos(reg1)).toEqual(N('000020 000022 000023'));
  await expect(reg1.getByTestId('workload-count')).toHaveText('3');

  const reg2 = await h.pageS('off.reg2');
  await reg2.goto('/officer/queue?filter=mine');
  await expect(reg2.getByTestId('queue-row')).toHaveCount(9);
  expect(await h.queueNos(reg2)).toEqual(N('000025 000026 000013 000015 000027 000016 000018 000012 000021'));
  await expect(reg2.getByTestId('workload-count')).toHaveText('9');

  const works = await h.pageS('off.works1');
  await works.goto('/officer/queue');
  await expect(works.getByTestId('queue-row')).toHaveCount(1);
  expect(await h.queueNos(works)).toEqual(N('000010'));

  const head = await h.pageS('head1');
  await head.goto('/officer/queue');
  await expect(head.getByTestId('queue-row')).toHaveCount(18);
  const hn = await h.queueNos(head);
  const i = hn.indexOf('EG-2569-000010');
  expect(hn.slice(i, i + 4)).toEqual(N('000010 000023 000025 000026'));
  await expect(head.getByTestId('claim-btn')).toHaveCount(0);
  for (const no of N('000017 000011 000014 000001 000009')) expect(hn).not.toContain(no);
});

test('TC-QUEUE-02 รับเรื่องซ้อน (พร้อมกันและต่อกัน)', async ({ h }) => {
  const claimsOf = async (no) => {
    const a = await h.loginS('audit1');
    return (await (await a.get(`/api/audit?event=CLAIM`)).json()).items.filter(x => x.caseNo === no).length;
  };
  // 1: two browser contexts click at once
  await h.reset();
  const A = await h.pageS('off.reg1'), B = await h.pageS('off.reg2');
  await Promise.all([A.goto('/officer/queue'), B.goto('/officer/queue')]);
  const statuses = await Promise.all([A, B].map(async p => {
    const [resp] = await Promise.all([p.waitForResponse(r => r.url().includes('/claim')), row(p, 'EG-2569-000028').getByTestId('claim-btn').click()]);
    return resp.status();
  }));
  expect([...statuses].sort(), 'exactly one claim succeeds').toEqual([200, 409]);
  const winner = statuses[0] === 200 ? 'off.reg1' : 'off.reg2';
  const loser = statuses[0] === 200 ? B : A;
  const c = await h.caseOf(await h.loginS('head1'), 'EG-2569-000028');
  expect({ owner: c.owner, status: c.status }).toEqual({ owner: winner, status: 'IN_REVIEW' });
  await expect(loser.getByTestId('action-error')).toHaveText('มีเจ้าหน้าที่รับเรื่องนี้แล้ว');
  const winPage = statuses[0] === 200 ? A : B;
  await expect(row(winPage, 'EG-2569-000028').getByTestId('row-owner')).toHaveText(winner);
  expect(await claimsOf('EG-2569-000028')).toBe(1);

  // 2: 10 API claims at once
  await h.reset();
  const r1 = await h.loginS('off.reg1'), r2 = await h.loginS('off.reg2');
  const res = await Promise.all([r1, r2, r1, r2, r1, r2, r1, r2, r1, r2].map(ctx => ctx.post('/api/officer/cases/EG-2569-000029/claim')));
  const codes = await Promise.all(res.map(async r => (r.status() === 200 ? 200 : (await r.json()).code)));
  expect(codes.filter(x => x === 200).length, '200 responses').toBe(1);
  expect(codes.filter(x => x === 'ALREADY_CLAIMED').length, 'ALREADY_CLAIMED responses').toBe(9);
  const winner2 = (await res.find(r => r.status() === 200).json()).owner;
  expect((await h.caseOf(r1, 'EG-2569-000029')).owner).toBe(winner2);
  expect(await claimsOf('EG-2569-000029')).toBe(1);

  // 3: sequential, deterministic
  await h.reset();
  const s1 = await h.loginS('off.reg1'), s2 = await h.loginS('off.reg2');
  const first = await s1.post('/api/officer/cases/EG-2569-000029/claim');
  expect({ status: first.status(), body: await first.json() }).toEqual({ status: 200, body: { owner: 'off.reg1' } });
  const second = await s2.post('/api/officer/cases/EG-2569-000029/claim');
  const b2 = await h.expectErr(second, 409, 'ALREADY_CLAIMED', 'off.reg2 claims a claimed case');
  expect(b2.message).toBe('มีเจ้าหน้าที่รับเรื่องนี้แล้ว');
  expect((await h.caseOf(s1, 'EG-2569-000029')).owner).toBe('off.reg1');
  expect((await (await s2.get('/api/officer/queue?filter=mine')).json()).items.length, 'off.reg2 workload').toBe(9);
  await h.expectErr(await s1.post('/api/officer/cases/EG-2569-000029/claim'), 409, 'ALREADY_CLAIMED', 'off.reg1 claims again');
  expect(await claimsOf('EG-2569-000029')).toBe(1);
});

test('TC-QUEUE-03 งานในมือสูงสุด 10', async ({ h }) => {
  await h.reset();
  const p = await h.pageS('off.reg2');
  await p.goto('/officer/queue');
  const wl = p.getByTestId('workload-count');
  await expect(wl).toHaveText('9');
  await row(p, 'EG-2569-000028').getByTestId('claim-btn').click();
  await expect(wl).toHaveText('10');
  await row(p, 'EG-2569-000029').getByTestId('claim-btn').click();
  await expect(p.getByTestId('action-error')).toHaveText('รับงานได้สูงสุด 10 เรื่อง');
  await h.expectErr(await p.request.post('/api/officer/cases/EG-2569-000029/claim'), 409, 'WORKLOAD_LIMIT');
  const c29 = await h.caseOf(p.request, 'EG-2569-000029');
  expect({ status: c29.status, owner: c29.owner }).toEqual({ status: 'SUBMITTED', owner: null });
  await p.reload();
  await expect(wl).toHaveText('10');
  await p.goto('/officer/cases/EG-2569-000025');
  await p.getByTestId('approve-btn').click();
  await expect(p.getByTestId('case-status')).toHaveText('อนุมัติ');
  await p.goto('/officer/queue');
  await expect(wl).toHaveText('9');
  await row(p, 'EG-2569-000029').getByTestId('claim-btn').click();
  await expect(wl).toHaveText('10');
  const reg1 = await h.loginS('off.reg1');
  expect((await reg1.post('/api/officer/cases/EG-2569-000030/claim')).status()).toBe(200);
  // 7-10: resubmission returns to the owner even above the limit
  await h.reset();
  const q = await h.pageS('off.reg2');
  await q.goto('/officer/cases/EG-2569-000025');
  await q.getByTestId('return-btn').click();
  await q.getByTestId('return-reason').fill('xxxxxxxxxx');
  await q.getByTestId('return-submit').click();
  await expect(q.getByTestId('case-status')).toHaveText('รอแก้ไขเอกสาร');
  await q.goto('/officer/queue');
  await expect(q.getByTestId('workload-count')).toHaveText('8');
  for (const no of ['EG-2569-000028', 'EG-2569-000029']) expect((await q.request.post(`/api/officer/cases/${no}/claim`)).status(), no).toBe(200);
  await q.reload();
  await expect(q.getByTestId('workload-count')).toHaveText('10');
  const sy = await h.pageC('somying');
  await sy.goto('/citizen/cases/EG-2569-000025');
  await sy.getByTestId('submit-fix-btn').click();
  await expect(sy.getByTestId('action-error')).toHaveCount(0);
  await expect(sy.getByTestId('case-status')).toHaveText('กำลังตรวจสอบ');
  expect((await h.caseOf(q.request, 'EG-2569-000025')).owner).toBe('off.reg2');
  await q.reload();
  await expect(q.getByTestId('workload-count')).toHaveText('11');
  const b = await h.expectErr(await q.request.post('/api/officer/cases/EG-2569-000030/claim'), 409, 'WORKLOAD_LIMIT');
  expect(b.message).toBe('รับงานได้สูงสุด 10 เรื่อง');
  await q.reload();
  await expect(q.getByTestId('workload-count')).toHaveText('11');
});

test('TC-SLA-01 กำหนดเสร็จตามตารางวันที่', async ({ h }) => {
  // expected = D0 (pay day if working day before 16:30, else next working day) + N working days, 16:30
  const rows = [
    ['a', 'SV-01', '2026-12-01T09:00:00+07:00', '2026-12-04T16:30:00+07:00'],
    ['b', 'SV-01', '2026-12-01T16:29:00+07:00', '2026-12-04T16:30:00+07:00'],
    ['c', 'SV-01', '2026-12-01T16:30:00+07:00', '2026-12-08T16:30:00+07:00'],
    ['d', 'SV-01', '2026-12-04T10:00:00+07:00', '2026-12-11T16:30:00+07:00'],
    ['e', 'SV-01', '2026-12-05T10:00:00+07:00', '2026-12-14T16:30:00+07:00'],
    ['f', 'SV-02', '2026-12-01T09:00:00+07:00', '2026-12-17T16:30:00+07:00'],
    ['g', 'SV-03', '2026-12-01T09:00:00+07:00', '2026-12-24T16:30:00+07:00'],
    ['h', 'SV-01', '2026-12-29T10:00:00+07:00', '2027-01-05T16:30:00+07:00'],
    ['i', 'SV-01', '2026-12-31T23:59:00+07:00', '2027-01-07T16:30:00+07:00'],
  ];
  for (const [r, service, at, due] of rows) {
    await h.reset();
    const { caseNo, ctx } = await h.newPaid({ service, at, areaSqm: 100 });
    expect.soft(caseNo, `row ${r}`).toBe('EG-2569-000031');
    expect.soft((await h.caseOf(ctx, caseNo)).dueAt, `row ${r} dueAt (paid ${at})`).toBe(due);
    const page = await h.pageC('somchai');
    await page.goto(`/citizen/cases/${caseNo}`);
    await expect.soft(page.getByTestId('sla-due'), `row ${r} sla-due`).toHaveAttribute('data-iso', due);
    await expect.soft(page.getByTestId('sla-due'), `row ${r} sla-due text`).toHaveText(thText(due));
    await page.context().close();
  }
});

test('TC-SLA-02 หยุดนับ SLA ระหว่างรอแก้ไข', async ({ h }) => {
  const claimReturn = async no => {
    const o = await h.loginS('off.reg1');
    expect((await o.post(`/api/officer/cases/${no}/claim`)).status()).toBe(200);
    expect((await o.post(`/api/officer/cases/${no}/return`, { data: { reason: 'xxxxxxxxxx' } })).status()).toBe(200);
  };
  // part 1
  await h.reset();
  const { caseNo } = await h.newPaid({ at: '2026-12-01T09:00:00+07:00' });
  await h.clock('2026-12-02T11:00:00+07:00');
  await claimReturn(caseNo);
  const sc = await h.pageC('somchai');
  await sc.goto(`/citizen/cases/${caseNo}`);
  await expect(sc.getByTestId('case-status')).toHaveText('รอแก้ไขเอกสาร');
  await expect(sc.getByTestId('sla-level')).toHaveText('หยุดนับ');
  await expect(sc.getByTestId('sla-level')).toHaveAttribute('data-level', 'paused');
  await expect(sc.getByTestId('fix-deadline')).toHaveAttribute('data-iso', '2026-12-09T11:00:00+07:00');
  await h.clock('2026-12-03T10:00:00+07:00');
  await sc.reload();
  await sc.getByTestId('submit-fix-btn').click();
  await expect(sc.getByTestId('case-status')).toHaveText('กำลังตรวจสอบ');
  expect.soft((await h.caseOf(sc.request, caseNo)).dueAt, 'part 1 dueAt (paused Thu 3)').toBe('2026-12-08T16:30:00+07:00');
  await expect.soft(sc.getByTestId('sla-due'), 'part 1 sla-due').toHaveText('8 ธ.ค. 2569 16:30');
  await expect.soft(sc.getByTestId('sla-level'), 'part 1 level').toHaveText('ปกติ');
  const op = await h.pageS('off.reg1');
  await op.goto(`/officer/cases/${caseNo}`);
  await expect(op.getByTestId('case-owner')).toHaveText('off.reg1');

  // part 2: seed …000017 resubmitted 1 Dec 09:00
  await h.reset();
  const s2 = await h.pageC('somchai');
  await s2.goto('/citizen/cases/EG-2569-000017');
  await expect(s2.getByTestId('sla-level')).toHaveText('หยุดนับ');
  await expect(s2.getByTestId('sla-due')).toHaveAttribute('data-iso', '2026-11-27T16:30:00+07:00');
  await s2.getByTestId('submit-fix-btn').click();
  await expect(s2.getByTestId('case-status')).toHaveText('กำลังตรวจสอบ');
  const c2 = await h.caseOf(s2.request, 'EG-2569-000017');
  expect.soft({ dueAt: c2.dueAt, slaLevel: c2.slaLevel, owner: c2.owner }, 'part 2').toEqual({ dueAt: '2026-12-01T16:30:00+07:00', slaLevel: 'near', owner: 'off.reg1' });
  await expect.soft(s2.getByTestId('sla-level'), 'part 2 level').toHaveText('ใกล้ครบกำหนด');

  // part 3: resubmitted 4 Dec 10:00 → paused 5 working days
  await h.reset();
  await h.clock('2026-12-04T10:00:00+07:00');
  const s3 = await h.loginC('somchai');
  const r3 = await s3.post('/api/cases/EG-2569-000017/resubmit');
  expect(r3.status()).toBe(200);
  const c3 = await h.caseOf(s3, 'EG-2569-000017');
  expect.soft({ dueAt: c3.dueAt, slaLevel: c3.slaLevel }, 'part 3').toEqual({ dueAt: '2026-12-04T16:30:00+07:00', slaLevel: 'near' });

  // part 4: returned and resubmitted on the same day → 0 days
  await h.reset();
  const p4 = await h.newPaid({ at: '2026-12-01T09:00:00+07:00' });
  await h.clock('2026-12-02T09:00:00+07:00');
  await claimReturn(p4.caseNo);
  await h.clock('2026-12-02T15:00:00+07:00');
  expect((await p4.ctx.post(`/api/cases/${p4.caseNo}/resubmit`)).status()).toBe(200);
  expect.soft((await h.caseOf(p4.ctx, p4.caseNo)).dueAt, 'part 4').toBe('2026-12-04T16:30:00+07:00');

  // part 5: across weekend + holiday, resubmitted after 16:30
  await h.reset();
  const p5 = await h.newPaid({ at: '2026-12-01T09:00:00+07:00' });
  await h.clock('2026-12-04T10:00:00+07:00');
  await claimReturn(p5.caseNo);
  await h.clock('2026-12-08T17:00:00+07:00');
  expect((await p5.ctx.post(`/api/cases/${p5.caseNo}/resubmit`)).status()).toBe(200);
  const c5 = await h.caseOf(p5.ctx, p5.caseNo);
  expect.soft({ dueAt: c5.dueAt, slaLevel: c5.slaLevel }, 'part 5').toEqual({ dueAt: '2026-12-08T16:30:00+07:00', slaLevel: 'overdue' });
});

test('TC-SLA-03 ระดับเตือน ปกติ / ใกล้ครบกำหนด / เกินกำหนด', async ({ h }) => {
  // A: new case due Fri 4 Dec 16:30
  await h.reset();
  const { caseNo, ctx } = await h.newPaid({ at: '2026-12-01T09:00:00+07:00' });
  const page = await h.pageC('somchai');
  for (const [t, lv] of [['2026-12-01T09:00:00', 'normal'], ['2026-12-02T09:00:00', 'normal'], ['2026-12-03T09:00:00', 'near'], ['2026-12-04T16:30:00', 'near'],
    ['2026-12-04T16:30:01', 'overdue'], ['2026-12-04T16:31:00', 'overdue'], ['2026-12-05T10:00:00', 'overdue']]) {
    await h.clock(t + '+07:00');
    expect.soft((await h.caseOf(ctx, caseNo)).slaLevel, `A ${t}`).toBe(lv);
    await page.goto(`/citizen/cases/${caseNo}`);
    await expect.soft(page.getByTestId('sla-level'), `A ${t}`).toHaveText(LEVEL_TH[lv]);
    await expect.soft(page.getByTestId('sla-level'), `A ${t}`).toHaveAttribute('data-level', lv);
  }
  // B: seed …000016 due Tue 8 Dec 16:30 (Sat, Sun, Mon 7 holiday in between)
  await h.reset();
  const reg2 = await h.pageS('off.reg2');
  for (const [t, lv] of [['2026-12-03T09:00:00', 'normal'], ['2026-12-04T09:00:00', 'near'], ['2026-12-08T16:30:00', 'near'], ['2026-12-08T16:31:00', 'overdue']]) {
    await h.clock(t + '+07:00');
    await reg2.goto('/officer/cases/EG-2569-000016');
    await expect.soft(reg2.getByTestId('sla-level'), `B ${t}`).toHaveText(LEVEL_TH[lv]);
  }
  // C: seed at 09:00
  await h.reset();
  const reg1 = await h.pageS('off.reg1');
  await reg1.goto('/officer/queue');
  for (const [no, lv] of [['000020', 'overdue'], ['000022', 'near'], ['000024', 'near'], ['000025', 'normal']]) {
    await expect.soft(row(reg1, `EG-2569-${no}`).getByTestId('row-sla-level'), `C ${no}`).toHaveText(LEVEL_TH[lv]);
  }
  await reg1.goto('/officer/cases/EG-2569-000017');
  await expect.soft(reg1.getByTestId('sla-level'), 'C 000017').toHaveText('หยุดนับ');
  const sy = await h.pageC('somying');
  await sy.goto('/citizen/cases/EG-2569-000001');
  await expect.soft(sy.getByTestId('sla-level'), 'C 000001').toHaveText('ปิดแล้ว');
  for (const [t, lv] of [['2026-12-01T16:30:00', 'near'], ['2026-12-01T16:31:00', 'overdue']]) {
    await h.clock(t + '+07:00');
    await reg1.goto('/officer/cases/EG-2569-000022');
    await expect.soft(reg1.getByTestId('sla-level'), `C 000022 ${t}`).toHaveText(LEVEL_TH[lv]);
  }
});

// ---------------------------------------------------------------- NOTI
const notiSet = async ctx => (await (await ctx.get('/api/notifications')).json()).items.map(i => `${i.caseNo.slice(-6)}:${i.level}`).sort();
const S = list => list.split(' ').filter(Boolean).sort();

async function noti01(h) {
  await h.reset();
  const reg1 = await h.pageS('off.reg1'); // first request after reset triggers evaluation at 09:00
  const reg2 = await h.pageS('off.reg2'), head = await h.pageS('head1'), works = await h.pageS('off.works1');
  const want = { reg1: S('000024:near 000022:near 000020:overdue'), reg2: S('000024:near'), head: S('000020:overdue'), works: [] };
  for (const [k, p] of Object.entries({ reg1, reg2, head, works })) {
    await p.goto('/notifications');
    const got = await p.getByTestId('noti-item').evaluateAll(xs => xs.map(x => `${x.dataset.caseNo.slice(-6)}:${x.dataset.level}`).sort());
    expect(got, `${k} noti-item`).toEqual(want[k]);
    expect(await notiSet(p.request), `${k} API`).toEqual(want[k]);
    await expect(p.getByTestId('bell-count'), `${k} bell`).toHaveText(String(want[k].length));
  }
  await expect(reg1.locator('[data-testid=noti-item][data-case-no="EG-2569-000024"]')).toContainText('คำขอ EG-2569-000024 ใกล้ครบกำหนด');
  await expect(reg1.locator('[data-testid=noti-item][data-case-no="EG-2569-000020"]')).toContainText('คำขอ EG-2569-000020 เกินกำหนด');
  await expect(works.getByTestId('noti-empty')).toHaveText('ไม่มีแจ้งเตือน');
  await h.clock('2026-12-01T16:31:00+07:00');
  expect(await notiSet(reg1.request), 'reg1 after 16:31').toEqual(S('000024:near 000022:near 000020:overdue 000022:overdue'));
  expect(await notiSet(head.request), 'head after 16:31').toEqual(S('000020:overdue 000022:overdue'));
  expect(await notiSet(reg2.request), 'reg2 after 16:31').toEqual(S('000024:near'));
  return { reg1, reg2, head, works };
}

test('TC-NOTI-01 ผู้รับแจ้งเตือนตามระดับ', async ({ h }) => { await noti01(h); });

test('TC-NOTI-02 ไม่แจ้งซ้ำ ข้ามระดับ และขั้นรออนุมัติ/รอออกเอกสาร', async ({ h }) => {
  // A: no duplicates
  const { reg1, head } = await noti01(h);
  for (let i = 0; i < 3; i++) { await reg1.goto('/notifications'); await head.goto('/notifications'); }
  for (let i = 0; i < 3; i++) { await notiSet(reg1.request); await notiSet(head.request); }
  for (let i = 0; i < 2; i++) await reg1.goto('/officer/queue');
  await expect(reg1.getByTestId('bell-count')).toHaveText('4');
  await head.goto('/notifications');
  await expect(head.getByTestId('bell-count')).toHaveText('2');
  for (const ctx of [reg1.request, head.request]) { const l = await notiSet(ctx); expect(new Set(l).size).toBe(l.length); }

  // B: clock jumps to Sat 5 Dec 10:00 → only current level, no back-filled "near"
  await h.reset();
  await h.clock('2026-12-05T10:00:00+07:00');
  const users = { 'off.reg1': null, 'off.reg2': null, 'off.works1': null, head1: null };
  for (const u of Object.keys(users)) users[u] = await h.pageS(u);
  const want = {
    'off.reg1': S('000020:overdue 000022:overdue 000023:overdue 000024:overdue 000028:overdue 000029:overdue 000030:overdue'),
    'off.reg2': S('000013:overdue 000015:overdue 000024:overdue 000025:overdue 000026:overdue 000027:overdue 000028:overdue 000029:overdue 000030:overdue 000016:near'),
    'off.works1': S('000010:overdue'),
    head1: S('000010:overdue 000013:overdue 000014:overdue 000015:overdue 000020:overdue 000022:overdue 000023:overdue 000024:overdue 000025:overdue 000026:overdue 000027:overdue 000028:overdue 000029:overdue 000030:overdue 000011:near'),
  };
  for (const [u, p] of Object.entries(users)) {
    await p.goto('/notifications');
    expect.soft(await notiSet(p.request), `B ${u}`).toEqual(want[u]);
    await expect.soft(p.getByTestId('bell-count'), `B ${u} bell`).toHaveText(String(want[u].length));
  }

  // C: PENDING_APPROVAL → head only; APPROVED → issuer (+ head when overdue)
  await h.reset();
  await h.clock('2026-12-04T09:00:00+07:00');
  const hd = await h.loginS('head1'), r1 = await h.loginS('off.reg1'), r2 = await h.loginS('off.reg2');
  const of = async (ctx, no) => (await notiSet(ctx)).filter(x => x.startsWith(no)).sort();
  expect.soft(await of(hd, '000014'), 'C head 000014 @12-04 09:00').toEqual(['000014:near']);
  expect.soft(await of(r1, '000014'), 'C reg1 000014').toEqual([]);
  expect.soft(await of(r2, '000014'), 'C reg2 000014').toEqual([]);
  await h.clock('2026-12-04T16:31:00+07:00');
  expect.soft(await of(hd, '000014'), 'C head 000014 @16:31').toEqual(['000014:near', '000014:overdue']);
  expect.soft(await of(r1, '000014'), 'C reg1 000014 @16:31').toEqual([]);
  expect.soft(await of(r2, '000014'), 'C reg2 000014 @16:31').toEqual([]);
  await h.clock('2026-12-08T09:00:00+07:00');
  expect.soft(await of(r1, '000019'), 'C reg1 000019 @12-08').toEqual(['000019:near']);
  expect.soft(await of(r2, '000019'), 'C reg2 000019 @12-08').toEqual([]);
  expect.soft(await of(hd, '000019'), 'C head 000019 @12-08').toEqual([]);
  await h.clock('2026-12-09T16:31:00+07:00');
  expect.soft(await of(r1, '000019'), 'C reg1 000019 @12-09 16:31').toEqual(['000019:near', '000019:overdue']);
  expect.soft(await of(hd, '000019'), 'C head 000019 @12-09 16:31').toEqual(['000019:overdue']);
});
