/**
 * helpers.ts · สูตรกลางของ TEST-PLAN.md §0 (ใช้ร่วมกันทั้ง part1 และ part2)
 *
 *   RESET            POST /api/test/reset → 200 · now = 2026-12-01T09:00:00+07:00
 *                    ปิด (dispose) ทุก context/cookie ที่เปิดไว้ก่อนหน้าเสมอ (CONTRACT 0.9)
 *                    → หลัง RESET ต้อง LOGIN_C / LOGIN_S ใหม่ ซึ่งจะสร้าง context ใหม่ให้เอง
 *   CLOCK(t)         PUT /api/test/clock {"now": t}
 *   LOGIN_C(idNo)    POST /api/auth/thaid/start + /verify OTP 123456
 *   LOGIN_S(user)    POST /api/auth/staff/login รหัสผ่าน Test@1234
 *   NEW_PAID(...)    CLOCK → LOGIN_C → ร่าง → แนบไฟล์บังคับ → QR → pay → GET payment → caseNo
 *
 * ทุก LOGIN_* สร้าง context ใหม่เสมอ:
 *   - ไม่ส่ง browser → APIRequestContext ใหม่ (cookie แยก)
 *   - ส่ง browser   → BrowserContext ใหม่ + page · actor.api = context.request (cookie ร่วมกับหน้าเว็บ)
 *
 * ค่าที่ test ใช้ทั้งหมดมาจาก CONTRACT.md / TEST-DATA.md / TEST-PLAN.md เท่านั้น (ไม่อ่านโค้ดเว็บ)
 */
