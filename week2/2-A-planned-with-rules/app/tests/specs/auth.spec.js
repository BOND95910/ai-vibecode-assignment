// หมวด AUTH · TC-AUTH-01 ถึง 04
const { test, expect } = require('../helpers/world');
const { eq, ok, status, err, tid, text, attr, count, hidden } = require('../helpers/check');
const { post, STAFF, CITIZENS } = require('../helpers/http');
const { uiLoginC, uiLoginS } = require('../helpers/ui');

const MSG_ID = 'เลขบัตรประชาชนไม่ถูกต้อง';

test('TC-AUTH-01 เลขบัตร 13 หลัก + checksum', async ({ w }) => {
  await w.reset();
  const { page, api } = await w.session('anon');
  const bad = [
    ['110170012345', '12 หลัก (ต่ำกว่าขอบ)'],
    ['11017001234567', '14 หลัก (เกินขอบ)'],
    ['1101700123457', 'checksum ผิด (ที่ถูกคือ 6)'],
    ['11017001234ab', 'ไม่ใช่ตัวเลขล้วน'],
  ];
  const good = ['1101700123456', '3100600987659', '1909900555015', '5500400111221'];

  // API
  for (const [v, why] of bad) {
    const r = await post(api, '/api/auth/thaid/start', { idNo: v });
    err(r, 400, 'INVALID_ID', MSG_ID, `API start ${v} (${why})`);
  }
  for (const v of good) {
    const r = await post(api, '/api/auth/thaid/start', { idNo: v });
    status(r, 200, `API start ${v}`);
    eq(r.body, { status: 'OTP_SENT' }, `API start ${v} body`);
  }

  // หน้าจอ: ทุกค่าเริ่มจากหน้า /login ใหม่
  for (const [v, why] of bad) {
    await page.goto('/login');
    await tid(page, 'login-tab-citizen').click();
    await tid(page, 'thaid-id-input').fill(v);
    await tid(page, 'thaid-submit').click();
    await text(page, 'thaid-error', MSG_ID, `thaid-error เมื่อกรอก ${v} (${why})`);
    await hidden(tid(page, 'otp-step'), `otp-step ต้องไม่แสดงเมื่อกรอก ${v}`);
  }
  for (const v of good) {
    await page.goto('/login');
    await tid(page, 'login-tab-citizen').click();
    await tid(page, 'thaid-id-input').fill(v);
    await tid(page, 'thaid-submit').click();
    await expect(tid(page, 'otp-step'), `otp-step ต้องแสดงเมื่อกรอก ${v}`).toBeVisible();
    await count(tid(page, 'thaid-error'), 0, `ไม่มี thaid-error เมื่อกรอก ${v}`);
  }
});

