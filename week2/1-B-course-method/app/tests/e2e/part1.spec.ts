/**
 * part1.spec.ts · Playwright ชุด 1 (22 TC) ตาม TEST-PLAN.md §2–§9
 *   AUTH-01..04 · FEE-01 · SUBMIT-01..03 · UPLOAD-01..02 · PAY-01..04 · QUEUE-01..03 · SLA-01..03 · NOTI-01..02
 *
 * กติกา
 * - ทุก TC เริ่มด้วย RESET · หลัง RESET ทุกครั้ง (รวมกลาง TC) สร้าง context ใหม่และล็อกอินใหม่
 *   (RESET ใน helpers ปิด context เก่าทั้งหมดให้เอง จึงใช้ cookie เก่าซ้ำไม่ได้)
 * - ค่าคาดหวังคัดจากการ์ด TC ตัวต่อตัว (ไม่อ่านจากหน้าจอเว็บ) · ชื่อ testid / ข้อความ error จาก CONTRACT.md
 * - BASE_URL จาก env · เว็บต้องรันด้วย TEST_MODE=1
 */
import type { Browser, Locator, Page, Response } from '@playwright/test';
import {
  test,
  expect,
  RESET,
  CLOCK,
  LOGIN_C,
  LOGIN_S,
  NEW_PAID,
  PAY,
  T0,
  OTP_OK,
  ID,
  MSG,
  DASH,
  STAFF,
  LEVEL_TH,
  STATUS_TH,
  EG,
  RC,
  PP,
  DR,
  newApi,
  newBrowserContext,
  expectStatus,
  expectApiError,
  sameInstant,
  getCase,
  myCases,
  myDrafts,
  draftFileCount,
  queueApi,
  claimApi,
  returnApi,
  resubmitApi,
  notificationsApi,
  auditApi,
  createDraftApi,
  uploadApi,
  expectPath,
  rowBy,
  attrsOf,
  fillAndCommit,
  openCitizenLogin,
  loginCitizenUi,
  loginStaffUi,
  workloadUi,
  testFile,
  type Actor,
  type UiActor,
  type ServiceId,
  type SlaLevel,
  type StaffUser,
  type TestFile,
} from './helpers';

// ───────────────────────────── ตัวช่วยเฉพาะชุดนี้ ─────────────────────────────

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** แถวคิวของเลขคำขอ */
const queueRow = (page: Page, caseNo: string) => rowBy(page, 'queue-row', 'data-case-no', caseNo);

/** ลำดับ data-case-no ของ queue-row บนหน้า */
const queueOrder = (page: Page) => attrsOf(page.getByTestId('queue-row'), 'data-case-no');

/** เปิดขั้นตอนยื่นแล้วไปขั้น 2/3 แนบเอกสาร */
async function openUploadStep(page: Page, service: ServiceId, value?: string): Promise<void> {
  await page.goto(`/citizen/new/${service}`);
  await expect(page.getByTestId('wizard-step')).toHaveText('1/3 กรอกข้อมูล');
  if (service === 'SV-01') await fillAndCommit(page.getByTestId('qty-input'), value ?? '1');
  if (service === 'SV-03') await fillAndCommit(page.getByTestId('area-input'), value ?? '100');
  await page.getByTestId('to-upload-btn').click();
  await expect(page.getByTestId('wizard-step')).toHaveText('2/3 แนบเอกสาร');
}

/**
 * แนบไฟล์ผ่าน <input type=file> แล้วรอ POST /api/drafts/:id/files ที่เกิดขึ้น (ถ้ามี) ตอบกลับ
 * คืน response ของการอัปโหลด (null = หน้าไม่ได้ส่งไฟล์ไปเซิร์ฟเวอร์ภายใน 8 วินาที)
 */
async function uploadUi(page: Page, inputTestId: string, file: TestFile): Promise<Response | null> {
  const settled = page
    .waitForResponse(
      (r) => r.request().method() === 'POST' && /\/api\/drafts\/[^/]+\/files$/.test(new URL(r.url()).pathname),
      { timeout: 8_000 },
    )
    .catch(() => null);
  await page.getByTestId(inputTestId).setInputFiles(file);
  return settled;
}

/** ลบไฟล์ (file-remove-btn ในแถว file-item) แล้วรอจำนวนลดลง */
async function removeFileUi(page: Page, item: Locator): Promise<void> {
  const items = page.getByTestId('file-item');
  const before = await items.count();
  await item.getByTestId('file-remove-btn').click();
  await expect(items).toHaveCount(before - 1);
}

/** ตรวจ sla-level (ข้อความไทย + data-level) */
async function expectLevel(loc: Locator, level: SlaLevel, soft = false): Promise<void> {
  const e = soft ? expect.soft : expect;
  await e(loc).toHaveText(LEVEL_TH[level]);
  await e(loc).toHaveAttribute('data-level', level);
}

/** ตรวจ case-status (ข้อความไทย + data-status) */
async function expectCaseStatus(page: Page, status: keyof typeof STATUS_TH): Promise<void> {
  const el = page.getByTestId('case-status');
  await expect(el).toHaveText(STATUS_TH[status]);
  await expect(el).toHaveAttribute('data-status', status);
}

type NotiLevel = 'near' | 'overdue';
type NotiKey = [caseNo: number, level: NotiLevel];

/** แจ้งเตือนของผู้ใช้ต้องเท่ากับชุดที่คาดหวังพอดี ทั้ง API และหน้า /notifications + bell-count */
async function expectNoti(actor: UiActor, expected: NotiKey[], label: string): Promise<void> {
  const want = expected.map(([n, l]) => `${EG(n)}|${l}`).sort();
  const items = await notificationsApi(actor.api);
  expect(items.map((i) => `${i.caseNo}|${i.level}`).sort(), `${label}: GET /api/notifications`).toEqual(want);
  for (const i of items) {
    expect(String(i.text), `${label}: text ของ ${i.caseNo}`).toBe(`คำขอ ${i.caseNo} ${LEVEL_TH[i.level as SlaLevel]}`);
  }
  const page = actor.page;
  await page.goto('/notifications');
  const ui = page.getByTestId('noti-item');
  await expect(ui, `${label}: noti-item`).toHaveCount(want.length);
  const got = await ui.evaluateAll((els) => els.map((e) => `${e.getAttribute('data-case-no')}|${e.getAttribute('data-level')}`));
  expect(got.sort(), `${label}: noti-item (data-case-no|data-level)`).toEqual(want);
  for (const [n, l] of expected) {
    await expect(
      page.locator(`[data-testid="noti-item"][data-case-no="${EG(n)}"][data-level="${l}"]`),
    ).toHaveText(`คำขอ ${EG(n)} ${LEVEL_TH[l]}`);
  }
  if (want.length === 0) await expect(page.getByTestId('noti-empty')).toHaveText(MSG.NOTI_EMPTY);
  await expect(page.getByTestId('bell-count'), `${label}: bell-count`).toHaveText(String(want.length));
}

/** ระดับแจ้งเตือนของคำขอหนึ่งใบของผู้ใช้ (เรียงตัวอักษร) */
async function notiLevelsFor(actor: Actor, n: number): Promise<string[]> {
  return (await notificationsApi(actor.api))
    .filter((i) => i.caseNo === EG(n))
    .map((i) => String(i.level))
    .sort();
}

/** จำนวนแถว Audit เหตุการณ์ CLAIM ของเลขคำขอ (ดูผ่าน audit1) */
async function claimAuditRows(caseNo: string): Promise<number> {
  const au = await LOGIN_S('audit1');
  const { items } = await auditApi(au.api, { event: 'CLAIM' });
  return items.filter((i) => i.caseNo === caseNo && i.event === 'CLAIM').length;
}

// ═════════════════════════════ AUTH ═════════════════════════════

test('TC-AUTH-01 เลขบัตร 13 หลัก + checksum', async ({ browser }) => {
  await RESET();
  const { page } = await newBrowserContext(browser);
  const anon = await newApi();

  const invalid: Array<[string, string]> = [
    ['110170012345', '12 หลัก ต่ำกว่าขอบ'],
    ['11017001234567', '14 หลัก เกินขอบ'],
    ['1101700123457', 'checksum ผิด'],
    ['11017001234ab', 'ไม่ใช่ตัวเลขล้วน'],
  ];
  for (const [v, why] of invalid) {
    await test.step(`${v} (${why}) → thaid-error · API 400 INVALID_ID`, async () => {
      await openCitizenLogin(page);
      const input = page.getByTestId('thaid-id-input');
      await input.fill(v);
      await expect(input).toHaveValue(v); // ไม่จำกัด maxlength: ต้องพิมพ์ได้ครบทุกตัว (A-45)
      await page.getByTestId('thaid-submit').click();
      await expect(page.getByTestId('thaid-error')).toHaveText(MSG.INVALID_ID);
      await expect(page.getByTestId('otp-step')).toBeHidden();
      await expectApiError(await anon.post('/api/auth/thaid/start', { data: { idNo: v } }), 400, 'INVALID_ID');
    });
  }

  for (const v of [ID.SOMCHAI, ID.SOMYING, ID.PITI, ID.MANA]) {
    await test.step(`${v} (checksum ถูก) → otp-step · API 200 OTP_SENT`, async () => {
      await openCitizenLogin(page);
      await page.getByTestId('thaid-id-input').fill(v);
      await page.getByTestId('thaid-submit').click();
      await expect(page.getByTestId('otp-step')).toBeVisible();
      await expect(page.getByTestId('thaid-error')).toBeHidden();
      const body = await expectStatus(await anon.post('/api/auth/thaid/start', { data: { idNo: v } }), 200);
      expect(body).toMatchObject({ status: 'OTP_SENT' });
    });
  }
});