import {
  test as base,
  expect,
  request as pwRequest,
  type APIRequestContext,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import * as zlib from 'zlib';
import * as nodePath from 'path';

export { expect };

// ───────────────────────────── ค่าคงที่ ─────────────────────────────

export const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
/** นาฬิกาหลัง RESET (อังคาร) */
export const T0 = '2026-12-01T09:00:00+07:00';
export const OTP_OK = '123456';
export const PASSWORD = 'Test@1234';

/** เลขบัตรประชาชนของ seed (TEST-DATA 1.1) */
export const ID = {
  SOMCHAI: '1101700123456',
  SOMYING: '3100600987659',
  MANA: '5500400111221',
  PITI: '1909900555015',
  BAD_CHECKSUM: '1101700123457',
} as const;

export const CITIZEN_NAME: Record<string, string> = {
  [ID.SOMCHAI]: 'สมชาย ใจดี',
  [ID.SOMYING]: 'สมหญิง รักไทย',
  [ID.MANA]: 'มานะ ตั้งใจ',
  [ID.PITI]: 'ปิติ มีสุข',
};

export type Role = 'citizen' | 'officer' | 'head' | 'executive' | 'auditor' | 'admin';
export type StaffUser = 'off.reg1' | 'off.reg2' | 'off.works1' | 'head1' | 'exec1' | 'audit1' | 'admin1';

/** บัญชีเจ้าหน้าที่ (TEST-DATA 1.2 · CONTRACT 2.1 / 3) */
export const STAFF: Record<StaffUser, { name: string; role: Role; dept: string; landing: string; roleText: string }> = {
  'off.reg1': { name: 'เจ้าหน้าที่ทะเบียน 1', role: 'officer', dept: 'registry', landing: '/officer/queue', roleText: 'เจ้าหน้าที่' },
  'off.reg2': { name: 'เจ้าหน้าที่ทะเบียน 2', role: 'officer', dept: 'registry', landing: '/officer/queue', roleText: 'เจ้าหน้าที่' },
  'off.works1': { name: 'เจ้าหน้าที่โยธา 1', role: 'officer', dept: 'works', landing: '/officer/queue', roleText: 'เจ้าหน้าที่' },
  head1: { name: 'หัวหน้าฝ่าย', role: 'head', dept: '', landing: '/head/approvals', roleText: 'หัวหน้าฝ่าย' },
  exec1: { name: 'ผู้บริหาร', role: 'executive', dept: '', landing: '/dashboard', roleText: 'ผู้บริหาร' },
  audit1: { name: 'ผู้ตรวจสอบภายใน', role: 'auditor', dept: '', landing: '/audit', roleText: 'ผู้ตรวจสอบภายใน' },
  admin1: { name: 'ผู้ดูแลระบบ', role: 'admin', dept: '', landing: '/admin/services', roleText: 'ผู้ดูแลระบบ' },
};

/** ข้อความตรงตัวอักษร (CONTRACT ตาราง 5) · "–" = en dash U+2013 */
export const MSG = {
  INVALID_ID: 'เลขบัตรประชาชนไม่ถูกต้อง',
  OTP_INVALID: 'รหัส OTP ไม่ถูกต้อง',
  LOCKED: 'ผิดเกินกำหนด เลขบัตรนี้ถูกล็อก 15 นาที',
  INVALID_CREDENTIALS: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
  INVALID_MOBILE: 'เบอร์มือถือต้องเป็นตัวเลข 10 หลักขึ้นต้นด้วย 0',
  CONSENT_REQUIRED: 'กรุณายินยอมการประมวลผลข้อมูลส่วนบุคคล (PDPA)',
  INVALID_QTY: 'จำนวนฉบับต้อง 1–5 ฉบับ',
  INVALID_AREA: 'กรุณาระบุพื้นที่ 1–500 ตร.ม.',
  AREA_TOO_LARGE: 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน',
  FILE_TOO_LARGE: 'ไฟล์ใหญ่เกิน 5 MB',
  FILE_TYPE: 'รองรับเฉพาะไฟล์ PDF, JPG, PNG',
  FILE_COUNT: 'แนบได้สูงสุด 5 ไฟล์ต่อคำขอ',
  PLAN_NOT_PDF: 'แบบแปลนต้องเป็นไฟล์ PDF เท่านั้น',
  QR_EXPIRED: 'QR หมดอายุ กรุณาสร้าง QR ใหม่',
  AMOUNT_MISMATCH: 'ยอดเงินไม่ตรงกับค่าธรรมเนียม',
  NOT_FOUND: 'ไม่พบคำขอ',
  CANNOT_CANCEL: 'ยกเลิกไม่ได้ คำขอมีเจ้าหน้าที่รับเรื่องแล้ว',
  FIX_WINDOW_EXPIRED: 'หมดเวลาแก้ไขแล้ว คำขอถูกยกเลิก',
  ALREADY_CLAIMED: 'มีเจ้าหน้าที่รับเรื่องนี้แล้ว',
  WORKLOAD_LIMIT: 'รับงานได้สูงสุด 10 เรื่อง',
  RETURN_LIMIT: 'ตีกลับได้สูงสุด 2 ครั้ง',
  REASON_TOO_SHORT: 'กรุณากรอกเหตุผลอย่างน้อย 10 ตัวอักษร',
  REASON_REQUIRED: 'กรุณากรอกเหตุผล',
  INVALID_STATE: 'สถานะคำขอไม่ถูกต้องสำหรับรายการนี้',
  FORBIDDEN: 'ไม่มีสิทธิ์ทำรายการนี้',
  FORBIDDEN_PAGE: 'ไม่มีสิทธิ์เข้าถึงหน้านี้',
  UNAUTHENTICATED: 'กรุณาเข้าสู่ระบบ',
  INVALID_FEE: 'ค่าธรรมเนียมต้องเป็นจำนวนเต็ม 0–100,000 บาท',
  INVALID_SLA: 'SLA ต้องเป็นจำนวนเต็ม 1–60 วันทำการ',
  DUPLICATE_HOLIDAY: 'มีวันหยุดนี้อยู่แล้ว',
  SELF_ROLE_CHANGE: 'ไม่สามารถเปลี่ยนบทบาทของตัวเองได้',
  NO_REFUND: 'ค่าธรรมเนียมที่ชำระแล้วไม่คืน',
  NOTI_EMPTY: 'ไม่มีแจ้งเตือน',
  QUEUE_EMPTY: 'ไม่มีงานในคิว',
} as const;

/** ค่าที่แสดงแทนค่าว่าง/ไม่ถูกต้อง (en dash) */
export const DASH = '–';

/** CONTRACT 4.1 */
export const STATUS_TH = {
  DRAFT: 'ร่าง',
  PENDING_PAYMENT: 'รอชำระเงิน',
  SUBMITTED: 'ส่งคำขอแล้ว',
  IN_REVIEW: 'กำลังตรวจสอบ',
  NEED_FIX: 'รอแก้ไขเอกสาร',
  PENDING_APPROVAL: 'รออนุมัติ',
  APPROVED: 'อนุมัติ',
  COMPLETED: 'เสร็จสิ้น',
  REJECTED: 'ไม่อนุมัติ',
  CANCELLED: 'ยกเลิก',
} as const;
export type CaseStatus = keyof typeof STATUS_TH;

/** CONTRACT 4.2 */
export const LEVEL_TH = {
  normal: 'ปกติ',
  near: 'ใกล้ครบกำหนด',
  overdue: 'เกินกำหนด',
  paused: 'หยุดนับ',
  closed: 'ปิดแล้ว',
} as const;
export type SlaLevel = keyof typeof LEVEL_TH;

export type ServiceId = 'SV-01' | 'SV-02' | 'SV-03';

/** เลขคำขอ: EG(25) → EG-2569-000025 */
export const EG = (n: number, beYear = 2569): string => `EG-${beYear}-${String(n).padStart(6, '0')}`;
/** เลขใบเสร็จ: RC(31) → RC-2569-000031 */
export const RC = (n: number, beYear = 2569): string => `RC-${beYear}-${String(n).padStart(6, '0')}`;
/** ref ชำระ: PP(2) → PP-0002 */
export const PP = (n: number): string => `PP-${String(n).padStart(4, '0')}`;
/** รหัสร่าง: DR(3) → DR-0003 */
export const DR = (n: number): string => `DR-${String(n).padStart(4, '0')}`;

// ───────────────────────────── ทะเบียน context (ปิดทุกตัวเมื่อ RESET) ─────────────────────────────

type Closable = { close(): Promise<void> };
const live = new Set<Closable>();

function track<T extends Closable>(c: T): T {
  live.add(c);
  return c;
}

/** ปิดทุก context ที่ helpers เปิดไว้ (เรียกอัตโนมัติใน RESET และตอนจบแต่ละ test) */
export async function disposeAll(): Promise<void> {
  const all = [...live];
  live.clear();
  await Promise.all(all.map((c) => c.close().catch(() => undefined)));
}

/**
 * `test` ที่ต่อจาก @playwright/test พร้อม fixture อัตโนมัติที่ปิด context ทั้งหมดตอนจบ test
 * (ใช้ `import { test, expect } from './helpers'`)
 */
export const test = base.extend<{ _disposeActors: void }>({
  _disposeActors: [
    async ({}, use) => {
      await use();
      await disposeAll();
    },
    { auto: true },
  ],
});

/** APIRequestContext ใหม่ (cookie ว่าง) */
export async function newApi(): Promise<APIRequestContext> {
  const api = await pwRequest.newContext({ baseURL: BASE_URL });
  track({ close: () => api.dispose() });
  return api;
}

/** BrowserContext ใหม่ (ยังไม่ล็อกอิน) + page */
export async function newBrowserContext(
  browser: Browser,
  opts: { viewport?: { width: number; height: number } } = {},
): Promise<{ context: BrowserContext; page: Page; api: APIRequestContext }> {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
    viewport: opts.viewport ?? { width: 1280, height: 900 },
    // อัดวิดีโอเพื่อทำ GIF หลักฐาน (เปิดเฉพาะเมื่อตั้ง RECORD_VIDEO_DIR · ไม่กระทบผลทดสอบ)
    ...(process.env.RECORD_VIDEO_DIR
      ? {
          recordVideo: {
            dir: nodePath.join(process.env.RECORD_VIDEO_DIR, (test.info().title.match(/^TC-[A-Z0-9]+-\d+/) || ['misc'])[0]),
            size: { width: 640, height: 450 },
          },
        }
      : {}),
  });
  track({ close: () => context.close() });
  // กล่อง dialog แบบ native (ถ้ามี) ให้กดยืนยัน · กล่องยืนยันยกเลิกคำขอของ CONTRACT เป็นแบบในหน้า (cancel-confirm-text)
  context.on('page', (p) => p.on('dialog', (d) => d.accept().catch(() => undefined)));
  const page = await context.newPage();
  return { context, page, api: context.request };
}

