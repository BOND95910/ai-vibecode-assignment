/**
 * part2.spec.ts · Playwright ชุด 2 (29 TC) ตาม TEST-PLAN.md §10–§16
 *   WORKFLOW-01..06 · DOC-01..03 · PDPA-01..03 · DASH-01..04 · AUDIT-01..03 · RBAC-01..06 · NFR-01..04
 *
 * กติกา (เหมือน part1)
 * - ทุก TC เริ่มด้วย RESET · หลัง RESET ทุกครั้ง (รวมกลาง TC) ล็อกอินใหม่ใน context ใหม่
 *   (RESET ของ helpers ปิด context เก่าทั้งหมด จึงใช้ cookie เก่าซ้ำไม่ได้)
 * - ค่าคาดหวังคัดจากการ์ด TC / TEST-DATA ตัวต่อตัว (ไม่อ่านจากหน้าจอเว็บ) · testid / ข้อความ error จาก CONTRACT.md
 * - ไม่ใช้ไลบรารีเพิ่ม: อ่าน PDF (ข้อความ ASCII + ToUnicode) · xlsx (zip + XML) · CSV ด้วยตัวอ่านเล็ก ๆ ในไฟล์นี้
 *
 * ตัวแปรสภาพแวดล้อม
 *   BASE_URL               ที่อยู่เว็บ (ค่าตั้งต้น http://localhost:3000) · เว็บต้องรันด้วย TEST_MODE=1
 *   DB_PATH                ไฟล์ SQLite ของเว็บ "บนเครื่องที่รัน test" (TC-NFR-04)
 *                          ไม่ตั้ง/ไม่มีไฟล์ → ใช้ app/data/egov.db (bind mount ของ docker compose)
 *   PII_SCAN_PATHS         (ไม่บังคับ) ไฟล์ดัมพ์/log เพิ่มเติมให้ TC-NFR-04 ค้น คั่นด้วย ","
 *   BASE_URL_NO_TEST_MODE  (ไม่บังคับ) เว็บอีกตัวที่ไม่ตั้ง TEST_MODE → TC-NFR-03 ตรวจ POST /api/test/reset = 404
 */
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, APIResponse, Browser, Download, Locator, Page, Route } from '@playwright/test';
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
  BASE_URL,
  EG,
  PP,
  DR,
  newApi,
  newBrowserContext,
  jsonOf,
  expectStatus,
  expectApiError,
  getCase,
  queueApi,
  claimApi,
  returnApi,
  resubmitApi,
  auditApi,
  createDraftApi,
  expectPath,
  rowBy,
  attrsOf,
  fillAndCommit,
  loginCitizenUi,
  loginStaffUi,
  workloadUi,
  testFile,
  type UiActor,
  type CaseStatus,
  type SlaLevel,
  type StaffUser,
} from './helpers';

// ═════════════════════════════ ค่าคงที่ของชุดนี้ ═════════════════════════════

/** เลขเอกสาร: DOC(2) → DOC-2569-000002 */
const DOC = (n: number, beYear = 2569): string => `DOC-${beYear}-${String(n).padStart(6, '0')}`;

const R9 = 'xxxxxxxxx'; // เหตุผล 9 ตัว (A-44)
const R10 = 'xxxxxxxxxx'; // เหตุผล 10 ตัว
const SP10 = ' '.repeat(10); // เว้นวรรคล้วน 10 ตัว
const UNMASK_REASON = 'ตรวจสอบตัวตนซ้ำ';
const FORWARD_NOTE = 'ส่งต่อให้หัวหน้าพิจารณา';
const SEED_CODE = 'K7M2Q9XA'; // รหัสตรวจสอบของ DOC-2569-000001 (TEST-DATA 5)

const VERIFY_CODE_RE = /^[A-Z0-9]{8}$/;
const MASK_RE = /^X-XXXX-XXXXX-\d{2}-\d$/;
const NAMES = ['สมชาย', 'สมหญิง', 'ปิติ', 'มานะ'];

/** CONTRACT 2.13 */
const VERIFY_TH = {
  VALID: 'เอกสารถูกต้อง',
  EXPIRED: 'เอกสารหมดอายุ',
  TAMPERED: 'ลายเซ็นไม่ถูกต้อง',
  NOT_FOUND: 'ไม่พบเอกสาร',
} as const;
type VerifyResult = keyof typeof VERIFY_TH;

/** ชื่อแสดงของผู้ลงนาม (CONTRACT 3) */
const SIGNER = {
  reg1: 'เจ้าหน้าที่ทะเบียน 1',
  reg2: 'เจ้าหน้าที่ทะเบียน 2',
  head: 'หัวหน้าฝ่าย',
} as const;

const KPI_IDS = ['kpi-received', 'kpi-closed', 'kpi-ontime-pct', 'kpi-backlog', 'kpi-overdue'] as const;
/** แถว xlsx ตาม CONTRACT 7 (คอลัมน์ A แถว 2–6) */
const XLSX_LABELS = ['รับเรื่อง', 'ปิดงาน', 'ทันกำหนด %', 'งานคงค้าง', 'เกินกำหนดคงค้าง'];

const officerCase = (caseNo: string) => `/officer/cases/${caseNo}`;
const citizenCase = (caseNo: string) => `/citizen/cases/${caseNo}`;

// ═════════════════════════════ ตัวช่วยหน้าเว็บ ═════════════════════════════

const queueRow = (page: Page, caseNo: string) => rowBy(page, 'queue-row', 'data-case-no', caseNo);
const approvalRow = (page: Page, caseNo: string) => rowBy(page, 'approval-row', 'data-case-no', caseNo);

/** case-status (ข้อความไทย + data-status) */
async function expectCaseStatus(page: Page, status: CaseStatus): Promise<void> {
  const el = page.getByTestId('case-status');
  await expect(el, `case-status = ${STATUS_TH[status]}`).toHaveText(STATUS_TH[status]);
  await expect(el).toHaveAttribute('data-status', status);
}

/** sla-level (ข้อความไทย + data-level) */
async function expectLevel(loc: Locator, level: SlaLevel): Promise<void> {
  await expect(loc).toHaveText(LEVEL_TH[level]);
  await expect(loc).toHaveAttribute('data-level', level);
}

/** จำนวน element ตาม testid (0 = ต้องไม่ render · CONTRACT 0.5) */
async function expectCounts(scope: Page | Locator, counts: Record<string, number>): Promise<void> {
  // ตรวจที่ต้องมี (> 0) ก่อน เพื่อยืนยันว่าส่วนปุ่มโหลดแล้ว แล้วจึงตรวจที่ต้องไม่มี (= 0) → ไม่ผ่านหลอกเพราะหน้ายังไม่ครบ
  const entries = Object.entries(counts).sort(([, a], [, b]) => Number(b > 0) - Number(a > 0));
  for (const [id, n] of entries) {
    await expect(scope.getByTestId(id), `${id} มี ${n}`).toHaveCount(n);
  }
}

/**
 * ฟอร์มเหตุผล: กดปุ่มเปิดเฉพาะเมื่อช่องเหตุผลยังไม่แสดง (กันกรณีปุ่มเป็นแบบสลับเปิด/ปิด) → กรอก → ยืนยัน
 */
async function submitReason(page: Page, openBtn: string, reasonId: string, submitId: string, reason: string): Promise<void> {
  const field = page.getByTestId(reasonId);
  await expect(page.getByTestId(openBtn)).toBeVisible();
  if (!(await field.isVisible())) await page.getByTestId(openBtn).click();
  await expect(field).toBeVisible();
  await field.fill(reason);
  await page.getByTestId(submitId).click();
}
const returnUi = (page: Page, reason: string) => submitReason(page, 'return-btn', 'return-reason', 'return-submit', reason);
const rejectUi = (page: Page, reason: string) => submitReason(page, 'reject-btn', 'reject-reason', 'reject-submit', reason);
const unmaskUi = (page: Page, reason: string) =>
  submitReason(page, 'show-full-id-btn', 'unmask-reason', 'unmask-submit', reason);

/** เปิดหน้า /verify/<code> (context ไม่ล็อกอิน) คืน HTTP status */
async function gotoVerify(page: Page, code: string): Promise<number> {
  const res = await page.goto(`/verify/${code}`);
  return res?.status() ?? 0;
}

async function expectVerifyResult(page: Page, result: VerifyResult): Promise<void> {
  const el = page.getByTestId('verify-result');
  await expect(el, `verify-result = ${VERIFY_TH[result]}`).toHaveText(VERIFY_TH[result]);
  await expect(el).toHaveAttribute('data-result', result);
}

/** เปิด /verify/<code> แล้วตรวจผล + HTTP + (ถ้าให้มา) วันหมดอายุ · ตรวจ API /api/verify ด้วย */
async function expectVerifyAt(page: Page, anon: APIRequestContext, code: string, result: VerifyResult, expires?: string): Promise<void> {
  const http = await gotoVerify(page, code);
  expect(http, `HTTP /verify/${code}`).toBe(result === 'NOT_FOUND' ? 404 : 200);
  expect(new URL(page.url()).pathname, '/verify ต้องไม่ redirect ไป /login').toBe(`/verify/${code}`);
  await expectVerifyResult(page, result);
  if (expires) await expect(page.getByTestId('verify-expires')).toHaveAttribute('data-iso', expires);
  const api = await anon.get(`/api/verify/${code}`);
  expect(api.status(), `GET /api/verify/${code}`).toBe(result === 'NOT_FOUND' ? 404 : 200);
  expect((await jsonOf(api))?.result).toBe(result);
}

/** signer บนหน้า /verify ของรหัสที่ได้ (context ใหม่ ไม่ล็อกอิน) */
async function expectSigner(browser: Browser, code: string, signer: string): Promise<void> {
  const { page } = await newBrowserContext(browser);
  expect(await gotoVerify(page, code)).toBe(200);
  await expectVerifyResult(page, 'VALID');
  await expect(page.getByTestId('verify-signer')).toHaveText(signer);
}

/** อ่าน verify-code บนหน้าเคส */
async function readVerifyCode(page: Page): Promise<string> {
  const loc = page.getByTestId('verify-code');
  await expect(loc).toHaveText(VERIFY_CODE_RE);
  return (await loc.innerText()).trim();
}

// ───────── Dashboard ─────────

/** เลือกค่าใน select ของ dashboard แล้วรอผล (รองรับทั้งแบบ fetch และแบบโหลดหน้าใหม่) */
async function pickDashSelect(page: Page, testid: string, value: string): Promise<void> {
  const loc = page.getByTestId(testid);
  if ((await loc.inputValue()) === value) return;
  const settled = page
    .waitForResponse((r) => /dashboard/.test(r.url()) && r.request().method() === 'GET', { timeout: 8_000 })
    .catch(() => null);
  await loc.selectOption(value);
  await settled;
  await page.waitForLoadState('domcontentloaded');
  await expect(loc).toHaveValue(value);
}

async function selectDashboard(page: Page, period: string, service: string): Promise<void> {
  await pickDashSelect(page, 'period-select', period);
  await pickDashSelect(page, 'service-select', service);
  await expect(page.getByTestId('period-select')).toHaveValue(period);
}

/** kpi-* ทั้ง 5 ช่อง [รับเรื่อง, ปิดงาน, ทันกำหนด %, คงค้าง, เกินกำหนด] */
async function expectKpis(page: Page, want: Array<string | number>, label = '', soft = false): Promise<void> {
  const e = soft ? expect.soft : expect;
  for (let i = 0; i < KPI_IDS.length; i++) {
    await e(page.getByTestId(KPI_IDS[i]), `${label} ${KPI_IDS[i]}`).toHaveText(String(want[i]));
  }
}

async function readKpis(page: Page): Promise<string[]> {
  const out: string[] = [];
  for (const id of KPI_IDS) out.push((await page.getByTestId(id).innerText()).trim());
  return out;
}

async function dashApi(api: APIRequestContext, period = '2026-12', service = 'ALL'): Promise<any> {
  return expectStatus(
    await api.get(`/api/dashboard?period=${period}&service=${service}`),
    200,
    `GET /api/dashboard ${period} ${service}`,
  );
}

// ───────── Audit ─────────

interface AuditRowUi {
  id: string;
  event: string;
  actor: string;
  caseNo: string;
  role: string;
  time: string;
  transition: string;
  detail: string;
  eventText: string;
  actorText: string;
  caseText: string;
}

async function auditRowsUi(page: Page): Promise<AuditRowUi[]> {
  return page.getByTestId('audit-row').evaluateAll((rows) =>
    rows.map((r) => {
      const cell = (t: string) => r.querySelector(`[data-testid="${t}"]`);
      const txt = (t: string) => ((cell(t)?.textContent ?? '') as string).replace(/\s+/g, ' ').trim();
      return {
        id: r.getAttribute('data-id') ?? '',
        event: r.getAttribute('data-event') ?? '',
        actor: r.getAttribute('data-actor') ?? '',
        caseNo: r.getAttribute('data-case-no') ?? '',
        role: txt('audit-role'),
        time: cell('audit-time')?.getAttribute('data-iso') ?? '',
        transition: txt('audit-transition'),
        detail: txt('audit-detail'),
        eventText: txt('audit-event'),
        actorText: txt('audit-actor'),
        caseText: txt('audit-case-no'),
      };
    }),
  );
}

/** กรองหน้า /audit (ช่องที่ไม่ส่ง = ว่าง) แล้วกด ค้นหา */
async function auditFilterUi(
  page: Page,
  f: { actor?: string; event?: string; from?: string; to?: string } = {},
): Promise<void> {
  if (new URL(page.url()).pathname !== '/audit') await page.goto('/audit');
  await page.getByTestId('audit-filter-actor').fill(f.actor ?? '');
  await page.getByTestId('audit-filter-event').selectOption(f.event ?? '');
  await page.getByTestId('audit-filter-from').fill(f.from ?? '');
  await page.getByTestId('audit-filter-to').fill(f.to ?? '');
  const settled = page
    .waitForResponse((r) => /audit/.test(r.url()) && r.request().method() === 'GET', { timeout: 8_000 })
    .catch(() => null);
  await page.getByTestId('audit-apply-btn').click();
  await settled;
  await page.waitForLoadState('domcontentloaded');
}

/** audit-count = n และจำนวน audit-row = n */
async function expectAuditCount(page: Page, n: number, label = '', soft = false): Promise<void> {
  const e = soft ? expect.soft : expect;
  await e(page.getByTestId('audit-count'), `${label} audit-count`).toHaveText(String(n));
  await e(page.getByTestId('audit-row'), `${label} audit-row`).toHaveCount(n);
}

/** ช่องเลขคำขอ/สถานะที่ "ไม่มี" แสดงเป็นว่างหรือ – */
const isNone = (s: string) => s === '' || s === DASH || s === '-';

// ───────── ดาวน์โหลด / ส่งออก ─────────

interface Captured {
  url: string;
  /** null = ได้ไฟล์จาก download event (Chromium ไม่ส่งคำขอของ <a download> ผ่าน route จึงไม่เห็น status/header) */
  status: number | null;
  headers: Record<string, string>;
  body: Buffer;
  /** ชื่อไฟล์: Content-Disposition (route) หรือ suggestedFilename (download) */
  fileName: string;
  via: 'route' | 'download';
}

/** ชื่อไฟล์จาก Content-Disposition */
function dispositionName(h: Record<string, string>): string {
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(h['content-disposition'] ?? '');
  return m ? decodeURIComponent(m[1].trim()) : '';
}

/**
 * คลิกปุ่มดาวน์โหลด/ส่งออกแล้วเก็บไฟล์จาก "คำขอเดียว" ที่ปุ่มสร้าง (ไม่ยิงซ้ำ → จำนวน Audit EXPORT ไม่เพี้ยน)
 * - ปุ่มที่ใช้ fetch/navigation: ดักด้วย route ที่ URL ตรง urlRe → ได้ status + header + เนื้อไฟล์
 * - ปุ่มที่เป็น <a href download>: Chromium ส่งตรงไปตัวจัดการดาวน์โหลด route มองไม่เห็น
 *   → ใช้ download event (หน้าเดิมหรือแท็บใหม่) ได้เนื้อไฟล์ + ชื่อไฟล์ · header ตรวจทีหลังด้วย headersOf()
 */
async function captureFromClick(page: Page, target: Locator, urlRe: RegExp): Promise<Captured> {
  let routed = null as Captured | null;
  let downloaded = null as Download | null;
  const handler = async (route: Route) => {
    try {
      const resp = await route.fetch();
      const body = await resp.body();
      const headers = resp.headers();
      const url = route.request().url();
      routed = { url, status: resp.status(), headers, body, fileName: dispositionName(headers), via: 'route' };
      await route.fulfill({ response: resp, body });
    } catch {
      await route.continue().catch(() => undefined);
    }
  };
  const onDownload = (d: Download) => {
    downloaded = d;
  };
  const onPage = (p: Page) => p.on('download', onDownload);
  const ctx = page.context();
  await ctx.route(urlRe, handler);
  page.on('download', onDownload);
  ctx.on('page', onPage);
  try {
    await target.click();
    await expect
      .poll(() => routed !== null || downloaded !== null, { message: `ไม่มีคำขอ ${urlRe} หรือ download หลังคลิก`, timeout: 20_000 })
      .toBe(true);
  } finally {
    await ctx.unroute(urlRe, handler).catch(() => undefined);
    page.off('download', onDownload);
    ctx.off('page', onPage);
  }
  if (routed) return routed;
  const d = downloaded as Download;
  expect(await d.failure(), `download ${d.url()} ล้มเหลว`).toBeNull();
  const file = await d.path();
  return { url: d.url(), status: null, headers: {}, body: fs.readFileSync(file), fileName: d.suggestedFilename(), via: 'download' };
}

/** ได้ไฟล์จริง: status 200 (ถ้าเห็น) และเนื้อไฟล์ไม่ว่าง */
function expectCapturedOk(got: Captured, label = ''): void {
  if (got.status !== null) expect(got.status, `${label} HTTP`).toBe(200);
  expect(got.body.length, `${label} ขนาดไฟล์`).toBeGreaterThan(0);
}

/**
 * status + header ของไฟล์ที่ได้จาก captureFromClick
 * ได้จาก download event → ขอ URL เดิมซ้ำด้วย cookie เดียวกัน 1 ครั้ง
 * (ถ้าเป็นการส่งออกที่ลง Audit ให้เรียกหลังตรวจจำนวน Audit แล้วเท่านั้น)
 */