test('TC-AUTH-02 OTP ผิด 3 ครั้งล็อก 15 นาที', async ({ w }) => {
  await w.reset();
  const piti = CITIZENS.piti.idNo;
  const verifyApi = async (r, otp) => post(r, '/api/auth/thaid/verify', { idNo: piti, otp });
  // ระหว่างล็อก start อาจตอบ 423 ได้ จึงยิง start ทิ้งก่อน verify (ไม่ assert ผล)
  const startAny = (r) => post(r, '/api/auth/thaid/start', { idNo: piti });

  // ขั้น 1-3 ผ่านหน้าจอ: ดักคำตอบ verify เพื่อดู HTTP status และ body จริง
  const { page } = await w.session('anon');
  await page.goto('/login');
  await tid(page, 'login-tab-citizen').click();
  await tid(page, 'thaid-id-input').fill(piti);
  await tid(page, 'thaid-submit').click();
  await expect(tid(page, 'otp-step')).toBeVisible();
  const submitOtp = async (otp) => {
    await tid(page, 'otp-input').fill(otp);
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/auth/thaid/verify')),
      tid(page, 'otp-submit').click(),
    ]);
    let body = null;
    try { body = await res.json(); } catch { /* ไม่ใช่ JSON */ }
    return { status: res.status(), body };
  };

  let r = await submitOtp('000000');
  eq(r.status, 401, 'ขั้น 1 HTTP');
  eq(r.body && r.body.code, 'OTP_INVALID', 'ขั้น 1 code');
  await text(page, 'otp-error', 'รหัส OTP ไม่ถูกต้อง', 'ขั้น 1 otp-error');
  await text(page, 'otp-attempts-left', 'เหลือ 2 ครั้ง', 'ขั้น 1 otp-attempts-left');

  r = await submitOtp('000000');
  eq(r.status, 401, 'ขั้น 2 HTTP (ครั้งที่ 2 ยังลองได้)');
  await text(page, 'otp-attempts-left', 'เหลือ 1 ครั้ง', 'ขั้น 2 otp-attempts-left');

  r = await submitOtp('000000');
  eq(r.status, 423, 'ขั้น 3 HTTP (ครั้งที่ 3 ล็อก)');
  eq(r.body && r.body.code, 'LOCKED', 'ขั้น 3 code');
  eq(r.body && r.body.lockedUntil, '2026-12-01T09:15:00+07:00', 'ขั้น 3 lockedUntil');
  await text(page, 'lock-message', 'ผิดเกินกำหนด เลขบัตรนี้ถูกล็อก 15 นาที', 'ขั้น 3 lock-message');
  await attr(tid(page, 'lock-until'), 'data-iso', '2026-12-01T09:15:00+07:00', 'ขั้น 3 lock-until');

  // ขั้น 4 OTP ถูกทันที ยังล็อก
  const api = await w.fresh('anon');
  await startAny(api);
  let v = await verifyApi(api, '123456');
  eq(v.status, 423, 'ขั้น 4 OTP ถูกขณะล็อกยังต้อง 423');
  eq(v.body && v.body.code, 'LOCKED', 'ขั้น 4 code');

  // ขั้น 5 สมชายล็อกอินได้ตามปกติ (ล็อกเฉพาะเลขบัตรที่ผิด)
  await w.fresh('somchai');

  // ขั้น 6 ผ่านไป 14:59 ยังล็อก
  await w.clock('2026-12-01T09:14:59+07:00');
  await startAny(api);
  v = await verifyApi(api, '123456');
  eq(v.status, 423, 'ขั้น 6 ผ่านไป 14:59 ยังต้อง 423');

  // ขั้น 7 ครบ 15:00 ปลดล็อก ตัวนับเริ่มใหม่ (ผ่านหน้าจอ)
  await w.clock('2026-12-01T09:15:00+07:00');
  await page.goto('/login');
  await tid(page, 'login-tab-citizen').click();
  await tid(page, 'thaid-id-input').fill(piti);
  await tid(page, 'thaid-submit').click();
  await expect(tid(page, 'otp-step'), 'ครบ 15:00 ปลดล็อกแล้ว otp-step ต้องแสดง').toBeVisible();
  r = await submitOtp('000000');
  eq(r.status, 401, 'ขั้น 7 HTTP หลังปลดล็อก');
  eq(r.body && r.body.code, 'OTP_INVALID', 'ขั้น 7 code');
  await text(page, 'otp-attempts-left', 'เหลือ 2 ครั้ง', 'ขั้น 7 ตัวนับเริ่มใหม่');

  // ขั้น 8 OTP ถูก ล็อกอินสำเร็จ
  r = await submitOtp('123456');
  eq(r.status, 200, 'ขั้น 8 HTTP');
  await expect(page, 'ขั้น 8 ต้องเข้า /citizen').toHaveURL(/\/citizen/);

  // ขั้น 9 OTP ถูกรีเซ็ตตัวนับเป็น 0
  await w.reset();
  const c = await w.fresh('anon');
  await startAny(c);
  v = await verifyApi(c, '000000');
  eq(v.status, 401, 'ขั้น 9 ผิดครั้งที่ 1');
  eq(v.body.attemptsLeft, 2, 'ขั้น 9 ผิดครั้งที่ 1 attemptsLeft');
  v = await verifyApi(c, '000000');
  eq(v.status, 401, 'ขั้น 9 ผิดครั้งที่ 2');
  eq(v.body.attemptsLeft, 1, 'ขั้น 9 ผิดครั้งที่ 2 attemptsLeft');
  v = await verifyApi(c, '123456');
  eq(v.status, 200, 'ขั้น 9 OTP ถูก');
  const lo = await post(c, '/api/auth/logout');
  eq(lo.status, 204, 'ขั้น 9 logout');
  await startAny(c);
  v = await verifyApi(c, '000000');
  eq(v.status, 401, 'ขั้น 9 รอบใหม่ ผิดครั้งที่ 1 (ต้องไม่ล็อก)');
  eq(v.body.attemptsLeft, 2, 'ขั้น 9 รอบใหม่ ผิดครั้งที่ 1 attemptsLeft (ตัวนับถูกรีเซ็ตโดย OTP ถูก)');
  v = await verifyApi(c, '000000');
  eq(v.status, 401, 'ขั้น 9 รอบใหม่ ผิดครั้งที่ 2 ต้องยังไม่ล็อก');
  eq(v.body.attemptsLeft, 1, 'ขั้น 9 รอบใหม่ ผิดครั้งที่ 2 ตอบ "เหลือ 1 ครั้ง"');
});