// ───────────────────────────── ตัวช่วย HTTP ─────────────────────────────

/** อ่าน JSON แบบไม่โยน error (body ว่าง/ไม่ใช่ JSON → null) */
export async function jsonOf(res: APIResponse): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** ตรวจ HTTP status พร้อมแสดง body เมื่อไม่ตรง */
export async function expectStatus(res: APIResponse, status: number, label = ''): Promise<any> {
  const text = await res.text().catch(() => '');
  expect(res.status(), `${label} ${res.url()} → ${res.status()} ${text.slice(0, 500)}`.trim()).toBe(status);
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** ตรวจ error รูปแบบ {"code","message"} (CONTRACT 0.6) */
export async function expectApiError(
  res: APIResponse,
  status: number,
  code?: string,
  message?: string,
  label = '',
): Promise<any> {
  const body = await expectStatus(res, status, label);
  if (code !== undefined) expect(body?.code, `${label} code`).toBe(code);
  if (message !== undefined) expect(body?.message, `${label} message`).toBe(message);
  return body;
}

/** เวลา ISO สองค่าเป็นขณะเดียวกัน (ไม่สนรูปแบบ offset) */
export function sameInstant(a: string | null | undefined, b: string): boolean {
  return !!a && Date.parse(a) === Date.parse(b);
}

// ───────────────────────────── สูตรกลาง ─────────────────────────────

/**
 * RESET · POST /api/test/reset → 200 {"ok":true,"now":"2026-12-01T09:00:00+07:00"}
 * ปิดทุก context เดิมก่อน (cookie เก่าใช้ไม่ได้หลัง reset · CONTRACT 0.9)
 */
export async function RESET(): Promise<void> {
  await disposeAll();
  const api = await pwRequest.newContext({ baseURL: BASE_URL });
  try {
    const res = await api.post('/api/test/reset');
    const body = await expectStatus(res, 200, 'RESET');
    expect(body?.ok, 'RESET ok').toBe(true);
    expect(body?.now, 'RESET now').toBe(T0);
  } finally {
    await api.dispose();
  }
}

/** CLOCK(t) · PUT /api/test/clock {"now":t} (นาฬิกาแช่แข็ง) */
export async function CLOCK(now: string): Promise<void> {
  const api = await pwRequest.newContext({ baseURL: BASE_URL });
  try {
    const res = await api.put('/api/test/clock', { data: { now } });
    const body = await expectStatus(res, 200, `CLOCK(${now})`);
    expect(sameInstant(body?.now, now), `CLOCK now = ${body?.now}`).toBe(true);
  } finally {
    await api.dispose();
  }
}

/** POST /api/test/payments/<ref>/pay {"amount"} · คืน {status, body} โดยไม่ assert */
export async function PAY(ref: string, amount: number): Promise<{ status: number; body: any }> {
  const api = await pwRequest.newContext({ baseURL: BASE_URL });
  try {
    const res = await api.post(`/api/test/payments/${ref}/pay`, { data: { amount } });
    return { status: res.status(), body: await jsonOf(res) };
  } finally {
    await api.dispose();
  }
}

export interface ApiActor {
  who: string;
  api: APIRequestContext;
  registered?: boolean;
  context?: undefined;
  page?: undefined;
}
export interface UiActor {
  who: string;
  api: APIRequestContext;
  registered?: boolean;
  context: BrowserContext;
  page: Page;
}
export type Actor = ApiActor | UiActor;

/** start + verify (ไม่สร้าง context) · คืน body ของ verify */
export async function citizenLoginWith(api: APIRequestContext, idNo: string): Promise<any> {
  const s = await api.post('/api/auth/thaid/start', { data: { idNo } });
  await expectStatus(s, 200, `LOGIN_C start ${idNo}`);
  const v = await api.post('/api/auth/thaid/verify', { data: { idNo, otp: OTP_OK } });
  return expectStatus(v, 200, `LOGIN_C verify ${idNo}`);
}

/** staff login (ไม่สร้าง context) · คืน body */
export async function staffLoginWith(api: APIRequestContext, username: string): Promise<any> {
  const r = await api.post('/api/auth/staff/login', { data: { username, password: PASSWORD } });
  return expectStatus(r, 200, `LOGIN_S ${username}`);
}

/** LOGIN_C(เลขบัตร) · context ใหม่เสมอ · ส่ง browser เพื่อได้ page ที่ล็อกอินแล้ว */
export async function LOGIN_C(idNo?: string): Promise<ApiActor>;
export async function LOGIN_C(idNo: string, browser: Browser): Promise<UiActor>;
export async function LOGIN_C(idNo: string = ID.SOMCHAI, browser?: Browser): Promise<Actor> {
  if (browser) {
    const { context, page, api } = await newBrowserContext(browser);
    const body = await citizenLoginWith(api, idNo);
    return { who: idNo, api, context, page, registered: body?.registered };
  }
  const api = await newApi();
  const body = await citizenLoginWith(api, idNo);
  return { who: idNo, api, registered: body?.registered };
}

/** LOGIN_S(user) · context ใหม่เสมอ · ส่ง browser เพื่อได้ page ที่ล็อกอินแล้ว */
export async function LOGIN_S(username: StaffUser | string): Promise<ApiActor>;
export async function LOGIN_S(username: StaffUser | string, browser: Browser): Promise<UiActor>;
export async function LOGIN_S(username: StaffUser | string, browser?: Browser): Promise<Actor> {
  if (browser) {
    const { context, page, api } = await newBrowserContext(browser);
    await staffLoginWith(api, username);
    return { who: username, api, context, page };
  }
  const api = await newApi();
  await staffLoginWith(api, username);
  return { who: username, api };
}

// ───────────────────────────── ร่าง ไฟล์ ชำระ ─────────────────────────────

/** ไฟล์บังคับตามบริการ (TEST-PLAN §0 NEW_PAID · TEST-DATA 11) */
export const REQUIRED_FILES: Record<ServiceId, Array<[docKey: string, fileName: string]>> = {
  'SV-01': [['id-card', 'id-card.pdf']],
  'SV-02': [
    ['id-card', 'id-card.pdf'],
    ['map', 'map.pdf'],
  ],
  'SV-03': [
    ['id-card', 'id-card.pdf'],
    ['plan', 'plan.pdf'],
    ['deed', 'deed.pdf'],
  ],
};

export function draftBody(service: ServiceId, opts: { qty?: number; areaSqm?: number } = {}): Record<string, unknown> {
  if (service === 'SV-01') return { serviceId: service, qty: opts.qty ?? 1 };
  if (service === 'SV-03') return { serviceId: service, areaSqm: opts.areaSqm ?? 100 };
  return { serviceId: service };
}

/** POST /api/drafts → 201 {draftId, fee} */
export async function createDraftApi(
  api: APIRequestContext,
  service: ServiceId,
  opts: { qty?: number; areaSqm?: number } = {},
): Promise<{ draftId: string; fee: number }> {
  const res = await api.post('/api/drafts', { data: draftBody(service, opts) });
  const body = await expectStatus(res, 201, `POST /api/drafts ${service}`);
  expect(body?.draftId, 'draftId').toBeTruthy();
  return { draftId: body.draftId, fee: body.fee };
}

/** POST /api/drafts/:id/files (multipart: file, docKey) · คืน response (ไม่ assert) */
export async function uploadApi(
  api: APIRequestContext,
  draftId: string,
  docKey: string,
  fileName: string,
  mimeType?: string,
): Promise<APIResponse> {
  const f = testFile(fileName, mimeType);
  return api.post(`/api/drafts/${draftId}/files`, {
    multipart: { file: { name: f.name, mimeType: f.mimeType, buffer: f.buffer }, docKey },
    timeout: 60_000,
  });
}

/** POST /api/drafts/:id/payment → 201 {ref, amount, qrCreatedAt, qrExpiresAt} */
export async function createQrApi(api: APIRequestContext, draftId: string): Promise<any> {
  const res = await api.post(`/api/drafts/${draftId}/payment`);
  const body = await expectStatus(res, 201, `POST /api/drafts/${draftId}/payment`);
  expect(body?.ref, 'ref').toBeTruthy();
  return body;
}

export interface NewPaidOptions {
  qty?: number;
  areaSqm?: number;
  /** ใช้ actor ที่ล็อกอินแล้ว (ไม่ล็อกอินใหม่) */
  actor?: Actor;
  /** ล็อกอินใน BrowserContext ใหม่ (ได้ actor.page) */
  browser?: Browser;
  /** false = หยุดหลังสร้าง QR (ยังไม่ชำระ) */
  pay?: boolean;
  /** ยอดที่ส่งให้ pay (ค่าตั้งต้น = fee) */
  amount?: number;
}

export interface NewPaidResult {
  actor: Actor;
  draftId: string;
  fee: number;
  ref: string;
  qr: any;
  pay?: any;
  caseNo?: string;
  receiptNo?: string;
}

/**
 * NEW_PAID(ผู้ยื่น, บริการ, เวลา, ตัวเลือก)
 * CLOCK(เวลา) → LOGIN_C → POST /api/drafts → แนบไฟล์บังคับ → POST payment → pay → GET /api/payments/<ref> → caseNo
 */
export async function NEW_PAID(
  who: string = ID.SOMCHAI,
  service: ServiceId = 'SV-01',
  at?: string,
  opts: NewPaidOptions = {},
): Promise<NewPaidResult> {
  if (at) await CLOCK(at);
  const actor: Actor = opts.actor ?? (opts.browser ? await LOGIN_C(who, opts.browser) : await LOGIN_C(who));
  const { draftId, fee } = await createDraftApi(actor.api, service, opts);
  for (const [docKey, fileName] of REQUIRED_FILES[service]) {
    await expectStatus(await uploadApi(actor.api, draftId, docKey, fileName), 201, `upload ${docKey}`);
  }
  const qr = await createQrApi(actor.api, draftId);
  const result: NewPaidResult = { actor, draftId, fee, ref: qr.ref, qr };
  if (opts.pay === false) return result;
  const paid = await PAY(qr.ref, opts.amount ?? fee);
  expect(paid.status, `pay ${qr.ref} → ${JSON.stringify(paid.body)}`).toBe(200);
  expect(paid.body?.status).toBe('PAID');
  const g = await actor.api.get(`/api/payments/${qr.ref}`);
  const payment = await expectStatus(g, 200, `GET /api/payments/${qr.ref}`);
  expect(payment?.caseNo, 'caseNo หลังชำระ').toBeTruthy();
  result.pay = paid.body;
  result.caseNo = payment.caseNo;
  result.receiptNo = payment.receiptNo ?? paid.body?.receiptNo;
  return result;
}

// ───────────────────────────── API อ่านข้อมูล ─────────────────────────────

/** GET /api/cases/:caseNo → 200 JSON (CONTRACT 6.7) */
export async function getCase(api: APIRequestContext, caseNo: string): Promise<any> {
  return expectStatus(await api.get(`/api/cases/${caseNo}`), 200, `GET /api/cases/${caseNo}`);
}

/** GET /api/cases → items (เฉพาะของฉันที่มีเลขแล้ว) */
export async function myCases(api: APIRequestContext): Promise<any[]> {
  const body = await expectStatus(await api.get('/api/cases'), 200, 'GET /api/cases');
  return body?.items ?? [];
}

/** GET /api/drafts → items */
export async function myDrafts(api: APIRequestContext): Promise<any[]> {
  const body = await expectStatus(await api.get('/api/drafts'), 200, 'GET /api/drafts');
  return body?.items ?? [];
}

/** จำนวนไฟล์ของร่างจาก GET /api/drafts/:id (คาดว่ามี files[]) */
export async function draftFileCount(api: APIRequestContext, draftId: string): Promise<number> {
  const body = await expectStatus(await api.get(`/api/drafts/${draftId}`), 200, `GET /api/drafts/${draftId}`);
  const candidates = [body, body?.item, body?.draft, Array.isArray(body?.items) ? body.items[0] : undefined];
  for (const c of candidates) {
    if (c && Array.isArray(c.files)) return c.files.length;
    if (c && typeof c.fileCount === 'number') return c.fileCount;
  }
  throw new Error(`GET /api/drafts/${draftId} ไม่มี files[] ให้นับ: ${JSON.stringify(body).slice(0, 300)}`);
}

/** GET /api/officer/queue?filter= → items */
export async function queueApi(api: APIRequestContext, filter: 'all' | 'unclaimed' | 'mine' = 'all'): Promise<any[]> {
  const body = await expectStatus(await api.get(`/api/officer/queue?filter=${filter}`), 200, `GET queue ${filter}`);
  return body?.items ?? [];
}

/** POST /api/officer/cases/:caseNo/claim (ไม่ assert) */
export function claimApi(api: APIRequestContext, caseNo: string): Promise<APIResponse> {
  return api.post(`/api/officer/cases/${caseNo}/claim`);
}

/** POST /api/officer/cases/:caseNo/return {"reason"} (ไม่ assert) */
export function returnApi(api: APIRequestContext, caseNo: string, reason = 'xxxxxxxxxx'): Promise<APIResponse> {
  return api.post(`/api/officer/cases/${caseNo}/return`, { data: { reason } });
}

/** POST /api/cases/:caseNo/resubmit (ไม่ assert) */
export function resubmitApi(api: APIRequestContext, caseNo: string): Promise<APIResponse> {
  return api.post(`/api/cases/${caseNo}/resubmit`);
}

/** GET /api/notifications → items */
export async function notificationsApi(api: APIRequestContext): Promise<any[]> {
  const body = await expectStatus(await api.get('/api/notifications'), 200, 'GET /api/notifications');
  return body?.items ?? [];
}

/** GET /api/audit?... → {count, items} */
export async function auditApi(api: APIRequestContext, query: Record<string, string> = {}): Promise<{ count: number; items: any[] }> {
  const qs = new URLSearchParams(query).toString();
  const body = await expectStatus(await api.get(`/api/audit${qs ? `?${qs}` : ''}`), 200, 'GET /api/audit');
  return { count: body?.count, items: body?.items ?? [] };
}

// ───────────────────────────── ตัวช่วยหน้าเว็บ ─────────────────────────────

/** รอให้ pathname ของหน้า = path */
export async function expectPath(page: Page, path: string, message?: string): Promise<void> {
  await expect.poll(() => new URL(page.url()).pathname, { message: message ?? `URL path ควรเป็น ${path}` }).toBe(path);
}

/** locator ของแถวตาม testid + data-* */
export function rowBy(scope: Page | Locator, testid: string, attr: string, value: string): Locator {
  return scope.locator(`[data-testid="${testid}"][${attr}="${value}"]`);
}

/** อ่านค่าแอตทริบิวต์ของทุก element ใน locator */
export function attrsOf(loc: Locator, attr: string): Promise<string[]> {
  return loc.evaluateAll((els, a) => els.map((e) => e.getAttribute(a as string) ?? ''), attr);
}

/** กรอกค่าในช่องแล้ว blur ให้เกิด input + change */
export async function fillAndCommit(loc: Locator, value: string): Promise<void> {
  await loc.fill(value);
  await loc.blur();
}

/** เปิด /login แท็บประชาชน */
export async function openCitizenLogin(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-tab-citizen').click();
  await expect(page.getByTestId('thaid-id-input')).toBeVisible();
}

/** ล็อกอินประชาชนผ่านหน้า /login (OTP 123456) */
export async function loginCitizenUi(page: Page, idNo: string): Promise<void> {
  await openCitizenLogin(page);
  await page.getByTestId('thaid-id-input').fill(idNo);
  await page.getByTestId('thaid-submit').click();
  await expect(page.getByTestId('otp-step')).toBeVisible();
  await page.getByTestId('otp-input').fill(OTP_OK);
  await page.getByTestId('otp-submit').click();
  await expect.poll(() => new URL(page.url()).pathname, { message: 'ออกจาก /login หลัง OTP' }).not.toBe('/login');
}

/** ล็อกอินเจ้าหน้าที่ผ่านแท็บเจ้าหน้าที่ */
export async function loginStaffUi(page: Page, username: string, password = PASSWORD): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-tab-staff').click();
  await page.getByTestId('staff-username').fill(username);
  await page.getByTestId('staff-password').fill(password);
  await page.getByTestId('staff-submit').click();
}