async function headersOf(page: Page, got: Captured): Promise<{ status: number; headers: Record<string, string> }> {
  if (got.status !== null) return { status: got.status, headers: got.headers };
  expect(got.url, 'URL ของไฟล์ดาวน์โหลดต้องเป็น http(s) เพื่อตรวจ header').toMatch(/^https?:\/\//);
  const r = await page.context().request.get(got.url);
  return { status: r.status(), headers: r.headers() };
}

/** คลิกลิงก์ดาวน์โหลด รอ download (หน้าเดิมหรือแท็บใหม่) · ไม่เกิด download → อ่านจาก href ด้วย cookie เดียวกัน */
async function clickDownload(page: Page, target: Locator): Promise<{ name: string; body: Buffer }> {
  const ctx = page.context();
  const dl = new Promise<Download>((resolve) => {
    page.once('download', resolve);
    ctx.once('page', (p) => p.once('download', resolve));
  });
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), 10_000));
  await target.click();
  const d = await Promise.race([dl, timeout]);
  if (d) {
    const p = await d.path();
    return { name: d.suggestedFilename(), body: p ? fs.readFileSync(p) : Buffer.alloc(0) };
  }
  const href = await target.evaluate((el) => (el.closest('a') as HTMLAnchorElement | null)?.href ?? el.getAttribute('href') ?? '');
  expect(href, 'ไม่มี download และไม่มี href ให้เปิด').toBeTruthy();
  const r = await ctx.request.get(href);
  expect(r.status(), `GET ${href}`).toBe(200);
  return { name: href.split('/').pop() ?? '', body: await r.body() };
}

function expectPdfHeaders(status: number, headers: Record<string, string>, fileName?: string, label = ''): void {
  expect(status, `${label} HTTP`).toBe(200);
  expect(headers['content-type'] ?? '', `${label} Content-Type`).toContain('application/pdf');
  if (fileName) expect(headers['content-disposition'] ?? '', `${label} Content-Disposition`).toContain(fileName);
}

// ═════════════════════════════ ตัวอ่าน PDF / xlsx / CSV ═════════════════════════════

type CMap = { width: number; map: Map<string, string> };

function inflateMaybe(raw: Buffer): Buffer {
  const trimmed = raw.subarray(0, raw.length - (raw.subarray(-2).toString('latin1') === '\r\n' ? 2 : raw.subarray(-1)[0] === 0x0a ? 1 : 0));
  for (const c of [raw, trimmed]) {
    try {
      return zlib.inflateSync(c);
    } catch {
      /* ไม่ใช่ deflate หรือมีส่วนเกิน */
    }
    try {
      return zlib.inflateSync(c, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    } catch {
      /* ข้าม */
    }
  }
  return raw;
}

/** เนื้อหา stream ทั้งหมดในไฟล์ PDF (คลาย FlateDecode ถ้าได้) */
function pdfStreams(buf: Buffer): string[] {
  const s = buf.toString('latin1');
  const out: string[] = [];
  const re = /(?<!end)stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) break;
    out.push(inflateMaybe(buf.subarray(start, end)).toString('latin1'));
    re.lastIndex = end + 9;
  }
  return out;
}

const hexToStr = (h: string) => {
  let o = '';
  for (let i = 0; i + 1 < h.length; i += 2) o += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
  return o;
};
const utf16Hex = (h: string) => {
  let o = '';
  for (let i = 0; i + 3 < h.length; i += 4) o += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
  return o;
};

function parseCMaps(streams: string[]): CMap[] {
  const maps: CMap[] = [];
  for (const s of streams) {
    if (!s.includes('begincmap') && !s.includes('beginbfchar') && !s.includes('beginbfrange')) continue;
    const map = new Map<string, string>();
    const cs = /begincodespacerange\s*<([0-9A-Fa-f]+)>/.exec(s);
    let width = cs ? cs[1].length : 0;
    for (const blk of s.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const p of blk[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        map.set(p[1].toUpperCase(), utf16Hex(p[2]));
        width ||= p[1].length;
      }
    }
    for (const blk of s.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const p of blk[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([^\]]*)\])/g)) {
        const w = p[1].length;
        width ||= w;
        const lo = parseInt(p[1], 16);
        const hi = parseInt(p[2], 16);
        const key = (c: number) => c.toString(16).toUpperCase().padStart(w, '0');
        if (p[3] !== undefined) {
          const head = utf16Hex(p[3]);
          const base = head.charCodeAt(head.length - 1);
          for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(key(c), head.slice(0, -1) + String.fromCharCode(base + (c - lo)));
        } else {
          const dst = [...(p[4] ?? '').matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => utf16Hex(x[1]));
          dst.forEach((d, i) => map.set(key(lo + i), d));
        }
      }
    }
    if (map.size) maps.push({ width: width || 4, map });
  }
  return maps;
}

function unescapePdfLiteral(s: string): string {
  return s.replace(/\\(\d{1,3}|\r\n|[\s\S])/g, (_, e: string) => {
    if (/^\d+$/.test(e)) return String.fromCharCode(parseInt(e, 8));
    const m: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '\n': '', '\r\n': '', '\r': '' };
    return e in m ? m[e] : e;
  });
}

type PdfTok = { lit?: string; hex?: string; num?: number };

/** ข้อความในแต่ละ text object (BT…ET) ของ content stream · คืนหลายแบบถอดรหัส (ไบต์ตรง + ทุก ToUnicode) */
function pdfContentLines(content: string, cmaps: CMap[]): string[] {
  const lines: string[] = [];
  const STR = String.raw`\((?:\\[\s\S]|[^\\)])*\)|<[0-9A-Fa-f\s]*>`;
  const OP = new RegExp(String.raw`\[((?:${STR}|[^\]])*)\]\s*TJ|(${STR})\s*(?:Tj|'|")`, 'g');
  const ITEM = new RegExp(String.raw`(${STR})|(-?\d*\.?\d+)`, 'g');
  const toTok = (s: string): PdfTok =>
    s.startsWith('(') ? { lit: unescapePdfLiteral(s.slice(1, -1)) } : { hex: s.slice(1, -1).replace(/\s+/g, '') };
  for (const blk of content.split(/\bET\b/)) {
    const bt = blk.search(/\bBT\b/);
    if (bt < 0) continue;
    const toks: PdfTok[] = [];
    for (const m of blk.slice(bt).matchAll(OP)) {
      if (m[1] !== undefined) {
        for (const it of m[1].matchAll(ITEM)) {
          if (it[1] !== undefined) toks.push(toTok(it[1]));
          else toks.push({ num: Number(it[2]) });
        }
      } else if (m[2] !== undefined) toks.push(toTok(m[2]));
    }
    if (!toks.length) continue;
    const render = (dec: (hex: string) => string) =>
      toks.map((t) => (t.num !== undefined ? (t.num <= -200 ? ' ' : '') : t.lit ?? dec(t.hex ?? ''))).join('');
    lines.push(render(hexToStr));
    for (const cm of cmaps) {
      lines.push(
        render((h) => {
          let o = '';
          for (let i = 0; i + cm.width <= h.length; i += cm.width) o += cm.map.get(h.slice(i, i + cm.width).toUpperCase()) ?? '';
          return o;
        }),
      );
    }
  }
  return lines;
}

/**
 * ข้อความจาก PDF
 *  - all   = ไบต์ดิบ + stream ที่คลายแล้ว + ข้อความที่ถอดได้ (ใช้หา "บรรทัด ASCII ที่เครื่องอ่านได้")
 *  - text  = เฉพาะข้อความที่ดึงออกมา (ใช้ตรวจข้อมูลส่วนบุคคล ไม่ใช่ไบต์ดิบ · TEST-PLAN DASH-03)
 */
function pdfText(buf: Buffer): { all: string; text: string } {
  const raw = buf.toString('latin1');
  const streams = pdfStreams(buf);
  const cmaps = parseCMaps(streams);
  const lines = streams.flatMap((s) => pdfContentLines(s, cmaps));
  const asciiLines = [raw, ...streams]
    .flatMap((s) => s.split(/[\r\n]+/))
    .filter((l) => /(?:docNo=|kpi )/.test(l));
  const text = [...lines, ...asciiLines].join('\n');
  return { all: [raw, ...streams, ...lines].join('\n'), text };
}

/** แตกไฟล์ zip (xlsx) → ชื่อไฟล์ → เนื้อหา */
function unzip(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`ไม่ใช่ไฟล์ zip/xlsx (ขนาด ${buf.length} ไบต์ ขึ้นต้น ${JSON.stringify(buf.subarray(0, 8).toString('latin1'))})`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    files.set(name, method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const xmlDecode = (s: string) =>
  s.replace(/&(lt|gt|amp|quot|apos|#x[0-9a-fA-F]+|#\d+);/g, (_, e: string) =>
    e === 'lt'
      ? '<'
      : e === 'gt'
        ? '>'
        : e === 'amp'
          ? '&'
          : e === 'quot'
            ? '"'
            : e === 'apos'
              ? "'"
              : String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)),
  );
const xmlTexts = (s: string) => [...s.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => xmlDecode(m[1])).join('');

/** อ่าน xlsx: ชีตแรกเป็น map A1 → ข้อความ · allText = ข้อความทุกเซลล์ทุกชีต */
function readXlsx(buf: Buffer): { first: Map<string, string>; allText: string[] } {
  const files = unzip(buf);
  const str = (n: string) => files.get(n)?.toString('utf8') ?? '';
  const shared = [...str('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xmlTexts(m[1]));
  const sheetCells = (xml: string) => {
    const cells = new Map<string, string>();
    for (const c of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /\br="([A-Z]+\d+)"/.exec(c[1])?.[1];
      if (!ref) continue;
      const t = /\bt="([^"]+)"/.exec(c[1])?.[1];
      const inner = c[2] ?? '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let val = '';
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = xmlTexts(inner);
      else if (v !== undefined) val = xmlDecode(v);
      cells.set(ref, val);
    }
    return cells;
  };
  // ชีตแรกตาม workbook.xml → rels
  let firstPath = 'xl/worksheets/sheet1.xml';
  const rid = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(str('xl/workbook.xml'))?.[1];
  if (rid) {
    const rel = new RegExp(`<Relationship\\b[^>]*\\bId="${rid}"[^>]*>`).exec(str('xl/_rels/workbook.xml.rels'))?.[0];
    const target = rel && /\bTarget="([^"]+)"/.exec(rel)?.[1];
    if (target) firstPath = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  }
  const sheets = [...files.keys()].filter((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n));
  const first = sheetCells(str(files.has(firstPath) ? firstPath : sheets.sort()[0] ?? firstPath));
  const allText = [...shared, ...sheets.flatMap((n) => [...sheetCells(str(n)).values()])];
  return { first, allText };
}

/** CSV (RFC 4180) → แถว (ตัด BOM และแถวว่าง) */
function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(cur);
      cur = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
    } else cur += c;
  }
  if (cur !== '' || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** ข้อความต้องไม่มีเลข 13 หลัก เบอร์ 0xxxxxxxxx และชื่อผู้ยื่น (BR-24) */
function expectNoPii(texts: string[], label: string): void {
  const joined = texts.join('\n');
  expect(joined.match(/\d{13}/g) ?? [], `${label}: ไม่มีเลข 13 หลัก`).toEqual([]);
  expect(joined.match(/0\d{9}/g) ?? [], `${label}: ไม่มีเบอร์ 0\\d{9}`).toEqual([]);
  for (const n of NAMES) expect(joined.includes(n), `${label}: ไม่มีชื่อ ${n}`).toBe(false);
}

// ═════════════════════════════ ตัวช่วย API ═════════════════════════════

const approveApi = (api: APIRequestContext, caseNo: string) => api.post(`/api/cases/${caseNo}/approve`);
const rejectApi = (api: APIRequestContext, caseNo: string, reason = R10) =>
  api.post(`/api/cases/${caseNo}/reject`, { data: { reason } });
const forwardApi = (api: APIRequestContext, caseNo: string, note?: string) =>
  api.post(`/api/officer/cases/${caseNo}/forward`, { data: note ? { note } : {} });
const issueApi = (api: APIRequestContext, caseNo: string) => api.post(`/api/officer/cases/${caseNo}/issue`);
const unmaskApi = (api: APIRequestContext, caseNo: string, reason: string) =>
  api.post(`/api/officer/cases/${caseNo}/unmask`, { data: { reason } });

/** approve (SV-01 ผู้ถือ) → 200 APPROVED */
async function approveOk(api: APIRequestContext, caseNo: string): Promise<void> {
  const b = await expectStatus(await approveApi(api, caseNo), 200, `approve ${caseNo}`);
  expect(b?.status).toBe('APPROVED');
}

/** issue → 200 {docNo, verifyCode, status: COMPLETED} */
async function issueOk(api: APIRequestContext, caseNo: string, docNo?: string): Promise<{ docNo: string; verifyCode: string }> {
  const b = await expectStatus(await issueApi(api, caseNo), 200, `issue ${caseNo}`);
  expect(b?.status).toBe('COMPLETED');
  if (docNo) expect(b?.docNo).toBe(docNo);
  expect(String(b?.verifyCode ?? '')).toMatch(VERIFY_CODE_RE);
  return { docNo: b.docNo, verifyCode: b.verifyCode };
}

async function servicesApi(api: APIRequestContext): Promise<Record<string, any>> {
  const b = await expectStatus(await api.get('/api/admin/services'), 200, 'GET /api/admin/services');
  return Object.fromEntries((b?.items ?? []).map((i: any) => [i.id, i]));
}

/** มี key ชื่อ name ที่ชั้นใดก็ได้ */
function hasKeyDeep(v: unknown, name: string): boolean {
  if (Array.isArray(v)) return v.some((x) => hasKeyDeep(x, name));
  if (v && typeof v === 'object') return Object.entries(v).some(([k, x]) => k === name || hasKeyDeep(x, name));
  return false;
}

/** epoch ms ช่วงปี 2020–2030 (TEST-PLAN PDPA-02: "เลข 13 หลักอื่น เช่น epoch ms ไม่นับ") */
const isEpochMs = (n: number) => Number.isInteger(n) && n >= 1.6e12 && n < 1.9e12;

/** เลขบัตรใน JSON: \d{13} (ยกเว้น epoch ms ทั้งค่า) และรูปแบบมีขีด */
function idLeaks(body: unknown): string[] {
  const hits: string[] = [];
  const walk = (v: unknown, at: string) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/\d{13,}/g)) if (!(m[0] === v && isEpochMs(Number(v)))) hits.push(`${at} = "${v}"`);
      if (/\d-\d{4}-\d{5}-\d{2}-\d/.test(v)) hits.push(`${at} = "${v}"`);
    } else if (typeof v === 'number') {
      if (/\d{13}/.test(String(v)) && !isEpochMs(v)) hits.push(`${at} = ${v}`);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (/\d{13}|\d-\d{4}-\d{5}-\d{2}-\d/.test(k)) hits.push(`key ${at}.${k}`);
        walk(x, `${at}.${k}`);
      }
    }
  };
  walk(body, '$');
  return hits;
}

// ═════════════════════════════ WORKFLOW ═════════════════════════════

test('TC-WORKFLOW-01 SV-01 อนุมัติ + ออกเอกสาร', async ({ browser }) => {
  await RESET();
  const r2 = await LOGIN_S('off.reg2', browser);
  const page = r2.page;

  await test.step('1 ตรวจปุ่ม …000025 (SV-01 ฿60 ผู้ถือ off.reg2)', async () => {
    await page.goto(officerCase(EG(25)));
    await expectCaseStatus(page, 'IN_REVIEW');
    await expectCounts(page, { 'approve-btn': 1, 'return-btn': 1, 'reject-btn': 1, 'forward-btn': 0, 'issue-btn': 0 });
    await expect(page.getByTestId('case-fee')).toHaveText('฿60');
  });

  await test.step('2 off.reg1 approve …000026 (ผู้ถือ off.reg2) → 403 FORBIDDEN', async () => {
    const r1 = await LOGIN_S('off.reg1');
    await expectApiError(await approveApi(r1.api, EG(26)), 403, 'FORBIDDEN');
    expect((await getCase(r2.api, EG(26))).status).toBe('IN_REVIEW');
  });

  await test.step('3 approve-btn → อนุมัติ', async () => {
    await page.getByTestId('approve-btn').click();
    await expectCaseStatus(page, 'APPROVED');
    await expectCounts(page, { 'issue-btn': 1, 'approve-btn': 0 });
  });

  await test.step('4 issue-btn → เสร็จสิ้น DOC-2569-000002', async () => {
    await page.getByTestId('issue-btn').click();
    await expectCaseStatus(page, 'COMPLETED');
    await expect(page.getByTestId('doc-no')).toHaveText(DOC(2));
    await readVerifyCode(page);
    await expect(page.getByTestId('closed-at')).toHaveAttribute('data-iso', T0);
    await expectLevel(page.getByTestId('sla-level'), 'closed');
  });

  await test.step('5 สมหญิงเปิดคำขอและดาวน์โหลด PDF', async () => {
    const sy = await LOGIN_C(ID.SOMYING, browser);
    await sy.page.goto(citizenCase(EG(25)));
    await expectCaseStatus(sy.page, 'COMPLETED');
    await expect(sy.page.getByTestId('download-doc-btn')).toHaveCount(1);
    const got = await captureFromClick(sy.page, sy.page.getByTestId('download-doc-btn'), /\/api\/documents\/|\.pdf(\?|$)|\/pdf(\?|$)/);
    expectCapturedOk(got, 'download-doc-btn');
    expect(got.fileName, 'ชื่อไฟล์ที่ดาวน์โหลด').toBe(`${DOC(2)}.pdf`);
    expect(got.body.subarray(0, 5).toString('latin1'), 'เนื้อไฟล์เป็น PDF').toBe('%PDF-');
    expect(pdfText(got.body).all).toContain(`docNo=${DOC(2)} caseNo=${EG(25)}`);
    const h = await headersOf(sy.page, got);
    expectPdfHeaders(h.status, h.headers, `${DOC(2)}.pdf`, 'download-doc-btn');
  });

  await test.step('6 exec1 Dashboard ธ.ค. ALL: closed 1 · onTime 1 · received 3 · backlog 20', async () => {
    const ex = await LOGIN_S('exec1');
    expect(await dashApi(ex.api)).toMatchObject({ closed: 1, onTime: 1, received: 3, backlog: 20 });
  });
});