test('TC-AUTH-02 OTP ผิด 3 ครั้งล็อก 15 นาที', async ({ browser }) => {
  const LOCK_UNTIL = '2026-12-01T09:15:00+07:00';
  const start = (api: Actor['api'], idNo: string) => api.post('/api/auth/thaid/start', { data: { idNo } });
  const verify = (api: Actor['api'], idNo: string, otp: string) =>
    api.post('/api/auth/thaid/verify', { data: { idNo, otp } });

  await test.step('API แถว 1–8', async () => {
    await RESET();
    const piti = await newApi();
    await expectStatus(await start(piti, ID.PITI), 200, 'start ปิติ');

    // 1
    let b = await expectApiError(await verify(piti, ID.PITI, '000000'), 401, 'OTP_INVALID', MSG.OTP_INVALID, '#1');
    expect(b.attemptsLeft, '#1 attemptsLeft').toBe(2);
    // 2
    b = await expectApiError(await verify(piti, ID.PITI, '000000'), 401, 'OTP_INVALID', undefined, '#2');
    expect(b.attemptsLeft, '#2 attemptsLeft').toBe(1);
    // 3
    b = await expectApiError(await verify(piti, ID.PITI, '000000'), 423, 'LOCKED', MSG.LOCKED, '#3');
    expect(sameInstant(b.lockedUntil, LOCK_UNTIL), `#3 lockedUntil = ${b.lockedUntil}`).toBe(true);
    // 4 OTP ถูกทันที → ยังล็อก
    await expectApiError(await verify(piti, ID.PITI, OTP_OK), 423, 'LOCKED', undefined, '#4');
    // 5 สมชายล็อกอินปกติ (ล็อกเฉพาะเลขบัตรที่ผิด)
    const somchai = await LOGIN_C(ID.SOMCHAI);
    expect(somchai.registered, '#5 สมชายล็อกอินสำเร็จ').toBe(true);
    // 6 ผ่านไป 14:59 → ยังล็อก
    await CLOCK('2026-12-01T09:14:59+07:00');
    await expectApiError(await verify(piti, ID.PITI, OTP_OK), 423, 'LOCKED', undefined, '#6');
    // 7 ครบ 15:00 → ปลดล็อก ตัวนับเริ่มใหม่
    await CLOCK('2026-12-01T09:15:00+07:00');
    await expectStatus(await start(piti, ID.PITI), 200, '#7 start');
    b = await expectApiError(await verify(piti, ID.PITI, '000000'), 401, 'OTP_INVALID', undefined, '#7');
    expect(b.attemptsLeft, '#7 attemptsLeft').toBe(2);
    // 8
    await expectStatus(await verify(piti, ID.PITI, OTP_OK), 200, '#8');
  });

  await test.step('API แถว 9: OTP ถูกรีเซ็ตตัวนับ', async () => {
    await RESET();
    const piti = await newApi();
    await expectStatus(await start(piti, ID.PITI), 200);
    let b = await expectApiError(await verify(piti, ID.PITI, '000000'), 401, 'OTP_INVALID');
    expect(b.attemptsLeft).toBe(2);
    b = await expectApiError(await verify(piti, ID.PITI, '000000'), 401, 'OTP_INVALID');
    expect(b.attemptsLeft).toBe(1);
    await expectStatus(await verify(piti, ID.PITI, OTP_OK), 200, 'OTP ถูก');
    await expectStatus(await piti.post('/api/auth/logout'), 204, 'logout');
    await expectStatus(await start(piti, ID.PITI), 200);
    b = await expectApiError(await verify(piti, ID.PITI, '000000'), 401, 'OTP_INVALID');
    expect(b.attemptsLeft).toBe(2);
    b = await expectApiError(await verify(piti, ID.PITI, '000000'), 401, 'OTP_INVALID', undefined, 'รอบใหม่ครั้งที่ 2 ต้องไม่ล็อก');
    expect(b.attemptsLeft).toBe(1);
  });

  await test.step('หน้าจอ แถว 1–3, 5, 7–8', async () => {
    await RESET();
    const { page } = await newBrowserContext(browser);
    const wrongOtp = async () => {
      await page.getByTestId('otp-input').fill('000000');
      await page.getByTestId('otp-submit').click();
    };
    await openCitizenLogin(page);
    await page.getByTestId('thaid-id-input').fill(ID.PITI);
    await page.getByTestId('thaid-submit').click();
    await expect(page.getByTestId('otp-step')).toBeVisible();

    await wrongOtp(); // 1
    await expect(page.getByTestId('otp-error')).toHaveText(MSG.OTP_INVALID);
    await expect(page.getByTestId('otp-attempts-left')).toHaveText('เหลือ 2 ครั้ง');
    await wrongOtp(); // 2
    await expect(page.getByTestId('otp-attempts-left')).toHaveText('เหลือ 1 ครั้ง');
    await wrongOtp(); // 3
    await expect(page.getByTestId('lock-message')).toHaveText(MSG.LOCKED);
    await expect(page.getByTestId('lock-until')).toHaveAttribute('data-iso', LOCK_UNTIL);

    // 5 สมชายล็อกอินผ่านหน้าจอได้ระหว่างที่ปิติถูกล็อก
    const other = await newBrowserContext(browser);
    await loginCitizenUi(other.page, ID.SOMCHAI);
    await expectPath(other.page, '/citizen');

    // 7 ปลดล็อกแล้ว ตัวนับเริ่มใหม่
    await CLOCK('2026-12-01T09:15:00+07:00');
    await openCitizenLogin(page);
    await page.getByTestId('thaid-id-input').fill(ID.PITI);
    await page.getByTestId('thaid-submit').click();
    await expect(page.getByTestId('otp-step')).toBeVisible();
    await wrongOtp();
    await expect(page.getByTestId('otp-error')).toHaveText(MSG.OTP_INVALID);
    await expect(page.getByTestId('otp-attempts-left')).toHaveText('เหลือ 2 ครั้ง');

    // 8
    await page.getByTestId('otp-input').fill(OTP_OK);
    await page.getByTestId('otp-submit').click();
    await expectPath(page, '/citizen');
  });

  await test.step('หน้าจอ แถว 9: ผิด 2 → ถูก → ออก → ผิด 2 ยัง "เหลือ 1 ครั้ง"', async () => {
    await RESET();
    const { page } = await newBrowserContext(browser);
    const enterId = async () => {
      await openCitizenLogin(page);
      await page.getByTestId('thaid-id-input').fill(ID.PITI);
      await page.getByTestId('thaid-submit').click();
      await expect(page.getByTestId('otp-step')).toBeVisible();
    };
    const otp = async (v: string) => {
      await page.getByTestId('otp-input').fill(v);
      await page.getByTestId('otp-submit').click();
    };
    await enterId();
    await otp('000000');
    await expect(page.getByTestId('otp-attempts-left')).toHaveText('เหลือ 2 ครั้ง');
    await otp('000000');
    await expect(page.getByTestId('otp-attempts-left')).toHaveText('เหลือ 1 ครั้ง');
    await otp(OTP_OK);
    await expectPath(page, '/citizen');
    await page.getByTestId('logout-btn').click();
    await expectPath(page, '/login');
    await enterId();
    await otp('000000');
    await expect(page.getByTestId('otp-attempts-left')).toHaveText('เหลือ 2 ครั้ง');
    await otp('000000');
    await expect(page.getByTestId('otp-attempts-left')).toHaveText('เหลือ 1 ครั้ง');
    await expect(page.getByTestId('lock-message')).toHaveCount(0);
  });
});

test('TC-AUTH-03 ลงทะเบียนครั้งแรก', async ({ browser }) => {
  await RESET();
  const { page } = await newBrowserContext(browser);
  await loginCitizenUi(page, ID.MANA);
  await expectPath(page, '/register');

  const submitReg = async (mobile: string, consent: boolean) => {
    await page.goto('/register');
    await page.getByTestId('reg-mobile').fill(mobile);
    await page.getByTestId('reg-email').fill('');
    await page.getByTestId('reg-consent').setChecked(consent);
    await page.getByTestId('reg-submit').click();
  };

  await test.step('1 reg-name = มานะ ตั้งใจ และ readOnly', async () => {
    const name = page.getByTestId('reg-name');
    await expect(name).toHaveValue('มานะ ตั้งใจ');
    await expect(name).toHaveJSProperty('readOnly', true);
    await name.focus();
    await page.keyboard.type('xyz');
    await expect(name).toHaveValue('มานะ ตั้งใจ');
  });

  for (const m of ['081234567', '08123456789', '1812345678', '08123abcde']) {
    await test.step(`2–4 เบอร์ ${m} → reg-error-mobile`, async () => {
      await submitReg(m, true);
      await expect(page.getByTestId('reg-error-mobile')).toHaveText(MSG.INVALID_MOBILE);
      await expectPath(page, '/register');
    });
  }

  await test.step('5 ไม่ติ๊ก reg-consent → reg-error-consent', async () => {
    await submitReg('0845678901', false);
    await expect(page.getByTestId('reg-error-consent')).toHaveText(MSG.CONSENT_REQUIRED);
    await expectPath(page, '/register');
  });

  await test.step('6 ครบ → /citizen สวัสดี มานะ ตั้งใจ', async () => {
    await submitReg('0845678901', true);
    await expectPath(page, '/citizen');
    await expect(page.getByTestId('citizen-welcome')).toHaveText('สวัสดี มานะ ตั้งใจ');
  });

  await test.step('7 ออกจากระบบ → ล็อกอินอีกครั้งเข้า /citizen ตรง ๆ', async () => {
    await page.getByTestId('logout-btn').click();
    await expectPath(page, '/login');
    const visited: string[] = [];
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) visited.push(new URL(f.url()).pathname);
    });
    await loginCitizenUi(page, ID.MANA);
    await expectPath(page, '/citizen');
    expect(visited, 'ต้องไม่ผ่าน /register').not.toContain('/register');
  });

  await test.step('8 RESET · API register: 400 INVALID_MOBILE / 400 CONSENT_REQUIRED', async () => {
    await RESET();
    const api = await newApi();
    await expectStatus(await api.post('/api/auth/thaid/start', { data: { idNo: ID.MANA } }), 200);
    const v = await expectStatus(
      await api.post('/api/auth/thaid/verify', { data: { idNo: ID.MANA, otp: OTP_OK } }),
      200,
    );
    expect(v?.registered).toBe(false);
    await expectApiError(
      await api.post('/api/auth/register', { data: { mobile: '081234567', email: '', consent: true } }),
      400,
      'INVALID_MOBILE',
    );
    await expectApiError(
      await api.post('/api/auth/register', { data: { mobile: '0845678901', email: '', consent: false } }),
      400,
      'CONSENT_REQUIRED',
    );
  });
});

test('TC-AUTH-04 เจ้าหน้าที่ SSO จำลองและหน้าตั้งต้น', async ({ browser }) => {
  await RESET();
  const { page } = await newBrowserContext(browser);
  const anon = await newApi();

  await page.goto('/login');
  await page.getByTestId('login-tab-staff').click();
  await expect(page.getByTestId('staff-submit')).toHaveText('เข้าสู่ระบบเจ้าหน้าที่ (SSO ภาครัฐ จำลอง)');

  const users: StaffUser[] = ['off.reg1', 'off.reg2', 'off.works1', 'head1', 'exec1', 'audit1', 'admin1'];
  for (const u of users) {
    await test.step(`${u} → ${STAFF[u].landing}`, async () => {
      const s = STAFF[u];
      await loginStaffUi(page, u);
      await expectPath(page, s.landing);
      await expect(page.getByTestId('user-name')).toHaveText(s.name);
      const role = page.getByTestId('user-role');
      await expect(role).toHaveText(s.roleText);
      await expect(role).toHaveAttribute('data-role', s.role);
      if (s.role === 'officer') await expect(role).toHaveAttribute('data-dept', s.dept);
      await page.getByTestId('logout-btn').click();
      await expectPath(page, '/login');
    });
  }

  const bad: Array<[string, string, string]> = [
    ['off.reg1', 'wrong', 'รหัสผ่านผิด'],
    ['nobody', 'Test@1234', 'username ไม่มี'],
    [ID.SOMCHAI, 'Test@1234', 'เลขบัตรประชาชนในช่อง username'],
  ];
  for (const [u, p, why] of bad) {
    await test.step(`${why} → staff-error · 401 INVALID_CREDENTIALS`, async () => {
      await loginStaffUi(page, u, p);
      await expect(page.getByTestId('staff-error')).toHaveText(MSG.INVALID_CREDENTIALS);
      await expectApiError(
        await anon.post('/api/auth/staff/login', { data: { username: u, password: p } }),
        401,
        'INVALID_CREDENTIALS',
        MSG.INVALID_CREDENTIALS,
      );
    });
  }

  await test.step('logout-btn → /login · เปิด /officer/queue หลังออกจากระบบ → /login', async () => {
    await loginStaffUi(page, 'off.reg1');
    await expectPath(page, '/officer/queue');
    await page.getByTestId('logout-btn').click();
    await expectPath(page, '/login');
    await page.goto('/officer/queue');
    await expectPath(page, '/login');
  });
});

