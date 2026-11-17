const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { default: AxeBuilder } = require('@axe-core/playwright');
const { test, expect, ID, file, STATUS_TH, LEVEL_TH } = require('./helpers');

// role → pages used by the responsive check (TC-NFR-01)
const RESP = [['anon', ['/login', '/verify/K7M2Q9XA']], ['C:somchai', ['/citizen', '/citizen/new/SV-03', '/citizen/cases/EG-2569-000013']],
  ['S:off.reg1', ['/officer/queue', '/officer/cases/EG-2569-000020']], ['S:head1', ['/head/approvals']], ['S:exec1', ['/dashboard']], ['S:audit1', ['/audit']], ['S:admin1', ['/admin/services']]];
const open = (h, who, opts) => (who === 'anon' ? h.page(opts) : who.startsWith('C:') ? h.pageC(who.slice(2), opts) : h.pageS(who.slice(2), opts));

test('TC-NFR-01 Responsive 375 / 768 / 1280', async ({ h }) => {
  await h.reset();
  const pages = [];
  for (const [who, urls] of RESP) pages.push([await open(h, who), urls, who]);
  let checks = 0;
  for (const [w, hgt] of [[375, 812], [768, 1024], [1280, 800]]) {
    for (const [p, urls, who] of pages) {
      await p.setViewportSize({ width: w, height: hgt });
      for (const url of urls) {
        await p.goto(url);
        const m = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
        expect.soft(m.sw, `${w}px ${who} ${url}: scrollWidth ${m.sw} > innerWidth ${m.iw}`).toBeLessThanOrEqual(m.iw);
        checks++;
      }
    }
  }
  expect(checks).toBe(33);
  // main task at 375 px
  const p = await h.page({ viewport: { width: 375, height: 812 } });
  await h.uiLoginC(p, ID.somchai);
  await expect(p).toHaveURL(/\/citizen$/);
  await p.getByTestId('start-service-SV-01').click();
  await p.getByTestId('qty-input').fill('1');
  await expect(p.getByTestId('fee-total')).toHaveText('฿20');
  await p.getByTestId('to-upload-btn').click();
  await expect(p.getByTestId('wizard-step')).toHaveText('2/3 แนบเอกสาร');
  await p.getByTestId('upload-input-id-card').setInputFiles(file('id-card.pdf'));
  await expect(p.getByTestId('to-payment-btn')).toBeEnabled();
  await p.getByTestId('to-payment-btn').click();
  const box = await p.getByTestId('create-qr-btn').boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375);
});

const A11Y = [['anon', '/login'], ['P:mana', '/register'], ['C:somchai', '/citizen'], ['C:somchai', '/citizen/new/SV-01'], ['C:somchai', '/citizen/cases/EG-2569-000017'],
  ['S:off.reg1', '/officer/queue'], ['S:off.reg1', '/officer/cases/EG-2569-000020'], ['S:head1', '/head/approvals'], ['S:exec1', '/dashboard'], ['S:audit1', '/audit'],
  ['S:admin1', '/admin/services'], ['S:off.reg1', '/notifications'], ['anon', '/verify/K7M2Q9XA']];

