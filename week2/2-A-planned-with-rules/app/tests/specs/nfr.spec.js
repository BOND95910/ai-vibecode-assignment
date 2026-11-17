// หมวด NFR · TC-NFR-01 ถึง 04
const { test, expect } = require('../helpers/world');
const AxeBuilder = require('@axe-core/playwright').default || require('@axe-core/playwright');
const { eq, ok, status, tid, text, count, contains } = require('../helpers/check');
const { get, post, put, loginC, CITIZENS } = require('../helpers/http');
const { CASE, LEVEL_TH, STATUS_TH } = require('../helpers/thai');
const { uiLoginC, attach } = require('../helpers/ui');
const { DB_PATH } = require('../helpers/env');
const { dumpAll, rawFiles, countOccurrences } = require('../helpers/db');

// ---------------------------------------------------------------- NFR-01
test('TC-NFR-01 Responsive 375/768/1280', async ({ w }) => {
  await w.reset();
  const VPS = [[375, 812], [768, 1024], [1280, 800]];
  // [ผู้ใช้, path, testid ที่แสดงว่าหน้าโหลดข้อมูลแล้ว]
  const PAGES = [
    ['anon', '/login', 'thaid-submit'],
    ['somchai', '/citizen', 'citizen-welcome'],
    ['somchai', '/citizen/new/SV-03', 'wizard-step'],
    ['somchai', `/citizen/cases/${CASE(13)}`, 'case-status'],
    ['off.reg1', '/officer/queue', 'queue-row'],
    ['off.reg1', `/officer/cases/${CASE(20)}`, 'case-status'],
    ['head1', '/head/approvals', 'approval-row'],
    ['exec1', '/dashboard', 'kpi-received'],
    ['audit1', '/audit', 'audit-row'],
    ['admin1', '/admin/services', 'service-row'],
    ['anon', '/verify/K7M2Q9XA', 'verify-result'],
  ];
  const sessions = {};
  for (const [who] of PAGES) if (!sessions[who]) sessions[who] = await w.session(who);
  let checks = 0;
  for (const [vw, vh] of VPS) {
    for (const [who, url, anchor] of PAGES) {
      const { page } = sessions[who];
      await page.setViewportSize({ width: vw, height: vh });
      await page.goto(url);
      await expect(tid(page, anchor).first(), `${url} @${vw}: รอ ${anchor}`).toBeVisible();
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      expect.soft(m.sw <= m.iw, `${who} ${url} @${vw}px: expected scrollWidth ≤ innerWidth but scrollWidth=${m.sw} innerWidth=${m.iw}`).toBe(true);
      checks++;
    }
  }
  eq(checks, 33, 'จำนวนการตรวจ (11 หน้า × 3 ขนาด)');

  // งานหลักที่ 375 px: ล็อกอินสมชายผ่านหน้าจอ → ยื่น SV-01 จนถึงปุ่มสร้าง QR
  const ctx = await w.browser.newContext({ baseURL: require('../helpers/env').BASE_URL, viewport: { width: 375, height: 812 }, locale: 'th-TH' });
  const page = await ctx.newPage();
  try {
    await uiLoginC(page, CITIZENS.somchai.idNo);
    await expect(page, 'ล็อกอินที่ 375px ต้องเข้า /citizen').toHaveURL(/\/citizen$/);
    await tid(page, 'start-service-SV-01').click();
    await tid(page, 'qty-input').fill('1');
    await text(page, 'fee-total', '฿20', '375px fee-total');
    await tid(page, 'to-upload-btn').click();
    await text(page, 'wizard-step', '2/3 แนบเอกสาร', '375px ต้องเข้าขั้น 2 ก่อนแนบไฟล์');
    await attach(page, 'upload-input-id-card', 'id-card.pdf');
    await expect(tid(page, 'to-payment-btn'), '375px to-payment-btn ต้องกดได้').toBeEnabled();
    await tid(page, 'to-payment-btn').click();
    await expect(tid(page, 'create-qr-btn'), '375px create-qr-btn').toBeVisible();
    const box = await tid(page, 'create-qr-btn').boundingBox();
    ok(box && box.x >= 0 && box.x + box.width <= 375, `create-qr-btn ต้องอยู่ในกรอบจอ 375px: expected x ≥ 0 และ x+width ≤ 375 but x=${box && box.x} width=${box && box.width}`);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------- NFR-02
const FORCED = async (page) => page.emulateMedia({ forcedColors: 'active' });

async function activeId(page) {
  return page.evaluate(() => (document.activeElement && document.activeElement.getAttribute('data-testid')) || null);
}
// กด Tab จนโฟกัสถึง testid ที่ต้องการ (ห้ามใช้เมาส์)
async function tabTo(page, id, max = 40) {
  for (let i = 0; i <= max; i++) {
    if ((await activeId(page)) === id) return;
    await page.keyboard.press('Tab');
  }
  ok(false, `ใช้ Tab ไม่ถึง ${id} ภายใน ${max} ครั้ง (โฟกัสล่าสุด = ${await activeId(page)})`);
}
async function ring(page, label) {
  const r = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return { o: s.outlineStyle, b: s.boxShadow }; });
  expect.soft(r.o !== 'none' || r.b !== 'none', `${label}: องค์ประกอบที่โฟกัสต้องมี outline/ring มองเห็น but outline-style=${r.o} box-shadow=${r.b}`).toBe(true);
}

async function statusItems(page) {
  return page.evaluate(() => [...document.querySelectorAll('[data-testid="case-status"],[data-testid="row-status"],[data-testid="sla-level"],[data-testid="row-sla-level"]')].map((e) => {
    const t = e.getAttribute('data-testid');
    const st = e.closest('[data-status]');
    const lv = e.closest('[data-level],[data-sla-level]');
    return {
      t, text: (e.textContent || '').trim(),
      status: e.getAttribute('data-status') || (st && st.getAttribute('data-status')) || null,
      level: e.getAttribute('data-level') || (lv && (lv.getAttribute('data-level') || lv.getAttribute('data-sla-level'))) || null,
    };
  }));
}
function checkStatusItems(items, label) {
  ok(items.length > 0, `${label}: ต้องพบ case-status/row-status/sla-level/row-sla-level อย่างน้อย 1 ตัว`);
  for (const it of items) {
    expect.soft(it.text.length > 0, `${label} ${it.t}: textContent ต้องไม่ว่าง (สถานะต้องไม่ใช้สีอย่างเดียว)`).toBe(true);
    if (it.t.endsWith('status')) {
      if (it.status) expect.soft(it.text, `${label} ${it.t} data-status=${it.status}: expected ${STATUS_TH[it.status]} but received ${it.text}`).toBe(STATUS_TH[it.status]);
      else expect.soft(Object.values(STATUS_TH), `${label} ${it.t}: ข้อความ ${it.text} ต้องอยู่ในตาราง 4.1`).toContain(it.text);
    } else if (it.level) {
      expect.soft(it.text, `${label} ${it.t} data-level=${it.level}: expected ${LEVEL_TH[it.level]} but received ${it.text}`).toBe(LEVEL_TH[it.level]);
    } else {
      expect.soft(Object.values(LEVEL_TH), `${label} ${it.t}: ข้อความ ${it.text} ต้องอยู่ในตาราง 4.2`).toContain(it.text);
    }
  }
}

test('TC-NFR-02 WCAG: axe + คีย์บอร์ด + label + สถานะไม่ใช้สีอย่างเดียว', async ({ w }) => {
  await w.reset();
  const PAGES = [
    ['anon', '/login', 'thaid-submit'],
    ['mana', '/register', 'reg-submit'],
    ['somchai', '/citizen', 'citizen-welcome'],
    ['somchai', '/citizen/new/SV-01', 'wizard-step'],
    ['somchai', `/citizen/cases/${CASE(17)}`, 'case-status'],
    ['off.reg1', '/officer/queue', 'queue-row'],
    ['off.reg1', `/officer/cases/${CASE(20)}`, 'case-status'],
    ['head1', '/head/approvals', 'approval-row'],
    ['exec1', '/dashboard', 'kpi-received'],
    ['audit1', '/audit', 'audit-row'],
    ['admin1', '/admin/services', 'service-row'],
    ['off.reg1', '/notifications', 'noti-item'],
    ['anon', '/verify/K7M2Q9XA', 'verify-result'],
  ];
  const sessions = {};
  for (const [who] of PAGES) if (!sessions[who]) sessions[who] = await w.session(who);

  // ส่วน A axe + ส่วน C label
  for (const [who, url, anchor] of PAGES) {
    const { page } = sessions[who];
    await page.goto(url);
    await expect(tid(page, anchor).first(), `${url}: รอ ${anchor}`).toBeVisible();
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect.soft(bad.length, `axe ${url}: expected 0 violation ระดับ serious/critical but received ${bad.length}: ${bad.map((v) => `${v.id}(${v.impact}) x${v.nodes.length}`).join(', ')}`).toBe(0);

    const unnamed = await page.evaluate(() => {
      const visible = (e) => { const b = e.getBoundingClientRect(); const s = getComputedStyle(e); return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const out = [];
      document.querySelectorAll('input, select, textarea').forEach((e) => {
        if (['hidden', 'submit', 'button', 'reset', 'image'].includes(e.type) || !visible(e)) return;
        const al = (e.getAttribute('aria-label') || '').trim();
        const lb = (e.getAttribute('aria-labelledby') || '').split(/\s+/).some((id) => id && (document.getElementById(id)?.textContent || '').trim());
        const lab = e.labels && [...e.labels].some((l) => (l.textContent || '').trim());
        if (!(al || lb || lab)) out.push(e.getAttribute('data-testid') || e.name || e.id || e.tagName);
      });
      return out;
    });
    expect.soft(unnamed.length, `label ${url}: expected ช่องกรอกที่ไม่มีชื่อ = 0 but received ${unnamed.length}: ${unnamed.join(', ')}`).toBe(0);
  }

  // ส่วน B คีย์บอร์ดอย่างเดียว
  const kb = await w.browser.newContext({ baseURL: require('../helpers/env').BASE_URL, locale: 'th-TH' });
  w.bctxs.add(kb);
  const page = await kb.newPage();
  await page.goto('/login');
  await tabTo(page, 'thaid-id-input');
  await ring(page, 'thaid-id-input');
  await page.keyboard.type('1101700123456');
  await page.keyboard.press('Enter');
  await expect(tid(page, 'otp-input'), 'หลัง Enter เลขบัตรต้องเห็น otp-input').toBeVisible();
  await tabTo(page, 'otp-input');
  await ring(page, 'otp-input');
  await page.keyboard.type('123456');
  await page.keyboard.press('Enter');
  await expect(page, 'ล็อกอินด้วยคีย์บอร์ดต้องถึง /citizen').toHaveURL(/\/citizen$/);
  await tabTo(page, 'start-service-SV-01');
  await ring(page, 'start-service-SV-01');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/citizen\/new\/SV-01/);
  await tabTo(page, 'qty-input');
  await ring(page, 'qty-input');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('1');
  await tabTo(page, 'to-upload-btn');
  await ring(page, 'to-upload-btn');
  await page.keyboard.press('Enter');
  await text(page, 'wizard-step', '2/3 แนบเอกสาร', 'คีย์บอร์ด ขั้น 2');
  await tabTo(page, 'upload-input-id-card');
  await ring(page, 'upload-input-id-card');
  await attach(page, 'upload-input-id-card', 'id-card.pdf');
  await tabTo(page, 'to-payment-btn');
  await ring(page, 'to-payment-btn');
  await page.keyboard.press('Enter');
  await expect(tid(page, 'create-qr-btn'), 'ด้วยคีย์บอร์ดอย่างเดียวต้องถึงขั้นเห็น create-qr-btn').toBeVisible();

  // ส่วน D สถานะไม่ใช้สีอย่างเดียว
  for (const [who, url, anchor] of [['somchai', `/citizen/cases/${CASE(17)}`, 'case-status'], ['off.reg1', '/officer/queue', 'queue-row'], ['off.reg1', `/officer/cases/${CASE(20)}`, 'case-status']]) {
    const s = sessions[who].page;
    await s.goto(url);
    await expect(tid(s, anchor).first()).toBeVisible();
    checkStatusItems(await statusItems(s), `ส่วน D ${url}`);
    await FORCED(s);
    checkStatusItems(await statusItems(s), `ส่วน D ${url} (forcedColors:active)`);
    await expect(s.getByTestId(anchor === 'queue-row' ? 'row-status' : 'case-status').first(), `ส่วน D ${url} forcedColors ข้อความต้องยังอ่านได้`).toBeVisible();
    await s.emulateMedia({ forcedColors: 'none' });
  }
});

// ---------------------------------------------------------------- NFR-03
test('TC-NFR-03 Health เวลาโหลด และผลซ้ำได้', async ({ w }) => {
  await w.reset();
  // health (ไม่มี cookie)
  const h = await get(await w.anon(), '/api/health');
  status(h, 200, 'GET /api/health');
  eq(h.body, { status: 'ok' }, 'GET /api/health body ตรงตัว (ไม่มีฟิลด์อื่น)');
  eq(h.text.replace(/\s/g, ''), '{"status":"ok"}', 'GET /api/health ข้อความดิบ');

  // เวลาโหลด: รอบที่ 2 หลังอุ่นเครื่อง ≤ 3,000 ms
  const loads = [['anon', '/login'], ['somchai', '/citizen'], ['off.reg1', '/officer/queue'], ['exec1', '/dashboard'], ['audit1', '/audit']];
  for (const [who, url] of loads) {
    const { page } = await w.session(who);
    await page.goto(url, { waitUntil: 'load' });
    const t0 = Date.now();
    await page.goto(url, { waitUntil: 'load' });
    const ms = Date.now() - t0;
    ok(ms <= 3000, `โหลด ${url} (${who}): expected ≤ 3000 ms but received ${ms} ms`);
  }

  // ผลซ้ำได้
  const snap = async () => {
    const reg1 = await w.api('off.reg1');
    const exec = await w.api('exec1');
    const clock = await w.getClock();
    const q = await get(reg1, '/api/officer/queue?filter=all');
    status(q, 200, 'snapshot queue');
    const d = await get(exec, '/api/dashboard?period=2026-12&service=ALL');
    status(d, 200, 'snapshot dashboard');
    return { clock, queue: q.body.items.map((i) => ({ caseNo: i.caseNo, dueAt: i.dueAt, status: i.status, owner: i.owner })), dashboard: d.body };
  };
  await w.reset();
  const s1 = await snap();
  eq(s1.clock, '2026-12-01T09:00:00+07:00', 'S1 clock');
  await w.clock('2026-12-10T12:00:00+07:00');
  status(await post(await w.api('off.reg1'), `/api/officer/cases/${CASE(28)}/claim`), 200, 'เปลี่ยนสถานะ: claim …000028');
  await w.newPaid({ service: 'SV-01', qty: 1 });
  await w.reset();
  const s2 = await snap();
  eq(s2.clock, '2026-12-01T09:00:00+07:00', 'S2 clock');
  eq(s2, s1, 'S1 ต้องเท่ากับ S2 ทุกค่า (RESET แล้วผลซ้ำได้)');

  // นาฬิกา: ไม่มี offset → 400 INVALID_TIME
  const hook = await w.hook();
  for (const bad of ['2026-12-01 09:00', '2026-12-01T09:00:00', 'not-a-date']) {
    const r = await put(hook, '/api/test/clock', { now: bad });
    status(r, 400, `PUT clock ${JSON.stringify(bad)}`);
    eq(r.body && r.body.code, 'INVALID_TIME', `PUT clock ${JSON.stringify(bad)} code`);
  }
  eq(await w.getClock(), '2026-12-01T09:00:00+07:00', 'นาฬิกาต้องไม่เปลี่ยนหลังได้ 400');

  // ปิด hook: ต้องมีเว็บอีกตัวที่ไม่ตั้ง TEST_MODE (ระบุที่อยู่ด้วย NO_TEST_MODE_URL)
  if (process.env.NO_TEST_MODE_URL) {
    const c = await w.pw.request.newContext();
    try {
      const r = await post(c, `${process.env.NO_TEST_MODE_URL.replace(/\/+$/, '')}/api/test/reset`);
      status(r, 404, 'เว็บที่ไม่ตั้ง TEST_MODE: POST /api/test/reset');
    } finally { await c.dispose(); }
  } else {
    test.info().annotations.push({ type: 'skipped-part', description: 'ปิด hook: ไม่ได้ตั้ง NO_TEST_MODE_URL (เว็บที่รันโดยไม่ตั้ง TEST_MODE) จึงไม่ได้ตรวจส่วนนี้' });
  }
});

// ---------------------------------------------------------------- NFR-04
test('TC-NFR-04 เข้ารหัสข้อมูลส่วนบุคคลที่เก็บ (inspection)', async ({ w }) => {
  await w.reset();
  // มานะลงทะเบียน (เบอร์ 0845678901) ตาม TC-AUTH-03
  const mana = await w.fresh('anon');
  await loginC(mana, CITIZENS.mana.idNo);
  const reg = await post(mana, '/api/auth/register', { mobile: '0845678901', email: '', consent: true });
  status(reg, 201, 'มานะลงทะเบียน');

  const needles = [
    '1101700123456', '3100600987659', '1909900555015', '5500400111221',
    '0812345678', '0823456789', '0834567890', '0845678901',
    '1-1017-00123-45-6', '3-1006-00987-65-9', '1-9099-00555-01-5', '5-5004-00111-22-1',
  ];
  const files = rawFiles(DB_PATH);
  ok(files.length > 0, `ไม่พบไฟล์ฐานข้อมูลที่ DB_PATH=${DB_PATH} (ตั้งตัวแปร DB_PATH ให้ตรงกับเว็บ)`);
  const dump = dumpAll(DB_PATH);
  ok(dump.tables.length > 0, 'ฐานข้อมูลต้องมีตารางอย่างน้อย 1 ตาราง', `DB_PATH=${DB_PATH}`);
  for (const n of needles) {
    for (const f of files) eq(countOccurrences(f.buf.toString('latin1'), n), 0, `ไบต์ดิบ ${f.path}: พบ "${n}"`);
    eq(countOccurrences(dump.text, n), 0, `ตารางทั้งหมด (dump): พบ "${n}"`);
  }

  // ตัวควบคุมบวก: ถอดรหัสได้ถูกต้อง
  const som = await w.api('somchai');
  const g = await get(som, `/api/cases/${CASE(5)}`);
  status(g, 200, 'ตัวควบคุมบวก GET …000005');
  eq(g.body.idNo, '1101700123456', 'ตัวควบคุมบวก idNo ที่ถอดรหัส');
  test.info().annotations.push({ type: 'encryption', description: 'ระบุวิธีเข้ารหัสในรายงาน (ARCHITECTURE.md: AES-256-GCM, ค้นหาด้วย HMAC)' });
});
