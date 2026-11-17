# ARCHITECTURE · ข้อตกลงร่วมของทีม (ทุกบล็อกต้องอ่านก่อนเริ่ม)

โจทย์ต้นทางอยู่ที่ `../../egov-brief/` (อ่านอย่างเดียว) — ถ้าเอกสารนี้ขัดกับ CONTRACT/REQUIREMENTS/TEST-DATA/DECISIONS ให้ยึดชุดโจทย์

## Stack

- Node.js 24 (CommonJS) · Express 4 · **`node:sqlite` (`DatabaseSync`) ในตัว ไม่ใช้ native module** · multer สำหรับ multipart · ไม่มี build step
- พอร์ต `PORT` (ค่าตั้งต้น 3000) · `BASE_URL` (ตั้งต้น `http://localhost:3000`) · `DB_PATH` (ตั้งต้น `./data/app.db` ในเครื่อง · `/data/app.db` ใน Docker volume) · `TEST_MODE=1` · `BUG_MODE=B03,B07`
- รันด้วย Docker: `docker compose up --build` คำสั่งเดียว (Dockerfile ฐาน `node:24-slim`) · รันในเครื่อง: `npm install && npm start`
- เวลา: ทุกกฎธุรกิจอ่านจาก `server/clock.js` เท่านั้น (ห้าม `new Date()` ตรง ๆ ในกฎธุรกิจ) · เก็บเวลาใน DB เป็น ISO `+07:00`

## โครงไฟล์ (แต่ละบล็อกเป็นเจ้าของเฉพาะไฟล์ของตัวเอง ห้ามแก้ไฟล์ของบล็อกอื่น)

```
app/
  docker-compose.yml  Dockerfile  package.json            B01
  server/
    index.js       โหลด server/routes/*.js และ server/pages/*.js ตามลำดับชื่อไฟล์     B01
    db.js clock.js bugs.js audit.js util.js testhook.js    B01
    seed.js                                                B02
    sla.js sla.selftest.js                                 B03
    rbac.js routes/auth.js                                 B04
    routes/drafts.js fees.js                               B05
    routes/payments.js                                     B06
    documents.js routes/verify.js                          B07
    routes/cases.js routes/officer.js notify.js            B08
    routes/reports.js routes/audit.js routes/admin.js      B09
    pages/citizen.js  (+ public/citizen/*, public/common.css)  B10
    pages/staff.js    (+ public/staff/*)                   B11
  tests/ (playwright.config.js, specs/*.spec.js, helpers)  B12
  test-report/                                             B13
```

## สัญญาของไฟล์พื้นฐาน (B01 เขียน บล็อกอื่นเรียกใช้)

