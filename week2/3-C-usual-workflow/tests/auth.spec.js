const { test, expect, ID } = require('./helpers');

test('TC-AUTH-01 เลขบัตร 13 หลัก + checksum', async ({ h }) => {
  await h.reset();
  const page = await h.page();
  const api = await h.api();
  await page.goto('/login');
  const input = page.getByTestId('thaid-id-input');
  await expect(page.getByTestId('thaid-submit')).toHaveText('เข้าสู่ระบบด้วย ThaiD (จำลอง)');
  for (const v of ['110170012345', '11017001234567', '1101700123457', '11017001234ab']) {
    await input.fill(v);
    await expect(input).toHaveValue(v); // no maxlength: 14 characters must fit (A-45)
    await page.getByTestId('thaid-submit').click();
    await expect(page.getByTestId('thaid-error'), v).toHaveText('เลขบัตรประชาชนไม่ถูกต้อง');
    await expect(page.getByTestId('otp-step'), v).toBeHidden();
    await h.expectErr(await api.post('/api/auth/thaid/start', { data: { idNo: v } }), 400, 'INVALID_ID', v);
  }
  for (const v of [ID.somchai, ID.somying, ID.piti, ID.mana]) {
    await input.fill(v);
    await page.getByTestId('thaid-submit').click();
    await expect(page.getByTestId('otp-step'), v).toBeVisible();
    await expect(page.getByTestId('thaid-error'), v).toHaveCount(0);
    const r = await api.post('/api/auth/thaid/start', { data: { idNo: v } });
    expect({ status: r.status(), body: await r.json() }, v).toEqual({ status: 200, body: { status: 'OTP_SENT' } });
  }
});