test('TC-WORKFLOW-02 SV-02 ผ่านหัวหน้า', async ({ browser }) => {
  await RESET();
  const r2 = await LOGIN_S('off.reg2', browser);
  const p2 = r2.page;

  await test.step('1 …000013 (SV-02): approve-btn 0 · forward-btn 1 · ไม่มี forward-target', async () => {
    await p2.goto(officerCase(EG(13)));
    await expectCaseStatus(p2, 'IN_REVIEW');
    await expectCounts(p2, { 'forward-btn': 1, 'approve-btn': 0, 'forward-target': 0 });
  });

  await test.step('2 forward-btn → รออนุมัติ · workload 8 · หายจากคิว', async () => {
    await p2.getByTestId('forward-btn').click();
    await expectCaseStatus(p2, 'PENDING_APPROVAL');
    await expect(await workloadUi(p2)).toHaveText('8');
    await expect(queueRow(p2, EG(12))).toHaveCount(1); // คิวโหลดแล้ว
    await expect(queueRow(p2, EG(13))).toHaveCount(0);
  });

  const hd = await LOGIN_S('head1', browser);
  await test.step('3 head1 /head/approvals = 3 แถว …13 → …14 → …11', async () => {
    await hd.page.goto('/head/approvals');
    await expect(hd.page.getByTestId('approval-row')).toHaveCount(3);
    expect(await attrsOf(hd.page.getByTestId('approval-row'), 'data-case-no')).toEqual([EG(13), EG(14), EG(11)]);
  });

  await test.step('4 approval-open …000013 → approve-btn 1 · reject-btn 1 · issue-btn 0', async () => {
    await approvalRow(hd.page, EG(13)).getByTestId('approval-open').click();
    await expectPath(hd.page, officerCase(EG(13)));
    await expectCaseStatus(hd.page, 'PENDING_APPROVAL');
    await expectCounts(hd.page, { 'approve-btn': 1, 'reject-btn': 1, 'issue-btn': 0 });
  });

  await test.step('5 head1 approve-btn → อนุมัติ · หัวหน้าไม่มี issue-btn', async () => {
    await hd.page.getByTestId('approve-btn').click();
    await expectCaseStatus(hd.page, 'APPROVED');
    await expect(hd.page.getByTestId('issue-btn')).toHaveCount(0);
  });

  await test.step('6 off.reg1 (ไม่ใช่ผู้รับเรื่อง) issue-btn 0 · API 403', async () => {
    const r1 = await LOGIN_S('off.reg1', browser);
    await r1.page.goto(officerCase(EG(13)));
    await expectCaseStatus(r1.page, 'APPROVED');
    await expect(r1.page.getByTestId('issue-btn')).toHaveCount(0);
    await expectApiError(await issueApi(r1.api, EG(13)), 403, 'FORBIDDEN');
  });

  await test.step('7 off.reg2 issue-btn → เสร็จสิ้น DOC-2569-000002 · verify-signer = หัวหน้าฝ่าย', async () => {
    await p2.goto(officerCase(EG(13)));
    await expect(p2.getByTestId('issue-btn')).toHaveCount(1);
    await p2.getByTestId('issue-btn').click();
    await expectCaseStatus(p2, 'COMPLETED');
    await expect(p2.getByTestId('doc-no')).toHaveText(DOC(2));
    await expectSigner(browser, await readVerifyCode(p2), SIGNER.head);
  });

  await test.step('8 RESET · off.reg1 ออกเอกสาร seed …000019 (APPROVED โดย head1)', async () => {
    await RESET();
    const r1 = await LOGIN_S('off.reg1', browser);
    await r1.page.goto(officerCase(EG(19)));
    await expectCaseStatus(r1.page, 'APPROVED');
    await r1.page.getByTestId('issue-btn').click();
    await expectCaseStatus(r1.page, 'COMPLETED');
    await expect(r1.page.getByTestId('doc-no')).toHaveText(DOC(2));
    await expectSigner(browser, await readVerifyCode(r1.page), SIGNER.head);
  });
});

test('TC-WORKFLOW-03 SV-03 สามขั้นตอน', async ({ browser }) => {
  await RESET();
  const r2 = await LOGIN_S('off.reg2', browser);
  const p2 = r2.page;

  await test.step('1 …000012 ขั้นตอน 1/3 · ฝ่ายทะเบียน · ฿1,010 · forward-btn 1', async () => {
    await p2.goto(officerCase(EG(12)));
    await expect(p2.getByTestId('case-step')).toHaveText('ขั้นตอน 1/3 · ฝ่ายทะเบียน');
    await expect(p2.getByTestId('case-fee')).toHaveText('฿1,010');
    await expect(p2.getByTestId('forward-btn')).toHaveCount(1);
  });

  await test.step('2 forward-btn → ยัง IN_REVIEW · ขั้นตอน 2/3 · ฝ่ายโยธา · ยังไม่มีผู้รับ · workload 8', async () => {
    await p2.getByTestId('forward-btn').click();
    await expect(p2.getByTestId('case-step')).toHaveText('ขั้นตอน 2/3 · ฝ่ายโยธา');
    await expectCaseStatus(p2, 'IN_REVIEW');
    await expect(p2.getByTestId('case-owner')).toHaveText('ยังไม่มีผู้รับ');
    await expect(await workloadUi(p2)).toHaveText('8');
  });

  await test.step('3 คิว off.reg2 ไม่มี …000012 (เหลือ 16 แถว)', async () => {
    await p2.goto('/officer/queue');
    await expect(p2.getByTestId('queue-row')).toHaveCount(16);
    await expect(queueRow(p2, EG(12))).toHaveCount(0);
  });

  const w1 = await LOGIN_S('off.works1', browser);
  await test.step('4 คิว off.works1 = …000010 → …000012 · claim-btn 2', async () => {
    await w1.page.goto('/officer/queue');
    await expect(w1.page.getByTestId('queue-row')).toHaveCount(2);
    expect(await attrsOf(w1.page.getByTestId('queue-row'), 'data-case-no')).toEqual([EG(10), EG(12)]);
    await expect(w1.page.getByTestId('claim-btn')).toHaveCount(2);
  });

  await test.step('5 off.reg1 claim …000012 (ข้ามแผนก) → 403', async () => {
    const r1 = await LOGIN_S('off.reg1');
    await expectApiError(await claimApi(r1.api, EG(12)), 403, 'FORBIDDEN');
  });

  await test.step('6 off.works1 claim แล้วส่งต่อ → รออนุมัติ · ขั้นตอน 3/3 · หัวหน้าฝ่าย', async () => {
    await queueRow(w1.page, EG(12)).getByTestId('claim-btn').click();
    await expect.poll(async () => (await getCase(w1.api, EG(12))).owner).toBe('off.works1');
    await w1.page.goto(officerCase(EG(12)));
    await expect(w1.page.getByTestId('case-owner')).toHaveText('off.works1');
    await w1.page.getByTestId('forward-btn').click();
    await expectCaseStatus(w1.page, 'PENDING_APPROVAL');
    await expect(w1.page.getByTestId('case-step')).toHaveText('ขั้นตอน 3/3 · หัวหน้าฝ่าย');
  });

  await test.step('7 head1 เห็น …000012 (รวม 3 แถว) → อนุมัติ', async () => {
    const hd = await LOGIN_S('head1', browser);
    await hd.page.goto('/head/approvals');
    await expect(hd.page.getByTestId('approval-row')).toHaveCount(3);
    await expect(approvalRow(hd.page, EG(12))).toHaveCount(1);
    await approvalRow(hd.page, EG(12)).getByTestId('approval-open').click();
    await expectPath(hd.page, officerCase(EG(12)));
    await hd.page.getByTestId('approve-btn').click();
    await expectCaseStatus(hd.page, 'APPROVED');
  });

  await test.step('8 off.works1 issue-btn 0 · off.reg2 (ทะเบียนขั้นแรก) ออกเอกสาร · signer หัวหน้าฝ่าย', async () => {
    await w1.page.goto(officerCase(EG(12)));
    await expectCaseStatus(w1.page, 'APPROVED');
    await expect(w1.page.getByTestId('issue-btn')).toHaveCount(0);
    await p2.goto(officerCase(EG(12)));
    await expect(p2.getByTestId('issue-btn')).toHaveCount(1);
    await p2.getByTestId('issue-btn').click();
    await expectCaseStatus(p2, 'COMPLETED');
    await expectSigner(browser, await readVerifyCode(p2), SIGNER.head);
  });
});

test('TC-WORKFLOW-04 ตีกลับสูงสุด 2 ครั้ง และผลหลังครบ', async ({ browser }) => {
  await test.step('ส่วน A …000020 (SV-01): ครั้งที่ 1, 2 ✓ · ครั้งที่ 3 ✗ · ยังอนุมัติ/ไม่อนุมัติได้', async () => {
    await RESET();
    const r1 = await LOGIN_S('off.reg1', browser);
    const sc = await LOGIN_C(ID.SOMCHAI);
    const p = r1.page;
    await p.goto(officerCase(EG(20)));
    await expect(p.getByTestId('return-count')).toHaveText('0');

    for (const n of [1, 2]) {
      await p.goto(officerCase(EG(20)));
      await returnUi(p, R10);
      await expectCaseStatus(p, 'NEED_FIX');
      await expect(p.getByTestId('return-count'), `return-count หลังตีกลับครั้งที่ ${n}`).toHaveText(String(n));
      await expectStatus(await resubmitApi(sc.api, EG(20)), 200, `สมชายส่งแก้ครั้งที่ ${n}`);
      const k = await getCase(r1.api, EG(20));
      expect(k.status).toBe('IN_REVIEW');
      expect(k.owner, 'กลับไปผู้ถือเดิม').toBe('off.reg1');
    }

    await p.goto(officerCase(EG(20)));
    await expectCaseStatus(p, 'IN_REVIEW');
    await expect(p.getByTestId('return-count')).toHaveText('2');
    await expectCounts(p, { 'return-btn': 0, 'approve-btn': 1, 'reject-btn': 1 });
    await expectApiError(await returnApi(r1.api, EG(20), R10), 409, 'RETURN_LIMIT', MSG.RETURN_LIMIT);
    const k = await getCase(r1.api, EG(20));
    expect(k.status).toBe('IN_REVIEW');
    expect(k.returnCount).toBe(2);
  });

  await test.step('ส่วน B seed …000023 ตีกลับแล้ว 2 ครั้ง', async () => {
    await RESET();
    const r1 = await LOGIN_S('off.reg1', browser);
    const p = r1.page;
    await p.goto(officerCase(EG(23)));
    await expectCaseStatus(p, 'IN_REVIEW');
    await expect(p.getByTestId('return-count')).toHaveText('2');
    await expectCounts(p, { 'return-btn': 0, 'approve-btn': 1, 'reject-btn': 1 });
    await expectApiError(await returnApi(r1.api, EG(23), R10), 409, 'RETURN_LIMIT', MSG.RETURN_LIMIT);
    expect((await getCase(r1.api, EG(23))).status).toBe('IN_REVIEW');
  });

  await test.step('ส่วน C …000013 (SV-02) หลังตีกลับครบ: ไม่มี return/approve/reject · ส่งต่อพร้อมหมายเหตุ', async () => {
    await RESET();
    const r2 = await LOGIN_S('off.reg2', browser);
    const sc = await LOGIN_C(ID.SOMCHAI);
    const p = r2.page;
    for (const n of [1, 2]) {
      await p.goto(officerCase(EG(13)));
      await returnUi(p, R10);
      await expectCaseStatus(p, 'NEED_FIX');
      await expectStatus(await resubmitApi(sc.api, EG(13)), 200, `สมชายส่งแก้ครั้งที่ ${n}`);
    }
    await p.goto(officerCase(EG(13)));
    await expectCaseStatus(p, 'IN_REVIEW');
    await expect(p.getByTestId('return-count')).toHaveText('2');
    await expectCounts(p, { 'return-btn': 0, 'approve-btn': 0, 'reject-btn': 0, 'forward-btn': 1 });
    await expectStatus(await rejectApi(r2.api, EG(13), R10), 403, 'off.reg2 reject SV-02');

    await p.getByTestId('forward-note').fill(FORWARD_NOTE);
    await p.getByTestId('forward-btn').click();
    await expectCaseStatus(p, 'PENDING_APPROVAL');

    const au = await LOGIN_S('audit1', browser);
    await au.page.goto('/audit');
    await auditFilterUi(au.page, { event: 'FORWARD' });
    const row = rowBy(au.page, 'audit-row', 'data-case-no', EG(13));
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('audit-detail')).toContainText(FORWARD_NOTE);
    const api = (await auditApi(au.api, { event: 'FORWARD' })).items.filter((i) => i.caseNo === EG(13));
    expect(api.map((i) => String(i.detail))).toEqual([expect.stringContaining(FORWARD_NOTE)]);

    const hd = await LOGIN_S('head1', browser);
    await hd.page.goto(officerCase(EG(13)));
    await expectCounts(hd.page, { 'reject-btn': 1, 'approve-btn': 1 });
  });
});

test('TC-WORKFLOW-05 เหตุผล ≥ 10 ตัวอักษร (ตีกลับ / ไม่อนุมัติ)', async ({ browser }) => {
  await test.step('ส่วน A ตีกลับ …000020 (off.reg1)', async () => {
    await RESET();
    const r1 = await LOGIN_S('off.reg1', browser);
    const p = r1.page;
    const bad: Array<[string, string]> = [
      [R9, '9 ตัว'],
      [SP10, 'เว้นวรรคล้วน 10 ตัว'],
    ];
    for (const [reason, why] of bad) {
      await p.goto(officerCase(EG(20)));
      await returnUi(p, reason);
      await expect(p.getByTestId('return-reason-error'), why).toHaveText(MSG.REASON_TOO_SHORT);
      await expectApiError(await returnApi(r1.api, EG(20), reason), 400, 'REASON_TOO_SHORT', MSG.REASON_TOO_SHORT, why);
      await expect(p.getByTestId('case-status')).toHaveText(STATUS_TH.IN_REVIEW);
      expect((await getCase(r1.api, EG(20))).status, why).toBe('IN_REVIEW');
    }
    await p.goto(officerCase(EG(20)));
    await returnUi(p, R10);
    await expectCaseStatus(p, 'NEED_FIX');
    const sc = await LOGIN_C(ID.SOMCHAI, browser);
    await sc.page.goto(citizenCase(EG(20)));
    await expect(sc.page.getByTestId('return-reason-display')).toHaveText(R10);
  });

  await test.step('ส่วน B ไม่อนุมัติ SV-01 …000026 (off.reg2)', async () => {
    await RESET();
    const r2 = await LOGIN_S('off.reg2', browser);
    const p = r2.page;
    await p.goto(officerCase(EG(26)));
    await rejectUi(p, R9);
    await expect(p.getByTestId('reject-reason-error')).toHaveText(MSG.REASON_TOO_SHORT);
    await expectApiError(await rejectApi(r2.api, EG(26), R9), 400, 'REASON_TOO_SHORT');
    expect((await getCase(r2.api, EG(26))).status).toBe('IN_REVIEW');

    await p.goto(officerCase(EG(26)));
    await rejectUi(p, R10);
    await expectCaseStatus(p, 'REJECTED');
    await expect(p.getByTestId('closed-at')).toHaveAttribute('data-iso', T0);
    await expectLevel(p.getByTestId('sla-level'), 'closed');

    const sc = await LOGIN_C(ID.SOMCHAI, browser);
    await sc.page.goto(citizenCase(EG(26)));
    await expectCaseStatus(sc.page, 'REJECTED');
    await expect(sc.page.getByTestId('no-refund-note')).toHaveText(MSG.NO_REFUND);

    const ex = await LOGIN_S('exec1');
    expect(await dashApi(ex.api)).toMatchObject({ closed: 1, onTime: 1 });
  });

  await test.step('ส่วน C head1 ไม่อนุมัติ …000011', async () => {
    await RESET();
    const hd = await LOGIN_S('head1', browser);
    const p = hd.page;
    await p.goto(officerCase(EG(11)));
    await rejectUi(p, R9);
    await expect(p.getByTestId('reject-reason-error')).toHaveText(MSG.REASON_TOO_SHORT);
    await expectApiError(await rejectApi(hd.api, EG(11), R9), 400, 'REASON_TOO_SHORT');
    expect((await getCase(hd.api, EG(11))).status).toBe('PENDING_APPROVAL');
    await p.goto(officerCase(EG(11)));
    await rejectUi(p, R10);
    await expectCaseStatus(p, 'REJECTED');
  });
});