- `require('./db')` → `{ db, initSchema, resetAll }` · `db` = `DatabaseSync` ตัวเดียว (prepare/run/get/all) · `resetAll()` ล้างทุกตาราง + ตัวนับ + session แล้วเรียก `seed()` ถ้ามี `server/seed.js`
- `require('./clock')` → `{ now(): Date, nowISO(): string(+07:00), set(iso), reset(), toBangkokISO(date) }`
- `require('./bugs')` → `{ bug(code): boolean }` อ่าน `BUG_MODE` (แยกด้วย `,` ตัดช่องว่าง) ครั้งเดียวตอนเริ่ม · วิธีใส่บั๊ก: `if (bug('B01')) {...บั๊ก...} else {...ถูก...}` อยู่ในตรรกะฝั่งเซิร์ฟเวอร์ และกระทบเฉพาะจุดตาม BUGS.md
- `require('./audit')` → `audit({ actor, role, event, caseNo, fromStatus, toStatus, detail })` เขียนแถว Audit (เวลา = clock) · เพิ่มได้อย่างเดียว
- `require('./util')` → `sendError(res, status, code, message)` ได้ JSON `{code,message}` · `thaiDateTime(iso)` → `4 ธ.ค. 2569 16:30` · `baht(n)` → `฿1,010` · `maskId(idNo)` → `X-XXXX-XXXXX-65-9` · `formatId(idNo)` → `3-1006-00987-65-9` · `encrypt(text)/decrypt(blob)` (AES-256-GCM) · `hashId(idNo)` (HMAC ไว้ค้นหาโดยไม่เก็บเลขตรง ๆ)
- session: คุกกี้ `sid` HttpOnly · เก็บใน `Map` ชื่อ `sessions` ที่ export จาก `server/util.js` (B01) · B04 เป็นเจ้าของ `getSession(req)` และ `requireRole(...roles)` ใน `server/rbac.js` ที่อ่าน/เขียน Map นั้น · reset ล้างทุก session
- testhook เรียก `require('./routes/payments').payByRef(ref, amount)` (B06 ต้อง export) และ `require('./documents').tamper(docNo)` (B07 ต้อง export)
- ทุกไฟล์ใต้ `server/routes/` และ `server/pages/` export `function (app) { ... }` · `index.js` เรียกตามลำดับชื่อไฟล์ (ตัวเลขนำหน้าไม่จำเป็น)
- ตัวนับเลขต่อปี พ.ศ. (คำขอ `EG-` ใบเสร็จ `RC-` เอกสาร `DOC-`) อยู่ในตาราง `counters` ที่ B01 สร้าง · ฟังก์ชัน `nextNumber(kind, buddhistYear)` ใน `db.js` ใช้ใน transaction เสมอ

## กติการ่วม

1. ห้ามแก้ผลที่คาดหวังของโจทย์ให้ตรงกับโค้ด · ถ้ากฎไม่ชัดให้ตาม DECISIONS ข้อ 18 ก่อน แล้วจด `QUESTIONS.md` (ต่อท้ายไฟล์ได้อย่างเดียว) แทนการเดา
2. ตรวจสิทธิ์ที่ **ฝั่ง API ทุกครั้ง** ไม่ใช่แค่ซ่อนปุ่ม · ข้อความ error ตรงตัวอักษรตาม CONTRACT ตาราง 5
3. BUG_MODE: ทุกบั๊กต้องใส่ผ่าน `bug('Bxx')` ในบล็อกที่ระบุ และปิด = ถูกต้อง 100% · ห้ามกระทบ seed
4. บล็อกที่เสร็จต้องมีหลักฐานว่าทำงานจริง (รันเซิร์ฟเวอร์/สคริปต์เล็ก ๆ ยิง API) ไม่ใช่แค่ "เขียนแล้ว" · ถ้าบล็อกก่อนหน้ายังขาดสิ่งที่ต้องพึ่ง ให้ทดสอบด้วย stub ของตัวเองและบอกใน report
5. ตอบรายงานสั้น: ไฟล์ที่สร้าง · สิ่งที่รันเพื่อพิสูจน์พร้อมผล · ข้อที่ยังไม่ทำ/สงสัย

## สัญญาที่ B01 กำหนดเพิ่ม

**test hook เรียกฟังก์ชันของบล็อกอื่น** (`server/testhook.js` require แบบหลวม ณ เวลาที่ถูกเรียก · ไม่มีไฟล์/ไม่มี export = ตอบ 501 `NOT_IMPLEMENTED`)
- B06 export `payByRef` จาก `server/routes/payments.js` โดยคง `module.exports = function (app) {...}` ไว้แล้วต่อ `module.exports.payByRef = payByRef` · `payByRef(ref, amount)` (amount เป็น `Number`) → คืน `{ status:'PAID', caseNo, receiptNo, duplicate }` (ส่งซ้ำ → `duplicate:true` เลขเดิม) · ผิดพลาดให้ `throw Object.assign(new Error('<ข้อความตาราง 5>'), { status, code })` เช่น `410 QR_EXPIRED` `422 AMOUNT_MISMATCH` `404 NOT_FOUND`
- B07 export `tamper` จาก `server/documents.js` · `tamper(docNo)` → คืน `true` เมื่อแก้ข้อมูลที่เก็บแล้ว (ไม่คำนวณลายเซ็นใหม่) · ไม่พบเอกสารคืน `false` (→ 404)
- `resetAll()` เรียก `require('./seed').seed()` เมื่อมี `server/seed.js` (B02) **ภายใน transaction เดียวกับการล้าง** · seed รันหลังตาราง/ตัวนับ/session ถูกล้างและนาฬิกา reset แล้ว (ใช้ `clock.nowISO()` ได้) · error ของ seed ไม่ถูกกลืน · `index.js` เรียก `resetAll()` เองหนึ่งครั้งตอนเริ่มถ้าตาราง `users` ว่าง (ฐานข้อมูลใหม่)