// ═════════════════════════════ FEE ═════════════════════════════

test('TC-FEE-01 ค่าธรรมเนียม SV-01 / SV-02 / SV-03', async ({ browser }) => {
  await RESET();
  const c = await LOGIN_C(ID.SOMCHAI, browser);
  const page = c.page;
  const feeTotal = page.getByTestId('fee-total');
  const feeError = page.getByTestId('fee-error');
  const next = page.getByTestId('to-upload-btn');

  type Row = { v: number; total?: string; fee?: number; error?: string; code?: string };
  const check = async (service: ServiceId, input: Locator, r: Row) => {
    await fillAndCommit(input, String(r.v));
    const body = service === 'SV-01' ? { serviceId: service, qty: r.v } : { serviceId: service, areaSqm: r.v };
    const res = await c.api.post('/api/drafts', { data: body });
    if (r.total) {
      await expect.soft(feeTotal, `${service} ${r.v}`).toHaveText(r.total);
      await expect.soft(feeError, `${service} ${r.v} ไม่มี fee-error`).toBeHidden();
      await expect.soft(next, `${service} ${r.v} to-upload-btn ใช้ได้`).toBeEnabled();
      const b = await expectStatus(res, 201, `POST /api/drafts ${service} ${r.v}`);
      expect.soft(b?.fee, `${service} ${r.v} fee`).toBe(r.fee);
    } else {
      await expect.soft(feeTotal, `${service} ${r.v}`).toHaveText(DASH);
      await expect.soft(feeError, `${service} ${r.v}`).toHaveText(r.error!);
      await expect.soft(next, `${service} ${r.v} to-upload-btn disabled`).toBeDisabled();
      await expectApiError(res, 400, r.code, undefined, `POST /api/drafts ${service} ${r.v}`);
    }
  };

  await test.step('SV-03 area-input', async () => {
    await page.goto('/citizen/new/SV-03');
    const area = page.getByTestId('area-input');
    const rows: Row[] = [
      { v: 0, error: MSG.INVALID_AREA, code: 'INVALID_AREA' },
      { v: -1, error: MSG.INVALID_AREA, code: 'INVALID_AREA' },
      { v: 1, total: '฿1,000', fee: 1000 },
      { v: 100, total: '฿1,000', fee: 1000 },
      { v: 101, total: '฿1,010', fee: 1010 },
      { v: 102, total: '฿1,020', fee: 1020 },
      { v: 250, total: '฿2,500', fee: 2500 },
      { v: 300, total: '฿3,000', fee: 3000 },
      { v: 499, total: '฿4,990', fee: 4990 },
      { v: 500, total: '฿5,000', fee: 5000 },
      { v: 501, error: MSG.AREA_TOO_LARGE, code: 'AREA_TOO_LARGE' },
    ];
    for (const r of rows) await check('SV-03', area, r);
  });

  await test.step('SV-01 qty-input', async () => {
    await page.goto('/citizen/new/SV-01');
    const qty = page.getByTestId('qty-input');
    const rows: Row[] = [
      { v: 0, error: MSG.INVALID_QTY, code: 'INVALID_QTY' },
      { v: 1, total: '฿20', fee: 20 },
      { v: 2, total: '฿40', fee: 40 },
      { v: 3, total: '฿60', fee: 60 },
      { v: 4, total: '฿80', fee: 80 },
      { v: 5, total: '฿100', fee: 100 },
      { v: 6, error: MSG.INVALID_QTY, code: 'INVALID_QTY' },
    ];
    for (const r of rows) await check('SV-01', qty, r);
  });

  await test.step('SV-02 ไม่มีช่องกรอก ฿500', async () => {
    await page.goto('/citizen/new/SV-02');
    await expect(feeTotal).toHaveText('฿500');
    await expect(page.getByTestId('qty-input')).toHaveCount(0);
    await expect(page.getByTestId('area-input')).toHaveCount(0);
    const b = await expectStatus(await c.api.post('/api/drafts', { data: { serviceId: 'SV-02' } }), 201);
    expect(b?.fee).toBe(500);
  });
});

// ═════════════════════════════ SUBMIT ═════════════════════════════

test('TC-SUBMIT-01 ยื่นคำขอ SV-01 ครบวงจร', async ({ browser }) => {
  await RESET();
  const c = await LOGIN_C(ID.SOMCHAI, browser);
  const page = c.page;

  await test.step('1 กรอกข้อมูล qty 2 → ฿40', async () => {
    await page.goto('/citizen');
    await page.getByTestId('start-service-SV-01').click();
    await expectPath(page, '/citizen/new/SV-01');
    await expect(page.getByTestId('wizard-step')).toHaveText('1/3 กรอกข้อมูล');
    await fillAndCommit(page.getByTestId('qty-input'), '2');
    await expect(page.getByTestId('fee-total')).toHaveText('฿40');
    await page.getByTestId('to-upload-btn').click();
  });

  await test.step('2 แนบเอกสาร id-card.pdf', async () => {
    await expect(page.getByTestId('wizard-step')).toHaveText('2/3 แนบเอกสาร');
    const toPay = page.getByTestId('to-payment-btn');
    await expect(toPay).toBeDisabled();
    await uploadUi(page, 'upload-input-id-card', testFile('id-card.pdf'));
    const items = page.getByTestId('file-item');
    await expect(items).toHaveCount(1);
    await expect(items.first()).toHaveAttribute('data-doc-key', 'id-card');
    await expect(toPay).toBeEnabled();
    await toPay.click();
  });

  await test.step('3 ชำระเงิน สร้าง QR PP-0002', async () => {
    await expect(page.getByTestId('wizard-step')).toHaveText('3/3 ชำระเงิน');
    await expect(page.getByTestId('payment-amount')).toHaveText('฿40');
    await page.getByTestId('create-qr-btn').click();
    await expect(page.getByTestId('qr-ref')).toHaveText(PP(2));
    await expect(page.getByTestId('qr-expires')).toHaveAttribute('data-iso', '2026-12-01T09:15:00+07:00');
    await expect(page.getByTestId('payment-status')).toHaveText('รอชำระ');
    await expect(page.getByTestId('payment-status')).toHaveAttribute('data-status', 'PENDING');
  });

  await test.step('4 ธนาคารจำลองชำระ ฿40 → EG-2569-000031', async () => {
    const paid = await PAY(PP(2), 40);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body).toMatchObject({ status: 'PAID', caseNo: EG(31), receiptNo: RC(31), duplicate: false });
    await page.getByTestId('refresh-payment-btn').click();
    await expect(page.getByTestId('payment-status')).toHaveText('ชำระแล้ว');
    await expect(page.getByTestId('payment-status')).toHaveAttribute('data-status', 'PAID');
    await expect(page.getByTestId('submitted-case-no')).toHaveText(EG(31));
    await expect(page.getByTestId('receipt-no')).toHaveText(RC(31));
    await expect(page.getByTestId('receipt-amount')).toHaveText('฿40');
    await expect(page.getByTestId('receipt-paid-at')).toHaveAttribute('data-iso', T0);
  });

  await test.step('5 หน้า /citizen/cases/EG-2569-000031', async () => {
    await page.getByTestId('go-case-btn').click();
    await expectPath(page, `/citizen/cases/${EG(31)}`);
    await expectCaseStatus(page, 'SUBMITTED');
    await expect(page.getByTestId('case-fee')).toHaveText('฿40');
    await expect(page.getByTestId('sla-due')).toHaveText('4 ธ.ค. 2569 16:30');
    await expect(page.getByTestId('sla-due')).toHaveAttribute('data-iso', '2026-12-04T16:30:00+07:00');
    await expectLevel(page.getByTestId('sla-level'), 'normal');
    await expect(page.getByTestId('cancel-case-btn')).toHaveCount(1);
    await expect(page.getByTestId('case-step')).toHaveCount(0);
  });

  await test.step('off.reg1 เห็นในคิว ท้ายกลุ่ม 4 ธ.ค. หลัง …000030', async () => {
    const o = await LOGIN_S('off.reg1', browser);
    await o.page.goto('/officer/queue');
    const row = queueRow(o.page, EG(31));
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('row-owner')).toHaveText(/^\s*$/);
    await expect(row).toHaveAttribute('data-owner', '');
    await expect(row.getByTestId('claim-btn')).toHaveCount(1);
    await expect(row.getByTestId('row-due')).toHaveAttribute('data-iso', '2026-12-04T16:30:00+07:00');
    const order = await queueOrder(o.page);
    expect(order.indexOf(EG(31)), `ลำดับ: ${order.join(' ')}`).toBe(order.indexOf(EG(30)) + 1);
  });
});

test('TC-SUBMIT-02 เอกสารบังคับครบก่อนชำระ', async ({ browser }) => {
  await RESET();
  const c = await LOGIN_C(ID.SOMCHAI, browser);
  const page = c.page;
  const toPay = page.getByTestId('to-payment-btn');
  const missing = page.getByTestId('missing-docs');
  const items = page.getByTestId('file-item');

  await test.step('SV-02', async () => {
    await openUploadStep(page, 'SV-02');
    await uploadUi(page, 'upload-input-id-card', testFile('id-card.pdf'));
    await expect(items).toHaveCount(1);
    await expect(toPay).toBeDisabled();
    await expect(missing).toHaveText('ยังขาดเอกสาร: แผนที่ตั้ง');

    await uploadUi(page, 'upload-input-map', testFile('map.pdf'));
    await expect(items).toHaveCount(2);
    await expect(toPay).toBeEnabled();
    await expect(missing).toBeHidden(); // ภาพสถานที่ไม่บังคับ

    await removeFileUi(page, rowBy(page, 'file-item', 'data-doc-key', 'map'));
    await expect(toPay).toBeDisabled();
    await expect(missing).toHaveText('ยังขาดเอกสาร: แผนที่ตั้ง');
  });

  await test.step('SV-03 พื้นที่ 100', async () => {
    await openUploadStep(page, 'SV-03', '100');
    await uploadUi(page, 'upload-input-id-card', testFile('id-card.pdf'));
    await expect(items).toHaveCount(1);
    await expect(toPay).toBeDisabled();
    await expect(missing).toHaveText('ยังขาดเอกสาร: แบบแปลน, โฉนด');

    await uploadUi(page, 'upload-input-deed', testFile('deed.pdf'));
    await expect(items).toHaveCount(2);
    await expect(toPay).toBeDisabled();
    await expect(missing).toHaveText('ยังขาดเอกสาร: แบบแปลน');

    await uploadUi(page, 'upload-input-plan', testFile('plan-as-jpg.jpg'));
    await expect(page.getByTestId('upload-error')).toHaveText(MSG.PLAN_NOT_PDF);
    await expect(items).toHaveCount(2);
    await expect(missing).toHaveText('ยังขาดเอกสาร: แบบแปลน');
    await expect(toPay).toBeDisabled();

    await uploadUi(page, 'upload-input-plan', testFile('plan.pdf'));
    await expect(items).toHaveCount(3);
    await expect(toPay).toBeEnabled();
    await expect(missing).toBeHidden();
  });

  await test.step('API: SV-03 ขาดแบบแปลน → 409 MISSING_DOCS · แนบครบ → 201', async () => {
    const d = await createDraftApi(c.api, 'SV-03', { areaSqm: 100 });
    await expectStatus(await uploadApi(c.api, d.draftId, 'id-card', 'id-card.pdf'), 201);
    await expectStatus(await uploadApi(c.api, d.draftId, 'deed', 'deed.pdf'), 201);
    const b = await expectApiError(await c.api.post(`/api/drafts/${d.draftId}/payment`), 409, 'MISSING_DOCS');
    expect(b?.missing).toEqual(['แบบแปลน']);
    await expectStatus(await uploadApi(c.api, d.draftId, 'plan', 'plan.pdf'), 201);
    await expectStatus(await c.api.post(`/api/drafts/${d.draftId}/payment`), 201);
  });
});