test('TC-WORKFLOW-06 เวลาแก้ไข 168 ชั่วโมง', async ({ browser }) => {
  const DEADLINE = '2026-12-04T14:00:00+07:00';

  await test.step('หน้าตั้งต้น …000017 (ตีกลับครั้งที่ 2 เมื่อ 27 พ.ย. 14:00)', async () => {
    await RESET();
    const sc = await LOGIN_C(ID.SOMCHAI, browser);
    const p = sc.page;
    await p.goto(citizenCase(EG(17)));
    await expectCaseStatus(p, 'NEED_FIX');
    await expect(p.getByTestId('return-reason-display')).toHaveText('ชื่อในเอกสารไม่ตรงกับบัตร กรุณาแก้ไข');
    await expect(p.getByTestId('fix-deadline')).toHaveText('4 ธ.ค. 2569 14:00');
    await expect(p.getByTestId('fix-deadline')).toHaveAttribute('data-iso', DEADLINE);
    await expect(p.getByTestId('submit-fix-btn')).toHaveCount(1);
  });

  await test.step('รอบ A 167:59 → ส่งแก้ได้ → กำลังตรวจสอบ', async () => {
    await RESET();
    await CLOCK('2026-12-04T13:59:00+07:00');
    const sc = await LOGIN_C(ID.SOMCHAI, browser);
    const p = sc.page;
    await p.goto(citizenCase(EG(17)));
    await expect(p.getByTestId('submit-fix-btn')).toBeEnabled();
    const resubmitted = p.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/cases/${EG(17)}/resubmit`,
      { timeout: 15_000 },
    );
    await p.getByTestId('submit-fix-btn').click();
    const rr = await resubmitted;
    expect(rr.status(), `ส่งแก้ที่ 167:59 → ${rr.status()} ${(await rr.text().catch(() => '')).slice(0, 200)}`).toBe(200);
    await expectCaseStatus(p, 'IN_REVIEW');
    expect((await getCase(sc.api, EG(17))).status).toBe('IN_REVIEW');
  });

  await test.step('รอบ B 168:00 → ยกเลิกอัตโนมัติ · resubmit 409 · timeline 14:00 · backlog 20', async () => {
    await RESET();
    await CLOCK(DEADLINE);
    const sc = await LOGIN_C(ID.SOMCHAI, browser);
    const p = sc.page;
    await p.goto(citizenCase(EG(17)));
    await expectCaseStatus(p, 'CANCELLED');
    await expect(p.getByTestId('submit-fix-btn')).toHaveCount(0);
    await expect(p.getByTestId('no-refund-note')).toHaveText(MSG.NO_REFUND);
    await expectStatus(await resubmitApi(sc.api, EG(17)), 409, 'resubmit หลังเส้นตาย');
    await expect(
      p.getByTestId('case-timeline').locator(`[data-testid="timeline-item"][data-iso="${DEADLINE}"]`),
      'timeline-item เวลายกเลิก',
    ).not.toHaveCount(0);
    const ex = await LOGIN_S('exec1');
    expect((await dashApi(ex.api)).backlog).toBe(20);
  });
});

// ═════════════════════════════ DOC ═════════════════════════════

test('TC-DOC-01 ออกเอกสารและข้อมูลในเอกสาร', async ({ browser }) => {
  await RESET();
  const r2 = await LOGIN_S('off.reg2', browser);
  await approveOk(r2.api, EG(25));
  const issuedRes = await issueApi(r2.api, EG(25));
  const issued = await expectStatus(issuedRes, 200, 'issue …000025');
  expect(issued).toMatchObject({ docNo: DOC(2), status: 'COMPLETED' });
  const code: string = issued.verifyCode;
  expect(code).toMatch(VERIFY_CODE_RE);
  const anon = await newApi();

  await test.step('สมหญิงดาวน์โหลด PDF: header + บรรทัด ASCII', async () => {
    const sy = await LOGIN_C(ID.SOMYING);
    const r = await sy.api.get(`/api/documents/${DOC(2)}/pdf`);
    expectPdfHeaders(r.status(), r.headers(), `${DOC(2)}.pdf`, 'GET pdf');
    expect(pdfText(await r.body()).all, 'บรรทัด docNo=… ใน PDF').toMatch(
      new RegExp(`(?<![\\w=-])docNo=${DOC(2)} caseNo=${EG(25)} verify=${code} validUntil=2027-02-28(?![\\w-])`),
    );
  });

  await test.step('หน้า /verify/<code> (ไม่ล็อกอิน)', async () => {
    const { page } = await newBrowserContext(browser);
    await expectVerifyAt(page, anon, code, 'VALID', '2027-02-28');
    await expect(page.getByTestId('verify-doc-no')).toHaveText(DOC(2));
    await expect(page.getByTestId('verify-applicant')).toHaveText('สมหญิง ร***');
    await expect(page.getByTestId('verify-service')).toHaveText('SV-01 ขอหนังสือรับรอง');
    await expect(page.getByTestId('verify-issued')).toHaveAttribute('data-iso', T0);
    await expect(page.getByTestId('verify-signer')).toHaveText(SIGNER.reg2);
  });

  await test.step('doc-qr data-url = <BASE_URL>/verify/<code> (หน้าเจ้าหน้าที่และประชาชน)', async () => {
    await r2.page.goto(officerCase(EG(25)));
    await expect(r2.page.getByTestId('doc-qr')).toHaveAttribute('data-url', `${BASE_URL}/verify/${code}`);
    const sy = await LOGIN_C(ID.SOMYING, browser);
    await sy.page.goto(citizenCase(EG(25)));
    await expect(sy.page.getByTestId('doc-qr')).toHaveAttribute('data-url', `${BASE_URL}/verify/${code}`);
  });

  await test.step('GET /api/verify/<code> → VALID · validUntil · issuedAt', async () => {
    const b = await expectStatus(await anon.get(`/api/verify/${code}`), 200);
    expect(b).toMatchObject({ result: 'VALID', validUntil: '2027-02-28', issuedAt: T0 });
  });

  await test.step('สมชาย (ไม่ใช่ผู้ยื่น) ขอ PDF → 404', async () => {
    const sc = await LOGIN_C(ID.SOMCHAI);
    await expectStatus(await sc.api.get(`/api/documents/${DOC(2)}/pdf`), 404);
  });

  await test.step('ออกซ้ำ → 409 INVALID_STATE · เอกสารถัดไปยังเป็น DOC-2569-000003', async () => {
    await expectApiError(await issueApi(r2.api, EG(25)), 409, 'INVALID_STATE');
    const r1 = await LOGIN_S('off.reg1');
    await issueOk(r1.api, EG(19), DOC(3));
  });
});

test('TC-DOC-02 ตรวจเอกสาร /verify', async ({ browser }) => {
  await RESET();
  const { page } = await newBrowserContext(browser);
  const anon = await newApi();

  await test.step(`/verify/${SEED_CODE} → เอกสารถูกต้อง (ไม่ redirect)`, async () => {
    await expectVerifyAt(page, anon, SEED_CODE, 'VALID', '2027-02-02');
    await expect(page.getByTestId('verify-doc-no')).toHaveText(DOC(1));
    await expect(page.getByTestId('verify-applicant')).toHaveText('สมชาย ใ***');
    await expect(page.getByTestId('verify-service')).toHaveText('SV-01 ขอหนังสือรับรอง');
    await expect(page.getByTestId('verify-issued')).toHaveAttribute('data-iso', '2026-11-05T10:00:00+07:00');
    await expect(page.getByTestId('verify-signer')).toHaveText(SIGNER.reg1);
  });

  await test.step('PDPA: หน้าไม่มี ใจดี และเลขบัตร', async () => {
    const text = await page.locator('body').innerText();
    const html = await page.content();
    for (const s of ['ใจดี', ID.SOMCHAI]) {
      expect(text.includes(s), `innerText มี ${s}`).toBe(false);
      expect(html.includes(s), `HTML มี ${s}`).toBe(false);
    }
  });

  await test.step('/verify/ZZZZZZZZ → 404 ไม่พบเอกสาร', async () => {
    await expectVerifyAt(page, anon, 'ZZZZZZZZ', 'NOT_FOUND');
    await expectCounts(page, { 'verify-applicant': 0, 'verify-doc-no': 0 });
  });

  await test.step('API /api/verify', async () => {
    expect(await expectStatus(await anon.get(`/api/verify/${SEED_CODE}`), 200)).toMatchObject({
      result: 'VALID',
      applicantMasked: 'สมชาย ใ***',
    });
    expect(await expectStatus(await anon.get('/api/verify/ZZZZZZZZ'), 404)).toMatchObject({ result: 'NOT_FOUND' });
  });
});

test('TC-DOC-03 เอกสารหมดอายุและลายเซ็นไม่ตรง', async ({ browser }) => {
  await test.step('ส่วน A SV-01 ออก 1 ธ.ค. 69 → ใช้ได้ถึง 28 ก.พ. 70', async () => {
    await RESET();
    const r2 = await LOGIN_S('off.reg2');
    await approveOk(r2.api, EG(25));
    const { verifyCode: c1 } = await issueOk(r2.api, EG(25));
    const { page } = await newBrowserContext(browser);
    const anon = await newApi();
    await CLOCK('2027-02-28T23:59:00+07:00');
    await expectVerifyAt(page, anon, c1, 'VALID', '2027-02-28');
    await CLOCK('2027-03-01T00:00:00+07:00');
    await expectVerifyAt(page, anon, c1, 'EXPIRED', '2027-02-28');
  });

  await test.step('ส่วน B SV-02 ออก 1 ธ.ค. 69 → ใช้ได้ถึง 30 พ.ย. 70', async () => {
    await RESET();
    const r1 = await LOGIN_S('off.reg1');
    const { verifyCode: c2 } = await issueOk(r1.api, EG(19));
    const { page } = await newBrowserContext(browser);
    const anon = await newApi();
    await CLOCK('2027-11-30T23:59:00+07:00');
    await expectVerifyAt(page, anon, c2, 'VALID', '2027-11-30');
    await CLOCK('2027-12-01T00:00:00+07:00');
    await expectVerifyAt(page, anon, c2, 'EXPIRED');
  });

  await test.step(`ส่วน C seed ${SEED_CODE} ใช้ได้ถึง 2 ก.พ. 70`, async () => {
    await RESET();
    const { page } = await newBrowserContext(browser);
    const anon = await newApi();
    await CLOCK('2027-02-02T23:59:00+07:00');
    await expectVerifyAt(page, anon, SEED_CODE, 'VALID', '2027-02-02');
    await CLOCK('2027-02-03T00:00:00+07:00');
    await expectVerifyAt(page, anon, SEED_CODE, 'EXPIRED', '2027-02-02');
  });

  await test.step('ส่วน E ออกวันที่ 29 ก.พ. 2571 → DOC-2571-000001/2 · SV-01 +89 วัน · SV-02 ครบรอบ − 1 วัน', async () => {
    await RESET();
    await CLOCK('2028-02-29T10:00:00+07:00');
    const r2 = await LOGIN_S('off.reg2');
    const r1 = await LOGIN_S('off.reg1');
    await approveOk(r2.api, EG(25));
    const { verifyCode: e1 } = await issueOk(r2.api, EG(25), DOC(1, 2571));
    const { verifyCode: e2 } = await issueOk(r1.api, EG(19), DOC(2, 2571));
    const { page } = await newBrowserContext(browser);
    const anon = await newApi();
    await CLOCK('2028-05-28T23:59:00+07:00');
    await expectVerifyAt(page, anon, e1, 'VALID', '2028-05-28');
    await CLOCK('2028-05-29T00:00:00+07:00');
    await expectVerifyAt(page, anon, e1, 'EXPIRED', '2028-05-28');
    await CLOCK('2029-02-27T23:59:00+07:00');
    await expectVerifyAt(page, anon, e2, 'VALID', '2029-02-27');
    await CLOCK('2029-02-28T00:00:00+07:00');
    await expectVerifyAt(page, anon, e2, 'EXPIRED', '2029-02-27');
  });

  await test.step('ส่วน D tamper DOC-2569-000001 → ลายเซ็นไม่ถูกต้อง (แม้หมดอายุด้วย)', async () => {
    await RESET();
    const anon = await newApi();
    expect(await expectStatus(await anon.post(`/api/test/documents/${DOC(1)}/tamper`), 200)).toMatchObject({ ok: true });
    const { page } = await newBrowserContext(browser);
    await expectVerifyAt(page, anon, SEED_CODE, 'TAMPERED');
    await expectCounts(page, { 'verify-doc-no': 0, 'verify-applicant': 0 });
    await CLOCK('2027-03-01T00:00:00+07:00');
    await expectVerifyAt(page, anon, SEED_CODE, 'TAMPERED');
    await expectCounts(page, { 'verify-doc-no': 0, 'verify-applicant': 0 });
  });
});

// ═════════════════════════════ PDPA ═════════════════════════════

test('TC-PDPA-01 ปิดบังเลขบัตรบนจอ', async ({ browser }) => {
  await RESET();
  const r2 = await LOGIN_S('off.reg2', browser);

  await test.step('off.reg2 /officer/queue: row-id-masked ทุกแถว', async () => {
    await r2.page.goto('/officer/queue');
    const cells = r2.page.getByTestId('row-id-masked');
    await expect(cells).toHaveCount(17);
    for (const t of await cells.allInnerTexts()) expect(t.trim()).toMatch(MASK_RE);
    await expect(queueRow(r2.page, EG(25)).getByTestId('row-id-masked')).toHaveText('X-XXXX-XXXXX-65-9');
    await expect(queueRow(r2.page, EG(26)).getByTestId('row-id-masked')).toHaveText('X-XXXX-XXXXX-45-6');
  });

  await test.step('off.reg2 หน้าคำขอ …000025: applicant-id ปิดบัง · HTML ไม่มีเลขเต็ม', async () => {
    await r2.page.goto(officerCase(EG(25)));
    await expect(r2.page.getByTestId('applicant-id')).toHaveText('X-XXXX-XXXXX-65-9');
    const html = await r2.page.content();
    expect(html.includes(ID.SOMYING), 'HTML มี 3100600987659').toBe(false);
    expect(html.includes('3-1006-00987-65-9'), 'HTML มี 3-1006-00987-65-9').toBe(false);
  });

  await test.step('head1 หน้าคำขอ …000025 ปิดบังเหมือนกัน', async () => {
    const hd = await LOGIN_S('head1', browser);
    await hd.page.goto(officerCase(EG(25)));
    await expect(hd.page.getByTestId('applicant-id')).toHaveText('X-XXXX-XXXXX-65-9');
  });

  await test.step('ประชาชนเห็นเลขของตัวเองเต็ม', async () => {
    const sy = await LOGIN_C(ID.SOMYING, browser);
    await sy.page.goto(citizenCase(EG(25)));
    await expect(sy.page.getByTestId('case-id-full')).toHaveText('3-1006-00987-65-9');
    const sc = await LOGIN_C(ID.SOMCHAI, browser);
    await sc.page.goto(citizenCase(EG(20)));
    await expect(sc.page.getByTestId('case-id-full')).toHaveText('1-1017-00123-45-6');
  });
});

test('TC-PDPA-02 API (JSON) ไม่ส่งเลขบัตรเต็ม', async () => {
  await RESET();
  const endpoints = [
    '/api/officer/queue?filter=all',
    `/api/cases/${EG(25)}`,
    `/api/cases/${EG(26)}`,
    `/api/cases/${EG(20)}`,
    '/api/notifications',
    `/api/cases/${EG(25)}/files`,
  ];
  for (const user of ['off.reg1', 'head1'] as StaffUser[]) {
    await test.step(`${user}: ทุก response JSON ไม่มีเลขบัตร`, async () => {
      const s = await LOGIN_S(user);
      for (const ep of endpoints) {
        const res = await s.api.get(ep);
        const label = `${user} GET ${ep}`;
        expect.soft(res.status(), label).toBe(200);
        expect.soft(res.headers()['content-type'] ?? '', `${label} Content-Type`).toContain('application/json');
        const text = await res.text();
        let body: any = null;
        try {
          body = JSON.parse(text);
        } catch {
          expect.soft(false, `${label} ไม่ใช่ JSON: ${text.slice(0, 200)}`).toBe(true);
          continue;
        }
        expect.soft(idLeaks(body), `${label} เลข 13 หลัก / d-dddd-ddddd-dd-d`).toEqual([]);
        expect.soft(hasKeyDeep(body, 'idNo'), `${label} มี key idNo`).toBe(false);
        for (const id of [ID.SOMYING, ID.SOMCHAI, ID.PITI]) {
          expect.soft(JSON.stringify(body).includes(id), `${label} มี ${id}`).toBe(false);
        }
        if (ep.startsWith('/api/officer/queue')) {
          // TEST-DATA §9.1: คิวทะเบียน filter all = 17 แถว (กำหนดไว้เฉพาะ off.reg1/off.reg2 · head ไม่ได้กำหนดจำนวน)
          if (user === 'off.reg1') expect.soft((body?.items ?? []).length, `${label} items`).toBe(17);
          else expect.soft((body?.items ?? []).length, `${label} items`).toBeGreaterThan(0);
          for (const it of body?.items ?? []) expect.soft(String(it?.idMasked), `${label} ${it?.caseNo} idMasked`).toMatch(MASK_RE);
        } else if (/^\/api\/cases\/[^/]+$/.test(ep)) {
          expect.soft(String(body?.idMasked), `${label} idMasked`).toMatch(MASK_RE);
        } else {
          for (const it of body?.items ?? []) if (it && 'idMasked' in it) expect.soft(String(it.idMasked)).toMatch(MASK_RE);
        }
      }
    });
  }
});

test('TC-PDPA-03 แสดงเลขเต็มต้องมีเหตุผลและบันทึก Audit', async ({ browser }) => {
  await RESET();
  const r2 = await LOGIN_S('off.reg2', browser);
  const p = r2.page;
  await p.goto(officerCase(EG(25)));

  await test.step('1 เหตุผลว่าง → กรุณากรอกเหตุผล · API 400 REASON_REQUIRED', async () => {
    await unmaskUi(p, '');
    await expect(p.getByTestId('unmask-error')).toHaveText(MSG.REASON_REQUIRED);
    await expect(p.getByTestId('full-id')).toHaveCount(0);
    await expectApiError(await unmaskApi(r2.api, EG(25), ''), 400, 'REASON_REQUIRED', MSG.REASON_REQUIRED);
  });

  await test.step('2 เหตุผลเว้นวรรคล้วน → ข้อความเดียวกัน', async () => {
    await unmaskUi(p, '     ');
    await expect(p.getByTestId('unmask-error')).toHaveText(MSG.REASON_REQUIRED);
    await expect(p.getByTestId('full-id')).toHaveCount(0);
    await expectApiError(await unmaskApi(r2.api, EG(25), '     '), 400, 'REASON_REQUIRED');
  });

  await test.step('3 เหตุผล ตรวจสอบตัวตนซ้ำ → full-id', async () => {
    await unmaskUi(p, UNMASK_REASON);
    await expect(p.getByTestId('full-id')).toHaveText('3-1006-00987-65-9');
  });

  await test.step('4 โหลดหน้าซ้ำ → ปิดบังตามเดิม', async () => {
    await p.reload();
    await expect(p.getByTestId('applicant-id')).toHaveText('X-XXXX-XXXXX-65-9');
    await expect(p.getByTestId('full-id')).toHaveCount(0);
  });

  const au = await LOGIN_S('audit1', browser);
  await test.step('5 audit1 กรอง UNMASK → 1 แถว (ความพยายามที่ผิดไม่ถูกบันทึก)', async () => {
    await au.page.goto('/audit');
    await auditFilterUi(au.page, { event: 'UNMASK' });
    await expectAuditCount(au.page, 1, 'UNMASK');
    const row = au.page.getByTestId('audit-row');
    await expect(row).toHaveAttribute('data-actor', 'off.reg2');
    await expect(row.getByTestId('audit-role')).toHaveText('officer');
    await expect(row.getByTestId('audit-case-no')).toHaveText(EG(25));
    await expect(row.getByTestId('audit-event')).toHaveText('UNMASK');
    await expect(row.getByTestId('audit-detail')).toContainText(UNMASK_REASON);
    await expect(row.getByTestId('audit-time')).toHaveAttribute('data-iso', T0);
    const api = await auditApi(au.api, { event: 'UNMASK' });
    expect(api.count).toBe(1);
  });

  await test.step('6 exec1 · audit1 · สมหญิง เรียก unmask → 403', async () => {
    const ex = await LOGIN_S('exec1');
    const sy = await LOGIN_C(ID.SOMYING);
    for (const [who, api] of [
      ['exec1', ex.api],
      ['audit1', au.api],
      ['สมหญิง', sy.api],
    ] as Array<[string, APIRequestContext]>) {
      expect((await unmaskApi(api, EG(25), 'x')).status(), `${who} unmask`).toBe(403);
    }
  });
});

// ═════════════════════════════ DASH ═════════════════════════════

/** ค่าที่ไม่ขึ้นกับช่วงเวลา (A-41): [backlog, overdue] ต่อบริการ ณ 1 ธ.ค. 09:00 */
const NOW_BY_SVC: Record<string, [number, number]> = {
  ALL: [21, 1],
  'SV-01': [11, 1],
  'SV-02': [7, 0],
  'SV-03': [3, 0],
};

test('TC-DASH-01 Dashboard ตัวเลขเริ่มต้น', async ({ browser }) => {
  await RESET();
  const ex = await LOGIN_S('exec1', browser);
  const page = ex.page;
  await page.goto('/dashboard');

  await test.step('ค่าเริ่มต้น 2026-12 / ALL', async () => {
    await expect(page.getByTestId('period-select')).toHaveValue('2026-12');
    await expect(page.getByTestId('service-select')).toHaveValue('ALL');
    await expectKpis(page, [3, 0, DASH, 21, 1], 'ธ.ค. ALL');
    await expect(page.getByTestId('workload-row')).toHaveCount(3);
    for (const [u, n] of [
      ['off.reg1', '3'],
      ['off.reg2', '9'],
      ['off.works1', '0'],
    ]) {
      await expect(rowBy(page, 'workload-row', 'data-username', u).getByTestId('workload-value'), u).toHaveText(n);
    }
    const d = await dashApi(ex.api);
    expect(d).toMatchObject({ received: 3, closed: 0, backlog: 21, overdue: 1 });
    expect(d.ontimePct, 'ontimePct เมื่อปิดงาน 0').toBeNull();
    const wl = Object.fromEntries((d.workload ?? []).map((w: any) => [w.username, w.count]));
    expect(wl).toMatchObject({ 'off.reg1': 3, 'off.reg2': 9, 'off.works1': 0 });
    expect(d.workload ?? [], 'workload API 3 แถว (การ์ด: 3 แถว)').toHaveLength(3);
  });

  await test.step('ไม่มีข้อมูลส่วนบุคคลบนหน้า', async () => {
    expectNoPii([await page.locator('body').innerText()], '/dashboard innerText');
  });

  const rows: Array<[string, number, number, string, number, number]> = [
    ['SV-01', 3, 0, DASH, 11, 1],
    ['SV-02', 0, 0, DASH, 7, 0],
    ['SV-03', 0, 0, DASH, 3, 0],
  ];
  for (const [svc, ...k] of rows) {
    await test.step(`service-select ${svc}`, async () => {
      await selectDashboard(page, '2026-12', svc);
      await expectKpis(page, k, svc, true);
      const d = await dashApi(ex.api, '2026-12', svc);
      expect.soft(d, `API ${svc}`).toMatchObject({ received: k[0], closed: k[1], backlog: k[3], overdue: k[4] });
      expect.soft(d.ontimePct, `API ${svc} ontimePct`).toBeNull();
    });
  }
});

test('TC-DASH-02 Dashboard ย้อนหลัง', async ({ browser }) => {
  await RESET();
  const ex = await LOGIN_S('exec1', browser);
  const page = ex.page;
  await page.goto('/dashboard');

  // [period, service, received, closed, onTime, pct]
  const rows: Array<[string, string, number, number, number, string]> = [
    ['2026-10', 'ALL', 1, 1, 1, '100.0%'],
    ['2026-11', 'ALL', 26, 7, 6, '85.7%'],
    ['2026-11', 'SV-01', 12, 3, 3, '100.0%'],
    ['2026-11', 'SV-02', 10, 3, 2, '66.7%'],
    ['2026-11', 'SV-03', 4, 1, 1, '100.0%'],
    ['2026', 'ALL', 30, 8, 7, '87.5%'],
    ['2026', 'SV-01', 16, 4, 4, '100.0%'],
    ['2026', 'SV-02', 10, 3, 2, '66.7%'],
    ['2026', 'SV-03', 4, 1, 1, '100.0%'],
  ];
  for (const [period, svc, received, closed, onTime, pct] of rows) {
    await test.step(`${period} / ${svc} → ${received} · ${closed} · ${pct}`, async () => {
      const [backlog, overdue] = NOW_BY_SVC[svc];
      await selectDashboard(page, period, svc);
      await expectKpis(page, [received, closed, pct, backlog, overdue], `${period} ${svc}`, true);
      const d = await dashApi(ex.api, period, svc);
      expect.soft(d, `API ${period} ${svc}`).toMatchObject({ received, closed, onTime, backlog, overdue });
      expect.soft(d.ontimePct, `API ${period} ${svc} ontimePct`).toBe(parseFloat(pct));
    });
  }
});

test('TC-DASH-03 ส่งออก Excel/PDF เท่าหน้าจอ', async ({ browser }) => {
  await RESET();
  const ex = await LOGIN_S('exec1', browser);
  const page = ex.page;
  await page.goto('/dashboard');
  const piiTexts: Array<[string, string[]]> = [];
  let pdfGot: Captured | undefined;

  const checkXlsx = async (want: string[], label: string) => {
    const onScreen = await readKpis(page);
    expect(onScreen, `${label} บนจอ`).toEqual(want);
    const got = await captureFromClick(page, page.getByTestId('export-xlsx-btn'), /export/i);
    expectCapturedOk(got, label);
    expect(got.body.subarray(0, 2).toString('latin1'), `${label} เป็นไฟล์ zip (xlsx)`).toBe('PK');
    if (got.fileName) expect(got.fileName, `${label} ชื่อไฟล์`).toMatch(/\.xlsx$/i);
    const { first, allText } = readXlsx(got.body);
    expect([first.get('A1'), first.get('B1')], `${label} หัวตาราง`).toEqual(['ตัวชี้วัด', 'ค่า']);
    const colA = [2, 3, 4, 5, 6].map((r) => (first.get(`A${r}`) ?? '').trim());
    const colB = [2, 3, 4, 5, 6].map((r) => (first.get(`B${r}`) ?? '').trim());
    expect(colA, `${label} คอลัมน์ A`).toEqual(XLSX_LABELS);
    expect(colB, `${label} คอลัมน์ B`).toEqual(want);
    expect(colB, `${label} เท่ากับ kpi-* บนจอ`).toEqual(onScreen);
    piiTexts.push([label, allText]);
  };

  await test.step('2026-11 / ALL → xlsx', async () => {
    await selectDashboard(page, '2026-11', 'ALL');
    await expectKpis(page, [26, 7, '85.7%', 21, 1], 'พ.ย.');
    await checkXlsx(['26', '7', '85.7%', '21', '1'], 'xlsx พ.ย.');
  });

  await test.step('2026-11 / ALL → pdf', async () => {
    const got = await captureFromClick(page, page.getByTestId('export-pdf-btn'), /export/i);
    expectCapturedOk(got, 'pdf พ.ย.');
    expect(got.body.subarray(0, 5).toString('latin1'), 'pdf พ.ย. เนื้อไฟล์เป็น PDF').toBe('%PDF-');
    if (got.status !== null) expectPdfHeaders(got.status, got.headers, undefined, 'pdf พ.ย.');
    pdfGot = got;
    const { all, text } = pdfText(got.body);
    expect(all, 'บรรทัด kpi ใน PDF').toMatch(/(?<![\w=-])kpi received=26 closed=7 ontime=85\.7% backlog=21 overdue=1(?![\w.%-])/);
    piiTexts.push(['pdf พ.ย.', [text]]);
  });

  await test.step('2026-12 / ALL → xlsx (ปิดงาน 0 → –)', async () => {
    await selectDashboard(page, '2026-12', 'ALL');
    await expectKpis(page, [3, 0, DASH, 21, 1], 'ธ.ค.');
    await checkXlsx(['3', '0', DASH, '21', '1'], 'xlsx ธ.ค.');
  });

  await test.step('ทุกไฟล์ไม่มีข้อมูลส่วนบุคคล', async () => {
    expect(piiTexts.length).toBe(3);
    for (const [label, texts] of piiTexts) expectNoPii(texts, label);
  });

  await test.step('Audit EXPORT = 3 แถวของ exec1', async () => {
    const au = await LOGIN_S('audit1', browser);
    await au.page.goto('/audit');
    await auditFilterUi(au.page, { event: 'EXPORT' });
    await expectAuditCount(au.page, 3, 'EXPORT');
    const rowsUi = await auditRowsUi(au.page);
    for (const r of rowsUi) {
      expect(r.actor).toBe('exec1');
      expect(r.role).toBe('executive');
    }
    const details = rowsUi.map((r) => r.detail);
    for (const [fmt, period] of [
      ['xlsx', '2026-11'],
      ['pdf', '2026-11'],
      ['xlsx', '2026-12'],
    ]) {
      expect(
        details.filter((d) => new RegExp(`\\b${fmt}\\b`).test(d) && d.includes(period)).length,
        `audit-detail มี ${fmt} ${period}: ${JSON.stringify(details)}`,
      ).toBe(1);
    }
  });

  await test.step('pdf พ.ย. Content-Type: application/pdf (ไฟล์มาทาง <a download> → ขอ URL เดิมซ้ำหลังนับ Audit แล้ว)', async () => {
    expect(pdfGot, 'ได้ไฟล์ pdf พ.ย.').toBeTruthy();
    const h = await headersOf(page, pdfGot!);
    expectPdfHeaders(h.status, h.headers, undefined, 'pdf พ.ย.');
  });
});

test('TC-DASH-04 ค่าขอบ "ทันกำหนด" 16:29:59 / 16:30:00 / 16:30:01', async ({ browser }) => {
  await RESET();
  await CLOCK('2026-12-03T16:00:00+07:00');
  const r1 = await LOGIN_S('off.reg1', browser);
  const r2 = await LOGIN_S('off.reg2', browser);
  const ex = await LOGIN_S('exec1', browser);

  const checkDash = async (closed: number, onTime: number, label: string) => {
    const d = await dashApi(ex.api);
    expect(d, `${label} API`).toMatchObject({ closed, onTime });
    await ex.page.goto('/dashboard');
    await expect(ex.page.getByTestId('kpi-closed'), `${label} kpi-closed`).toHaveText(String(closed));
  };
  const closedAt = async (actor: UiActor, caseNo: string, iso: string) => {
    await actor.page.goto(officerCase(caseNo));
    await expect(actor.page.getByTestId('closed-at'), `closed-at ${caseNo}`).toHaveAttribute('data-iso', iso);
    expect((await getCase(actor.api, caseNo)).closedAt).toBe(iso);
  };

  await test.step('1 16:00 approve …000025 (off.reg2) และ …000023 (off.reg1)', async () => {
    await approveOk(r2.api, EG(25));
    await approveOk(r1.api, EG(23));
  });

  await test.step('2 16:29:59 issue …000025 → ทัน (1 · 1)', async () => {
    await CLOCK('2026-12-03T16:29:59+07:00');
    await issueOk(r2.api, EG(25));
    await closedAt(r2, EG(25), '2026-12-03T16:29:59+07:00');
    await checkDash(1, 1, 'หลังขั้น 2');
  });

  await test.step('3 16:30:00 reject …000026 → ทัน ที่ขอบ (2 · 2)', async () => {
    await CLOCK('2026-12-03T16:30:00+07:00');
    const b = await expectStatus(await rejectApi(r2.api, EG(26), R10), 200, 'reject …000026');
    expect(b?.status).toBe('REJECTED');
    await closedAt(r2, EG(26), '2026-12-03T16:30:00+07:00');
    await checkDash(2, 2, 'หลังขั้น 3');
  });

  await test.step('4 16:30:01 issue …000023 → ไม่ทัน (3 · 2) · backlog 18', async () => {
    await CLOCK('2026-12-03T16:30:01+07:00');
    await issueOk(r1.api, EG(23));
    await closedAt(r1, EG(23), '2026-12-03T16:30:01+07:00');
    await checkDash(3, 2, 'หลังขั้น 4');
    await expect(ex.page.getByTestId('kpi-backlog')).toHaveText('18');
    expect((await dashApi(ex.api)).backlog).toBe(18);
  });
});

// ═════════════════════════════ AUDIT ═════════════════════════════

test('TC-AUDIT-01 เหตุการณ์และฟิลด์ใน Audit', async ({ browser }) => {
  await RESET();

  await test.step('ทำรายการ 1–7 ผ่าน API (ล็อกอินครั้งเดียวต่อบัญชี)', async () => {
    const r2 = await LOGIN_S('off.reg2');
    await expectStatus(await claimApi(r2.api, EG(28)), 200, 'claim …000028');
    const r1 = await LOGIN_S('off.reg1');
    await expectStatus(await returnApi(r1.api, EG(20), R10), 200, 'return …000020');
    await expectStatus(await forwardApi(r2.api, EG(13)), 200, 'forward …000013');
    const hd = await LOGIN_S('head1');
    await expectStatus(await approveApi(hd.api, EG(13)), 200, 'head approve …000013');
    await approveOk(r2.api, EG(25));
    await issueOk(r2.api, EG(25), DOC(2));
    await expectStatus(await rejectApi(r2.api, EG(26), R10), 200, 'reject …000026');
    await expectStatus(await unmaskApi(r2.api, EG(25), UNMASK_REASON), 200, 'unmask …000025');
    const ex = await LOGIN_S('exec1');
    await expectStatus(
      await ex.api.get('/api/dashboard/export?format=xlsx&period=2026-12&service=ALL'),
      200,
      'export xlsx',
    );
    const ad = await LOGIN_S('admin1');
    await expectStatus(await ad.api.put('/api/admin/services/SV-01', { data: { fee: 25, sla: 3 } }), 200, 'admin SV-01 fee 25');
  });

  const au = await LOGIN_S('audit1', browser);
  const page = au.page;
  await page.goto('/audit');

  type Exp = { event: string; actor: string; role: string; caseNo: string | null; transition: string | null; detail?: string[] };
  const LOGINS: StaffUser[] = ['off.reg2', 'off.reg1', 'head1', 'exec1', 'admin1', 'audit1'];
  const expected: Exp[] = [
    ...LOGINS.map((u) => ({ event: 'STAFF_LOGIN', actor: u, role: STAFF[u].role, caseNo: null, transition: null })),
    { event: 'CLAIM', actor: 'off.reg2', role: 'officer', caseNo: EG(28), transition: 'SUBMITTED → IN_REVIEW' },
    { event: 'RETURN', actor: 'off.reg1', role: 'officer', caseNo: EG(20), transition: 'IN_REVIEW → NEED_FIX', detail: [R10] },
    { event: 'FORWARD', actor: 'off.reg2', role: 'officer', caseNo: EG(13), transition: 'IN_REVIEW → PENDING_APPROVAL' },
    { event: 'APPROVE', actor: 'head1', role: 'head', caseNo: EG(13), transition: 'PENDING_APPROVAL → APPROVED' },
    { event: 'APPROVE', actor: 'off.reg2', role: 'officer', caseNo: EG(25), transition: 'IN_REVIEW → APPROVED' },
    { event: 'ISSUE', actor: 'off.reg2', role: 'officer', caseNo: EG(25), transition: 'APPROVED → COMPLETED', detail: [DOC(2)] },
    { event: 'REJECT', actor: 'off.reg2', role: 'officer', caseNo: EG(26), transition: 'IN_REVIEW → REJECTED', detail: [R10] },
    { event: 'UNMASK', actor: 'off.reg2', role: 'officer', caseNo: EG(25), transition: null, detail: [UNMASK_REASON] },
    { event: 'EXPORT', actor: 'exec1', role: 'executive', caseNo: null, transition: null, detail: ['xlsx', '2026-12'] },
    { event: 'ADMIN_CHANGE', actor: 'admin1', role: 'admin', caseNo: null, transition: null, detail: ['SV-01 fee 20 → 25'] },
  ];
  /** ลำดับที่ทำจริง (เก่า → ใหม่) · หน้าจอต้องกลับด้าน */
  const doneOrder = [
    'STAFF_LOGIN off.reg2',
    'CLAIM off.reg2',
    'STAFF_LOGIN off.reg1',
    'RETURN off.reg1',
    'FORWARD off.reg2',
    'STAFF_LOGIN head1',
    'APPROVE head1',
    'APPROVE off.reg2',
    'ISSUE off.reg2',
    'REJECT off.reg2',
    'UNMASK off.reg2',
    'STAFF_LOGIN exec1',
    'EXPORT exec1',
    'STAFF_LOGIN admin1',
    'ADMIN_CHANGE admin1',
    'STAFF_LOGIN audit1',
  ];

  await test.step('ไม่กรอง: audit-count 16 · ทุกแถวตามตาราง', async () => {
    // soft: ถ้าจำนวนไม่ตรง ยังตรวจรายแถวต่อ เพื่อบอกว่าแถวไหนหาย (เช่น UNMASK เมื่อเปิด B11)
    await expectAuditCount(page, 16, 'ไม่กรอง', true);
    const rows = await auditRowsUi(page);
    const used = new Set<number>();
    for (const e of expected) {
      const idx = rows.findIndex(
        (r, i) => !used.has(i) && r.event === e.event && r.actor === e.actor && (e.caseNo ? r.caseNo === e.caseNo : isNone(r.caseNo)),
      );
      expect(idx, `ไม่พบแถว ${e.event} ${e.actor} ${e.caseNo ?? ''}`).toBeGreaterThanOrEqual(0);
      used.add(idx);
      const r = rows[idx];
      const label = `${e.event} ${e.actor}`;
      expect.soft(r.eventText, `${label} audit-event`).toBe(e.event);
      expect.soft(r.actorText, `${label} audit-actor`).toBe(e.actor);
      expect.soft(r.role, `${label} audit-role`).toBe(e.role);
      if (e.caseNo) expect.soft(r.caseText, `${label} audit-case-no`).toBe(e.caseNo);
      else expect.soft(isNone(r.caseText), `${label} audit-case-no ว่าง/– (${r.caseText})`).toBe(true);
      expect.soft(r.transition, `${label} audit-transition`).toBe(e.transition ?? DASH);
      for (const d of e.detail ?? []) expect.soft(r.detail, `${label} audit-detail`).toContain(d);
      expect.soft(r.time, `${label} audit-time`).toBe(T0);
    }
    expect(used.size).toBe(16);
    const ids = rows.map((r) => Number(r.id));
    if (ids.every((n) => Number.isFinite(n))) {
      expect(ids, 'data-id มาก → น้อย (เวลาเท่ากัน)').toEqual([...ids].sort((a, b) => b - a));
    }
    expect.soft(rows.map((r) => `${r.event} ${r.actor}`), 'ใหม่ → เก่า').toEqual([...doneOrder].reverse());
  });

  await test.step('API GET /api/audit = 16 แถว', async () => {
    const api = await auditApi(au.api);
    expect(api.count).toBe(16);
    expect(api.items.length).toBe(16);
    for (const it of api.items) expect.soft(it.time, `${it.event} time`).toBe(T0);
  });

  await test.step('กรอง: actor off.reg2 = 7 · event APPROVE = 2 · ทั้งสอง = 1', async () => {
    await auditFilterUi(page, { actor: 'off.reg2' });
    await expectAuditCount(page, 7, 'actor off.reg2');
    expect((await auditRowsUi(page)).map((r) => r.event).sort()).toEqual(
      ['STAFF_LOGIN', 'CLAIM', 'FORWARD', 'APPROVE', 'ISSUE', 'REJECT', 'UNMASK'].sort(),
    );
    await auditFilterUi(page, { event: 'APPROVE' });
    await expectAuditCount(page, 2, 'event APPROVE');
    expect((await auditRowsUi(page)).map((r) => r.actor).sort()).toEqual(['head1', 'off.reg2']);
    await auditFilterUi(page, { actor: 'off.reg2', event: 'APPROVE' });
    await expectAuditCount(page, 1, 'off.reg2 + APPROVE');
    expect((await auditApi(au.api, { actor: 'off.reg2' })).count).toBe(7);
    expect((await auditApi(au.api, { event: 'APPROVE' })).count).toBe(2);
    expect((await auditApi(au.api, { actor: 'off.reg2', event: 'APPROVE' })).count).toBe(1);
  });

  await test.step('CSV: หัวตาราง · 16 แถว · หลังส่งออก audit-count 17 (EXPORT audit-csv)', async () => {
    await auditFilterUi(page, {});
    await expectAuditCount(page, 16, 'ล้างตัวกรอง');
    const screen = await auditRowsUi(page);
    const got = await captureFromClick(page, page.getByTestId('audit-export-csv-btn'), /export|\.csv/i);
    expectCapturedOk(got, 'CSV');
    const rows = parseCsv(got.body.toString('utf8'));
    expect(rows[0].join(',')).toBe('time,username,role,event,caseNo,fromStatus,toStatus,detail');
    const data = rows.slice(1);
    expect(data.length, 'แถวข้อมูล CSV').toBe(16);
    expect.soft(data.map((r) => `${r[3]} ${r[1]}`), 'CSV เรียงเหมือนจอ').toEqual(screen.map((r) => `${r.event} ${r.actor}`));
    await page.goto('/audit');
    await expectAuditCount(page, 17, 'หลังส่งออก CSV');
    const top = (await auditRowsUi(page))[0];
    expect(top.event).toBe('EXPORT');
    expect(top.actor).toBe('audit1');
    expect(top.detail).toContain('audit-csv');
  });
});

test('TC-AUDIT-02 Audit แก้/ลบไม่ได้ (405)', async ({ browser }) => {
  await RESET();
  const au = await LOGIN_S('audit1', browser);
  const before = await auditApi(au.api);
  expect(before.items.length, 'STAFF_LOGIN ของ audit1').toBe(1);
  const id = String(before.items[0].id);
  const ad = await LOGIN_S('admin1');

  for (const [who, api] of [
    ['admin1', ad.api],
    ['audit1', au.api],
  ] as Array<[string, APIRequestContext]>) {
    await test.step(`${who}: PUT/PATCH/DELETE → 405`, async () => {
      const calls: Array<[string, () => Promise<APIResponse>]> = [
        [`PUT /api/audit/${id}`, () => api.put(`/api/audit/${id}`, { data: { detail: 'x' } })],
        [`PATCH /api/audit/${id}`, () => api.patch(`/api/audit/${id}`, { data: { detail: 'x' } })],
        [`DELETE /api/audit/${id}`, () => api.delete(`/api/audit/${id}`)],
        ['PUT /api/audit', () => api.put('/api/audit', { data: { detail: 'x' } })],
        ['DELETE /api/audit', () => api.delete('/api/audit')],
        ['DELETE /api/audit/999999', () => api.delete('/api/audit/999999')],
      ];
      for (const [label, call] of calls) {
        const res = await call();
        expect.soft(res.status(), `${who} ${label}`).toBe(405);
        if (res.status() === 405) expect.soft((await jsonOf(res))?.code, `${who} ${label} code`).toBe('METHOD_NOT_ALLOWED');
      }
    });
  }

  await test.step('ข้อมูลเดิมไม่ถูกแก้/หาย · เพิ่มเฉพาะ STAFF_LOGIN ของ admin1', async () => {
    const after = await auditApi(au.api);
    for (const b of before.items) {
      expect(after.items.find((a) => String(a.id) === String(b.id)), `แถว id ${b.id}`).toEqual(b);
    }
    const added = after.items.filter((a) => !before.items.some((b) => String(b.id) === String(a.id)));
    expect(added.map((a) => `${a.event} ${a.username}`)).toEqual(['STAFF_LOGIN admin1']);
  });

  await test.step('UI ไม่มีปุ่มแก้/ลบ · admin1 GET /api/audit → 403', async () => {
    await au.page.goto('/audit');
    await expect(au.page.getByTestId('audit-row').first()).toBeVisible();
    await expectCounts(au.page, { 'audit-edit-btn': 0, 'audit-delete-btn': 0 });
    expect((await ad.api.get('/api/audit')).status()).toBe(403);
  });
});

test('TC-AUDIT-03 กรองช่วงวันที่ตามเวลาไทย', async ({ browser }) => {
  await RESET();
  const L = [
    { actor: 'off.reg1', iso: '2026-11-30T23:59:59+07:00' },
    { actor: 'off.reg2', iso: '2026-12-01T00:00:00+07:00' },
    { actor: 'off.works1', iso: '2026-12-01T23:59:59+07:00' },
    { actor: 'off.reg1', iso: '2026-12-02T00:00:00+07:00' },
    { actor: 'audit1', iso: '2026-12-02T09:00:00+07:00' },
  ];
  let au: UiActor | undefined;
  await test.step('สร้าง STAFF_LOGIN L1–L5 ตามนาฬิกา', async () => {
    for (const l of L) {
      await CLOCK(l.iso);
      if (l.actor === 'audit1') au = await LOGIN_S('audit1', browser);
      else await LOGIN_S(l.actor);
    }
  });
  const page = au!.page;
  await page.goto('/audit');
  await expectAuditCount(page, 5, 'ไม่กรอง');

  // [from, to, actor, แถวที่ต้องได้ (1-based)]
  const cases: Array<[string, string, string, number[]]> = [
    ['2026-12-01', '2026-12-01', '', [2, 3]],
    ['2026-11-30', '2026-11-30', '', [1]],
    ['2026-11-30', '2026-12-01', '', [1, 2, 3]],
    ['2026-12-02', '', '', [4, 5]],
    ['', '2026-11-30', '', [1]],
    ['2026-12-01', '2026-12-02', '', [2, 3, 4, 5]],
    ['2026-12-01', '2026-12-01', 'off.reg2', [2]],
  ];
  for (const [from, to, actor, want] of cases) {
    await test.step(`from=${from || '(ว่าง)'} to=${to || '(ว่าง)'}${actor ? ` actor=${actor}` : ''} → L${want.join(' L')}`, async () => {
      const exp = want.map((i) => `${L[i - 1].actor}|${L[i - 1].iso}`).sort();
      await auditFilterUi(page, { from, to, actor });
      await expectAuditCount(page, want.length);
      const got = (await auditRowsUi(page)).map((r) => `${r.actor}|${r.time}`).sort();
      expect.soft(got, 'แถวบนจอ (actor|data-iso)').toEqual(exp);
      const q: Record<string, string> = {};
      if (from) q.from = from;
      if (to) q.to = to;
      if (actor) q.actor = actor;
      const api = await auditApi(au!.api, q);
      expect.soft(api.count, 'API count').toBe(want.length);
      expect.soft(api.items.map((i) => `${i.username}|${i.time}`).sort(), 'API items').toEqual(exp);
    });
  }
});

// ═════════════════════════════ RBAC ═════════════════════════════

test('TC-RBAC-01 ประชาชนเปิดคำขอคนอื่นไม่ได้ (IDOR)', async ({ browser }) => {
  await RESET();
  const sy = await LOGIN_C(ID.SOMYING, browser);
  const p = sy.page;

  await test.step('UI …000005 (ของสมชาย) → 404 ไม่พบคำขอ', async () => {
    const res = await p.goto(citizenCase(EG(5)));
    expect(res?.status(), `สมหญิงเปิด ${citizenCase(EG(5))} (ของสมชาย) HTTP`).toBe(404);
    await expect(p.getByTestId('not-found-msg')).toHaveText(MSG.NOT_FOUND);
    await expectCounts(p, { 'case-no': 0, 'case-status': 0 });
    expect((await p.content()).includes('สมชาย'), 'HTML มีชื่อสมชาย').toBe(false);
  });

  await test.step('API ของคนอื่น = ไม่มีจริง (404 เนื้อหาเดียวกัน)', async () => {
    const other = await sy.api.get(`/api/cases/${EG(5)}`);
    const otherBody = await expectApiError(other, 404, 'NOT_FOUND', MSG.NOT_FOUND);
    expect(otherBody).toEqual({ code: 'NOT_FOUND', message: MSG.NOT_FOUND });
    const none = await sy.api.get(`/api/cases/${EG(999999)}`);
    expect(none.status()).toBe(404);
    expect(await none.text(), 'แยกไม่ออกว่าเลขมีอยู่').toBe(await other.text());
    expect((await sy.api.get(`/api/documents/${DOC(1)}/pdf`)).status(), 'PDF ของสมชาย').toBe(404);
    expect((await sy.api.get(`/api/drafts/${DR(1)}`)).status(), 'ร่างของสมชาย').toBe(404);
    expect((await sy.api.post(`/api/cases/${EG(30)}/cancel`)).status(), 'ยกเลิกของสมชาย').toBe(404);
  });

  await test.step('ของตัวเอง …000007 → 200 · สมชายเปิด …000005 ของตัวเอง → 200 · …000030 ยังไม่ถูกยกเลิก', async () => {
    const res = await p.goto(citizenCase(EG(7)));
    expect(res?.status()).toBe(200);
    await expect(p.getByTestId('case-no')).toHaveText(EG(7));
    const sc = await LOGIN_C(ID.SOMCHAI);
    await getCase(sc.api, EG(5));
    expect((await getCase(sc.api, EG(30))).status).toBe('SUBMITTED');
  });
});

test('TC-RBAC-02 เจ้าหน้าที่อนุมัติ SV-02 ไม่ได้ (ตรวจที่ API)', async ({ browser }) => {
  await RESET();
  const r2 = await LOGIN_S('off.reg2', browser);

  await test.step('1 approve …000014 (PENDING_APPROVAL) → 403', async () => {
    await expectApiError(await approveApi(r2.api, EG(14)), 403, 'FORBIDDEN');
    expect((await getCase(r2.api, EG(14))).status).toBe('PENDING_APPROVAL');
  });
  await test.step('2 approve …000013 (ถือเอง IN_REVIEW) → 403', async () => {
    await expectApiError(await approveApi(r2.api, EG(13)), 403);
    expect((await getCase(r2.api, EG(13))).status).toBe('IN_REVIEW');
  });
  await test.step('3 reject …000014 → 403', async () => {
    await expectApiError(await rejectApi(r2.api, EG(14), R10), 403);
    expect((await getCase(r2.api, EG(14))).status).toBe('PENDING_APPROVAL');
  });
  await test.step('4 UI …000013 และ …000014 ไม่มี approve-btn', async () => {
    for (const n of [13, 14]) {
      await r2.page.goto(officerCase(EG(n)));
      await expect(r2.page.getByTestId('case-no')).toHaveText(EG(n));
      await expect(r2.page.getByTestId('approve-btn'), EG(n)).toHaveCount(0);
    }
  });
  const hd = await LOGIN_S('head1');
  await test.step('5 head1 approve SV-01 …000025 → 403', async () => {
    await expectApiError(await approveApi(hd.api, EG(25)), 403);
    expect((await getCase(hd.api, EG(25))).status).toBe('IN_REVIEW');
  });
  await test.step('6 head1 approve …000014 → 200 APPROVED', async () => {
    expect(await expectStatus(await approveApi(hd.api, EG(14)), 200)).toMatchObject({ status: 'APPROVED' });
  });
  await test.step('7 Audit APPROVE = 1 แถว (head1)', async () => {
    const au = await LOGIN_S('audit1', browser);
    await au.page.goto('/audit');
    await auditFilterUi(au.page, { event: 'APPROVE' });
    await expectAuditCount(au.page, 1, 'APPROVE');
    const [row] = await auditRowsUi(au.page);
    expect(row.actor).toBe('head1');
    expect(row.caseNo).toBe(EG(14));
  });
});

type Who = 'anon' | 'citizen' | 'officer' | 'head' | 'executive' | 'auditor' | 'admin';
const WHO: Who[] = ['anon', 'citizen', 'officer', 'head', 'executive', 'auditor', 'admin'];

test('TC-RBAC-03 ตารางสิทธิ์หน้า/API ตามบทบาท', async ({ browser }) => {
  const USER: Record<Exclude<Who, 'anon' | 'citizen'>, StaffUser> = {
    officer: 'off.reg1',
    head: 'head1',
    executive: 'exec1',
    auditor: 'audit1',
    admin: 'admin1',
  };
  // L = redirect /login · Y = 200 · F = 403 + forbidden-msg (ลำดับตาม WHO)
  const PAGES: Array<[string, string]> = [
    ['/citizen', 'L Y F F F F F'],
    ['/officer/queue', 'L F Y Y F F F'],
    ['/head/approvals', 'L F F Y F F F'],
    ['/dashboard', 'L F F F Y F F'],
    ['/audit', 'L F F F F Y F'],
    ['/admin/services', 'L F F F F F Y'],
    ['/admin/holidays', 'L F F F F F Y'],
    ['/admin/users', 'L F F F F F Y'],
    ['/notifications', 'L F Y Y F F F'],
    [`/verify/${SEED_CODE}`, 'Y Y Y Y Y Y Y'],
  ];
  type Call = { label: string; asSomying?: boolean; run: (api: APIRequestContext) => Promise<APIResponse>; want: string };
  const APIS: Call[] = [
    { label: 'GET /api/officer/queue', run: (a) => a.get('/api/officer/queue'), want: '401 403 200 200 403 403 403' },
    { label: 'GET /api/notifications', run: (a) => a.get('/api/notifications'), want: '401 403 200 200 403 403 403' },
    {
      label: 'GET /api/dashboard',
      run: (a) => a.get('/api/dashboard?period=2026-12&service=ALL'),
      want: '401 403 403 403 200 403 403',
    },
    { label: 'GET /api/audit', run: (a) => a.get('/api/audit'), want: '401 403 403 403 403 200 403' },
    { label: 'GET /api/admin/services', run: (a) => a.get('/api/admin/services'), want: '401 403 403 403 403 403 200' },
    {
      label: 'POST /api/drafts',
      run: (a) => a.post('/api/drafts', { data: { serviceId: 'SV-01', qty: 1 } }),
      want: '401 201 403 403 403 403 403',
    },
    {
      label: `GET /api/cases/${EG(25)} (ประชาชน = สมหญิง)`,
      asSomying: true,
      run: (a) => a.get(`/api/cases/${EG(25)}`),
      want: '401 200 200 200 403 403 403',
    },
    // เรียกเป็นลำดับสุดท้ายหลัง RESET (ผู้ถือเรื่องยังไม่เปลี่ยน)
    {
      label: `POST claim ${EG(28)}`,
      run: (a) => a.post(`/api/officer/cases/${EG(28)}/claim`),
      want: '401 403 200 403 403 403 403',
    },
  ];
  const NAV_ALL = [
    'nav-my-cases',
    'nav-queue',
    'nav-approvals',
    'nav-dashboard',
    'nav-audit',
    'nav-admin-services',
    'nav-admin-holidays',
    'nav-admin-users',
    'nav-bell',
  ];
  const NAV: Record<Exclude<Who, 'anon'>, string[]> = {
    citizen: ['nav-my-cases'],
    officer: ['nav-queue', 'nav-bell'],
    head: ['nav-queue', 'nav-approvals', 'nav-bell'],
    executive: ['nav-dashboard'],
    auditor: ['nav-audit'],
    admin: ['nav-admin-services', 'nav-admin-holidays', 'nav-admin-users'],
  };
  const LANDING: Record<Exclude<Who, 'anon'>, string> = {
    citizen: '/citizen',
    officer: '/officer/queue',
    head: '/head/approvals',
    executive: '/dashboard',
    auditor: '/audit',
    admin: '/admin/services',
  };

  for (const [w, who] of WHO.entries()) {
    await test.step(`บทบาท ${who}: หน้า · API · เมนู`, async () => {
      await RESET();
      let page: Page;
      let api: APIRequestContext;
      let somyingApi: APIRequestContext | undefined;
      if (who === 'anon') {
        ({ page } = await newBrowserContext(browser));
        api = await newApi();
      } else if (who === 'citizen') {
        ({ page, api } = await LOGIN_C(ID.SOMCHAI, browser));
        somyingApi = (await LOGIN_C(ID.SOMYING)).api;
      } else {
        ({ page, api } = await LOGIN_S(USER[who], browser));
      }

      for (const [url, row] of PAGES) {
        const want = row.split(' ')[w];
        const res = await page.goto(url);
        const label = `${who} ${url}`;
        if (want === 'L') {
          expect.soft(new URL(page.url()).pathname, `${label} → /login`).toBe('/login');
        } else if (want === 'Y') {
          expect.soft(res?.status(), `${label} HTTP`).toBe(200);
          expect.soft(new URL(page.url()).pathname, `${label} ไม่ redirect`).toBe(url);
          await expect.soft(page.getByTestId('forbidden-msg'), `${label} ไม่มี forbidden-msg`).toHaveCount(0);
        } else {
          expect.soft(res?.status(), `${label} HTTP`).toBe(403);
          await expect.soft(page.getByTestId('forbidden-msg'), `${label} forbidden-msg`).toHaveText(MSG.FORBIDDEN_PAGE);
        }
      }

      for (const c of APIS) {
        const want = Number(c.want.split(' ')[w]);
        const res = await c.run(c.asSomying && somyingApi ? somyingApi : api);
        expect.soft(res.status(), `${who} ${c.label}`).toBe(want);
      }

      if (who !== 'anon') {
        await page.goto(LANDING[who]);
        for (const id of NAV_ALL) {
          const n = await page.getByTestId(id).count();
          if (NAV[who].includes(id)) expect.soft(n, `${who} มี ${id}`).toBeGreaterThan(0);
          else expect.soft(n, `${who} ต้องไม่มี ${id}`).toBe(0);
        }
      }
    });
  }

  await test.step('ส่วน C ขอบเขตแผนก', async () => {
    await RESET();
    const w1 = await LOGIN_S('off.works1', browser);
    const r1 = await LOGIN_S('off.reg1');
    await expectApiError(await claimApi(w1.api, EG(28)), 403, 'FORBIDDEN');
    await expectApiError(await claimApi(r1.api, EG(10)), 403, 'FORBIDDEN');
    expect((await queueApi(w1.api)).map((i) => i.caseNo)).toEqual([EG(10)]);
    await w1.page.goto('/officer/queue');
    await expect(w1.page.getByTestId('queue-row')).toHaveCount(1);
    await expect(queueRow(w1.page, EG(10))).toHaveCount(1);
  });
});

test('TC-RBAC-04 ผู้ดูแลระบบ: บริการ วันหยุด ผู้ใช้ และยอดที่ล็อก', async ({ browser }) => {
  await RESET();
  const ad = await LOGIN_S('admin1', browser);
  const ap = ad.page;
  const SEED_HOLIDAYS = ['2026-12-07', '2026-12-10', '2026-12-31', '2027-01-01'];

  await test.step('1 /admin/holidays = 4 แถว', async () => {
    await ap.goto('/admin/holidays');
    await expect(ap.getByTestId('holiday-row')).toHaveCount(4);
    expect((await attrsOf(ap.getByTestId('holiday-row'), 'data-date')).sort()).toEqual(SEED_HOLIDAYS);
  });

  await test.step('2 ก่อนแก้: NEW_PAID SV-01 qty 1 → …000031 กำหนด 4 ธ.ค. 16:30', async () => {
    const r = await NEW_PAID(ID.SOMCHAI, 'SV-01', T0, { qty: 1 });
    expect(r.fee).toBe(20);
    expect(r.caseNo).toBe(EG(31));
    expect((await getCase(r.actor.api, EG(31))).dueAt).toBe('2026-12-04T16:30:00+07:00');
  });

  await test.step('3 แก้ SV-01 = ฿25 · SV-02 = ฿600 ผ่านหน้าจอ', async () => {
    for (const [svc, fee] of [
      ['SV-01', '25'],
      ['SV-02', '600'],
    ]) {
      await ap.goto('/admin/services');
      await ap.getByTestId(`svc-fee-${svc}`).fill(fee);
      await ap.getByTestId(`svc-save-${svc}`).click();
      await expect(ap.getByTestId('action-success'), `บันทึก ${svc}`).toBeVisible();
    }
    const s = await servicesApi(ad.api);
    expect(s['SV-01']?.fee).toBe(25);
    expect(s['SV-02']?.fee).toBe(600);
  });

  const sc = await LOGIN_C(ID.SOMCHAI, browser);
  await test.step('4 ร่างใหม่ใช้ค่าใหม่ · คำขอเดิมไม่เปลี่ยน', async () => {
    const p = sc.page;
    await p.goto('/citizen/new/SV-01');
    await fillAndCommit(p.getByTestId('qty-input'), '5');
    await expect(p.getByTestId('fee-total')).toHaveText('฿125');
    await fillAndCommit(p.getByTestId('qty-input'), '1');
    await expect(p.getByTestId('fee-total')).toHaveText('฿25');
    await p.goto('/citizen/new/SV-02');
    await expect(p.getByTestId('fee-total')).toHaveText('฿600');
    expect((await createDraftApi(sc.api, 'SV-01', { qty: 5 })).fee).toBe(125);
    expect((await createDraftApi(sc.api, 'SV-02')).fee).toBe(600);
    await p.goto(citizenCase(EG(30)));
    await expect(p.getByTestId('case-fee')).toHaveText('฿20');
  });

  await test.step('5 PP-0001 (DR-0002) ยอดล็อก ฿500 · ชำระ 600 → 422 · 500 → …000032', async () => {
    const p = sc.page;
    await p.goto(`/citizen/new/SV-02?draft=${DR(2)}`);
    await p.waitForLoadState('networkidle').catch(() => undefined);
    const amt = p.getByTestId('payment-amount');
    for (let i = 0; i < 3 && !(await amt.isVisible()); i++) {
      const toPay = p.getByTestId('to-payment-btn');
      const toUp = p.getByTestId('to-upload-btn');
      if (await toPay.isVisible()) await toPay.click();
      else if (await toUp.isVisible()) await toUp.click();
      await p.waitForLoadState('networkidle').catch(() => undefined);
    }
    await expect(amt).toHaveText('฿500');
    const bad = await PAY(PP(1), 600);
    expect(bad.status, JSON.stringify(bad.body)).toBe(422);
    expect(bad.body?.code).toBe('AMOUNT_MISMATCH');
    const ok = await PAY(PP(1), 500);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'PAID', caseNo: EG(32) });
  });

  await test.step('6 เพิ่มวันหยุด 2026-12-02 → 5 แถว · คำขอเดิมไม่คำนวณใหม่', async () => {
    await ap.goto('/admin/holidays');
    await ap.getByTestId('holiday-date-input').fill('2026-12-02');
    await ap.getByTestId('holiday-name-input').fill('วันหยุดทดสอบ');
    await ap.getByTestId('holiday-add-btn').click();
    await expect(ap.getByTestId('holiday-row')).toHaveCount(5);
    await expect(rowBy(ap, 'holiday-row', 'data-date', '2026-12-02')).toHaveCount(1);
    expect((await getCase(sc.api, EG(31))).dueAt).toBe('2026-12-04T16:30:00+07:00');
  });

  await test.step('7 หลังเพิ่มวันหยุด NEW_PAID SV-01 ฿25 → …000033 กำหนด 8 ธ.ค. 16:30', async () => {
    const r = await NEW_PAID(ID.SOMCHAI, 'SV-01', T0, { qty: 1 });
    expect(r.fee).toBe(25);
    expect(r.caseNo).toBe(EG(33));
    expect((await getCase(r.actor.api, EG(33))).dueAt).toBe('2026-12-08T16:30:00+07:00');
  });

  const exPage = (await newBrowserContext(browser)).page;
  await test.step('8 เปลี่ยน exec1 เป็น auditor → ล็อกอินใหม่ได้หน้า /audit · /dashboard 403', async () => {
    await expectStatus(await ad.api.put('/api/admin/users/exec1', { data: { role: 'auditor', dept: '' } }), 200);
    await loginStaffUi(exPage, 'exec1');
    await expectPath(exPage, '/audit');
    const res = await exPage.goto('/dashboard');
    expect(res?.status()).toBe(403);
    await expect(exPage.getByTestId('forbidden-msg')).toHaveText(MSG.FORBIDDEN_PAGE);
  });

  const ADMIN_DETAILS = ['SV-01 fee 20 → 25', 'SV-02 fee 500 → 600', 'holiday add 2026-12-02', 'exec1 role executive → auditor'];
  const checkAdminAudit = async (n: number, details: string[]) => {
    await auditFilterUi(exPage, { event: 'ADMIN_CHANGE' });
    await expectAuditCount(exPage, n, 'ADMIN_CHANGE');
    const rows = await auditRowsUi(exPage);
    for (const r of rows) {
      expect.soft(r.actor).toBe('admin1');
      expect.soft(r.role).toBe('admin');
    }
    const all = rows.map((r) => r.detail).join('\n');
    for (const d of details) expect(all, `มี detail "${d}"`).toContain(d);
  };

  await test.step('9 exec1 (auditor) กรอง ADMIN_CHANGE = 4', async () => {
    await checkAdminAudit(4, ADMIN_DETAILS);
  });

  await test.step('10 admin POST /api/drafts → 403', async () => {
    expect((await ad.api.post('/api/drafts', { data: { serviceId: 'SV-01', qty: 1 } })).status()).toBe(403);
  });

  await test.step('11 ลบวันหยุด 2026-12-02 → 4 แถว · ADMIN_CHANGE รวม 5', async () => {
    await ap.goto('/admin/holidays');
    await rowBy(ap, 'holiday-row', 'data-date', '2026-12-02').getByTestId('holiday-delete-btn').click();
    await expect(ap.getByTestId('holiday-row')).toHaveCount(4);
    await checkAdminAudit(5, [...ADMIN_DETAILS, 'holiday delete 2026-12-02']);
  });
});

test('TC-RBAC-05 สิทธิ์เปิด/ดาวน์โหลดไฟล์แนบ', async ({ browser }) => {
  await RESET();
  const FILES: Record<number, string[]> = {
    25: ['id-card.pdf'],
    12: ['id-card.pdf', 'plan.pdf', 'deed.pdf'],
    10: ['id-card.pdf', 'plan.pdf', 'deed.pdf'],
    11: ['id-card.pdf', 'plan.pdf', 'deed.pdf'],
  };
  const ids: Record<number, string[]> = {};
  const hd = await LOGIN_S('head1');
  for (const n of [25, 12, 10, 11]) {
    const b = await expectStatus(await hd.api.get(`/api/cases/${EG(n)}/files`), 200, `head1 files ${EG(n)}`);
    ids[n] = (b?.items ?? []).map((i: any) => String(i.fileId));
    expect(ids[n].length, `fileId ของ ${EG(n)}`).toBe(FILES[n].length);
  }

  const check = async (who: string, api: APIRequestContext, n: number, list: number, file: number) => {
    const label = `${who} ${EG(n)}`;
    const r = await api.get(`/api/cases/${EG(n)}/files`);
    expect.soft(r.status(), `${label} /files`).toBe(list);
    if (list === 200) {
      const names = ((await jsonOf(r))?.items ?? []).map((i: any) => i.name).sort();
      expect.soft(names, `${label} รายการไฟล์`).toEqual([...FILES[n]].sort());
    }
    for (const fid of ids[n]) {
      const f = await api.get(`/api/files/${encodeURIComponent(fid)}`);
      expect.soft(f.status(), `${label} /api/files/${fid}`).toBe(file);
      if (file === 200 && f.status() === 200) {
        expect.soft(f.headers()['content-type'] ?? '', `${label} Content-Type`).toContain('application/pdf');
        expect.soft((await f.body()).subarray(0, 4).toString('latin1'), `${label} ขึ้นต้น %PDF`).toBe('%PDF');
      }
    }
  };

  const r1 = await LOGIN_S('off.reg1', browser);
  const r2 = await LOGIN_S('off.reg2', browser);
  const w1 = await LOGIN_S('off.works1');
  const sy = await LOGIN_C(ID.SOMYING, browser);
  const sc = await LOGIN_C(ID.SOMCHAI);
  const ex = await LOGIN_S('exec1');
  const au = await LOGIN_S('audit1');
  const adm = await LOGIN_S('admin1');
  const anon = await newApi();

  await test.step('ตารางสิทธิ์ /files และ /api/files/:fileId', async () => {
    await check('off.reg1', r1.api, 25, 200, 200);
    await check('off.works1', w1.api, 25, 403, 403);
    await check('off.reg2', r2.api, 12, 200, 200);
    await check('off.works1', w1.api, 12, 403, 403);
    await check('off.works1', w1.api, 10, 200, 200);
    await check('off.reg1', r1.api, 10, 200, 200);
    await check('off.works1', w1.api, 11, 200, 200);
    for (const n of [25, 10, 12]) await check('head1', hd.api, n, 200, 200);
    await check('สมหญิง', sy.api, 25, 200, 200);
    await check('สมชาย', sc.api, 25, 404, 404);
    await check('exec1', ex.api, 25, 403, 403);
    await check('audit1', au.api, 25, 403, 403);
    await check('admin1', adm.api, 25, 403, 403);
    await check('ไม่ล็อกอิน', anon, 25, 401, 401);
  });

  await test.step('fileId ที่ไม่มี → 404', async () => {
    const real = ids[25][0];
    const fake = /^\d+$/.test(real) ? String(Number(real) + 1_000_000) : `${real.slice(0, -4)}zzzz`;
    expect((await r1.api.get(`/api/files/${encodeURIComponent(fake)}`)).status()).toBe(404);
  });

  await test.step('UI doc-item และ doc-download-link', async () => {
    await r1.page.goto(officerCase(EG(25)));
    const items = r1.page.getByTestId('doc-item');
    await expect(items).toHaveCount(1);
    await expect(items).toHaveAttribute('data-name', 'id-card.pdf');
    const dl = await clickDownload(r1.page, items.getByTestId('doc-download-link'));
    expect(dl.body.length, 'ไฟล์ที่ดาวน์โหลด > 0 ไบต์').toBeGreaterThan(0);
    await r2.page.goto(officerCase(EG(12)));
    await expect(r2.page.getByTestId('doc-item')).toHaveCount(3);
    await sy.page.goto(citizenCase(EG(25)));
    await expect(sy.page.getByTestId('doc-item')).toHaveCount(1);
  });
});

test('TC-RBAC-06 ผู้ดูแลระบบ: ช่วงค่าที่ยอมรับ', async ({ browser }) => {
  await RESET();
  const ad = await LOGIN_S('admin1', browser);
  const p = ad.page;
  const sv01 = async () => (await servicesApi(ad.api))['SV-01'];
  const putSv01 = (fee: number, sla: number) => ad.api.put('/api/admin/services/SV-01', { data: { fee, sla } });
  const uiSave = async (field: 'fee' | 'sla', value: string) => {
    await p.goto('/admin/services');
    await p.getByTestId(`svc-${field}-SV-01`).fill(value);
    await p.getByTestId('svc-save-SV-01').click();
  };
  let fee = 20;
  let sla = 3;

  // ค่าที่ถูกปฏิเสธ: ตรวจทั้งหน้าจอและ API · ค่าที่ยอมรับ: บันทึกครั้งเดียวผ่านหน้าจอ แล้วตรวจ HTTP ของ
  // PUT /api/admin/services/SV-01 ที่หน้าจอส่ง (= 200) → ครบทั้งสองช่องทาง และ Audit = 5 พอดีตามการ์ด
  const acceptUi = async (field: 'fee' | 'sla', value: string) => {
    await p.goto('/admin/services');
    await p.getByTestId(`svc-${field}-SV-01`).fill(value);
    const [res] = await Promise.all([
      p.waitForResponse((r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === '/api/admin/services/SV-01'),
      p.getByTestId('svc-save-SV-01').click(),
    ]);
    expect(res.status(), `PUT ${field} ${value}`).toBe(200);
    await expect(p.getByTestId('action-success'), `${field} ${value}`).toBeVisible();
  };
  const rejectFee = async (v: number) => {
    await expectApiError(await putSv01(v, sla), 400, 'INVALID_FEE', MSG.INVALID_FEE, `PUT fee ${v}`);
    await uiSave('fee', String(v));
    await expect(p.getByTestId('action-error'), `fee ${v}`).toHaveText(MSG.INVALID_FEE);
    expect((await sv01())?.fee, `fee ${v} ค่าไม่เปลี่ยน`).toBe(fee);
  };
  const rejectSla = async (v: number) => {
    await expectApiError(await putSv01(fee, v), 400, 'INVALID_SLA', MSG.INVALID_SLA, `PUT sla ${v}`);
    await uiSave('sla', String(v));
    await expect(p.getByTestId('action-error'), `sla ${v}`).toHaveText(MSG.INVALID_SLA);
    expect((await sv01())?.sla, `sla ${v} ค่าไม่เปลี่ยน`).toBe(sla);
  };

  await test.step('fee −1 → 400 INVALID_FEE', async () => rejectFee(-1));
  await test.step('fee 0 → 200 ยอมรับ', async () => {
    await acceptUi('fee', '0');
    fee = 0;
    expect((await sv01())?.fee).toBe(0);
  });
  await test.step('fee 100000 → 200 ยอมรับ', async () => {
    await acceptUi('fee', '100000');
    fee = 100000;
    expect((await sv01())?.fee).toBe(100000);
  });
  await test.step('fee 100001 → 400 INVALID_FEE', async () => rejectFee(100001));
  await test.step('sla 0 → 400 INVALID_SLA', async () => rejectSla(0));
  await test.step('sla 1 → 200 ยอมรับ', async () => {
    await acceptUi('sla', '1');
    sla = 1;
    expect((await sv01())?.sla).toBe(1);
  });
  await test.step('sla 60 → 200 ยอมรับ', async () => {
    await acceptUi('sla', '60');
    sla = 60;
    expect((await sv01())?.sla).toBe(60);
  });
  await test.step('sla 61 → 400 INVALID_SLA', async () => rejectSla(61));

  await test.step('วันหยุดซ้ำ 2026-12-07 → 409 · วันเสาร์ 2026-12-05 → 201', async () => {
    await expectApiError(
      await ad.api.post('/api/admin/holidays', { data: { date: '2026-12-07', name: 'ซ้ำ' } }),
      409,
      'DUPLICATE_HOLIDAY',
      MSG.DUPLICATE_HOLIDAY,
    );
    await p.goto('/admin/holidays');
    await p.getByTestId('holiday-date-input').fill('2026-12-07');
    await p.getByTestId('holiday-name-input').fill('ซ้ำ');
    await p.getByTestId('holiday-add-btn').click();
    await expect(p.getByTestId('action-error')).toHaveText(MSG.DUPLICATE_HOLIDAY);
    await p.goto('/admin/holidays');
    await expect(p.getByTestId('holiday-row')).toHaveCount(4);
    await expectStatus(await ad.api.post('/api/admin/holidays', { data: { date: '2026-12-05', name: 'วันเสาร์' } }), 201);
    await p.goto('/admin/holidays');
    await expect(p.getByTestId('holiday-row')).toHaveCount(5);
  });

  await test.step('admin1 เปลี่ยนบทบาทตัวเอง → 409 SELF_ROLE_CHANGE', async () => {
    await expectApiError(
      await ad.api.put('/api/admin/users/admin1', { data: { role: 'executive', dept: '' } }),
      409,
      'SELF_ROLE_CHANGE',
      MSG.SELF_ROLE_CHANGE,
    );
    await p.goto('/admin/users');
    const row = rowBy(p, 'user-row', 'data-username', 'admin1');
    await row.getByTestId('user-role-select').selectOption('executive');
    await row.getByTestId('user-save-btn').click();
    await expect(p.getByTestId('action-error')).toHaveText(MSG.SELF_ROLE_CHANGE);
    const me = await expectStatus(await ad.api.get('/api/me'), 200);
    expect(me?.role).toBe('admin');
  });

  await test.step('Audit ADMIN_CHANGE = 5 (คำขอที่ถูกปฏิเสธไม่ถูกบันทึก)', async () => {
    const au = await LOGIN_S('audit1', browser);
    await au.page.goto('/audit');
    await auditFilterUi(au.page, { event: 'ADMIN_CHANGE' });
    await expectAuditCount(au.page, 5, 'ADMIN_CHANGE');
    const all = (await auditRowsUi(au.page)).map((r) => r.detail).join('\n');
    for (const d of ['SV-01 fee 20 → 0', 'SV-01 fee 0 → 100000', 'SV-01 sla 3 → 1', 'SV-01 sla 1 → 60', 'holiday add 2026-12-05']) {
      expect.soft(all, `มี detail "${d}"`).toContain(d);
    }
    expect((await auditApi(au.api, { event: 'ADMIN_CHANGE' })).count).toBe(5);
  });
});

// ═════════════════════════════ NFR ═════════════════════════════

test('TC-NFR-01 Responsive 375 / 768 / 1280', async ({ browser }) => {
  await RESET();
  const SIZES = [
    { width: 375, height: 812 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 },
  ];
  const anonPage = (await newBrowserContext(browser)).page;
  const sc = await LOGIN_C(ID.SOMCHAI, browser);
  const r1 = await LOGIN_S('off.reg1', browser);
  const hd = await LOGIN_S('head1', browser);
  const ex = await LOGIN_S('exec1', browser);
  const au = await LOGIN_S('audit1', browser);
  const ad = await LOGIN_S('admin1', browser);
  const PAGES: Array<[Page, string]> = [
    [anonPage, '/login'],
    [sc.page, '/citizen'],
    [sc.page, '/citizen/new/SV-03'],
    [sc.page, citizenCase(EG(13))],
    [r1.page, '/officer/queue'],
    [r1.page, officerCase(EG(20))],
    [hd.page, '/head/approvals'],
    [ex.page, '/dashboard'],
    [au.page, '/audit'],
    [ad.page, '/admin/services'],
    [anonPage, `/verify/${SEED_CODE}`],
  ];

  await test.step('11 หน้า × 3 ขนาด: scrollWidth ≤ innerWidth', async () => {
    let checks = 0;
    for (const size of SIZES) {
      for (const [page, url] of PAGES) {
        await page.setViewportSize(size);
        const res = await page.goto(url);
        await page.waitForLoadState('load');
        expect.soft(res?.status(), `${url} @${size.width}px HTTP`).toBe(200);
        expect.soft(new URL(page.url()).pathname, `${url} @${size.width}px ไม่ถูกเปลี่ยนหน้า`).toBe(url);
        const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
        expect.soft(m.sw, `${url} @${size.width}px scrollWidth ${m.sw} > innerWidth ${m.iw}`).toBeLessThanOrEqual(m.iw);
        checks++;
      }
    }
    expect(checks).toBe(33);
  });

  await test.step('งานหลักที่ 375 px: ล็อกอิน → SV-01 → แนบ → ไปชำระ → create-qr-btn อยู่ในจอ', async () => {
    const { page } = await newBrowserContext(browser, { viewport: { width: 375, height: 812 } });
    await loginCitizenUi(page, ID.SOMCHAI);
    await expectPath(page, '/citizen');
    await page.getByTestId('start-service-SV-01').click();
    await expectPath(page, '/citizen/new/SV-01');
    await fillAndCommit(page.getByTestId('qty-input'), '1');
    await expect(page.getByTestId('fee-total')).toHaveText('฿20');
    await page.getByTestId('to-upload-btn').click();
    await expect(page.getByTestId('wizard-step')).toHaveText('2/3 แนบเอกสาร');
    await page.getByTestId('upload-input-id-card').setInputFiles(testFile('id-card.pdf'));
    await expect(page.getByTestId('file-item')).toHaveCount(1);
    await expect(page.getByTestId('to-payment-btn')).toBeEnabled();
    await page.getByTestId('to-payment-btn').click();
    const qr = page.getByTestId('create-qr-btn');
    await expect(qr).toBeVisible();
    const box = await qr.boundingBox();
    expect(box, 'create-qr-btn boundingBox').not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  });
});

test('TC-NFR-02 WCAG: axe + คีย์บอร์ด + label + สถานะไม่ใช้สีอย่างเดียว', async ({ browser }) => {
  await RESET();
  type Who2 = 'anon' | 'mana' | 'somchai' | 'off.reg1' | 'head1' | 'exec1' | 'audit1' | 'admin1';
  const A_PAGES: Array<[Who2, string]> = [
    ['anon', '/login'],
    ['mana', '/register'],
    ['somchai', '/citizen'],
    ['somchai', '/citizen/new/SV-01'],
    ['somchai', citizenCase(EG(17))],
    ['off.reg1', '/officer/queue'],
    ['off.reg1', officerCase(EG(20))],
    ['head1', '/head/approvals'],
    ['exec1', '/dashboard'],
    ['audit1', '/audit'],
    ['admin1', '/admin/services'],
    ['off.reg1', '/notifications'],
    ['anon', `/verify/${SEED_CODE}`],
  ];
  const pages = new Map<Who2, Page>();
  const pageOf = async (who: Who2): Promise<Page> => {
    let p = pages.get(who);
    if (!p) {
      if (who === 'anon') p = (await newBrowserContext(browser)).page;
      else if (who === 'mana') {
        const m = await LOGIN_C(ID.MANA, browser);
        expect(m.registered, 'มานะยังไม่ลงทะเบียน').toBe(false);
        p = m.page;
      } else if (who === 'somchai') p = (await LOGIN_C(ID.SOMCHAI, browser)).page;
      else p = (await LOGIN_S(who, browser)).page;
      pages.set(who, p);
    }
    return p;
  };

  type StatusEl = { testid: string; code: string; text: string };
  const readStatuses = (page: Page): Promise<StatusEl[]> =>
    page.evaluate(() => {
      const out: Array<{ testid: string; code: string; text: string }> = [];
      for (const id of ['case-status', 'row-status']) {
        document.querySelectorAll(`[data-testid="${id}"]`).forEach((el) => {
          const code = el.closest('[data-status]')?.getAttribute('data-status') ?? '';
          out.push({ testid: id, code, text: ((el as HTMLElement).innerText ?? '').trim() });
        });
      }
      for (const id of ['sla-level', 'row-sla-level']) {
        document.querySelectorAll(`[data-testid="${id}"]`).forEach((el) => {
          const code =
            el.closest('[data-level]')?.getAttribute('data-level') ??
            el.closest('[data-sla-level]')?.getAttribute('data-sla-level') ??
            '';
          out.push({ testid: id, code, text: ((el as HTMLElement).innerText ?? '').trim() });
        });
      }
      return out;
    });
  const expectStatusTexts = (els: StatusEl[], label: string) => {
    for (const e of els) {
      const map: Record<string, string> = e.testid.includes('status') ? STATUS_TH : LEVEL_TH;
      expect.soft(e.text, `${label} ${e.testid}[${e.code}] ข้อความไม่ว่าง`).not.toBe('');
      expect.soft(e.text, `${label} ${e.testid}[${e.code}]`).toBe(map[e.code]);
    }
  };

  await test.step('ส่วน A axe (serious/critical = 0) · ส่วน C label · ส่วน D สถานะมีข้อความ', async () => {
    let statusCount = 0;
    for (const [who, url] of A_PAGES) {
      const page = await pageOf(who);
      const res = await page.goto(url);
      expect.soft(res?.status(), `${who} ${url} HTTP`).toBe(200);
      expect.soft(new URL(page.url()).pathname, `${who} ${url} ไม่ redirect`).toBe(url.split('?')[0]);
      await page.waitForLoadState('networkidle').catch(() => undefined);

      const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      const bad = axe.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => `${v.id} (${v.impact}) × ${v.nodes.length}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
      expect.soft(bad, `axe ${url}`).toEqual([]);

      const unlabeled = await page.evaluate(() => {
        const out: string[] = [];
        const shown = (el: Element) => {
          const cs = getComputedStyle(el);
          return (el as HTMLElement).getClientRects().length > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
        };
        const textOfIds = (ids: string) =>
          ids
            .split(/\s+/)
            .map((i) => document.getElementById(i)?.textContent?.trim() ?? '')
            .join(' ')
            .trim();
        document.querySelectorAll('input, select, textarea').forEach((el) => {
          const type = (el.getAttribute('type') ?? '').toLowerCase();
          if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type) || !shown(el)) return;
          const aria = (el.getAttribute('aria-label') ?? '').trim();
          const by = el.getAttribute('aria-labelledby');
          const labels = (el as HTMLInputElement).labels;
          const hasLabel = !!labels && Array.from(labels).some((l) => (l.textContent ?? '').trim() !== '');
          if (aria || (by && textOfIds(by)) || hasLabel) return;
          out.push(`${el.tagName.toLowerCase()}[data-testid=${el.getAttribute('data-testid') ?? ''}][name=${el.getAttribute('name') ?? ''}]`);
        });
        return out;
      });
      expect.soft(unlabeled, `label ${url}`).toEqual([]);

      const st = await readStatuses(page);
      statusCount += st.length;
      expectStatusTexts(st, url);
      if (st.length) {
        await page.emulateMedia({ forcedColors: 'active' });
        expectStatusTexts(await readStatuses(page), `${url} (forced-colors)`);
        await page.emulateMedia({ forcedColors: 'none' });
      }
    }
    expect(statusCount, 'มี case-status/row-status/sla-level ให้ตรวจ').toBeGreaterThan(0);
  });

  await test.step('ส่วน B คีย์บอร์ดอย่างเดียว: ล็อกอิน → SV-01 → แนบ → ไปชำระ', async () => {
    const { page } = await newBrowserContext(browser);
    const noRing = new Set<string>();
    const tabTo = async (testid: string, max = 60) => {
      for (let i = 0; i <= max; i++) {
        const f = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || el === document.body || el === document.documentElement) return null;
          const cs = getComputedStyle(el);
          const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (!!cs.boxShadow && cs.boxShadow !== 'none');
          return { testid: el.getAttribute('data-testid') ?? '', tag: el.tagName.toLowerCase(), id: el.id, ring };
        });
        if (f) {
          if (!f.ring) noRing.add(`${f.tag}${f.testid ? `[data-testid=${f.testid}]` : f.id ? `#${f.id}` : ''} @${new URL(page.url()).pathname}`);
          if (f.testid === testid) return;
        }
        await page.keyboard.press('Tab');
      }
      throw new Error(`กด Tab ${max} ครั้งแล้วยังไม่ถึง ${testid} (${new URL(page.url()).pathname})`);
    };

    await page.goto('/login');
    try {
      await tabTo('thaid-id-input', 30);
    } catch {
      await tabTo('login-tab-citizen');
      await page.keyboard.press('Enter');
      await tabTo('thaid-id-input');
    }
    await page.keyboard.type(ID.SOMCHAI);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('otp-step')).toBeVisible();
    await tabTo('otp-input');
    await page.keyboard.type(OTP_OK);
    await page.keyboard.press('Enter');
    await expectPath(page, '/citizen');
    await tabTo('start-service-SV-01');
    await page.keyboard.press('Enter');
    await expectPath(page, '/citizen/new/SV-01');
    await tabTo('qty-input');
    await page.keyboard.press('Control+A');
    await page.keyboard.type('1');
    await tabTo('to-upload-btn');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('wizard-step')).toHaveText('2/3 แนบเอกสาร');
    await tabTo('upload-input-id-card');
    await page.getByTestId('upload-input-id-card').setInputFiles(testFile('id-card.pdf'));
    await expect(page.getByTestId('file-item')).toHaveCount(1);
    await expect(page.getByTestId('to-payment-btn')).toBeEnabled();
    await tabTo('to-payment-btn');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('create-qr-btn')).toBeVisible();
    expect([...noRing], 'องค์ประกอบที่โฟกัสแล้วไม่มี outline/ring').toEqual([]);
  });
});