**ตัวนับเลขและรูปแบบเลข**
- `nextNumber(kind, buddhistYear)` คืนจำนวนเต็มลำดับถัดไป (เริ่มที่ 1 ถ้ายังไม่มีแถว) แล้วเพิ่มตัวนับ · `kind` = `EG` `RC` `DOC` (ปี พ.ศ.) · `DR` `PP` ใช้ปี `0` · เรียกใน `tx()` เสมอ
- `setCounter(kind, year, next)` ให้ seed ตั้งค่า เช่น `setCounter('EG',2569,31)` `setCounter('RC',2569,31)` `setCounter('DOC',2569,2)` `setCounter('DR',0,3)` `setCounter('PP',0,2)`
- `util.formatNo('EG', 2569, 31)` → `EG-2569-000031` · `util.formatNo('DR', 0, 3, 4)` → `DR-0003` · `util.buddhistYear(iso)` → ปี พ.ศ. ตามเวลาไทย (ใช้กับเวลาชำระ)
- `db.js` export เพิ่ม: `tx(fn)` (BEGIN IMMEDIATE/COMMIT/ROLLBACK ซ้อนได้) · `setCounter` · `DB_PATH`

**hook ต่อทุก request** (CONTRACT 0.7: ประเมินแจ้งเตือน SLA + ยกเลิกอัตโนมัติ) — `require('./util').requestHooks` เป็น array ของ `(req) => void` (sync) · B08 `push` ฟังก์ชันของตนตอนไฟล์ถูกโหลด · `index.js` เรียกทุกตัวก่อน route ทุกตัวสำหรับทุกคำขอ ยกเว้น `/api/test/*` · error ใน hook ไม่ถูกกลืน (กลายเป็น 500)

**ฟังก์ชันกลางเพิ่มเติมใน `util.js`**: `sendError(res, status, code, message, extra?)` (extra merge เข้า JSON เช่น `{attemptsLeft}` `{lockedUntil}` `{missing}`) · `thaiDate('2027-02-02')` → `2 ก.พ. 2570` · `hashPassword/verifyPassword` (scrypt สำหรับ `users.password_hash`) · `parseCookies(req)` (index.js ใส่ `req.cookies` ให้ทุกคำขอแล้ว → B04 อ่าน `req.cookies.sid`) · `sessions` (Map ว่างหลัง reset; รูปแบบค่าข้างในให้ B04 กำหนด) · `thaiDateKey(iso)` → `YYYY-MM-DD` ตามเวลาไทย · `pad`

**นาฬิกา** `clock.js`: แช่แข็งเสมอ (ค่าเริ่มต้น `2026-12-01T09:00:00+07:00` ทั้งตอนเปิดเซิร์ฟเวอร์และหลัง reset) · `set(iso)` ต้องมี offset และเป็นวันที่มีจริง ไม่เช่นนั้น throw `INVALID_TIME` และนาฬิกาไม่เปลี่ยน · `parseISO(iso)` → `Date|null` · ไม่มี `Date.now()` ในกฎธุรกิจ