test('TC-SUBMIT-03 ร่าง และการยกเลิก', async ({ browser }) => {
  await test.step('ส่วน A ร่าง', async () => {
    await RESET();
    const c = await LOGIN_C(ID.SOMCHAI, browser);
    const page = c.page;
    await page.goto('/citizen');
    await expect(page.getByTestId('my-case-row')).toHaveCount(10);
    const drafts = page.getByTestId('my-draft-row');
    await expect(drafts).toHaveCount(2);
    await expect(rowBy(page, 'my-draft-row', 'data-draft-id', DR(1))).toHaveAttribute('data-status', 'DRAFT');
    await expect(rowBy(page, 'my-draft-row', 'data-draft-id', DR(2))).toHaveAttribute('data-status', 'PENDING_PAYMENT');
    for (const t of await drafts.allTextContents()) expect(t, 'แถวร่างห้ามมี EG-').not.toContain('EG-');

    await rowBy(page, 'my-draft-row', 'data-draft-id', DR(1)).getByTestId('open-draft-btn').click();
    await expectPath(page, '/citizen/new/SV-01');
    await expect(page.getByTestId('qty-input')).toHaveValue('2');
    await expect(page.getByTestId('fee-total')).toHaveText('฿40');

    await page.goto('/citizen');
    await page.getByTestId('start-service-SV-01').click();
    await expectPath(page, '/citizen/new/SV-01');
    await fillAndCommit(page.getByTestId('qty-input'), '3');
    await page.getByTestId('save-draft-btn').click();
    await expect(page.getByTestId('draft-id')).toHaveText(DR(3));

    await page.goto('/citizen');
    await expect(page.getByTestId('my-case-row')).toHaveCount(10);
    expect((await myCases(c.api)).length, 'GET /api/cases items.length').toBe(10);
    expect((await myDrafts(c.api)).length, 'GET /api/drafts').toBe(3);
  });

  await test.step('ส่วน B ยกเลิก …000030', async () => {
    await RESET();
    const c = await LOGIN_C(ID.SOMCHAI, browser);
    const page = c.page;
    await page.goto(`/citizen/cases/${EG(30)}`);
    const cancelBtn = page.getByTestId('cancel-case-btn');
    await expect(cancelBtn).toHaveCount(1);
    await cancelBtn.click();
    await expect(page.getByTestId('cancel-confirm-text')).toHaveText(MSG.NO_REFUND);
    await page.getByTestId('confirm-cancel-btn').click();
    await expectCaseStatus(page, 'CANCELLED');
    await expect(page.getByTestId('no-refund-note')).toHaveText(MSG.NO_REFUND);
    await expect(cancelBtn).toHaveCount(0);

    const o = await LOGIN_S('off.reg1', browser);
    await o.page.goto('/officer/queue');
    await expect(o.page.getByTestId('queue-row')).toHaveCount(16);
    await expect(queueRow(o.page, EG(30))).toHaveCount(0);

    const e = await LOGIN_S('exec1', browser);
    await e.page.goto('/dashboard');
    await expect(e.page.getByTestId('kpi-backlog')).toHaveText('20');
    await expect(e.page.getByTestId('kpi-received')).toHaveText('3');
  });

  await test.step('ส่วน C ยกเลิกไม่ได้เมื่อมีผู้รับ', async () => {
    await RESET();
    const o = await LOGIN_S('off.reg1');
    await expectStatus(await claimApi(o.api, EG(30)), 200, 'off.reg1 claim …000030');
    const c = await LOGIN_C(ID.SOMCHAI, browser);
    await c.page.goto(`/citizen/cases/${EG(30)}`);
    await expectCaseStatus(c.page, 'IN_REVIEW');
    await expect(c.page.getByTestId('cancel-case-btn')).toHaveCount(0);
    await expectApiError(await c.api.post(`/api/cases/${EG(30)}/cancel`), 409, 'CANNOT_CANCEL', MSG.CANNOT_CANCEL);
    await expectApiError(await c.api.post(`/api/cases/${EG(13)}/cancel`), 409, 'CANNOT_CANCEL');
  });

  await test.step('ส่วน E ลบร่าง', async () => {
    await RESET();
    const c = await LOGIN_C(ID.SOMCHAI, browser);
    await expectStatus(await c.api.delete(`/api/drafts/${DR(1)}`), 204, 'DELETE DR-0001');
    await expectStatus(await c.api.get(`/api/drafts/${DR(1)}`), 404, 'GET DR-0001 หลังลบ');
    await c.page.goto('/citizen');
    const drafts = c.page.getByTestId('my-draft-row');
    await expect(drafts).toHaveCount(1);
    await expect(drafts.first()).toHaveAttribute('data-draft-id', DR(2));
    await expectStatus(await c.api.delete(`/api/drafts/${DR(2)}`), 204, 'DELETE DR-0002 (PENDING_PAYMENT)');
    await expectStatus(await c.api.get(`/api/payments/${PP(1)}`), 404, 'GET PP-0001 หลังลบร่าง');
    const paid = await PAY(PP(1), 500);
    expect(paid.status, `pay PP-0001 หลังลบร่าง ${JSON.stringify(paid.body)}`).toBe(404);
  });

  await test.step('ส่วน F ยกเลิกชนกับรับเรื่อง (พร้อมกัน)', async () => {
    await RESET();
    const c = await LOGIN_C(ID.SOMCHAI);
    const o = await LOGIN_S('off.reg1');
    const [cancel, claim] = await Promise.all([c.api.post(`/api/cases/${EG(30)}/cancel`), claimApi(o.api, EG(30))]);
    const cs = cancel.status();
    const ks = claim.status();
    expect([cs, ks].filter((s) => s === 200).length, `cancel=${cs} claim=${ks} ต้องสำเร็จฝั่งเดียว`).toBe(1);
    const after = await getCase(o.api, EG(30));
    const mine = await queueApi(o.api, 'mine');
    if (cs === 200) {
      await expectApiError(claim, 409, 'INVALID_STATE', undefined, 'claim แพ้');
      expect(after.status).toBe('CANCELLED');
      expect(after.owner ?? null, 'ยกเลิกชนะ: ไม่มีผู้ถือ').toBeFalsy();
      expect(mine.length, 'off.reg1 งานในมือยัง 3').toBe(3);
    } else {
      await expectApiError(cancel, 409, 'CANNOT_CANCEL', undefined, 'cancel แพ้');
      expect(after.status).toBe('IN_REVIEW');
      expect(after.owner).toBe('off.reg1');
      expect(mine.length, 'off.reg1 งานในมือ 4').toBe(4);
    }
  });
});

// ═════════════════════════════ UPLOAD ═════════════════════════════

test('TC-UPLOAD-01 ขนาดและจำนวนไฟล์', async ({ browser }) => {
  test.setTimeout(420_000);
  await RESET();
  const c = await LOGIN_C(ID.SOMCHAI, browser);
  const page = c.page;
  await openUploadStep(page, 'SV-01', '1');
  const items = page.getByTestId('file-item');
  const err = page.getByTestId('upload-error');

  for (const [name, size] of [
    ['size-5242879.pdf', 5242879],
    ['size-5242880.pdf', 5242880],
  ] as Array<[string, number]>) {
    await test.step(`${name} → รับ · 201`, async () => {
      const up = await uploadUi(page, 'upload-input-id-card', testFile(name));
      // ตรวจผลอัปโหลดของหน้าก่อน: ถ้าเว็บปฏิเสธขอบ ≤ 5 MB ข้อความล้มจะบอกค่าจริง (เช่น 400 FILE_TOO_LARGE) ไม่ใช่แค่ file-item 0
      const upText = up ? (await up.text().catch(() => '')).slice(0, 300) : '(หน้าไม่ได้ส่งไฟล์)';
      expect(up?.status(), `หน้าอัปโหลด ${name} (${size} ไบต์ ≤ 5,242,880 ต้องรับ) → ${up?.status() ?? '-'} ${upText}`).toBe(201);
      await expect(items).toHaveCount(1);
      await expect(err).toBeHidden();
      const d = await createDraftApi(c.api, 'SV-01', { qty: 1 });
      const b = await expectStatus(await uploadApi(c.api, d.draftId, 'id-card', name), 201, `API ${name}`);
      expect(b?.size, 'ไฟล์ไม่ถูกตัด').toBe(size);
      await removeFileUi(page, items.first());
      await expect(items).toHaveCount(0);
    });
  }

  await test.step('size-5242881.pdf → ไฟล์ใหญ่เกิน 5 MB · 400 FILE_TOO_LARGE', async () => {
    await uploadUi(page, 'upload-input-id-card', testFile('size-5242881.pdf'));
    await expect(err).toHaveText(MSG.FILE_TOO_LARGE);
    await expect(items).toHaveCount(0);
    const d = await createDraftApi(c.api, 'SV-01', { qty: 1 });
    await expectApiError(
      await uploadApi(c.api, d.draftId, 'id-card', 'size-5242881.pdf'),
      400,
      'FILE_TOO_LARGE',
      MSG.FILE_TOO_LARGE,
    );
  });

  await test.step('จำนวน: 5 ไฟล์รับ · ไฟล์ที่ 6 ปฏิเสธ · ลบ 1 แล้วแนบได้', async () => {
    await uploadUi(page, 'upload-input-id-card', testFile('id-card.pdf'));
    await expect(items).toHaveCount(1);
    for (let i = 1; i <= 4; i++) {
      await uploadUi(page, 'upload-input-extra', testFile(`multi-${i}.pdf`));
      await expect(items).toHaveCount(1 + i);
    }
    await expect(items).toHaveCount(5);

    await uploadUi(page, 'upload-input-extra', testFile('multi-5.pdf'));
    await expect(err).toHaveText(MSG.FILE_COUNT);
    await expect(items).toHaveCount(5);

    const d = await createDraftApi(c.api, 'SV-01', { qty: 1 });
    await expectStatus(await uploadApi(c.api, d.draftId, 'id-card', 'id-card.pdf'), 201);
    for (let i = 1; i <= 4; i++) {
      await expectStatus(await uploadApi(c.api, d.draftId, 'extra', `multi-${i}.pdf`), 201, `API multi-${i}`);
    }
    await expectApiError(await uploadApi(c.api, d.draftId, 'extra', 'multi-5.pdf'), 400, 'FILE_COUNT', MSG.FILE_COUNT);

    await removeFileUi(page, rowBy(page, 'file-item', 'data-name', 'multi-1.pdf'));
    await expect(items).toHaveCount(4);
    await uploadUi(page, 'upload-input-extra', testFile('multi-5.pdf'));
    await expect(items).toHaveCount(5);
    await expect(rowBy(page, 'file-item', 'data-name', 'multi-5.pdf')).toHaveCount(1);
  });
});