test('TC-NFR-03 Health เวลาโหลด และผลซ้ำได้', async ({ browser }) => {
  await RESET();

  await test.step('GET /api/health → {"status":"ok"} ตรงตัว', async () => {
    const anon = await newApi();
    const res = await anon.get('/api/health');
    expect(res.status()).toBe(200);
    expect(JSON.parse(await res.text())).toStrictEqual({ status: 'ok' });
  });

  await test.step('เวลาโหลดรอบที่ 2 ≤ 3,000 ms', async () => {
    const pagesToTime: Array<[Page, string]> = [
      [(await newBrowserContext(browser)).page, '/login'],
      [(await LOGIN_C(ID.SOMCHAI, browser)).page, '/citizen'],
      [(await LOGIN_S('off.reg1', browser)).page, '/officer/queue'],
      [(await LOGIN_S('exec1', browser)).page, '/dashboard'],
      [(await LOGIN_S('audit1', browser)).page, '/audit'],
    ];
    for (const [page, url] of pagesToTime) {
      await page.goto(url, { waitUntil: 'load' });
      const t = Date.now();
      const res = await page.goto(url, { waitUntil: 'load' });
      const ms = Date.now() - t;
      expect.soft(res?.status(), `${url} HTTP`).toBe(200);
      expect.soft(ms, `${url} โหลด ${ms} ms`).toBeLessThanOrEqual(3000);
    }
  });

  const snapshot = async () => {
    const anon = await newApi();
    const clock = await expectStatus(await anon.get('/api/test/clock'), 200, 'GET /api/test/clock');
    const r1 = await LOGIN_S('off.reg1');
    const queue = (await queueApi(r1.api, 'all')).map((i) => ({
      caseNo: i.caseNo,
      dueAt: i.dueAt,
      status: i.status,
      owner: i.owner ?? null,
    }));
    const ex = await LOGIN_S('exec1');
    const dash = await dashApi(ex.api);
    return { clock: clock?.now, queue, dash };
  };

  await test.step('ผลซ้ำได้: RESET → S1 → เปลี่ยนสถานะ → RESET → S2 = S1', async () => {
    await RESET();
    const s1 = await snapshot();
    expect(s1.clock).toBe(T0);
    expect(s1.queue.length).toBe(17);
    await CLOCK('2026-12-10T12:00:00+07:00');
    const r1 = await LOGIN_S('off.reg1');
    await expectStatus(await claimApi(r1.api, EG(28)), 200, 'claim …000028');
    const paid = await NEW_PAID(ID.SOMCHAI, 'SV-01', undefined, { qty: 1 });
    expect(paid.caseNo).toBeTruthy();
    await RESET();
    const s2 = await snapshot();
    expect(s2).toEqual(s1);
    expect(s2.clock).toBe(T0);
  });

  await test.step('PUT /api/test/clock ไม่มี offset → 400 INVALID_TIME', async () => {
    const anon = await newApi();
    await expectApiError(await anon.put('/api/test/clock', { data: { now: '2026-12-01 09:00' } }), 400, 'INVALID_TIME');
  });

  await test.step('ปิด hook: เว็บที่ไม่ตั้ง TEST_MODE → POST /api/test/reset = 404', async () => {
    const other = (process.env.BASE_URL_NO_TEST_MODE ?? '').replace(/\/+$/, '');
    if (!other) {
      test.info().annotations.push({
        type: 'NFR-03',
        description: 'ข้ามการตรวจโหมดไม่มี TEST_MODE (ตั้ง BASE_URL_NO_TEST_MODE เพื่อตรวจ)',
      });
      return;
    }
    const api = await newApi();
    expect((await api.post(`${other}/api/test/reset`)).status()).toBe(404);
  });
});