**ฐานข้อมูล / schema** (อ่านคอมเมนต์ใน `server/db.js` เป็นคำอธิบายคอลัมน์ · ทุกเวลาเป็น ISO +07:00 · ไม่ใช้ foreign key)
- `users` เลขบัตร/เบอร์เก็บ `id_no_enc`/`mobile_enc` ด้วย `util.encrypt` · ค้นหาด้วย `id_hash = util.hashId(idNo)` · `id_masked` เก็บไว้ทำคิวโดยไม่ต้อง decrypt · เจ้าหน้าที่ใช้ `username` + `password_hash` · ประชาชน `username` เป็น NULL
- `drafts` (DR-xxxx: DRAFT/PENDING_PAYMENT/SUBMITTED, `fee` คือยอดที่ล็อก A-42, `case_no` ผูกหลังชำระ) · `cases` (ที่มีเลขแล้ว; `owner` `registry_owner` `works_owner` `approver` `dept` `step` `due_at` `return_count` `return_reason` `returned_at` `fix_deadline` `closed_at` `doc_no` `receipt_no`) · `case_returns` (ประวัติตีกลับ/ส่งแก้ ใช้คิดหยุดนับ) · `timeline_events` · `files` (BLOB, `draft_id` หรือ `case_no`) · `payments` (ref PP-xxxx + ใบเสร็จ `receipt_no`) · `documents` (`signature` + ฟิลด์ที่ถูก sign) · `audit` · `notifications` (`UNIQUE(username, case_no, level)` กันแจ้งซ้ำ → ใช้ `INSERT OR IGNORE`) · `services` (`fee` `fee_base` `fee_per_sqm` `sla` `docs_json`) · `holidays` · `counters` · `otp_attempts` (key = `id_hash`) · `meta` (key/value เบ็ดเตล็ด)
- `files.content` เก็บเนื้อไฟล์ใน SQLite · multer ที่ B05 ใช้ต้องตั้ง `limits.fileSize` ≥ 6 MB แล้วตรวจ 5,242,880 ไบต์เองเพื่อตอบ 400 `FILE_TOO_LARGE` (ห้ามให้ multer โยน `LIMIT_FILE_SIZE` ที่ 5 MB)

**การรันและโครงของ index.js**: โหลด `server/routes/*.js` ก่อน แล้ว `server/pages/*.js` ตามลำดับชื่อไฟล์ · ไฟล์ที่ไม่ได้ export function (เช่นไลบรารี) ข้ามพร้อม warning · `public/` เสิร์ฟแบบ static (ไม่มี index) ที่ราก · `/api/*` ที่ไม่มี route → 404 JSON `NOT_FOUND` · JSON พัง → 400 `BAD_JSON` · body JSON/urlencoded รับได้ 8 MB (เกิน → 413 `PAYLOAD_TOO_LARGE`) · `/api/test/*` ตอบ 404 เมื่อไม่ตั้ง `TEST_MODE=1` (ต้องเป็น `1` ตรงตัว) · `docker-compose.yml` ตั้ง `TEST_MODE` ตั้งต้น `1` (`TEST_MODE=0 docker compose up` เพื่อปิด) · ตรวจฐานด้วย `node server/base.selftest.js`

## สัญญาที่ B02 กำหนดเพิ่ม