test('TC-AUTH-02 OTP ผิด 3 ครั้งล็อก 15 นาที', async ({ h }) => {
  await h.reset();
  const page = await h.page();
  const otp = async code => { await page.getByTestId('otp-input').fill(code); await page.getByTestId('otp-submit').click(); };
  await page.goto('/login');
  await page.getByTestId('thaid-id-input').fill(ID.piti);
  await page.getByTestId('thaid-submit').click();
  await expect(page.getByTestId('otp-step')).toBeVisible();
  // 1-2
  await otp('000000');
  await expect(page.getByTestId('otp-error')).toHaveText('รหัส OTP ไม่ถูกต้อง');
  await expect(page.getByTestId('otp-attempts-left')).toHaveText('เหลือ 2 ครั้ง');
  await otp('000000');
  await expect(page.getByTestId('otp-attempts-left')).toHaveText('เหลือ 1 ครั้ง');
  // 3: locked from the 3rd failure
  await otp('000000');
  await expect(page.getByTestId('lock-message')).toHaveText('ผิดเกินกำหนด เลขบัตรนี้ถูกล็อก 15 นาที');
  await expect(page.getByTestId('lock-until')).toHaveAttribute('data-iso', '2026-12-01T09:15:00+07:00');
  // 4: correct OTP still locked
  await otp('123456');
  await expect(page.getByTestId('lock-message')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  const api = await h.api();
  const locked = await h.expectErr(await api.post('/api/auth/thaid/verify', { data: { idNo: ID.piti, otp: '123456' } }), 423, 'LOCKED', 'step 4');
  expect(locked.lockedUntil).toBe('2026-12-01T09:15:00+07:00');
  // 5: other ID unaffected
  await h.loginC('somchai');
  // 6: +14:59 still locked
  await h.clock('2026-12-01T09:14:59+07:00');
  await h.expectErr(await api.post('/api/auth/thaid/verify', { data: { idNo: ID.piti, otp: '123456' } }), 423, 'LOCKED', 'step 6 (14:59)');
  // 7: +15:00 unlocked, counter restarted
  await h.clock('2026-12-01T09:15:00+07:00');
  await page.goto('/login');
  await page.getByTestId('thaid-id-input').fill(ID.piti);
  await page.getByTestId('thaid-submit').click();
  await otp('000000');
  await expect(page.getByTestId('otp-attempts-left')).toHaveText('เหลือ 2 ครั้ง');
  await expect(page.getByTestId('lock-message')).toHaveCount(0);
  // 8
  await otp('123456');
  await expect(page).toHaveURL(/\/citizen$/);
  // 9: correct OTP resets the counter
  await h.reset();
  const c = await h.api();
  const v = otpCode => c.post('/api/auth/thaid/verify', { data: { idNo: ID.piti, otp: otpCode } });
  expect((await c.post('/api/auth/thaid/start', { data: { idNo: ID.piti } })).status()).toBe(200);
  expect((await (await v('000000')).json()).attemptsLeft).toBe(2);
  expect((await (await v('000000')).json()).attemptsLeft).toBe(1);
  expect((await v('123456')).status()).toBe(200);
  expect((await c.post('/api/auth/logout')).status()).toBe(204);
  const r1 = await v('000000');
  expect({ status: r1.status(), left: (await r1.json()).attemptsLeft }).toEqual({ status: 401, left: 2 });
  const r2 = await v('000000');
  expect({ status: r2.status(), left: (await r2.json()).attemptsLeft }).toEqual({ status: 401, left: 1 });
});

test('TC-AUTH-03 ลงทะเบียนครั้งแรก', async ({ h }) => {
  await h.reset();
  const page = await h.page();
  const loginMana = () => h.uiLoginC(page, ID.mana);
  await loginMana();
  await expect(page).toHaveURL(/\/register$/);
  const name = page.getByTestId('reg-name');
  await expect(name).toHaveValue('มานะ ตั้งใจ');
  expect(await name.evaluate(e => e.readOnly)).toBe(true);
  await name.focus();
  await page.keyboard.type('xyz');
  await expect(name).toHaveValue('มานะ ตั้งใจ');
  const submit = async (mobile, consent) => {
    await page.getByTestId('reg-mobile').fill(mobile);
    await page.getByTestId('reg-consent').setChecked(consent);
    await page.getByTestId('reg-submit').click();
  };
  for (const bad of ['081234567', '08123456789', '1812345678', '08123abcde']) {
    await submit(bad, true);
    await expect(page.getByTestId('reg-error-mobile'), bad).toHaveText('เบอร์มือถือต้องเป็นตัวเลข 10 หลักขึ้นต้นด้วย 0');
    await expect(page).toHaveURL(/\/register$/);
  }
  await submit('0845678901', false);
  await expect(page.getByTestId('reg-error-consent')).toHaveText('กรุณายินยอมการประมวลผลข้อมูลส่วนบุคคล (PDPA)');
  await expect(page).toHaveURL(/\/register$/);
  await page.getByTestId('reg-email').fill('');
  await submit('0845678901', true);
  await expect(page).toHaveURL(/\/citizen$/);
  await expect(page.getByTestId('citizen-welcome')).toHaveText('สวัสดี มานะ ตั้งใจ');
  await page.getByTestId('logout-btn').click();
  await expect(page).toHaveURL(/\/login$/);
  await loginMana();
  await expect(page).toHaveURL(/\/citizen$/);
  // 8: API after a fresh RESET
  await h.reset();
  const c = await h.api();
  await c.post('/api/auth/thaid/start', { data: { idNo: ID.mana } });
  const v = await c.post('/api/auth/thaid/verify', { data: { idNo: ID.mana, otp: '123456' } });
  expect(await v.json()).toEqual({ registered: false });
  await h.expectErr(await c.post('/api/auth/register', { data: { mobile: '081234567', email: '', consent: true } }), 400, 'INVALID_MOBILE');
  await h.expectErr(await c.post('/api/auth/register', { data: { mobile: '0845678901', email: '', consent: false } }), 400, 'CONSENT_REQUIRED');
});

test('TC-AUTH-04 เจ้าหน้าที่ SSO จำลองและหน้าตั้งต้นตามบทบาท', async ({ h }) => {
  await h.reset();
  const page = await h.page();
  const rows = [
    ['off.reg1', '/officer/queue', 'เจ้าหน้าที่ทะเบียน 1', 'เจ้าหน้าที่', 'officer', 'registry'],
    ['off.reg2', '/officer/queue', 'เจ้าหน้าที่ทะเบียน 2', 'เจ้าหน้าที่', 'officer', 'registry'],
    ['off.works1', '/officer/queue', 'เจ้าหน้าที่โยธา 1', 'เจ้าหน้าที่', 'officer', 'works'],
    ['head1', '/head/approvals', 'หัวหน้าฝ่าย', 'หัวหน้าฝ่าย', 'head', null],
    ['exec1', '/dashboard', 'ผู้บริหาร', 'ผู้บริหาร', 'executive', null],
    ['audit1', '/audit', 'ผู้ตรวจสอบภายใน', 'ผู้ตรวจสอบภายใน', 'auditor', null],
    ['admin1', '/admin/services', 'ผู้ดูแลระบบ', 'ผู้ดูแลระบบ', 'admin', null],
  ];
  const staffLogin = (u, p) => h.uiLoginS(page, u, p);
  await page.goto('/login');
  await page.getByTestId('login-tab-staff').click();
  await expect(page.getByTestId('staff-submit')).toHaveText('เข้าสู่ระบบเจ้าหน้าที่ (SSO ภาครัฐ จำลอง)');
  for (const [u, landing, name, roleTh, role, dept] of rows) {
    await staffLogin(u, 'Test@1234');
    await expect(page, u).toHaveURL(new RegExp(landing.replace(/\//g, '\\/') + '$'));
    await expect(page.getByTestId('user-name'), u).toHaveText(name);
    const r = page.getByTestId('user-role');
    await expect(r, u).toHaveText(roleTh);
    await expect(r, u).toHaveAttribute('data-role', role);
    if (dept) await expect(r, u).toHaveAttribute('data-dept', dept);
    await page.getByTestId('logout-btn').click();
    await expect(page, u).toHaveURL(/\/login$/);
  }
  const api = await h.api();
  for (const [u, p] of [['off.reg1', 'wrong'], ['nobody', 'Test@1234'], ['1101700123456', 'Test@1234']]) {
    await staffLogin(u, p);
    await expect(page.getByTestId('staff-error'), u).toHaveText('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
    await h.expectErr(await api.post('/api/auth/staff/login', { data: { username: u, password: p } }), 401, 'INVALID_CREDENTIALS', u);
  }
  await page.goto('/officer/queue');
  await expect(page).toHaveURL(/\/login$/);
});