/** workload-count จากหน้า /officer/queue */
export async function workloadUi(page: Page): Promise<Locator> {
  await page.goto('/officer/queue');
  return page.getByTestId('workload-count');
}

// ───────────────────────────── ไฟล์ทดสอบ (TEST-DATA 11) ─────────────────────────────

export interface TestFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** PDF จริงขนาด n ไบต์ (หัว %PDF + ช่องว่าง + %%EOF) */
export function makePdf(n: number): Buffer {
  const head = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n', 'latin1');
  const tail = Buffer.from('\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');
  const pad = n - head.length - tail.length;
  if (pad < 0) throw new Error(`pdf ${n} เล็กเกินไป`);
  return Buffer.concat([head, Buffer.alloc(pad, 0x20), tail]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

/** PNG จริง 1x1 + chunk tEXt ให้ครบ n ไบต์ */
export function makePng(n: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const base = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.from([0x00, 0xff, 0x00, 0x00]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  const pad = n - base.length - 12;
  if (pad < 2) throw new Error(`png ${n} เล็กเกินไป`);
  const text = pngChunk('tEXt', Buffer.concat([Buffer.from([0x6b, 0x00]), Buffer.alloc(pad - 2, 0x78)]));
  return Buffer.concat([base.subarray(0, base.length - 12), text, base.subarray(base.length - 12)]);
}

/** JPEG จริงแบบย่อ (SOI + APP0 + COM + EOI) ขนาด n ไบต์ */
export function makeJpg(n: number): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  const pad = n - soi.length - app0.length - 2 - 4;
  const len = Buffer.alloc(2);
  len.writeUInt16BE(pad + 2);
  return Buffer.concat([soi, app0, Buffer.from([0xff, 0xfe]), len, Buffer.alloc(pad, 0x78), Buffer.from([0xff, 0xd9])]);
}

function mimeOf(name: string): string {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'txt') return 'text/plain';
  return 'application/octet-stream';
}

const fileCache = new Map<string, Buffer>();

function buildFile(name: string): Buffer {
  const size = /^size-(\d+)\.pdf$/.exec(name);
  if (size) return makePdf(Number(size[1]));
  if (/^(ok-id|id-card|map|plan|deed|multi-[1-6])\.pdf$/.test(name)) return makePdf(1024);
  if (name === 'real.jpg' || name === 'plan-as-jpg.jpg') return makeJpg(1024);
  if (name === 'real.png') return makePng(1024);
  if (name === 'fake-text.pdf' || name === 'fake-text.jpg' || name === 'notes.txt') return Buffer.from('hello', 'latin1');
  if (name === 'exe-as.png') return Buffer.concat([Buffer.from('MZ', 'latin1'), Buffer.alloc(1022, 0)]);
  throw new Error(`ไม่รู้จักไฟล์ทดสอบ ${name} (TEST-DATA 11)`);
}

/** ไฟล์ทดสอบตาม TEST-DATA 11 (สร้างในหน่วยความจำ ขนาดตรงไบต์) · ใช้กับ setInputFiles และ multipart */
export function testFile(name: string, mimeType?: string): TestFile {
  let buf = fileCache.get(name);
  if (!buf) {
    buf = buildFile(name);
    fileCache.set(name, buf);
  }
  return { name, mimeType: mimeType ?? mimeOf(name), buffer: buf };
}