- `require('./seed')` → `{ seed, SIGN_KEY, signDocument }` · `SIGN_KEY = 'egov-eservice-test-sign-key'` คีย์ทดสอบของลายเซ็นเอกสาร (A-22) · `signDocument({docNo, caseNo, applicant, serviceId, issuedAt, validUntil, signer})` → HMAC-SHA256 hex ของฟิลด์ตามลำดับนี้ต่อกันด้วย `|` (ตรงกับ CONTRACT ข้อ 3) · **B07 import `SIGN_KEY` (หรือ `signDocument`) จาก `./seed` ไปเซ็น/ตรวจเอกสารใหม่ ห้ามตั้งคีย์ใหม่** ไม่งั้นเอกสาร `DOC-2569-000001` ของ seed จะตรวจเป็น `TAMPERED` · `applicant` = ชื่อเต็มที่เก็บใน `documents.applicant_name` · `issuedAt` = สตริง ISO ที่เก็บใน `documents.issued_at` ตามที่เก็บ (`2026-11-05T10:00:00+07:00`) · `validUntil` = `YYYY-MM-DD`
- `seed()` ทำใน `tx()` · ไม่สร้าง audit/notifications/otp_attempts/meta · รหัสผ่านเจ้าหน้าที่ `Test@1234` แฮชด้วย `util.hashPassword` · ตรวจด้วย `node server/seed.selftest.js` (ใช้ฐานไฟล์ชั่วคราว)
- **รูปแบบของข้อมูล seed ที่บล็อกอื่นต้องรู้** (โจทย์ไม่ได้ระบุ ผู้เขียนเลือกตามความหมายของคอลัมน์ใน `db.js`):
  - `users`: ประชาชน 4 แถวตามลำดับ สมชาย(1) สมหญิง(2) มานะ(3) ปิติ(4) · **มานะมีแถวแล้วแต่ `registered=0`** `consent_at`/`mobile_enc` เป็น NULL · เลขที่ checksum ผิด `1101700123457` ไม่มีแถว · เจ้าหน้าที่ `dept` = `registry`/`works` · head/exec/audit/admin `dept=''` · `email=''` ทุกแถว
  - `cases.owner`: มีค่าเฉพาะ SUBMITTED→NULL · IN_REVIEW ที่ถูกรับ → ผู้ถือ · NEED_FIX → ผู้ถือเดิม (`off.reg1` ของ F01) · **PENDING_APPROVAL / APPROVED / COMPLETED / REJECTED / CANCELLED → NULL** (หัวหน้าดูจาก `status`; ผู้ออกเอกสารของ APPROVED/PENDING_APPROVAL ดูที่ `registry_owner`) · `approver` ว่างจนกว่าจะอนุมัติ (A01 = `head1` + `approved_at 2026-11-30T15:00:00+07:00`)
  - `cases.dept`: SUBMITTED/IN_REVIEW/NEED_FIX/APPROVED ของ SV-01/02 และ SV-03 ขั้น 1 = `registry` · SV-03 ขั้น 2 (W01) = `works` · PENDING_APPROVAL และคำขอที่ปิดแล้ว = `''` · คิวทะเบียน = `dept='registry' AND status IN ('SUBMITTED','IN_REVIEW','APPROVED')` (17 แถว; NEED_FIX ไม่อยู่ในคิวเพราะสถานะ) · `step` มีเฉพาะ SV-03 (คำขอปิดแล้ว = 3)
  - `registry_owner` ตั้งให้ทุกใบที่เคยถูกรับ (ใบประวัติทั้งหมด = `off.reg1`) · `works_owner` ตั้งเฉพาะ SV-03 ที่โยธารับแล้ว (…000002 …000011 = `off.works1`; W01 …000010 = NULL) · ใช้ตัดสินสิทธิ์ "เคยผ่านขั้นนั้น" ของไฟล์แนบได้
  - ใบเสร็จของคำขอ 30 ใบอยู่ที่ `cases.receipt_no` (`RC-2569-000001..30`) **ไม่มีแถวใน `payments`** · `payments` มีแถวเดียว `PP-0001` (PENDING, ร่าง `DR-0002`) · `drafts` มี 2 แถว (DR-0001 DRAFT, DR-0002 PENDING_PAYMENT) ใบประวัติ `cases.draft_id` = NULL
  - ตัวนับหลัง seed (ตาราง `counters`): `EG/2569=31` `RC/2569=31` `DOC/2569=2` `DR/0=3` `PP/0=2`
  - `files`: `file_id` = `F-0001`…; ไฟล์ของคำขอใช้ `case_no`, ไฟล์ของ DR-0002 ใช้ `draft_id` (`id-card.pdf` + `map.pdf`) · ทุกไฟล์ PDF 1,024 ไบต์ mime `application/pdf`
  - `timeline_events` ของ seed: ทุกใบมี `PAID` + `SUBMITTED` ที่เวลาชำระ · ใบที่ถูกรับ มี `CLAIM` (ชำระ+1 ชม.) และขั้นถัดไปตามเส้นทาง · เวลาระหว่างขั้นที่ TEST-DATA ไม่ระบุเป็นค่าที่ผู้เขียนกำหนดเอง (ชำระ+1/+2/+3/+4 ชม., อนุมัติก่อนปิด 30 นาที) · F01/F02 มี `RETURN`/`RESUBMIT` ตรงตาราง 4.4 · `case_returns.returned_by` = ผู้ถือ · F02 (IN_REVIEW หลังส่งแก้) `returned_at`/`fix_deadline` = NULL แต่ `return_reason` เก็บเหตุผลล่าสุด
