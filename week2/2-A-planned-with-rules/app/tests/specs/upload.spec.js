// หมวด UPLOAD · TC-UPLOAD-01 (จับ B02) · TC-UPLOAD-02
const { test, expect } = require('../helpers/world');
const { eq, ok, status, err, tid, text, count, hidden } = require('../helpers/check');
const { get } = require('../helpers/http');
const { testFile } = require('../helpers/files');
const { attach } = require('../helpers/ui');

const E_BIG = 'ไฟล์ใหญ่เกิน 5 MB';
const E_TYPE = 'รองรับเฉพาะไฟล์ PDF, JPG, PNG';
const E_COUNT = 'แนบได้สูงสุด 5 ไฟล์ต่อคำขอ';

// เปิดร่าง SV-01 (qty 1) ไปที่ขั้นแนบเอกสารผ่านหน้าจอ
async function toUploadStep(page) {
  await page.goto('/citizen/new/SV-01');
  await tid(page, 'qty-input').fill('1');
  await tid(page, 'to-upload-btn').click();
  await text(page, 'wizard-step', '2/3 แนบเอกสาร', 'ขั้นแนบเอกสาร');
}
// จำนวนไฟล์ในร่างจาก API (รูปแบบ GET /api/drafts/:id ไม่ได้ระบุใน CONTRACT: ถ้าไม่มีอาร์เรย์ files คืน null)
const filesIn = (body) => (body && Array.isArray(body.files) ? body.files.length : null);

test('TC-UPLOAD-01 ขนาดและจำนวนไฟล์', async ({ w }) => {
  await w.reset();
  const { page, api } = await w.session('somchai');

  // ---- ขนาด: API (ร่างแยกต่อไฟล์) ----
  const sizes = [[5242879, 201], [5242880, 201], [5242881, 400]];
  for (const [n, expected] of sizes) {
    const d = await w.draft(api, 'SV-01', { qty: 1 });
    const r = await w.upload(api, d.draftId, 'id-card', `size-${n}.pdf`, null);
    if (expected === 201) {
      status(r, 201, `API ไฟล์ ${n} ไบต์ (≤ 5 MB ต้องรับ)`);
      eq(r.body.size, n, `API ไฟล์ ${n} size ที่เก็บ`);
    } else {
      err(r, 400, 'FILE_TOO_LARGE', E_BIG, `API ไฟล์ ${n} ไบต์ (เกิน 5 MB ต้อง 400 ไม่ใช่ 413)`);
    }
  }

  // ---- ขนาด: หน้าจอ ----
  await toUploadStep(page);
  for (const n of [5242879, 5242880]) {
    await attach(page, 'upload-input-id-card', `size-${n}.pdf`);
    await count(tid(page, 'file-item'), 1, `หน้าจอ ไฟล์ ${n} ไบต์ ต้องรับ`);
    await hidden(tid(page, 'upload-error'), `หน้าจอ ไฟล์ ${n} ไบต์ ต้องไม่มี upload-error`);
    await tid(page, 'file-remove-btn').first().click();
    await count(tid(page, 'file-item'), 0, `ลบไฟล์ ${n} แล้ว`);
  }
  await attach(page, 'upload-input-id-card', 'size-5242881.pdf');
  await text(page, 'upload-error', E_BIG, 'หน้าจอ ไฟล์ 5242881 ไบต์ upload-error');
  await count(tid(page, 'file-item'), 0, 'หน้าจอ ไฟล์ 5242881 ไบต์ ต้องไม่เพิ่ม file-item');

  // ---- จำนวน: หน้าจอ ----
  await toUploadStep(page);
  await attach(page, 'upload-input-id-card', 'id-card.pdf');
  await tid(page, 'upload-input-extra').setInputFiles(['multi-1.pdf', 'multi-2.pdf', 'multi-3.pdf', 'multi-4.pdf'].map((name) => testFile(name)));
  await count(tid(page, 'file-item'), 5, 'รวม 5 ไฟล์ ต้องรับครบ');
  await attach(page, 'upload-input-extra', 'multi-5.pdf');
  await text(page, 'upload-error', E_COUNT, 'ไฟล์ที่ 6 upload-error');
  await count(tid(page, 'file-item'), 5, 'ไฟล์ที่ 6 ถูกปฏิเสธ file-item ต้องยัง 5');
  await page.locator('[data-testid="file-item"][data-doc-key="extra"]').first().getByTestId('file-remove-btn').click();
  await count(tid(page, 'file-item'), 4, 'ลบ 1 ไฟล์');
  await attach(page, 'upload-input-extra', 'multi-5.pdf');
  await count(tid(page, 'file-item'), 5, 'แนบ multi-5.pdf หลังลบ 1 ไฟล์ ต้องรับ (ไฟล์ที่ถูกปฏิเสธไม่ถูกนับ)');

  // ---- จำนวน: API ----
  const d = await w.draft(api, 'SV-01', { qty: 1 });
  await w.upload(api, d.draftId, 'id-card', 'id-card.pdf');
  for (const i of [1, 2, 3, 4]) await w.upload(api, d.draftId, 'extra', `multi-${i}.pdf`);
  const sixth = await w.upload(api, d.draftId, 'extra', 'multi-5.pdf', null);
  err(sixth, 400, 'FILE_COUNT', E_COUNT, 'API ไฟล์ที่ 6');
});

