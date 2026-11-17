// Shared recipes from TEST-PLAN §0: RESET, CLOCK, LOGIN_C, LOGIN_S, NEW_PAID.
// Expected values in the specs come from the rules (REQUIREMENTS/TEST-DATA), never from the screen.
const path = require('node:path');
const base = require('@playwright/test');
const { expect } = base;

const BASE = process.env.BASE_URL_RESOLVED || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3100}`;
const ID = { somchai: '1101700123456', somying: '3100600987659', mana: '5500400111221', piti: '1909900555015' };
const PW = 'Test@1234';
const file = name => path.join(__dirname, 'testfiles', name);
const REQUIRED = { 'SV-01': ['id-card'], 'SV-02': ['id-card', 'map'], 'SV-03': ['id-card', 'plan', 'deed'] };
const TH_M = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const thText = iso => { const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return `${d} ${TH_M[m - 1]} ${y + 543}${iso.length > 10 ? ' ' + iso.slice(11, 16) : ''}`; };
const baht = n => '฿' + n.toLocaleString('en-US');
// expected labels (CONTRACT §4) — written here independently of app/, so tests check the app instead of copying it
const STATUS_TH = { DRAFT: 'ร่าง', PENDING_PAYMENT: 'รอชำระเงิน', SUBMITTED: 'ส่งคำขอแล้ว', IN_REVIEW: 'กำลังตรวจสอบ', NEED_FIX: 'รอแก้ไขเอกสาร', PENDING_APPROVAL: 'รออนุมัติ', APPROVED: 'อนุมัติ', COMPLETED: 'เสร็จสิ้น', REJECTED: 'ไม่อนุมัติ', CANCELLED: 'ยกเลิก' };
const LEVEL_TH = { normal: 'ปกติ', near: 'ใกล้ครบกำหนด', overdue: 'เกินกำหนด', paused: 'หยุดนับ', closed: 'ปิดแล้ว' };
const MASK = /^X-XXXX-XXXXX-\d{2}-\d$/;
const pdfText = buf => [...buf.toString('latin1').matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)].map(m => m[1].replace(/\\(.)/g, '$1')).join('\n');

const test = base.test.extend({
  h: async ({ browser, playwright }, use) => {
    const owned = [];
    const api = async () => { const c = await playwright.request.newContext({ baseURL: BASE }); owned.push(c); return c; };
    const hook = await api();
    const h = {
      api,
      async reset() {
        const r = await hook.post('/api/test/reset');
        expect(r.status(), 'POST /api/test/reset').toBe(200);
        expect(await r.json()).toEqual({ ok: true, now: '2026-12-01T09:00:00+07:00' });
      },
      async clock(now) {
        const r = await hook.put('/api/test/clock', { data: { now } });
        expect(r.status(), `CLOCK(${now})`).toBe(200);
      },
      pay: (ref, amount) => hook.post(`/api/test/payments/${ref}/pay`, { data: { amount } }),
      tamper: docNo => hook.post(`/api/test/documents/${docNo}/tamper`),
      async loginC(who, ctx) {
        ctx ||= await api();
        const idNo = ID[who] || who;
        expect((await ctx.post('/api/auth/thaid/start', { data: { idNo } })).status(), `thaid start ${who}`).toBe(200);
        const r = await ctx.post('/api/auth/thaid/verify', { data: { idNo, otp: '123456' } });
        expect(r.status(), `thaid verify ${who}`).toBe(200);
        return ctx;
      },
      async loginS(username, ctx) {
        ctx ||= await api();
        const r = await ctx.post('/api/auth/staff/login', { data: { username, password: PW } });
        expect(r.status(), `staff login ${username}`).toBe(200);
        return ctx;
      },
      async page(opts = {}) {
        const context = await browser.newContext({ baseURL: BASE, ...opts });
        owned.push(context);
        return context.newPage();
      },
      async pageC(who, opts) { const p = await h.page(opts); await h.loginC(who, p.request); return p; },
      async pageS(user, opts) { const p = await h.page(opts); await h.loginS(user, p.request); return p; },
      upload: (ctx, draftId, docKey, name, buffer) => ctx.post(`/api/drafts/${draftId}/files`, {
        multipart: { docKey, file: buffer ? { name, mimeType: 'application/octet-stream', buffer } : require('node:fs').createReadStream(file(name)) } }),
      // draft + required files + QR (not paid)
      async newQr(ctx, service = 'SV-01', opts = {}) {
        const body = { serviceId: service, ...(service === 'SV-01' ? { qty: opts.qty ?? 1 } : {}), ...(service === 'SV-03' ? { areaSqm: opts.areaSqm ?? 100 } : {}) };
        const d = await ctx.post('/api/drafts', { data: body });
        expect(d.status(), 'POST /api/drafts').toBe(201);
        const { draftId, fee } = await d.json();
        for (const key of REQUIRED[service]) expect((await h.upload(ctx, draftId, key, `${key}.pdf`)).status(), `upload ${key}`).toBe(201);
        const p = await ctx.post(`/api/drafts/${draftId}/payment`);
        expect(p.status(), 'POST payment').toBe(201);
        return { draftId, fee, ...(await p.json()) };
      },
      // NEW_PAID(ผู้ยื่น, บริการ, เวลา, ตัวเลือก)
      async newPaid({ who = 'somchai', service = 'SV-01', at, ctx, ...opts } = {}) {
        if (at) await h.clock(at);
        ctx ||= await h.loginC(who);
        const q = await h.newQr(ctx, service, opts);
        const r = await h.pay(q.ref, q.fee);
        expect(r.status(), `pay ${q.ref}`).toBe(200);
        const caseNo = (await (await ctx.get(`/api/payments/${q.ref}`)).json()).caseNo;
        return { ...q, caseNo, ctx };
      },
      // LOGIN_C / LOGIN_S through the /login page (UI flows)
      async uiLoginC(page, idNo) {
        await page.goto('/login');
        await page.getByTestId('thaid-id-input').fill(idNo);
        await page.getByTestId('thaid-submit').click();
        await page.getByTestId('otp-input').fill('123456');
        await page.getByTestId('otp-submit').click();
      },
      async uiLoginS(page, username, password = PW) {
        await page.goto('/login');
        await page.getByTestId('login-tab-staff').click();
        await page.getByTestId('staff-username').fill(username);
        await page.getByTestId('staff-password').fill(password);
        await page.getByTestId('staff-submit').click();
      },
      async expectErr(resp, status, code, label) {
        const body = await resp.json().catch(() => ({}));
        expect({ status: resp.status(), code: body.code }, label).toEqual({ status, code });
        return body;
      },
      async caseOf(ctx, caseNo) { return (await ctx.get(`/api/cases/${caseNo}`)).json(); },
      async queueNos(page) {
        await page.getByTestId('queue-table').waitFor();
        return page.getByTestId('queue-row').evaluateAll(rs => rs.map(r => r.dataset.caseNo));
      },
    };
    await use(h);
    for (const c of owned.reverse()) await (c.dispose ? c.dispose() : c.close()).catch(() => {});
  },
});

module.exports = { test, expect, BASE, ID, file, thText, baht, pdfText, STATUS_TH, LEVEL_TH, MASK };