- **ผลข้างเคียงต่อ B01**: `server/base.selftest.js` บรรทัด 60 (`SELECT COUNT(*) FROM counters` = 0 หลัง `resetAll()`) ล้มเมื่อมี `seed.js` เพราะ seed ตั้งตัวนับ 5 แถว · เจ้าของไฟล์ต้องแก้ให้ตรวจ `EG/2569 = 31` แทน

## สัญญาที่ B08 กำหนดเพิ่ม

ไฟล์: `server/routes/cases.js` (คำขอ/ยกเลิก/ส่งแก้/ไฟล์/อนุมัติ) · `server/routes/officer.js` (คิว/รับเรื่อง/ตีกลับ/ส่งต่อ/ออกเอกสาร/เลขเต็ม/แจ้งเตือน) · `server/notify.js` (ฮุกต่อทุก request: ยกเลิกอัตโนมัติ + แจ้งเตือน — `cases.js` require แล้ว push เข้า `util.requestHooks` เอง; ตัวไฟล์ไม่ใช่ route) · พิสูจน์ด้วย `node server/cases.selftest.js`

**API ที่เพิ่มจาก CONTRACT** (ผู้เรียก B10/B11): `GET /api/head/approvals` (head เท่านั้น · แถวรูปเดียวกับคิว ไม่มี `idNo` · เรียง BR-16 · PENDING_APPROVAL ทุกแผนก) · `GET /api/cases/:caseNo` มีฟิลด์เพิ่ม (ด้านล่าง) · `GET /api/officer/queue` ตอบ `{items, workload}` (`workload` = ตัวเลขของ `workload-count` เฉพาะ officer; head = `null`)