test('TC-UPLOAD-02 ชนิดไฟล์จากเนื้อไฟล์', async ({ w }) => {
  await w.reset();
  const { page, api } = await w.session('somchai');
  const accepted = ['ok-id.pdf', 'real.jpg', 'real.png'];
  const rejected = [
    ['fake-text.pdf', undefined, 'ข้อความ hello นามสกุล .pdf'],
    ['fake-text.jpg', undefined, 'ข้อความ นามสกุล .jpg'],
    ['exe-as.png', undefined, 'หัวไฟล์ MZ นามสกุล .png'],
    ['notes.txt', undefined, 'ข้อความ .txt'],
    ['fake-text.pdf', 'application/pdf', 'ข้อความ ส่งด้วย Content-Type application/pdf (ห้ามเชื่อ Content-Type)'],
  ];

  // ---- API ----
  for (const name of accepted) {
    const d = await w.draft(api, 'SV-01', { qty: 1 });
    const r = await w.upload(api, d.draftId, 'id-card', name, null);
    status(r, 201, `API ${name} (เนื้อไฟล์จริงถูกชนิด ต้องรับ)`);
  }
  // ร่างเดียวรับไม่เกิน 5 ไฟล์: ถ้าไฟล์ที่ถูกปฏิเสธถูกเก็บ/นับ ไฟล์ดี 5 ไฟล์ท้ายนี้จะไม่ครบ
  const d = await w.draft(api, 'SV-01', { qty: 1 });
  for (const [name, mime, why] of rejected) {
    const r = await w.upload(api, d.draftId, 'id-card', testFile(name, mime), null);
    err(r, 400, 'FILE_TYPE', E_TYPE, `API ${name} (${why})`);
  }
  const g = await get(api, `/api/drafts/${d.draftId}`);
  status(g, 200, 'API GET ร่างหลังโดนปฏิเสธ');
  const n = filesIn(g.body);
  if (n !== null) eq(n, 0, 'API GET /api/drafts/:id จำนวนไฟล์ต้องไม่เพิ่มจากไฟล์ที่ถูกปฏิเสธ');
  await w.upload(api, d.draftId, 'id-card', 'id-card.pdf');
  for (const i of [1, 2, 3, 4]) await w.upload(api, d.draftId, 'extra', `multi-${i}.pdf`);
  const sixth = await w.upload(api, d.draftId, 'extra', 'multi-5.pdf', null);
  err(sixth, 400, 'FILE_COUNT', 'แนบได้สูงสุด 5 ไฟล์ต่อคำขอ', 'API ไฟล์ที่ถูกปฏิเสธต้องไม่ถูกนับรวม (แนบดีครบ 5 แล้วไฟล์ที่ 6 ถึงเต็ม)');

  // ---- หน้าจอ ----
  await toUploadStep(page);
  for (const name of accepted) {
    await attach(page, 'upload-input-id-card', name);
    await count(tid(page, 'file-item'), 1, `หน้าจอ ${name} ต้องรับ`);
    await tid(page, 'file-remove-btn').first().click();
    await count(tid(page, 'file-item'), 0, `ลบ ${name} แล้ว`);
  }
  for (const [name, mime, why] of rejected) {
    await tid(page, 'upload-input-id-card').setInputFiles(testFile(name, mime));
    await text(page, 'upload-error', E_TYPE, `หน้าจอ ${name} (${why}) upload-error`);
    await count(tid(page, 'file-item'), 0, `หน้าจอ ${name} (${why}) ต้องไม่เพิ่ม file-item`);
  }
});