test('TC-UPLOAD-02 ชนิดไฟล์จากเนื้อไฟล์', async ({ browser }) => {
  await RESET();
  const c = await LOGIN_C(ID.SOMCHAI, browser);
  const page = c.page;
  await openUploadStep(page, 'SV-01', '1');
  const items = page.getByTestId('file-item');
  const err = page.getByTestId('upload-error');

  for (const name of ['ok-id.pdf', 'real.jpg', 'real.png']) {
    await test.step(`${name} → รับ · 201`, async () => {
      await uploadUi(page, 'upload-input-id-card', testFile(name));
      await expect(items).toHaveCount(1);
      const d = await createDraftApi(c.api, 'SV-01', { qty: 1 });
      await expectStatus(await uploadApi(c.api, d.draftId, 'id-card', name), 201, `API ${name}`);
      await removeFileUi(page, items.first());
      await expect(items).toHaveCount(0);
    });
  }

  // ร่าง API สำหรับนับไฟล์: มีไฟล์ที่รับแล้ว 1 ไฟล์ แล้วไฟล์ที่ถูกปฏิเสธต้องไม่ทำให้จำนวนเพิ่ม
  const apiDraft = await createDraftApi(c.api, 'SV-01', { qty: 1 });
  await expectStatus(await uploadApi(c.api, apiDraft.draftId, 'id-card', 'ok-id.pdf'), 201);
  const baseCount = await draftFileCount(c.api, apiDraft.draftId);
  expect(baseCount).toBe(1);

  const rejected: Array<[string, string | undefined, string]> = [
    ['fake-text.pdf', undefined, 'ข้อความ นามสกุล .pdf'],
    ['fake-text.jpg', undefined, 'ข้อความ นามสกุล .jpg'],
    ['exe-as.png', undefined, 'หัวไฟล์ MZ'],
    ['notes.txt', undefined, 'ข้อความ .txt'],
    ['fake-text.pdf', 'application/pdf', 'ส่ง mimeType application/pdf (ไม่เชื่อ Content-Type)'],
  ];
  for (const [name, mime, why] of rejected) {
    await test.step(`${name} (${why}) → ปฏิเสธ · 400 FILE_TYPE`, async () => {
      await uploadUi(page, 'upload-input-id-card', testFile(name, mime));
      await expect(err).toHaveText(MSG.FILE_TYPE);
      await expect(items).toHaveCount(0);
      await expectApiError(
        await uploadApi(c.api, apiDraft.draftId, 'id-card', name, mime),
        400,
        'FILE_TYPE',
        MSG.FILE_TYPE,
      );
      expect(await draftFileCount(c.api, apiDraft.draftId), 'GET /api/drafts/:id จำนวนไฟล์ไม่เพิ่ม').toBe(baseCount);
    });
  }
  await expect(items).toHaveCount(0);
});

// ═════════════════════════════ PAY ═════════════════════════════

test('TC-PAY-01 อายุ QR 15:00', async ({ browser }) => {
  const rounds: Array<{ n: number; clock?: string; age: string; ok: boolean }> = [
    { n: 1, age: '5:00', ok: true },
    { n: 2, clock: '2026-12-01T09:09:59+07:00', age: '14:59', ok: true },
    { n: 3, clock: '2026-12-01T09:10:00+07:00', age: '15:00', ok: false },
    { n: 4, clock: '2026-12-01T09:10:01+07:00', age: '15:01', ok: false },
  ];
  for (const r of rounds) {
    await test.step(`รอบ ${r.n} อายุ ${r.age} → ${r.ok ? '200 PAID' : '410 QR_EXPIRED'}`, async () => {
      await RESET();
      if (r.clock) await CLOCK(r.clock);
      const c = r.n === 3 ? await LOGIN_C(ID.SOMCHAI, browser) : await LOGIN_C(ID.SOMCHAI);
      const paid = await PAY(PP(1), 500);
      if (r.ok) {
        expect(paid.status, JSON.stringify(paid.body)).toBe(200);
        expect(paid.body).toMatchObject({ status: 'PAID', caseNo: EG(31) });
        return;
      }
      expect(paid.status, JSON.stringify(paid.body)).toBe(410);
      expect(paid.body?.code).toBe('QR_EXPIRED');
      if (r.n !== 3) return;

      const p = await expectStatus(await c.api.get(`/api/payments/${PP(1)}`), 200);
      expect(p?.status).toBe('EXPIRED');
      expect((await myCases(c.api)).length, 'GET /api/cases ยัง 10 (ไม่ออกเลข)').toBe(10);

      // รอบ 3 บนจอ
      const page = (c as UiActor).page;
      await page.goto(`/citizen/new/SV-02?draft=${DR(2)}`);
      await expect(page.getByTestId('qr-expired-msg')).toHaveText(MSG.QR_EXPIRED);
      await expect(page.getByTestId('payment-status')).toHaveText('QR หมดอายุ');
      await expect(page.getByTestId('payment-status')).toHaveAttribute('data-status', 'EXPIRED');
      const regen = page.getByTestId('regenerate-qr-btn');
      await expect(regen).toHaveCount(1);
      await regen.click();
      await expect(page.getByTestId('qr-ref')).toHaveText(PP(2));
      await expect(page.getByTestId('qr-expires')).toHaveAttribute('data-iso', '2026-12-01T09:25:00+07:00');
      const p2 = await PAY(PP(2), 500);
      expect(p2.status, JSON.stringify(p2.body)).toBe(200);
      expect(p2.body?.caseNo).toBe(EG(31));
    });
  }
});

test('TC-PAY-02 ยอดเงินและ callback ซ้ำ', async () => {
  await RESET();
  const np = await NEW_PAID(ID.SOMCHAI, 'SV-01', undefined, { qty: 1, pay: false });
  expect(np.ref).toBe(PP(2));
  expect(np.fee).toBe(20);
  const api = np.actor.api;
  const payStatus = async () => (await expectStatus(await api.get(`/api/payments/${PP(2)}`), 200))?.status;

  await test.step('1 ฿19 → 422 AMOUNT_MISMATCH', async () => {
    const r = await PAY(PP(2), 19);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body?.code).toBe('AMOUNT_MISMATCH');
    expect(await payStatus()).toBe('PENDING');
    expect((await myCases(api)).length).toBe(10);
  });
  await test.step('2 ฿21 → 422', async () => {
    const r = await PAY(PP(2), 21);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(await payStatus()).toBe('PENDING');
  });
  await test.step('3 ฿20 → 200 PAID EG-2569-000031', async () => {
    const r = await PAY(PP(2), 20);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'PAID', caseNo: EG(31), receiptNo: RC(31) });
    expect((await myCases(api)).length).toBe(11);
  });
  await test.step('4 ฿20 ซ้ำ → 200 duplicate:true เลขเดิม', async () => {
    const r = await PAY(PP(2), 20);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ duplicate: true, caseNo: EG(31), receiptNo: RC(31) });
    expect((await myCases(api)).length).toBe(11);
  });
  await test.step('5 ร่างใหม่ SV-01 qty 1 → EG-2569-000032', async () => {
    const np2 = await NEW_PAID(ID.SOMCHAI, 'SV-01', undefined, { qty: 1, actor: np.actor });
    expect(np2.caseNo).toBe(EG(32));
    expect(np2.receiptNo).toBe(RC(32));
  });
});

test('TC-PAY-03 ชำระพร้อมกัน เลขไม่ซ้ำ', async () => {
  await RESET();
  const somchai = await LOGIN_C(ID.SOMCHAI);
  const somying = await LOGIN_C(ID.SOMYING);
  const plan: Array<[Actor, 'สมชาย' | 'สมหญิง']> = [
    [somchai, 'สมชาย'],
    [somchai, 'สมชาย'],
    [somchai, 'สมชาย'],
    [somying, 'สมหญิง'],
    [somying, 'สมหญิง'],
    [somying, 'สมหญิง'],
  ];
  const refs: Array<{ ref: string; who: 'สมชาย' | 'สมหญิง' }> = [];
  for (const [actor, who] of plan) {
    const np = await NEW_PAID(actor.who, 'SV-01', undefined, { qty: 1, actor, pay: false });
    refs.push({ ref: np.ref, who });
  }
  expect(refs.map((r) => r.ref).sort()).toEqual([2, 3, 4, 5, 6, 7].map(PP));

  const bank = await newApi();
  const res = await Promise.all(refs.map((r) => bank.post(`/api/test/payments/${r.ref}/pay`, { data: { amount: 20 } })));
  const bodies = await Promise.all(res.map((r) => r.json().catch(() => null)));
  res.forEach((r, i) => expect(r.status(), `${refs[i].ref} ${JSON.stringify(bodies[i])}`).toBe(200));

  const caseNos = bodies.map((b) => b?.caseNo as string);
  const receiptNos = bodies.map((b) => b?.receiptNo as string);
  expect(new Set(caseNos).size, 'caseNo ไม่ซ้ำ 6 ค่า').toBe(6);
  expect([...caseNos].sort()).toEqual([31, 32, 33, 34, 35, 36].map((n) => EG(n)));
  expect([...receiptNos].sort()).toEqual([31, 32, 33, 34, 35, 36].map((n) => RC(n)));

  for (const [actor, who] of [
    [somchai, 'สมชาย'],
    [somying, 'สมหญิง'],
  ] as Array<[Actor, string]>) {
    const expected = caseNos.filter((_, i) => refs[i].who === who).sort();
    const got = (await myCases(actor.api)).map((i) => i.caseNo as string).filter((n) => caseNos.includes(n)).sort();
    expect(got, `GET /api/cases ของ${who} มี 3 เลขใหม่`).toEqual(expected);
    expect(got).toHaveLength(3);
  }

  const next = await NEW_PAID(ID.SOMCHAI, 'SV-01', undefined, { qty: 1, actor: somchai });
  expect(next.caseNo).toBe(EG(37));
});

test('TC-PAY-04 เลขคำขอข้ามปี', async ({ browser }) => {
  await RESET();
  const c = await LOGIN_C(ID.SOMCHAI, browser);
  const page = c.page;

  await test.step('1 31 ธ.ค. 23:58 สร้างร่าง SV-01 + QR → ยังไม่มีเลขคำขอ', async () => {
    await CLOCK('2026-12-31T23:58:00+07:00');
    await openUploadStep(page, 'SV-01', '1');
    await uploadUi(page, 'upload-input-id-card', testFile('id-card.pdf'));
    await expect(page.getByTestId('file-item')).toHaveCount(1);
    await page.getByTestId('to-payment-btn').click();
    await expect(page.getByTestId('wizard-step')).toHaveText('3/3 ชำระเงิน');
    await page.getByTestId('create-qr-btn').click();
    await expect(page.getByTestId('qr-ref')).toHaveText(PP(2));
    expect((await myCases(c.api)).length).toBe(10);
    const p = await expectStatus(await c.api.get(`/api/payments/${PP(2)}`), 200);
    expect(p?.status).toBe('PENDING');
    expect(p?.caseNo ?? null).toBeFalsy();
  });

  await test.step('2 23:59 ชำระ ฿20 → EG-2569-000031', async () => {
    await CLOCK('2026-12-31T23:59:00+07:00');
    const r = await PAY(PP(2), 20);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ caseNo: EG(31), receiptNo: RC(31) });
    await page.getByTestId('refresh-payment-btn').click();
    await expect(page.getByTestId('receipt-paid-at')).toHaveAttribute('data-iso', '2026-12-31T23:59:00+07:00');
  });

  await test.step('3 1 ม.ค. 2570 00:00 → EG-2570-000001', async () => {
    const np = await NEW_PAID(ID.SOMCHAI, 'SV-01', '2027-01-01T00:00:00+07:00', { qty: 1, actor: c });
    expect(np.caseNo).toBe(EG(1, 2570));
    expect(np.receiptNo).toBe(RC(1, 2570));
  });

  await test.step('4 อีกใบที่ 2027-01-01T00:00:00 → EG-2570-000002', async () => {
    const np = await NEW_PAID(ID.SOMCHAI, 'SV-01', undefined, { qty: 1, actor: c });
    expect(np.caseNo).toBe(EG(2, 2570));
  });

  await test.step('5 GET /api/cases/EG-2569-000031 ยังเป็นเลขเดิม', async () => {
    const k = await getCase(c.api, EG(31));
    expect(k.caseNo).toBe(EG(31));
  });
});