**`GET /api/cases/:caseNo`** (citizen · officer · head; ไม่ล็อกอิน 401; executive/auditor/admin 403; citizen ไม่ใช่เจ้าของ/ไม่มีเลข 404 `{code:'NOT_FOUND',message:'ไม่พบคำขอ'}` เหมือนกันทุกตัวอักษร) ฟิลด์: `caseNo serviceId serviceName status step stepLabel(SV-03 เท่านั้น เช่น 'ขั้นตอน 2/3 · ฝ่ายโยธา') dept fee qty areaSqm paidAt receiptNo dueAt slaLevel owner(username|null) ownerName returnCount returnReason(เหตุผลล่าสุด) fixDeadline(เฉพาะ NEED_FIX) rejectReason closedAt applicantName docNo verifyCode document{docNo,verifyCode,issuedAt,validUntil,signer,verifyUrl}|null`
- **เลขบัตร**: citizen ได้ `idNo` (13 หลัก) + `idFormatted` (`3-1006-00987-65-9` ไว้ใส่ `case-id-full`) และ **ไม่มี** `idMasked` · officer/head ได้ `idMasked` เท่านั้น (ห้ามมี `idNo`/เลข 13 หลัก)
- `timeline[]` = `{time,kind,text,actor(citizen เห็น null),actorRole,fromStatus,toStatus}` เรียงเวลาเก่า → ใหม่ (`kind` AUTO_CANCEL = ยกเลิกอัตโนมัติ เวลา = ตีกลับ + 168 ชม.)
- `files[]` (= `docs[]` alias) = `{fileId,name,docKey,size,mime}` ของคำขอ (officer นอกขอบเขต BR-29 ได้ `[]`)
- `can` = `{claim, return, forward, approve, reject, issue, unmask, cancel, resubmit}` boolean ต่อผู้เรียก (render ปุ่มตามนี้ทั้งหมด; false = ไม่ render): `return` = ผู้ถือ + IN_REVIEW + ตีกลับ < 2 · `forward` = ผู้ถือ + IN_REVIEW + ไม่ใช่ SV-01 · `approve`/`reject` = SV-01 ผู้ถือ IN_REVIEW หรือ head ที่ SV-02/03 PENDING_APPROVAL (เจ้าหน้าที่ SV-02/03 ไม่เคยมี) · `issue` = APPROVED + ผู้เรียกเป็น `registry_owner` · `unmask` = officer/head · `cancel` = เจ้าของ + SUBMITTED ไม่มีผู้ถือ · `resubmit` = เจ้าของ + NEED_FIX ที่ยังไม่พ้นเส้นตาย

**รูปแบบข้อมูลที่ B08 ตั้ง** (ต่อจากข้อตกลง seed ของ B02):
- `APPROVED` → `owner=NULL dept='registry'` (ผู้ออกเอกสาร = `registry_owner`; อยู่ในคิวทะเบียนแบบ `owner` ว่าง) · ส่งต่อ SV-02 → `PENDING_APPROVAL dept=''` · SV-03 ขั้น 1 → ขั้น 2 = `IN_REVIEW step=2 dept='works' owner=NULL` → ขั้น 3 = `PENDING_APPROVAL step=3 dept=''`
- ตีกลับ = `NEED_FIX` คง `owner` เดิม (+ แถวใน `case_returns`, `fix_deadline` = +168 ชม.) · ส่งแก้ = `IN_REVIEW` คงผู้ถือ/ขั้นเดิม `returned_at`/`fix_deadline` = NULL `due_at` ใหม่จาก `sla.extendForFix` · ปิดงาน (COMPLETED/REJECTED/CANCELLED) → `owner=NULL dept=''`
- `registry_owner` ตั้งตอนเจ้าหน้าที่ทะเบียนรับเรื่องครั้งแรก · `works_owner` ตอนโยธารับเรื่อง · ยกเลิก/ยกเลิกอัตโนมัติ/ส่งแก้ไม่เขียน audit (ไม่ใช่ 1 ใน 10 เหตุการณ์) แต่เขียน timeline (`CANCEL`/`AUTO_CANCEL`/`RESUBMIT`)

