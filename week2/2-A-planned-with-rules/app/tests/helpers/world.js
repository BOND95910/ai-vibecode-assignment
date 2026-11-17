// "โลก" ของ TC หนึ่งเรื่อง: RESET · CLOCK · LOGIN_C · LOGIN_S · NEW_PAID ตามสูตรกลาง TEST-PLAN ข้อ 0
// หลัก: RESET ล้าง session ทุกคน (CONTRACT 0.9) จึงปิด context ทุกตัวที่เปิดไว้ก่อน reset แล้วล็อกอินใหม่เสมอ
const base = require('@playwright/test');
const { BASE_URL } = require('./env');
const { status, eq, ok } = require('./check');
const { call, get, post, put, loginAs, loginC, loginS, CITIZENS } = require('./http');
const { testFile, REQUIRED_DOCS } = require('./files');

const CTX_OPTS = { baseURL: BASE_URL, locale: 'th-TH', timezoneId: 'Asia/Bangkok' };
const DEFAULT_NOW = '2026-12-01T09:00:00+07:00';

class World {
  constructor(playwright, browser) {
    this.pw = playwright;
    this.browser = browser;
    this.apis = new Set(); // APIRequestContext ที่ล็อกอินแล้ว (ใช้ได้ถึง RESET ครั้งถัดไป)
    this.bctxs = new Set(); // BrowserContext
    this.cache = new Map();
    this.hookCtx = null; // /api/test/* ไม่ต้องล็อกอิน จึงใช้ตัวเดียวได้ตลอด
  }

  async _hook() {
    if (!this.hookCtx) this.hookCtx = await this.pw.request.newContext({ baseURL: BASE_URL });
    return this.hookCtx;
  }

  async closeSessions() {
    for (const c of this.apis) await c.dispose().catch(() => {});
    for (const c of this.bctxs) await c.close().catch(() => {});
    this.apis.clear();
    this.bctxs.clear();
    this.cache.clear();
  }

  async dispose() {
    await this.closeSessions();
    if (this.hookCtx) await this.hookCtx.dispose().catch(() => {});
  }

  // RESET: POST /api/test/reset → 200 · now = 2026-12-01T09:00:00+07:00 · session เก่าใช้ไม่ได้อีก
  async reset() {
    await this.closeSessions();
    const r = await post(await this._hook(), '/api/test/reset');
    status(r, 200, 'RESET');
    eq(r.body && r.body.now, DEFAULT_NOW, 'RESET now');
    return r.body;
  }

  // CLOCK(t): PUT /api/test/clock (นาฬิกาแช่แข็ง)
  async clock(t) {
    const r = await put(await this._hook(), '/api/test/clock', { now: t });
    status(r, 200, `CLOCK(${t})`);
    ok(r.body && new Date(r.body.now).getTime() === new Date(t).getTime(), `CLOCK(${t}) now`, `received ${r.text}`);
    return r.body;
  }
  async getClock() {
    const r = await get(await this._hook(), '/api/test/clock');
    status(r, 200, 'GET clock');
    return r.body.now;
  }

  // callback ธนาคารจำลอง: คืนผลดิบ (status/body) ให้ TC ตรวจเอง
  async pay(ref, amount) {
    return post(await this._hook(), `/api/test/payments/${ref}/pay`, { amount });
  }
  async tamper(docNo) {
    return post(await this._hook(), `/api/test/documents/${docNo}/tamper`);
  }
  hook() { return this._hook(); }

  async _newApi() {
    const c = await this.pw.request.newContext({ baseURL: BASE_URL });
    this.apis.add(c);
    return c;
  }

  // request context ที่ล็อกอินแล้ว (ใช้ซ้ำต่อบัญชีจนกว่าจะ RESET) · who = somchai|somying|mana|piti|off.reg1|...
  async api(who) {
    if (this.cache.has(who)) return this.cache.get(who);
    const c = await this._newApi();
    if (who !== 'anon') await loginAs(c, who);
    this.cache.set(who, c);
    return c;
  }
  // ล็อกอินใหม่ทุกครั้ง (ไม่ใช้ cache) เช่นหลังตั้งบทบาทใหม่
  async fresh(who) {
    const c = await this._newApi();
    if (who !== 'anon') await loginAs(c, who);
    return c;
  }
  async anon() { return this.api('anon'); }

  // VIDEO=1 → อัดวิดีโอของ context ที่เปิดผ่าน session/pageFor ลงโฟลเดอร์ของ TC (ทำ GIF หลักฐาน) · ปกติไม่อัด
  rec() { return this.videoDir ? { recordVideo: { dir: this.videoDir, size: { width: 800, height: 450 } } } : {}; }