// ═════════════════════════════ QUEUE ═════════════════════════════

test('TC-QUEUE-01 ลำดับคิวและขอบเขตแผนก', async ({ browser }) => {
  const REG_ORDER = [20, 22, 24, 23, 25, 26, 13, 15, 27, 28, 29, 30, 16, 18, 19, 12, 21].map((n) => EG(n));
  const NOT_IN_QUEUE = [17, 11, 14, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => EG(n));
  await RESET();

  await test.step('off.reg1 · filter all 17 แถว', async () => {
    const r1 = await LOGIN_S('off.reg1', browser);
    const page = r1.page;
    await page.goto('/officer/queue');
    await expect(page.getByTestId('queue-filter')).toHaveValue('all');
    const rows = page.getByTestId('queue-row');
    await expect(rows).toHaveCount(17);
    expect(await queueOrder(page)).toEqual(REG_ORDER);

    const lv = rows.getByTestId('row-sla-level');
    await expect(lv.nth(0)).toHaveText(LEVEL_TH.overdue);
    await expect(lv.nth(1)).toHaveText(LEVEL_TH.near);
    await expect(lv.nth(2)).toHaveText(LEVEL_TH.near);

    const masks = await rows.getByTestId('row-id-masked').allTextContents();
    expect(masks).toHaveLength(17);
    for (const m of masks) expect(m.trim()).toMatch(/^X-XXXX-XXXXX-\d{2}-\d$/);

    await expect(page.getByTestId('claim-btn')).toHaveCount(4);
    for (const n of [24, 28, 29, 30]) await expect(queueRow(page, EG(n)).getByTestId('claim-btn')).toHaveCount(1);
    await expect(queueRow(page, EG(19)).getByTestId('claim-btn')).toHaveCount(0);

    const order = await queueOrder(page);
    for (const n of NOT_IN_QUEUE) expect(order, `${n} ต้องไม่อยู่ในคิว`).not.toContain(n);

    await page.getByTestId('queue-filter').selectOption('unclaimed');
    await expect.poll(() => queueOrder(page)).toEqual([24, 28, 29, 30].map((n) => EG(n)));
    await page.getByTestId('queue-filter').selectOption('mine');
    await expect.poll(() => queueOrder(page)).toEqual([20, 22, 23].map((n) => EG(n)));
    await expect(page.getByTestId('workload-count')).toHaveText('3');
  });

  await test.step('off.reg2 · mine 9 แถว', async () => {
    const r2 = await LOGIN_S('off.reg2', browser);
    await r2.page.goto('/officer/queue');
    await r2.page.getByTestId('queue-filter').selectOption('mine');
    await expect
      .poll(() => queueOrder(r2.page))
      .toEqual([25, 26, 13, 15, 27, 16, 18, 12, 21].map((n) => EG(n)));
    await expect(r2.page.getByTestId('workload-count')).toHaveText('9');
  });

  await test.step('off.works1 เห็น 1 แถว …000010', async () => {
    const w = await LOGIN_S('off.works1', browser);
    await w.page.goto('/officer/queue');
    await expect.poll(() => queueOrder(w.page)).toEqual([EG(10)]);
  });

  await test.step('head1 เห็น 18 แถว ไม่มี claim-btn', async () => {
    const h = await LOGIN_S('head1', browser);
    await h.page.goto('/officer/queue');
    await expect(h.page.getByTestId('queue-row')).toHaveCount(18);
    const order = await queueOrder(h.page);
    expect([...order].sort()).toEqual([...REG_ORDER, EG(10)].sort());
    const i10 = order.indexOf(EG(10));
    expect(order.slice(i10, i10 + 4), 'กลุ่ม 3 ธ.ค.').toEqual([10, 23, 25, 26].map((n) => EG(n)));
    await expect(h.page.getByTestId('claim-btn')).toHaveCount(0);
    for (const n of NOT_IN_QUEUE) expect(order).not.toContain(n);
  });
});

test('TC-QUEUE-02 รับเรื่องซ้อน (พร้อมกันและต่อกัน)', async ({ browser }) => {
  await test.step('ส่วน 1 พร้อมกันผ่านหน้าจอ (…000028)', async () => {
    await RESET();
    const A = await LOGIN_S('off.reg1', browser);
    const B = await LOGIN_S('off.reg2', browser);
    await Promise.all([A.page.goto('/officer/queue'), B.page.goto('/officer/queue')]);
    const btnA = queueRow(A.page, EG(28)).getByTestId('claim-btn');
    const btnB = queueRow(B.page, EG(28)).getByTestId('claim-btn');
    await expect(btnA).toBeVisible();
    await expect(btnB).toBeVisible();
    // เก็บผล POST …/claim ของทั้งสองหน้า: การ์ดกำหนดสำเร็จ 1 คน · อีกคน HTTP 409 ALREADY_CLAIMED
    // (ตรวจรหัสก่อนหน้าจอ เพื่อให้ข้อความล้มบอกค่าจริง เช่น [200,200] เมื่อเปิด B08)
    const claimRes = (p: Page) =>
      p.waitForResponse(
        (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/officer/cases/${EG(28)}/claim`,
        { timeout: 15_000 },
      );
    const [resA, resB] = await Promise.all([claimRes(A.page), claimRes(B.page), btnA.click(), btnB.click()]);
    const codes = [resA.status(), resB.status()];
    expect([...codes].sort(), `claim พร้อมกัน: off.reg1 → ${codes[0]} · off.reg2 → ${codes[1]} (ต้องสำเร็จคนเดียว อีกคน 409)`).toEqual([
      200, 409,
    ]);
    const loseBody = JSON.parse(await (codes[0] === 409 ? resA : resB).text());
    expect(loseBody, 'claim ที่แพ้ → 409 ALREADY_CLAIMED').toMatchObject({ code: 'ALREADY_CLAIMED', message: MSG.ALREADY_CLAIMED });

    let owner = '';
    await expect
      .poll(async () => {
        owner = (await getCase(A.api, EG(28))).owner ?? '';
        return owner;
      })
      .not.toBe('');
    expect(owner, 'owner = คนที่ได้ 200').toBe(codes[0] === 200 ? 'off.reg1' : 'off.reg2');
    expect((await getCase(A.api, EG(28))).status).toBe('IN_REVIEW');
    const [win, lose] = owner === 'off.reg1' ? [A, B] : [B, A];
    await expect(lose.page.getByTestId('action-error')).toHaveText(MSG.ALREADY_CLAIMED);

    await win.page.goto('/officer/queue');
    const row = queueRow(win.page, EG(28));
    await expect(row).toHaveAttribute('data-owner', owner);
    await expect(row.getByTestId('row-owner'), 'row-owner = ชื่อผู้ชนะ').toHaveText(
      new RegExp(`^(?:${esc(owner)}|${esc(STAFF[owner as StaffUser].name)})$`),
    );
    expect(await claimAuditRows(EG(28)), 'Audit CLAIM ของ …000028').toBe(1);
  });

  await test.step('ส่วน 2 API 10 ครั้งพร้อมกัน (…000029)', async () => {
    await RESET();
    const A = await LOGIN_S('off.reg1');
    const B = await LOGIN_S('off.reg2');
    const shooters = [A, B, A, B, A, B, A, B, A, B];
    const res = await Promise.all(shooters.map((s) => claimApi(s.api, EG(29))));
    const ok = res.map((r, i) => ({ r, who: shooters[i].who })).filter((x) => x.r.status() === 200);
    expect(ok.length, `สถานะ: ${res.map((r) => r.status()).join(',')}`).toBe(1);
    for (const r of res.filter((x) => x.status() !== 200)) await expectApiError(r, 409, 'ALREADY_CLAIMED');
    expect((await getCase(A.api, EG(29))).owner).toBe(ok[0].who);
    expect(await claimAuditRows(EG(29)), 'Audit CLAIM ของ …000029').toBe(1);
  });

  await test.step('ส่วน 3 ต่อกัน (…000029)', async () => {
    await RESET();
    const A = await LOGIN_S('off.reg1');
    const B = await LOGIN_S('off.reg2', browser);
    const b1 = await expectStatus(await claimApi(A.api, EG(29)), 200, 'off.reg1 claim');
    expect(b1?.owner).toBe('off.reg1');
    await expectApiError(await claimApi(B.api, EG(29)), 409, 'ALREADY_CLAIMED', MSG.ALREADY_CLAIMED, 'off.reg2 claim');
    expect((await getCase(A.api, EG(29))).owner).toBe('off.reg1');
    await expect(await workloadUi(B.page)).toHaveText('9');
    await expectStatus(await claimApi(A.api, EG(29)), 409, 'off.reg1 claim ซ้ำเอง');
    expect(await claimAuditRows(EG(29)), 'Audit CLAIM ของ …000029').toBe(1);
  });
});

test('TC-QUEUE-03 งานในมือสูงสุด 10', async ({ browser }) => {
  await RESET();
  const r2 = await LOGIN_S('off.reg2', browser);
  const page = r2.page;

  await test.step('1 workload-count = 9', async () => {
    await expect(await workloadUi(page)).toHaveText('9');
  });

  await test.step('2 claim …000028 (ครั้งที่ 10) → 10', async () => {
    await queueRow(page, EG(28)).getByTestId('claim-btn').click();
    await expect.poll(async () => (await getCase(r2.api, EG(28))).owner).toBe('off.reg2');
    await expect(await workloadUi(page)).toHaveText('10');
  });

  await test.step('3 claim …000029 (ครั้งที่ 11) → รับงานได้สูงสุด 10 เรื่อง', async () => {
    // ตรวจ HTTP ของคำขอที่ปุ่มบนจอยิงจริง (การ์ด: API 409 WORKLOAD_LIMIT)
    const [uiRes] = await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/officer/cases/${EG(29)}/claim`,
      ),
      queueRow(page, EG(29)).getByTestId('claim-btn').click(),
    ]);
    await expectApiError(uiRes, 409, 'WORKLOAD_LIMIT', MSG.WORKLOAD_LIMIT, 'claim จากปุ่ม');
    await expect(page.getByTestId('action-error')).toHaveText(MSG.WORKLOAD_LIMIT);
    const k = await getCase(r2.api, EG(29));
    expect(k.status).toBe('SUBMITTED');
    expect(k.owner ?? null, '…000029 ไม่มีผู้รับ').toBeFalsy();
    await expect(await workloadUi(page)).toHaveText('10');
  });

  await test.step('4 อนุมัติ …000025 (→ APPROVED) → 9', async () => {
    await page.goto(`/officer/cases/${EG(25)}`);
    await page.getByTestId('approve-btn').click();
    await expect.poll(async () => (await getCase(r2.api, EG(25))).status).toBe('APPROVED');
    await expect(await workloadUi(page)).toHaveText('9');
  });

  await test.step('5 claim …000029 อีกครั้ง → 10', async () => {
    await queueRow(page, EG(29)).getByTestId('claim-btn').click();
    await expect.poll(async () => (await getCase(r2.api, EG(29))).owner).toBe('off.reg2');
    await expect(await workloadUi(page)).toHaveText('10');
  });

  await test.step('6 off.reg1 (งานในมือ 3) claim …000030 → สำเร็จ', async () => {
    const r1 = await LOGIN_S('off.reg1');
    await expectStatus(await claimApi(r1.api, EG(30)), 200);
  });

  await test.step('7–10 RESET · NEED_FIX ไม่นับ · ส่งแก้คืนผู้ถือเดิมแม้เกิน 10', async () => {
    await RESET();
    const reg2 = await LOGIN_S('off.reg2', browser);
    const p = reg2.page;

    // 7 ตีกลับ …000025
    await p.goto(`/officer/cases/${EG(25)}`);
    await p.getByTestId('return-btn').click();
    await p.getByTestId('return-reason').fill('xxxxxxxxxx');
    await p.getByTestId('return-submit').click();
    await expectCaseStatus(p, 'NEED_FIX');
    await expect(await workloadUi(p)).toHaveText('8');

    // 8
    await expectStatus(await claimApi(reg2.api, EG(28)), 200, 'claim …000028');
    await expectStatus(await claimApi(reg2.api, EG(29)), 200, 'claim …000029');
    await expect(await workloadUi(p)).toHaveText('10');

    // 9 สมหญิงส่งแก้ไข
    const sy = await LOGIN_C(ID.SOMYING, browser);
    await sy.page.goto(`/citizen/cases/${EG(25)}`);
    await sy.page.getByTestId('submit-fix-btn').click();
    await expectCaseStatus(sy.page, 'IN_REVIEW');
    await expect(sy.page.getByTestId('action-error')).toBeHidden();
    expect((await getCase(reg2.api, EG(25))).owner).toBe('off.reg2');
    await expect(await workloadUi(p)).toHaveText('11');

    // 10
    await expectApiError(await claimApi(reg2.api, EG(30)), 409, 'WORKLOAD_LIMIT', MSG.WORKLOAD_LIMIT);
    await expect(await workloadUi(p)).toHaveText('11');
  });
});