**เจ้าหน้าที่** (ทุก API ตรวจสิทธิ์ฝั่งเซิร์ฟเวอร์):
- `GET /api/officer/queue?filter=all|unclaimed|mine` แถว `{caseNo,serviceId,applicantName,idMasked,status,step,owner(null=ว่าง),dueAt,slaLevel,dept,can:{claim}}` — `can.claim` ใช้ตัดสินว่าจะ render `claim-btn` ในแถวหรือไม่ · filter ไม่รู้จัก = `all`
- `POST /api/officer/cases/:no/claim` → `{owner}` · `…/return {reason}` → `{status:'NEED_FIX',returnCount}` · `…/forward {note?}` → `{status:'IN_REVIEW',step:2}` | `{status:'PENDING_APPROVAL',step:3}` (SV-03) | `{status:'PENDING_APPROVAL'}` (SV-02) · `…/issue` → `{docNo,verifyCode,status:'COMPLETED'}` · `…/unmask {reason}` → `{idNo}` · `POST /api/cases/:no/approve` → `{status:'APPROVED'}` · `/reject {reason}` → `{status:'REJECTED',closedAt}` · `GET /api/notifications` → `{items:[{id,caseNo,level,text,createdAt}]}` (ใหม่ → เก่า; `bell-count` = `items.length`)
- ลำดับตรวจ: claim = บทบาท/แผนก 403 → ALREADY_CLAIMED → INVALID_STATE (สถานะไม่ใช่ SUBMITTED/IN_REVIEW) → WORKLOAD_LIMIT · return/forward = ผู้ถือ 403 → INVALID_STATE → RETURN_LIMIT → เหตุผล 400 · approve/reject = บทบาทตามบริการ 403 → สถานะ 409 → ผู้ถือ (SV-01) 403 → เหตุผล 400 · issue = `registry_owner` 403 → สถานะ 409 · unmask = บทบาท 403 → ไม่มีคำขอ 404 → เหตุผล 400

**ประชาชน**: `GET /api/cases` → `{items:[{caseNo,serviceId,serviceName,status,step,fee,paidAt,dueAt,slaLevel}]}` เรียงเลขมาก → น้อย · `POST /api/cases/:no/cancel` → `{status:'CANCELLED'}` (409 `CANNOT_CANCEL`) · `POST /api/cases/:no/resubmit` (multipart ไม่บังคับ: ช่อง `file` ซ้ำได้ + `docKey` เดียวใช้ทั้งชุด ค่าตั้งต้น `extra`; ผิดข้อใด = ไม่เก็บสักไฟล์) → `{status:'IN_REVIEW',dueAt}` · 409 `FIX_WINDOW_EXPIRED` เมื่อพ้นเส้นตาย (ยกเลิกอัตโนมัติแล้ว)

**ไฟล์**: `GET /api/cases/:no/files` → `{items:[{fileId,name,docKey,size,mime}]}` · `GET /api/files/:fileId` เนื้อไฟล์ `Content-Type` ตามชนิดจริง `Content-Disposition: inline` (หน้า UI ทำ `doc-download-link` ชี้ `/api/files/<fileId>`) · สิทธิ์: citizen เจ้าของ (คนอื่น 404) · head ทุกใบ · officer ทะเบียน ทุกใบ · officer โยธา เฉพาะ SV-03 ที่ถึงขั้น 2 แล้ว (นอกนั้น 403) · exec/audit/admin 403 · ไม่ล็อกอิน 401 · fileId ไม่มี 404

**ฮุกต่อ request**: `notify.js` — `NEED_FIX` ที่ `now >= fix_deadline` → `CANCELLED` (`closed_at`/เวลา timeline = `fix_deadline`) แล้วประเมินแจ้งเตือนระดับปัจจุบัน (`sla.level` + `clock.nowISO()`) ผู้รับตาม BR-15 · `INSERT OR IGNORE` กันซ้ำด้วย UNIQUE · ไม่ประเมิน NEED_FIX/ปิดแล้ว · `/api/test/*` ไม่ผ่านฮุก (index.js ข้ามให้แล้ว)

**BUG_MODE ที่ B08 ใส่**: B06 (`GET /api/cases/:no` ข้ามเช็กเจ้าของ) · B07 (approve ข้ามเช็กบทบาทเมื่อเจ้าหน้าที่ใช้กับ SV-02/03 ที่ PENDING_APPROVAL; flag `can.approve` ยัง false) · B08 (claim ข้ามเช็ก owner; UPDATE ไม่มี `owner IS NULL`) · B09 (`idNo` ในแถวคิว) · B11 (unmask ไม่เขียน audit) · B12 (ไม่เช็ก RETURN_LIMIT และ `can.return` ยัง true ตามที่ BUGS.md ระบุว่าปุ่มยังแสดง)