test('TC-NFR-02 WCAG: axe + คีย์บอร์ด + label + สถานะไม่ใช้สีอย่างเดียว', async ({ h }) => {
  await h.reset();
  const cache = {};
  const known = [];
  for (const [who, url] of A11Y) {
    let p = cache[who];
    if (!p) {
      if (who === 'P:mana') { // first-time citizen: session limited to /register
        p = await h.page();
        await p.request.post('/api/auth/thaid/start', { data: { idNo: ID.mana } });
        await p.request.post('/api/auth/thaid/verify', { data: { idNo: ID.mana, otp: '123456' } });
      } else p = await open(h, who);
      cache[who] = p;
    }
    await p.goto(url);
    // A: axe serious/critical = 0
    const res = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    const bad = res.violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => `${v.id} (${v.impact}): ${v.nodes.map(n => n.target.join(' ')).join(', ')}`);
    expect.soft(bad, `axe ${url}`).toEqual([]);
    known.push(...res.violations.filter(v => !['serious', 'critical'].includes(v.impact)).map(v => `${url} ${v.id} (${v.impact})`));
    // C: every visible input/select/textarea has an accessible name
    const unnamed = await p.evaluate(() => [...document.querySelectorAll('input, select, textarea')]
      .filter(e => e.type !== 'hidden' && e.getClientRects().length)
      .filter(e => !(e.labels && e.labels.length) && !e.getAttribute('aria-label') && !e.getAttribute('aria-labelledby'))
      .map(e => e.outerHTML.slice(0, 80)));
    expect.soft(unnamed, `unlabelled fields on ${url}`).toEqual([]);
    // D: status/level text present and consistent with codes
    const st = await p.locator('[data-testid=case-status],[data-testid=row-status],[data-testid=sla-level],[data-testid=row-sla-level]')
      .evaluateAll(es => es.map(e => [e.dataset.status || e.dataset.level, e.textContent.trim(), !!e.dataset.status]));
    for (const [code, text, isStatus] of st) expect.soft(text, `${url} ${code}`).toBe((isStatus ? STATUS_TH : LEVEL_TH)[code]);
  }
  if (known.length) test.info().annotations.push({ type: 'known a11y issues (moderate/minor)', description: known.join('; ') });
  const q = cache['S:off.reg1'];
  await q.emulateMedia({ forcedColors: 'active' });
  await q.goto('/officer/queue');
  for (const t of await q.locator('[data-testid=row-status],[data-testid=row-sla-level]').allInnerTexts()) expect(t.trim().length).toBeGreaterThan(0);

  // B: keyboard only (no mouse clicks)
  const k = await h.page();
  const focusRing = async () => k.evaluate(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle !== 'none' || s.boxShadow !== 'none'; });
  const tabTo = async testid => {
    for (let i = 0; i < 40; i++) {
      await k.keyboard.press('Tab');
      if (await k.evaluate(id => document.activeElement?.dataset?.testid === id, testid)) {
        expect.soft(await focusRing(), `visible focus on ${testid}`).toBe(true);
        return;
      }
    }
    throw new Error(`keyboard: could not reach ${testid} with Tab`);
  };
  await k.goto('/login');
  await tabTo('thaid-id-input');
  await k.keyboard.type(ID.somchai);
  await k.keyboard.press('Enter');
  await expect(k.getByTestId('otp-input')).toBeFocused();
  await k.keyboard.type('123456');
  await k.keyboard.press('Enter');
  await expect(k).toHaveURL(/\/citizen$/);
  await tabTo('start-service-SV-01');
  await k.keyboard.press('Enter');
  await expect(k).toHaveURL(/\/citizen\/new\/SV-01$/);
  await tabTo('qty-input');
  await k.keyboard.press('Control+A');
  await k.keyboard.type('1');
  await expect(k.getByTestId('fee-total')).toHaveText('฿20');
  await tabTo('to-upload-btn');
  await k.keyboard.press('Enter');
  await expect(k.getByTestId('wizard-step')).toHaveText('2/3 แนบเอกสาร');
  await k.getByTestId('upload-input-id-card').focus();
  await k.getByTestId('upload-input-id-card').setInputFiles(file('id-card.pdf'));
  await expect(k.getByTestId('to-payment-btn')).toBeEnabled();
  await tabTo('to-payment-btn');
  await k.keyboard.press('Enter');
  await expect(k.getByTestId('create-qr-btn')).toBeVisible();
});