// ═════════════════════════════ SLA ═════════════════════════════

test('TC-SLA-01 กำหนดเสร็จตามตารางวันที่', async ({ browser }) => {
  const rows: Array<{ k: string; svc: ServiceId; at: string; due: string; text?: string; areaSqm?: number }> = [
    { k: 'a', svc: 'SV-01', at: '2026-12-01T09:00:00+07:00', due: '2026-12-04T16:30:00+07:00', text: '4 ธ.ค. 2569 16:30' },
    { k: 'b', svc: 'SV-01', at: '2026-12-01T16:29:00+07:00', due: '2026-12-04T16:30:00+07:00' },
    { k: 'c', svc: 'SV-01', at: '2026-12-01T16:30:00+07:00', due: '2026-12-08T16:30:00+07:00', text: '8 ธ.ค. 2569 16:30' },
    { k: 'd', svc: 'SV-01', at: '2026-12-04T10:00:00+07:00', due: '2026-12-11T16:30:00+07:00', text: '11 ธ.ค. 2569 16:30' },
    { k: 'e', svc: 'SV-01', at: '2026-12-05T10:00:00+07:00', due: '2026-12-14T16:30:00+07:00', text: '14 ธ.ค. 2569 16:30' },
    { k: 'f', svc: 'SV-02', at: '2026-12-01T09:00:00+07:00', due: '2026-12-17T16:30:00+07:00' },
    { k: 'g', svc: 'SV-03', at: '2026-12-01T09:00:00+07:00', due: '2026-12-24T16:30:00+07:00', areaSqm: 100 },
    { k: 'h', svc: 'SV-01', at: '2026-12-29T10:00:00+07:00', due: '2027-01-05T16:30:00+07:00', text: '5 ม.ค. 2570 16:30' },
    { k: 'i', svc: 'SV-01', at: '2026-12-31T23:59:00+07:00', due: '2027-01-07T16:30:00+07:00', text: '7 ม.ค. 2570 16:30' },
  ];
  for (const r of rows) {
    await test.step(`แถว ${r.k}: ${r.svc} ชำระ ${r.at} → ${r.due}`, async () => {
      await RESET();
      const np = await NEW_PAID(ID.SOMCHAI, r.svc, r.at, { browser, areaSqm: r.areaSqm });
      expect(np.caseNo).toBe(EG(31));
      expect.soft((await getCase(np.actor.api, EG(31))).dueAt, `แถว ${r.k} dueAt`).toBe(r.due);
      const page = (np.actor as UiActor).page;
      await page.goto(`/citizen/cases/${EG(31)}`);
      const due = page.getByTestId('sla-due');
      await expect.soft(due, `แถว ${r.k} sla-due data-iso`).toHaveAttribute('data-iso', r.due);
      if (r.text) await expect.soft(due, `แถว ${r.k} sla-due ข้อความ`).toHaveText(r.text);
    });
  }
});

test('TC-SLA-02 หยุดนับ SLA ระหว่างรอแก้ไข', async ({ browser }) => {
  await test.step('ส่วน 1: ตีกลับ 2 ธ.ค. 11:00 ส่งแก้ 3 ธ.ค. 10:00 → 8 ธ.ค.', async () => {
    await RESET();
    const np = await NEW_PAID(ID.SOMCHAI, 'SV-01', T0, { browser });
    expect(np.caseNo).toBe(EG(31));
    const somchai = np.actor as UiActor;
    expect((await getCase(somchai.api, EG(31))).dueAt).toBe('2026-12-04T16:30:00+07:00');

    await CLOCK('2026-12-02T11:00:00+07:00');
    const r1 = await LOGIN_S('off.reg1', browser);
    await expectStatus(await claimApi(r1.api, EG(31)), 200, 'claim');
    const ret = await expectStatus(await returnApi(r1.api, EG(31), 'xxxxxxxxxx'), 200, 'return');
    expect(ret).toMatchObject({ status: 'NEED_FIX', returnCount: 1 });
    await r1.page.goto(`/officer/cases/${EG(31)}`);
    await expectCaseStatus(r1.page, 'NEED_FIX');

    await somchai.page.goto(`/citizen/cases/${EG(31)}`);
    await expectLevel(somchai.page.getByTestId('sla-level'), 'paused');
    await expect(somchai.page.getByTestId('fix-deadline')).toHaveAttribute('data-iso', '2026-12-09T11:00:00+07:00');

    await CLOCK('2026-12-03T10:00:00+07:00');
    await somchai.page.goto(`/citizen/cases/${EG(31)}`);
    await somchai.page.getByTestId('submit-fix-btn').click();
    await expectCaseStatus(somchai.page, 'IN_REVIEW');

    expect((await getCase(somchai.api, EG(31))).dueAt).toBe('2026-12-08T16:30:00+07:00');
    await somchai.page.goto(`/citizen/cases/${EG(31)}`);
    await expect(somchai.page.getByTestId('sla-due')).toHaveText('8 ธ.ค. 2569 16:30');
    await expect(somchai.page.getByTestId('sla-due')).toHaveAttribute('data-iso', '2026-12-08T16:30:00+07:00');
    await expectLevel(somchai.page.getByTestId('sla-level'), 'normal');

    await r1.page.goto(`/officer/cases/${EG(31)}`);
    await expectCaseStatus(r1.page, 'IN_REVIEW');
    await expect(r1.page.getByTestId('case-owner')).toHaveText('off.reg1');
  });

  await test.step('ส่วน 2: …000017 ส่งแก้ 1 ธ.ค. 09:00 → 1 ธ.ค. 16:30 ใกล้ครบกำหนด', async () => {
    await RESET();
    const c = await LOGIN_C(ID.SOMCHAI, browser);
    await c.page.goto(`/citizen/cases/${EG(17)}`);
    await expectLevel(c.page.getByTestId('sla-level'), 'paused');
    await expect(c.page.getByTestId('sla-due')).toHaveAttribute('data-iso', '2026-11-27T16:30:00+07:00');
    await c.page.getByTestId('submit-fix-btn').click();
    await expectCaseStatus(c.page, 'IN_REVIEW');
    const k = await getCase(c.api, EG(17));
    expect(k.dueAt).toBe('2026-12-01T16:30:00+07:00');
    expect(k.slaLevel).toBe('near');
    await c.page.goto(`/citizen/cases/${EG(17)}`);
    await expectLevel(c.page.getByTestId('sla-level'), 'near');
    const r1 = await LOGIN_S('off.reg1');
    expect((await getCase(r1.api, EG(17))).owner).toBe('off.reg1');
  });

  await test.step('ส่วน 3: …000017 ส่งแก้ 4 ธ.ค. 10:00 → 4 ธ.ค. 16:30', async () => {
    await RESET();
    await CLOCK('2026-12-04T10:00:00+07:00');
    const c = await LOGIN_C(ID.SOMCHAI, browser);
    const b = await expectStatus(await resubmitApi(c.api, EG(17)), 200, 'resubmit');
    expect(b?.status).toBe('IN_REVIEW');
    const k = await getCase(c.api, EG(17));
    expect(k.dueAt).toBe('2026-12-04T16:30:00+07:00');
    expect(k.slaLevel).toBe('near');
    await c.page.goto(`/citizen/cases/${EG(17)}`);
    await expectLevel(c.page.getByTestId('sla-level'), 'near');
  });

  await test.step('ส่วน 4: ตีกลับและส่งแก้วันเดียวกัน → dueAt ไม่เปลี่ยน', async () => {
    await RESET();
    const np = await NEW_PAID(ID.SOMCHAI, 'SV-01', T0);
    expect(np.caseNo).toBe(EG(31));
    await CLOCK('2026-12-02T09:00:00+07:00');
    const r1 = await LOGIN_S('off.reg1');
    await expectStatus(await claimApi(r1.api, EG(31)), 200, 'claim');
    await expectStatus(await returnApi(r1.api, EG(31)), 200, 'return');
    await CLOCK('2026-12-02T15:00:00+07:00');
    await expectStatus(await resubmitApi(np.actor.api, EG(31)), 200, 'resubmit');
    expect((await getCase(np.actor.api, EG(31))).dueAt).toBe('2026-12-04T16:30:00+07:00');
  });

  await test.step('ส่วน 5: คร่อมสุดสัปดาห์/วันหยุด ส่งแก้ 8 ธ.ค. 17:00 → 8 ธ.ค. 16:30 เกินกำหนด', async () => {
    await RESET();
    const np = await NEW_PAID(ID.SOMCHAI, 'SV-01', T0, { browser });
    expect(np.caseNo).toBe(EG(31));
    const somchai = np.actor as UiActor;
    await CLOCK('2026-12-04T10:00:00+07:00');
    const r1 = await LOGIN_S('off.reg1');
    await expectStatus(await claimApi(r1.api, EG(31)), 200, 'claim');
    await expectStatus(await returnApi(r1.api, EG(31)), 200, 'return');
    expect((await getCase(somchai.api, EG(31))).fixDeadline).toBe('2026-12-11T10:00:00+07:00');
    await CLOCK('2026-12-08T17:00:00+07:00');
    await expectStatus(await resubmitApi(somchai.api, EG(31)), 200, 'resubmit');
    const k = await getCase(somchai.api, EG(31));
    expect(k.dueAt).toBe('2026-12-08T16:30:00+07:00');
    expect(k.slaLevel).toBe('overdue');
    await somchai.page.goto(`/citizen/cases/${EG(31)}`);
    await expectLevel(somchai.page.getByTestId('sla-level'), 'overdue');
  });
});