  // เบราว์เซอร์ context ที่ล็อกอินแล้วผ่าน API (cookie ใช้ร่วมกับหน้า) · who = 'anon' ไม่ล็อกอิน
  async session(who, { viewport } = {}) {
    const ctx = await this.browser.newContext({ ...CTX_OPTS, ...this.rec(), ...(viewport ? { viewport } : {}) });
    this.bctxs.add(ctx);
    if (who !== 'anon') await loginAs(ctx.request, who);
    const page = await ctx.newPage();
    return { ctx, page, api: ctx.request };
  }

  // หน้าเบราว์เซอร์ที่ใช้ cookie เดียวกับ request context ที่ล็อกอินแล้ว (ไม่ล็อกอินซ้ำ จึงไม่เกิดแถว STAFF_LOGIN เพิ่ม)
  async pageFor(api, { viewport } = {}) {
    const state = await api.storageState();
    const ctx = await this.browser.newContext({ ...CTX_OPTS, ...this.rec(), storageState: state, ...(viewport ? { viewport } : {}) });
    this.bctxs.add(ctx);
    const page = await ctx.newPage();
    return { ctx, page, api: ctx.request };
  }

  // GET /api/audit ด้วย audit1 (ระวัง: การล็อกอินครั้งแรกของ audit1 เกิดแถว STAFF_LOGIN)
  async auditItems(query = '') {
    const r = await get(await this.api('audit1'), '/api/audit' + (query ? '?' + query : ''));
    status(r, 200, `GET /api/audit?${query}`);
    return r.body;
  }
  async dashboard(period = '2026-12', service = 'ALL', who = 'exec1') {
    const r = await get(await this.api(who), `/api/dashboard?period=${period}&service=${service}`);
    status(r, 200, `GET dashboard ${period} ${service}`);
    return r.body;
  }

  // ---- ร่าง / ไฟล์ / ชำระ ----
  async draft(r, serviceId, extra = {}) {
    const res = await post(r, '/api/drafts', { serviceId, ...extra });
    status(res, 201, `POST /api/drafts ${serviceId} ${JSON.stringify(extra)}`);
    return res.body; // { draftId, fee }
  }
  async upload(r, draftId, docKey, file, expect = 201) {
    const res = await call(r, 'POST', `/api/drafts/${draftId}/files`, {
      multipart: { docKey, file: typeof file === 'string' ? testFile(file) : file },
    });
    if (expect) status(res, expect, `upload ${docKey}/${typeof file === 'string' ? file : file.name} → ${draftId}`);
    return res;
  }
  async qr(r, draftId, expect = 201) {
    const res = await post(r, `/api/drafts/${draftId}/payment`);
    if (expect) status(res, expect, `POST /api/drafts/${draftId}/payment`);
    return res;
  }

  /**
   * NEW_PAID(ผู้ยื่น, บริการ, เวลา, ตัวเลือก) ตามสูตรกลางข้อ 0:
   * CLOCK(at) → LOGIN_C → POST /api/drafts → ไฟล์บังคับ → POST /payment → pay → GET /api/payments/<ref>
   * opts: who (ค่าตั้งต้น somchai) · service · at · qty · areaSqm · r (request context ที่ล็อกอินแล้ว) · unpaid (หยุดหลังสร้าง QR) · amount (ยอดที่ยิง callback)
   */
  async newPaid(opts = {}) {
    const { who = 'somchai', service = 'SV-01', at, qty = 1, areaSqm = 100, unpaid = false } = opts;
    if (at) await this.clock(at);
    const r = opts.r || (await this.api(who));
    const extra = service === 'SV-01' ? { qty } : service === 'SV-03' ? { areaSqm } : {};
    const d = await this.draft(r, service, extra);
    for (const [docKey, name] of REQUIRED_DOCS[service]) await this.upload(r, d.draftId, docKey, name);
    const q = await this.qr(r, d.draftId);
    const out = { draftId: d.draftId, fee: d.fee, ref: q.body.ref, amount: q.body.amount, qr: q.body };
    if (unpaid) return out;
    const p = await this.pay(out.ref, opts.amount ?? d.fee);
    status(p, 200, `NEW_PAID pay ${out.ref}`);
    const g = await get(r, `/api/payments/${out.ref}`);
    status(g, 200, `GET /api/payments/${out.ref}`);
    ok(g.body.caseNo, `NEW_PAID ${out.ref} ต้องได้ caseNo`, `received ${g.text}`);
    return { ...out, caseNo: g.body.caseNo, receiptNo: g.body.receiptNo, payBody: p.body };
  }
}

const test = base.test.extend({
  w: async ({ playwright, browser }, use, testInfo) => {
    const w = new World(playwright, browser);
    if (process.env.VIDEO) w.videoDir = require('path').join(process.env.VIDEO_DIR || 'test-results/videos', testInfo.title.split(' ')[0]);
    await use(w);
    await w.dispose();
  },
});

module.exports = { test, expect: base.expect, World, DEFAULT_NOW, CTX_OPTS, CITIZENS, loginC, loginS };