test('TC-AUTH-03 ลงทะเบียนครั้งแรก', async ({ w }) => {
  await w.reset();
  const mana = CITIZENS.mana;
  const { page } = await w.session('anon');
  await uiLoginC(page, mana.idNo);
  await expect(page, 'มานะยังไม่ลงทะเบียน ต้องถูกพาไป /register').toHaveURL(/\/register/);

  // 1 ชื่อจาก ThaiD อ่านอย่างเดียว
  await expect(tid(page, 'reg-name'), 'reg-name ต้องเป็นชื่อจาก ThaiD').toHaveValue(mana.name);
  eq(await tid(page, 'reg-name').evaluate((e) => e.readOnly), true, 'reg-name readOnly');
  await tid(page, 'reg-name').click();
  await page.keyboard.type('zzz');
  await expect(tid(page, 'reg-name'), 'พิมพ์ลง reg-name แล้วค่าต้องไม่เปลี่ยน').toHaveValue(mana.name);

  // 2-4 เบอร์ผิดรูปแบบ (ติ๊กยินยอมแล้ว)
  const MSG_MOBILE = 'เบอร์มือถือต้องเป็นตัวเลข 10 หลักขึ้นต้นด้วย 0';
  await tid(page, 'reg-consent').setChecked(true);
  for (const [mobile, why] of [['081234567', '9 หลัก'], ['08123456789', '11 หลัก'], ['1812345678', '10 หลักไม่ขึ้นต้น 0'], ['08123abcde', 'มีตัวอักษร']]) {
    await tid(page, 'reg-mobile').fill(mobile);
    await tid(page, 'reg-submit').click();
    await text(page, 'reg-error-mobile', MSG_MOBILE, `reg-error-mobile เมื่อเบอร์ ${mobile} (${why})`);
    await expect(page, `เบอร์ ${mobile} ต้องยังอยู่ /register`).toHaveURL(/\/register/);
  }

  // 5 ไม่ติ๊กยินยอม
  await tid(page, 'reg-mobile').fill('0845678901');
  await tid(page, 'reg-consent').setChecked(false);
  await tid(page, 'reg-submit').click();
  await text(page, 'reg-error-consent', 'กรุณายินยอมการประมวลผลข้อมูลส่วนบุคคล (PDPA)', 'reg-error-consent');
  await expect(page, 'ไม่ติ๊กยินยอมต้องยังอยู่ /register').toHaveURL(/\/register/);

  // 6 ครบถ้วน อีเมลว่าง
  await tid(page, 'reg-consent').setChecked(true);
  await tid(page, 'reg-email').fill('');
  await tid(page, 'reg-submit').click();
  await expect(page, 'ลงทะเบียนสำเร็จต้องไป /citizen').toHaveURL(/\/citizen$/);
  await text(page, 'citizen-welcome', 'สวัสดี มานะ ตั้งใจ', 'citizen-welcome');

  // 7 ออกจากระบบ แล้วล็อกอินอีกครั้งต้องเข้า /citizen ตรง ๆ ไม่ผ่าน /register
  await tid(page, 'logout-btn').click();
  await expect(page).toHaveURL(/\/login/);
  const seen = [];
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) seen.push(f.url()); });
  await uiLoginC(page, mana.idNo);
  await expect(page, 'ล็อกอินครั้งที่ 2 ต้องเข้า /citizen').toHaveURL(/\/citizen$/);
  ok(!seen.some((u) => u.includes('/register')), 'ล็อกอินครั้งที่ 2 ต้องไม่ผ่าน /register', `เส้นทางที่ผ่าน: ${seen.join(' > ')}`);

  // 8 API: RESET แล้วล็อกอินมานะ (registered:false) แล้ว register ผิดเงื่อนไข
  await w.reset();
  const api = await w.fresh('anon');
  const s = await post(api, '/api/auth/thaid/start', { idNo: mana.idNo });
  status(s, 200, 'API start มานะ');
  const v = await post(api, '/api/auth/thaid/verify', { idNo: mana.idNo, otp: '123456' });
  status(v, 200, 'API verify มานะ');
  eq(v.body.registered, false, 'API verify มานะ registered');
  let r = await post(api, '/api/auth/register', { mobile: '081234567', email: '', consent: true });
  err(r, 400, 'INVALID_MOBILE', MSG_MOBILE, 'API register เบอร์ 9 หลัก');
  r = await post(api, '/api/auth/register', { mobile: '0845678901', email: '', consent: false });
  err(r, 400, 'CONSENT_REQUIRED', 'กรุณายินยอมการประมวลผลข้อมูลส่วนบุคคล (PDPA)', 'API register consent=false (ยังไม่ลงทะเบียนจึงไม่ใช่ 409)');
});