test('TC-SLA-03 ระดับเตือน ปกติ / ใกล้ครบกำหนด / เกินกำหนด', async ({ browser }) => {
  await test.step('ส่วน A: คำขอใหม่ …000031 กำหนด ศ. 4 ธ.ค. 16:30', async () => {
    await RESET();
    const np = await NEW_PAID(ID.SOMCHAI, 'SV-01', T0, { browser });
    expect(np.caseNo).toBe(EG(31));
    const c = np.actor as UiActor;
    const rows: Array<[string, SlaLevel]> = [
      ['2026-12-01T09:00:00+07:00', 'normal'],
      ['2026-12-02T09:00:00+07:00', 'normal'],
      ['2026-12-03T09:00:00+07:00', 'near'],
      ['2026-12-04T16:30:00+07:00', 'near'],
      ['2026-12-04T16:30:01+07:00', 'overdue'],
      ['2026-12-04T16:31:00+07:00', 'overdue'],
      ['2026-12-05T10:00:00+07:00', 'overdue'],
    ];
    for (const [t, lv] of rows) {
      await CLOCK(t);
      await c.page.goto(`/citizen/cases/${EG(31)}`);
      await expectLevel(c.page.getByTestId('sla-level'), lv, true);
      expect.soft((await getCase(c.api, EG(31))).slaLevel, `slaLevel @ ${t}`).toBe(lv);
    }
  });

  await test.step('ส่วน B: seed …000016 กำหนด อ. 8 ธ.ค. 16:30', async () => {
    await RESET();
    const piti = await LOGIN_C(ID.PITI, browser);
    const rows: Array<[string, SlaLevel]> = [
      ['2026-12-03T09:00:00+07:00', 'normal'],
      ['2026-12-04T09:00:00+07:00', 'near'],
      ['2026-12-08T16:30:00+07:00', 'near'],
      ['2026-12-08T16:31:00+07:00', 'overdue'],
    ];
    for (const [t, lv] of rows) {
      await CLOCK(t);
      await piti.page.goto(`/citizen/cases/${EG(16)}`);
      await expectLevel(piti.page.getByTestId('sla-level'), lv, true);
      expect.soft((await getCase(piti.api, EG(16))).slaLevel, `slaLevel @ ${t}`).toBe(lv);
    }
  });

  await test.step('ส่วน C: seed ที่ 09:00 ผ่าน /officer/queue และหน้าเคส', async () => {
    await RESET();
    const r1 = await LOGIN_S('off.reg1', browser);
    const page = r1.page;
    const seed: Array<[number, SlaLevel]> = [
      [20, 'overdue'],
      [22, 'near'],
      [24, 'near'],
      [25, 'normal'],
    ];
    await page.goto('/officer/queue');
    for (const [n, lv] of seed) {
      const row = queueRow(page, EG(n));
      await expect.soft(row.getByTestId('row-sla-level'), `queue ${n}`).toHaveText(LEVEL_TH[lv]);
      await expect.soft(row, `queue ${n} data-sla-level`).toHaveAttribute('data-sla-level', lv);
    }
    for (const [n, lv] of [...seed, [17, 'paused']] as Array<[number, SlaLevel]>) {
      await page.goto(`/officer/cases/${EG(n)}`);
      await expectLevel(page.getByTestId('sla-level'), lv, true);
    }
    const sy = await LOGIN_C(ID.SOMYING, browser);
    await sy.page.goto(`/citizen/cases/${EG(1)}`);
    await expectLevel(sy.page.getByTestId('sla-level'), 'closed');

    await CLOCK('2026-12-01T16:30:00+07:00');
    await page.goto('/officer/queue');
    await expect(queueRow(page, EG(22)).getByTestId('row-sla-level')).toHaveText(LEVEL_TH.near);
    await CLOCK('2026-12-01T16:31:00+07:00');
    await page.goto('/officer/queue');
    await expect(queueRow(page, EG(22)).getByTestId('row-sla-level')).toHaveText(LEVEL_TH.overdue);
  });
});

// ═════════════════════════════ NOTI ═════════════════════════════

/** TC-NOTI-01 ทั้งขั้น (ใช้ซ้ำใน TC-NOTI-02 ส่วน A) */
async function notiFlow01(browser: Browser) {
  await RESET();
  // request แรกหลัง reset = ล็อกอิน off.reg1 ที่ 09:00 (กระตุ้นการประเมิน)
  const reg1 = await LOGIN_S('off.reg1', browser);
  const reg2 = await LOGIN_S('off.reg2', browser);
  const head = await LOGIN_S('head1', browser);
  const works = await LOGIN_S('off.works1', browser);

  await expectNoti(reg1, [[24, 'near'], [22, 'near'], [20, 'overdue']], 'off.reg1 @09:00');
  await expectNoti(reg2, [[24, 'near']], 'off.reg2 @09:00');
  await expectNoti(head, [[20, 'overdue']], 'head1 @09:00');
  await expectNoti(works, [], 'off.works1 @09:00');

  await CLOCK('2026-12-01T16:31:00+07:00');
  await expectNoti(reg1, [[24, 'near'], [22, 'near'], [20, 'overdue'], [22, 'overdue']], 'off.reg1 @16:31');
  await expectNoti(head, [[20, 'overdue'], [22, 'overdue']], 'head1 @16:31');
  await expectNoti(reg2, [[24, 'near']], 'off.reg2 @16:31');
  return { reg1, reg2, head, works };
}

test('TC-NOTI-01 ผู้รับแจ้งเตือนตามระดับ', async ({ browser }) => {
  await notiFlow01(browser);
});

test('TC-NOTI-02 ไม่แจ้งซ้ำ ข้ามระดับ และขั้นรออนุมัติ/รอออกเอกสาร', async ({ browser }) => {
  await test.step('ส่วน A ไม่แจ้งซ้ำ', async () => {
    const { reg1, head } = await notiFlow01(browser);
    for (let i = 0; i < 3; i++) {
      await reg1.page.goto('/notifications');
      await head.page.goto('/notifications');
    }
    for (let i = 0; i < 3; i++) {
      await notificationsApi(reg1.api);
      await notificationsApi(head.api);
    }
    for (let i = 0; i < 2; i++) {
      await reg1.page.goto('/officer/queue');
      await head.page.goto('/officer/queue');
    }
    await expectNoti(reg1, [[24, 'near'], [22, 'near'], [20, 'overdue'], [22, 'overdue']], 'off.reg1 หลังเปิดซ้ำ');
    await expectNoti(head, [[20, 'overdue'], [22, 'overdue']], 'head1 หลังเปิดซ้ำ');
  });

  await test.step('ส่วน B ข้ามระดับ: request แรกที่ ส. 5 ธ.ค. 10:00 (TEST-DATA 8.1)', async () => {
    await RESET();
    await CLOCK('2026-12-05T10:00:00+07:00');
    const reg1 = await LOGIN_S('off.reg1', browser);
    const reg2 = await LOGIN_S('off.reg2', browser);
    const works = await LOGIN_S('off.works1', browser);
    const head = await LOGIN_S('head1', browser);
    const od = (ns: number[]): NotiKey[] => ns.map((n) => [n, 'overdue']);

    await expectNoti(reg1, od([20, 22, 23, 24, 28, 29, 30]), 'off.reg1 @5 ธ.ค.');
    await expectNoti(reg2, [...od([13, 15, 24, 25, 26, 27, 28, 29, 30]), [16, 'near']], 'off.reg2 @5 ธ.ค.');
    await expectNoti(works, od([10]), 'off.works1 @5 ธ.ค.');
    await expectNoti(
      head,
      [...od([10, 13, 14, 15, 20, 22, 23, 24, 25, 26, 27, 28, 29, 30]), [11, 'near']],
      'head1 @5 ธ.ค.',
    );
    // ระบุในการ์ด: …000024 มีเฉพาะ overdue อย่างละ 1 · …000020/…000022 head1 มี overdue อย่างละ 1
    for (const a of [reg1, reg2, head]) expect(await notiLevelsFor(a, 24), `${a.who} …000024`).toEqual(['overdue']);
    for (const n of [20, 22]) {
      expect(await notiLevelsFor(reg1, n), `off.reg1 …0000${n}`).toEqual(['overdue']);
      expect(await notiLevelsFor(head, n), `head1 …0000${n}`).toEqual(['overdue']);
    }
  });

  await test.step('ส่วน C ขั้นรออนุมัติ (…000014) และรอออกเอกสาร (…000019)', async () => {
    await RESET();
    await CLOCK('2026-12-04T09:00:00+07:00');
    const head = await LOGIN_S('head1', browser);
    const reg1 = await LOGIN_S('off.reg1');
    const reg2 = await LOGIN_S('off.reg2');

    expect(await notiLevelsFor(head, 14), 'head1 …000014 @4 ธ.ค. 09:00').toEqual(['near']);
    expect(await notiLevelsFor(reg1, 14), 'off.reg1 …000014').toEqual([]);
    expect(await notiLevelsFor(reg2, 14), 'off.reg2 …000014').toEqual([]);

    // 1
    await CLOCK('2026-12-04T16:31:00+07:00');
    expect(await notiLevelsFor(head, 14), 'head1 …000014 @4 ธ.ค. 16:31').toEqual(['near', 'overdue']);
    expect(await notiLevelsFor(reg1, 14)).toEqual([]);
    expect(await notiLevelsFor(reg2, 14)).toEqual([]);
    await head.page.goto('/notifications');
    await expect(rowBy(head.page, 'noti-item', 'data-case-no', EG(14))).toHaveCount(2);

    // 2
    await CLOCK('2026-12-08T09:00:00+07:00');
    expect(await notiLevelsFor(reg1, 19), 'off.reg1 …000019 @8 ธ.ค. 09:00').toEqual(['near']);
    expect(await notiLevelsFor(reg2, 19), 'off.reg2 …000019').toEqual([]);
    expect(await notiLevelsFor(head, 19), 'head1 …000019').toEqual([]);

    // 3
    await CLOCK('2026-12-09T16:31:00+07:00');
    expect(await notiLevelsFor(reg1, 19), 'off.reg1 …000019 @9 ธ.ค. 16:31').toEqual(['near', 'overdue']);
    expect(await notiLevelsFor(head, 19), 'head1 …000019 @9 ธ.ค. 16:31').toEqual(['overdue']);
  });
});
