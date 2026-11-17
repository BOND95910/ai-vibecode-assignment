// ตัวช่วยหน้าจอ: ใช้ data-testid ตาม CONTRACT เท่านั้น (ไม่อ่านโค้ดเว็บ)
const { expect } = require('@playwright/test');
const { tid, text, attr, count } = require('./check');
const { testFile } = require('./files');

const rowSel = (testid, attrName, value) => `[data-testid="${testid}"][${attrName}="${value}"]`;
const queueRow = (page, caseNo) => page.locator(rowSel('queue-row', 'data-case-no', caseNo));

// ---- ล็อกอินผ่านหน้า /login ----
async function uiLoginC(page, idNo, otp = '123456') {
  await page.goto('/login');
  await tid(page, 'login-tab-citizen').click();
  await tid(page, 'thaid-id-input').fill(idNo);
  await tid(page, 'thaid-submit').click();
  await expect(tid(page, 'otp-step'), 'หลังเลขบัตรถูกต้อง otp-step ต้องแสดง').toBeVisible();
  await tid(page, 'otp-input').fill(otp);
  await tid(page, 'otp-submit').click();
}
async function uiLoginS(page, username, password = 'Test@1234') {
  await page.goto('/login');
  await tid(page, 'login-tab-staff').click();
  await tid(page, 'staff-username').fill(username);
  await tid(page, 'staff-password').fill(password);
  await tid(page, 'staff-submit').click();
}

// ---- รอหน้าโหลดข้อมูลจริงก่อนตรวจ "ไม่มีปุ่ม" (กัน count()==0 ผ่านหลอกก่อน render) ----
async function caseReady(page, caseNo) {
  await expect(tid(page, 'case-no'), `หน้าคำขอ ${caseNo}: case-no`).toHaveText(caseNo);
  await expect(tid(page, 'case-status'), 'case-status ต้องมี data-status').toHaveAttribute('data-status', /\S/);
}
async function openCase(page, path, caseNo) {
  await page.goto(path);
  await caseReady(page, caseNo);
}
const officerCase = (page, caseNo) => openCase(page, `/officer/cases/${caseNo}`, caseNo);
const citizenCase = (page, caseNo) => openCase(page, `/citizen/cases/${caseNo}`, caseNo);

async function queueReady(page) {
  await expect(page.getByTestId('queue-row').first(), 'คิวต้องมีอย่างน้อย 1 แถว').toBeVisible();
}
async function dashReady(page) {
  await expect(tid(page, 'kpi-received')).toHaveText(/\S/);
}
async function auditReady(page) {
  await expect(page.getByTestId('audit-row').first(), 'Audit ต้องมีอย่างน้อย 1 แถว').toBeVisible();
}

// รายการค่าของแถวทั้งหมด เช่น rowAttr(page,'queue-row','data-case-no') -> ['EG-..','..']
async function rowAttr(page, rowTestId, attrName) {
  return page.getByTestId(rowTestId).evaluateAll((els, a) => els.map((e) => e.getAttribute(a)), attrName);
}
async function rowCellTexts(page, rowTestId, cellTestId) {
  return page.getByTestId(rowTestId).evaluateAll(
    (els, c) => els.map((e) => (e.querySelector(`[data-testid="${c}"]`)?.textContent || '').trim()),
    cellTestId,
  );
}
const lastDigits = (arr) => arr.map((s) => s.slice(-6));

// ---- การกระทำบนหน้าคำขอฝั่งเจ้าหน้าที่ ----
async function doApprove(page) { await tid(page, 'approve-btn').click(); }
async function doIssue(page) { await tid(page, 'issue-btn').click(); }
async function doForward(page, note) {
  if (note !== undefined) await tid(page, 'forward-note').fill(note);
  await tid(page, 'forward-btn').click();
}
async function doReturn(page, reason) {
  await tid(page, 'return-btn').click();
  await tid(page, 'return-reason').fill(reason);
  await tid(page, 'return-submit').click();
}
async function doReject(page, reason) {
  await tid(page, 'reject-btn').click();
  await tid(page, 'reject-reason').fill(reason);
  await tid(page, 'reject-submit').click();
}
async function doUnmask(page, reason) {
  await tid(page, 'show-full-id-btn').click();
  await tid(page, 'unmask-reason').fill(reason);
  await tid(page, 'unmask-submit').click();
}
async function doClaimRow(page, caseNo) {
  await queueRow(page, caseNo).getByTestId('claim-btn').click();
}

// ---- ตัวช่วยขั้นตอนยื่นคำขอ ----
async function attach(page, inputTestId, fileName) {
  await tid(page, inputTestId).setInputFiles(testFile(fileName));
}
// เริ่มบริการ → กรอกข้อมูล → ขั้นแนบเอกสารบังคับ → ขั้นชำระเงิน → สร้าง QR (ผ่านหน้าจอ) คืน qr-ref
async function uiToQr(page, service, { qty, area } = {}) {
  await page.goto(`/citizen/new/${service}`);
  await text(page, 'wizard-step', '1/3 กรอกข้อมูล', 'ขั้น 1');
  if (qty !== undefined) await tid(page, 'qty-input').fill(String(qty));
  if (area !== undefined) await tid(page, 'area-input').fill(String(area));
  await tid(page, 'to-upload-btn').click();
  await text(page, 'wizard-step', '2/3 แนบเอกสาร', 'ขั้น 2');
  const docs = { 'SV-01': [['upload-input-id-card', 'id-card.pdf']], 'SV-02': [['upload-input-id-card', 'id-card.pdf'], ['upload-input-map', 'map.pdf']], 'SV-03': [['upload-input-id-card', 'id-card.pdf'], ['upload-input-plan', 'plan.pdf'], ['upload-input-deed', 'deed.pdf']] }[service];
  for (const [input, name] of docs) await attach(page, input, name);
  await expect(tid(page, 'to-payment-btn'), 'แนบเอกสารบังคับครบแล้ว to-payment-btn ต้องใช้ได้').toBeEnabled();
  await tid(page, 'to-payment-btn').click();
  await text(page, 'wizard-step', '3/3 ชำระเงิน', 'ขั้น 3');
  await tid(page, 'create-qr-btn').click();
  await expect(tid(page, 'qr-ref')).toHaveText(/^PP-\d+$/);
  return (await tid(page, 'qr-ref').textContent()).trim();
}

// ดาวน์โหลดด้วยการกดปุ่ม คืน { download, response } (response = คำตอบ HTTP ของลิงก์ดาวน์โหลดถ้าจับได้)
async function clickDownload(page, locator, urlPart) {
  const dl = page.waitForEvent('download');
  // ลิงก์ดาวน์โหลดบางแบบไม่ส่ง response event: ไม่ถือเป็นข้อผิดพลาดของ TC
  const resp = urlPart ? page.waitForResponse((r) => r.url().includes(urlPart), { timeout: 8000 }).catch(() => null) : Promise.resolve(null);
  await locator.click();
  const download = await dl;
  return { download, response: await resp };
}

module.exports = {
  rowSel, queueRow, uiLoginC, uiLoginS, caseReady, openCase, officerCase, citizenCase, queueReady, dashReady, auditReady,
  rowAttr, rowCellTexts, lastDigits, doApprove, doIssue, doForward, doReturn, doReject, doUnmask, doClaimRow, attach, uiToQr,
  clickDownload, attr, count, text, tid,
};