test('TC-AUTH-04 เจ้าหน้าที่ SSO จำลองและหน้าตั้งต้นตามบทบาท', async ({ w }) => {
  await w.reset();
  const { page, api } = await w.session('anon');
  const table = [
    ['off.reg1', '/officer/queue', 'เจ้าหน้าที่ทะเบียน 1', 'เจ้าหน้าที่', 'officer', 'registry'],
    ['off.reg2', '/officer/queue', 'เจ้าหน้าที่ทะเบียน 2', 'เจ้าหน้าที่', 'officer', 'registry'],
    ['off.works1', '/officer/queue', 'เจ้าหน้าที่โยธา 1', 'เจ้าหน้าที่', 'officer', 'works'],
    ['head1', '/head/approvals', 'หัวหน้าฝ่าย', 'หัวหน้าฝ่าย', 'head', null],
    ['exec1', '/dashboard', 'ผู้บริหาร', 'ผู้บริหาร', 'executive', null],
    ['audit1', '/audit', 'ผู้ตรวจสอบภายใน', 'ผู้ตรวจสอบภายใน', 'auditor', null],
    ['admin1', '/admin/services', 'ผู้ดูแลระบบ', 'ผู้ดูแลระบบ', 'admin', null],
  ];
  await page.goto('/login');
  await tid(page, 'login-tab-staff').click();
  await text(page, 'staff-submit', 'เข้าสู่ระบบเจ้าหน้าที่ (SSO ภาครัฐ จำลอง)', 'ข้อความปุ่ม staff-submit');

  for (const [u, landing, name, roleTh, role, dept] of table) {
    await uiLoginS(page, u);
    await expect(page, `${u} ต้องไปหน้า ${landing}`).toHaveURL(new RegExp(landing.replace('/', '\\/') + '$'));
    await text(page, 'user-name', name, `${u} user-name`);
    await text(page, 'user-role', roleTh, `${u} user-role`);
    await attr(tid(page, 'user-role'), 'data-role', role, `${u} data-role`);
    if (dept) await attr(tid(page, 'user-role'), 'data-dept', dept, `${u} data-dept`);
    await tid(page, 'logout-btn').click();
    await expect(page, `${u} logout ต้องไป /login`).toHaveURL(/\/login/);
  }

  // รหัสผ่านผิด · username ไม่มี · เลขบัตรประชาชนในช่อง username → ข้อความเดียวกัน 3 กรณี (401 INVALID_CREDENTIALS)
  const MSG = 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง';
  for (const [u, p] of [['off.reg1', 'wrong'], ['nobody', 'Test@1234'], ['1101700123456', 'Test@1234']]) {
    const r = await post(api, '/api/auth/staff/login', { username: u, password: p });
    err(r, 401, 'INVALID_CREDENTIALS', MSG, `API staff login ${u}/${p}`);
    await uiLoginS(page, u, p);
    await text(page, 'staff-error', MSG, `staff-error ${u}/${p}`);
  }

  // หลังออกจากระบบ เปิดหน้าที่ต้องล็อกอิน → redirect /login
  await page.goto('/officer/queue');
  await expect(page, 'ยังไม่ล็อกอินเปิด /officer/queue ต้อง redirect /login').toHaveURL(/\/login/);
});