test('TC-NFR-04 เข้ารหัสข้อมูลส่วนบุคคลที่เก็บ (inspection)', async () => {
  const started = Date.now();
  await RESET();

  await test.step('มานะลงทะเบียน เบอร์ 0845678901 (ตาม TC-AUTH-03)', async () => {
    const api = await newApi();
    await expectStatus(await api.post('/api/auth/thaid/start', { data: { idNo: ID.MANA } }), 200);
    const v = await expectStatus(await api.post('/api/auth/thaid/verify', { data: { idNo: ID.MANA, otp: OTP_OK } }), 200);
    expect(v?.registered).toBe(false);
    await expectStatus(
      await api.post('/api/auth/register', { data: { mobile: '0845678901', email: '', consent: true } }),
      201,
      'register มานะ',
    );
  });

  await test.step('ค้นค่าตรงตัวในไฟล์ฐานข้อมูล (DB_PATH + -wal/-journal/-shm) → 0 ทุกค่า', async () => {
    const fallback = path.resolve(__dirname, '../../data/egov.db');
    const main = [process.env.DB_PATH, fallback].find((p): p is string => !!p && fs.existsSync(p));
    expect(main, `ไม่พบไฟล์ฐานข้อมูล (DB_PATH=${process.env.DB_PATH ?? ''} · ${fallback})`).toBeTruthy();
    const files = [main!, `${main}-wal`, `${main}-journal`, `${main}-shm`]
      .concat((process.env.PII_SCAN_PATHS ?? '').split(',').map((s) => s.trim()))
      .filter((p) => !!p && fs.existsSync(p) && fs.statSync(p).isFile());
    expect(fs.readFileSync(main!).subarray(0, 15).toString('latin1'), `${main} เป็นไฟล์ SQLite`).toBe('SQLite format 3');
    const newest = Math.max(...files.map((f) => fs.statSync(f).mtimeMs));
    expect(newest, `${main} ต้องถูกเขียนระหว่าง test นี้ (เป็น DB ของเว็บที่ทดสอบอยู่)`).toBeGreaterThanOrEqual(started - 5_000);
    test.info().annotations.push({ type: 'NFR-04 files', description: files.join(', ') });

    const values = [
      ID.SOMCHAI,
      ID.SOMYING,
      ID.PITI,
      ID.MANA,
      '0812345678',
      '0823456789',
      '0834567890',
      '0845678901',
      '1-1017-00123-45-6',
      '3-1006-00987-65-9',
      '1-9099-00555-01-5',
      '5-5004-00111-22-1',
    ];
    const bufs = files.map((f) => [f, fs.readFileSync(f)] as const);
    for (const v of values) {
      const needle = Buffer.from(v, 'utf8');
      let count = 0;
      const where: string[] = [];
      for (const [f, b] of bufs) {
        for (let i = b.indexOf(needle); i >= 0; i = b.indexOf(needle, i + 1)) {
          count++;
          if (!where.includes(f)) where.push(f);
        }
      }
      expect.soft(count, `พบ "${v}" ${count} ครั้งใน ${where.join(', ')}`).toBe(0);
    }
  });

  await test.step('ตัวควบคุมบวก: สมชายยังเห็น idNo เต็มของตัวเอง', async () => {
    const sc = await LOGIN_C(ID.SOMCHAI);
    expect((await getCase(sc.api, EG(5))).idNo).toBe(ID.SOMCHAI);
    test.info().annotations.push({
      type: 'NFR-04',
      description: 'ผู้ทดสอบบันทึกวิธีเข้ารหัสที่เว็บใช้ (เช่น AES-256-GCM) ในรายงาน · HTTPS เป็น Q-08 ไม่ทดสอบที่นี่',
    });
  });
});