test('TC-NFR-03 Health เวลาโหลด และผลซ้ำได้', async ({ h }) => {
  const anon = await h.api();
  const hr = await anon.get('/api/health');
  expect({ status: hr.status(), body: await hr.text() }).toEqual({ status: 200, body: '{"status":"ok"}' });
  // load time (2nd visit after warm-up)
  await h.reset();
  const timings = {};
  for (const [who, url] of [['anon', '/login'], ['C:somchai', '/citizen'], ['S:off.reg1', '/officer/queue'], ['S:exec1', '/dashboard'], ['S:audit1', '/audit']]) {
    const p = await open(h, who);
    await p.goto(url, { waitUntil: 'load' });
    const t0 = Date.now();
    await p.goto(url, { waitUntil: 'load' });
    timings[url] = Date.now() - t0;
    expect.soft(timings[url], `${url} load ms`).toBeLessThanOrEqual(3000);
  }
  test.info().annotations.push({ type: 'load-time-ms', description: JSON.stringify(timings) });
  // reproducible after reset
  const snapshot = async () => {
    const reg1 = await h.loginS('off.reg1'), exec = await h.loginS('exec1');
    return {
      clock: await (await anon.get('/api/test/clock')).json(),
      queue: (await (await reg1.get('/api/officer/queue')).json()).items.map(i => ({ caseNo: i.caseNo, dueAt: i.dueAt, status: i.status, owner: i.owner })),
      dash: await (await exec.get('/api/dashboard?period=2026-12&service=ALL')).json(),
    };
  };
  await h.reset();
  const s1 = await snapshot();
  await h.clock('2026-12-10T12:00:00+07:00');
  expect((await (await h.loginS('off.reg1')).post('/api/officer/cases/EG-2569-000028/claim')).status()).toBe(200);
  await h.newPaid({});
  await h.reset();
  const s2 = await snapshot();
  expect(s2).toEqual(s1);
  expect(s1.clock).toEqual({ now: '2026-12-01T09:00:00+07:00' });
  const bad = await anon.put('/api/test/clock', { data: { now: '2026-12-01 09:00' } });
  expect({ status: bad.status(), code: (await bad.json()).code }).toEqual({ status: 400, code: 'INVALID_TIME' });
  // hooks disabled without TEST_MODE
  let url = process.env.NOHOOK_URL, child;
  if (!url) {
    const env = { ...process.env, PORT: '3199', DB_PATH: path.resolve(__dirname, '..', 'data', 'nohook.db.json') };
    delete env.TEST_MODE;
    child = spawn(process.execPath, [path.resolve(__dirname, '..', 'app', 'server.js')], { env, stdio: 'ignore' });
    url = 'http://localhost:3199';
  }
  try {
    const c = await h.api();
    await expect.poll(async () => (await c.get(`${url}/api/health`).catch(() => null))?.status() ?? 0, { timeout: 15000 }).toBe(200);
    expect((await c.post(`${url}/api/test/reset`)).status(), 'reset without TEST_MODE').toBe(404);
  } finally { child?.kill(); }
});

test('TC-NFR-04 เข้ารหัสข้อมูลส่วนบุคคลที่เก็บ (inspection)', async ({ h }) => {
  const dbPath = process.env.DB_PATH;
  expect(dbPath, 'set DB_PATH to the database file of the web under test').toBeTruthy();
  await h.reset();
  const before = Date.now() - 2000; // tolerate coarse filesystem timestamps
  const c = await h.api();
  await c.post('/api/auth/thaid/start', { data: { idNo: ID.mana } });
  await c.post('/api/auth/thaid/verify', { data: { idNo: ID.mana, otp: '123456' } });
  expect((await c.post('/api/auth/register', { data: { mobile: '0845678901', email: '', consent: true } })).status()).toBe(201);
  expect(fs.existsSync(dbPath), `DB_PATH ${dbPath}`).toBe(true);
  // the file must be the live one: written by this server after the registration above, not a stale copy
  expect(fs.statSync(dbPath).mtimeMs, `DB_PATH ${dbPath} was not written during this test`).toBeGreaterThanOrEqual(before);
  const raw = fs.readFileSync(dbPath, 'utf8');
  const secrets = ['1101700123456', '3100600987659', '1909900555015', '5500400111221', '0812345678', '0823456789', '0834567890', '0845678901',
    '1-1017-00123-45-6', '3-1006-00987-65-9', '1-9099-00555-01-5', '5-5004-00111-22-1'];
  const found = Object.fromEntries(secrets.map(s => [s, raw.split(s).length - 1]));
  expect(found).toEqual(Object.fromEntries(secrets.map(s => [s, 0])));
  const sc = await h.loginC('somchai');
  expect((await h.caseOf(sc, 'EG-2569-000005')).idNo).toBe('1101700123456');
  test.info().annotations.push({ type: 'encryption', description: 'idNo / mobile / email stored as AES-256-GCM (random 96-bit IV + tag, base64); lookup by HMAC-SHA256 of idNo' });
});
