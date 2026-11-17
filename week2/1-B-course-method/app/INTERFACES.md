# INTERFACES · สัญญาภายในโค้ดระหว่างบล็อก (B01)

> ไฟล์นี้กำหนด **ใครเขียนไฟล์ไหน · export อะไร · signature อะไร** เพื่อให้ B02–B10 ทำขนานกันได้โดยไม่แก้ไฟล์ของกันและกัน
> สัญญาภายนอก (route, `data-testid`, ข้อความ error, JSON) อยู่ที่ `/workspace/egov-brief/CONTRACT.md` — ไฟล์นี้ไม่ซ้ำรายละเอียดนั้น แต่บอกว่า **ใครเป็นเจ้าของ** แต่ละส่วน
> ห้ามแก้ไฟล์ของบล็อกอื่น · ถ้าต้องการให้ไฟล์ของ B01 เพิ่มอะไร (เช่น dependency ใหม่) ให้เขียนบรรทัด `BOARD:` บอก B13

## 0. รันอย่างไร

```text
docker compose up --build                       # :3000 · ไม่มี test hook
TEST_MODE=1 docker compose up --build           # /api/test/* เปิด · เริ่มเว็บ = reset + seed + นาฬิกา 2026-12-01T09:00:00+07:00
TEST_MODE=1 BUG_MODE=B03,B07 docker compose up  # เปิดบั๊กตาม BUGS.md
# ไม่ใช้ docker:
npm install && TEST_MODE=1 DB_PATH=./data/dev.db PORT=3000 node src/server.js
node scripts/smoke.js http://localhost:3000     # ตรวจ health/reset/clock (EXPECT_TEST_MODE=0 เมื่อไม่ตั้ง TEST_MODE)
```

- DB: SQLite ไฟล์ `DB_PATH` (ในคอนเทนเนอร์ `/data/egov.db` = `app/data/egov.db` บนเครื่อง) · ใช้ `DB_PATH=:memory:` สำหรับทดสอบหน่วยได้
- ไฟล์ที่อยู่ในอิมเมจมีแค่ `src/` `public/` `package.json` → โค้ดตอนรันห้ามอ่าน `fixtures/` `tests/` หรือไฟล์ `.md`
- dependency ที่มีให้ (ห้ามแก้ `package.json`): `express@4` `better-sqlite3@12` `multer@2` `express-async-errors` `pdfkit` `exceljs` `qrcode`

## 1. แผนผังไฟล์และเจ้าของ

| ไฟล์ | เจ้าของ | หน้าที่ |
|---|---|---|
| `Dockerfile` `docker-compose.yml` `package.json` `package-lock.json` `.dockerignore` `scripts/smoke.js` | B01 | รัน/บิลด์ |
| `src/server.js` | B01 | Express · โหลดโมดูลอัตโนมัติ · tick ก่อนทุก request · 404/error handler · `GET /api/health` `GET /` `POST /logout` |
| `src/clock.js` | B01 | นาฬิกาทดสอบ Asia/Bangkok |
| `src/db.js` | B01 | schema ทุกตาราง · `resetAll()` (ล้าง + เรียก `seed()`) · `nextSeq()` |
| `src/bugs.js` | B01 | `isBug('B03')` |
| `src/http.js` | B01 | `fail(code)` → `{code,message}` ตรงตัว CONTRACT §5 · `upload` (multipart) · `sniffFileType` · `baseUrl` |
| `src/session.js` | B01 | session cookie · `requireApi()` `requirePage()` · `landingFor()` |
| `src/audit.js` | B01 | `logAudit()` (เขียน Audit) |
| `src/crypto.js` | B01 | เข้ารหัส PII · `idHash` · รหัสผ่าน · `signDoc` (HMAC เอกสาร) · `randomCode` |
| `src/format.js` | B01 | วันที่ไทย · `฿` · ปิดบังเลขบัตร/ชื่อ · `esc` · `timeTag` |
| `src/constants.js` | B01 | ข้อความสถานะ/บทบาท/ระดับ · แคตตาล็อกบริการ (เอกสาร เส้นทาง) · ตัวเลขกฎ `LIMITS` · รูปแบบเลข |
| `src/views/layout.js` | B01 | โครงหน้า HTML + header/เมนูตามบทบาท + หน้า 403/404 |
| `src/modules/testhooks.js` | B01 | `POST /api/test/reset` · `GET/PUT /api/test/clock` |
| `public/app.css` `public/common.js` | B01 | CSS ร่วม · `window.Egov` (api/format ฝั่งเบราว์เซอร์) |
| `src/seed.js` | **B02** | `seed(db)` ข้อมูลตาม TEST-DATA |
| `fixtures/*` | **B02** | ไฟล์ทดสอบอัปโหลด (TEST-DATA §11) — ใช้โดย test เท่านั้น |
| `src/sla.js` | **B03** | วันทำการ · กำหนดเสร็จ · หยุดนับ · ระดับเตือน · สร้างแจ้งเตือน |
| `src/modules/citizen.js` | **B04** | API ประชาชน: ร่าง ไฟล์ ชำระ คำขอของฉัน ยกเลิก ส่งแก้ + test hook ชำระ |
| `src/modules/auth.js` | **B05** | API ล็อกอิน ThaiD/SSO ลงทะเบียน `me` logout + unmask (PDPA) |
| `src/modules/workflow.js` | **B06** | API เจ้าหน้าที่/หัวหน้า: คิว claim return forward approve reject issue · ไฟล์แนบตามสิทธิ์ · PDF เอกสาร · verify · ยกเลิกอัตโนมัติ 168 ชม. + test hook tamper |
| `src/modules/dashboard.js` | **B07** | API Dashboard + export xlsx/pdf |
| `src/modules/admin-audit.js` | **B08** | API Audit (อ่าน/กรอง/CSV/405) · `/api/notifications` · API ผู้ดูแลระบบ |
| `src/views/citizen.js` (+ `public/citizen.*` ถ้าต้องการ) | **B09** | หน้า `/login` `/register` `/citizen` `/citizen/new/:service` `/citizen/cases/:caseNo` `/verify/:code` |
| `src/views/staff.js` (+ `public/staff.*` ถ้าต้องการ) | **B10** | หน้า `/officer/queue` `/officer/cases/:caseNo` `/head/approvals` `/dashboard` `/audit` `/admin/services` `/admin/holidays` `/admin/users` `/notifications` |
| `tests/**` | B11 · B12 | Playwright |

## 2. กติการ่วม (ทุกบล็อกต้องทำตาม)

1. **เวลา**: ห้าม `Date.now()` / `new Date()` ในกฎธุรกิจ → ใช้ `clock.nowIso()` · ทุกเวลาที่เก็บ/ส่งออก API เป็น `"YYYY-MM-DDTHH:MM:SS+07:00"` จาก `clock.toIso()` (เทียบด้วยสตริงได้) · วันที่ล้วน `"YYYY-MM-DD"` (ค.ศ.)
2. **Error API**: `fail('CODE', extra?, message?)` เท่านั้น (ข้อความตรงตัวจาก `http.ERRORS`) · ห้ามพิมพ์ข้อความ error เอง · หน้า HTML 403/404 ใช้ `layout.forbiddenPage` / `layout.notFoundPage`
3. **สิทธิ์**: API ใช้ `requireApi(...roles)` (ไม่ล็อกอิน 401 → บทบาทผิด 403) · หน้าใช้ `requirePage(...roles)` (ไม่ล็อกอิน → `/login` · บทบาทผิด → 403 `forbidden-msg`) · บทบาทอ่านจาก `req.user.role` (ภาพตอนล็อกอิน) · กฎที่ละเอียดกว่า (เจ้าของ/แผนก/ขั้น) ตรวจในโมดูล
4. **BUG_MODE**: `const { isBug } = require('../bugs')` · ใส่บั๊กเฉพาะจุดตาม BUGS.md ในโมดูลของตัวเอง (ตาราง §5) · ห้ามเปลี่ยน seed/ข้อความ
5. **ความพร้อมกัน**: better-sqlite3 เป็น sync — ทำ "อ่านแล้วเขียน" ใน handler เดียวโดย **ไม่มี `await` คั่น** (หรือห่อ `db.transaction`) → เลขคำขอไม่ซ้ำ · claim ได้คนเดียว
6. **PII**: เลขบัตร/เบอร์เก็บด้วย `crypto.encrypt()` เท่านั้น · ค้นเลขบัตรด้วย `users.id_hash = crypto.idHash(idNo)` · API ของเจ้าหน้าที่ห้ามมี `idNo` / เลข 13 หลัก / `d-dddd-ddddd-dd-d` (ยกเว้น unmask) · executive ไม่เห็นชื่อ/เลขบัตร/เบอร์
7. **Route**: โมดูลห้ามลงทะเบียน catch-all (`app.use('/api', …)` ที่ตอบเอง, `app.get('*')`) และห้ามติดตั้ง body parser/error handler ซ้ำ (server.js ทำแล้ว: JSON/form ≤ 10 MB) · multipart ใช้ `http.upload`
8. **require ข้ามโมดูล**: ไฟล์ร่วมของ B01 require ที่หัวไฟล์ได้ · ไฟล์ของบล็อกอื่น (`../sla`, `./workflow`, `../modules/citizen` …) ให้ **require ภายในฟังก์ชัน** (lazy) เพื่อไม่ติดลำดับโหลด/วงวน และให้เว็บรันได้แม้บล็อกนั้นยังไม่เสร็จ
9. **HTML**: escape ทุกค่าด้วย `format.esc` · วันเวลาใช้ `format.timeTag(testid, iso)` (มี `data-iso`) · เงิน `format.baht` · ทุก input มี `<label for>` · สถานะ/ระดับมีข้อความเสมอ (ไม่ใช้สีอย่างเดียว)

## 3. รูปแบบโมดูล (โหลดอัตโนมัติ)

`server.js` โหลด `src/modules/*.js` แล้ว `src/views/*.js` (เรียงตาม `order` แล้วชื่อไฟล์) ไฟล์ที่ export `register` เท่านั้นที่ถูกเรียก (`layout.js` ไม่มี register)

```js
// src/modules/<name>.js หรือ src/views/<name>.js
'use strict';
const express = require('express');
const { db } = require('../db');
const clock = require('../clock');
const { fail, upload } = require('../http');
const { requireApi, requirePage } = require('../session');
const { isBug } = require('../bugs');

function register(app, ctx) {
  app.get('/api/xxx', requireApi('officer', 'head'), (req, res) => { /* sync หรือ async ก็ได้ */ });
  ctx.testRouter.post('/payments/:ref/pay', handler);   // → POST /api/test/payments/:ref/pay (เฉพาะ TEST_MODE=1)
}
module.exports = { register /* , order: 50 (ค่าเริ่มต้น) */, ...ฟังก์ชันที่ export ตาม §6 };
```

`ctx` = `{ app, testRouter, TEST_MODE, tickFns, clock, bugs, db }`
- `ctx.testRouter` = `express.Router()` ที่ mount ที่ `/api/test` เฉพาะ `TEST_MODE=1` (ไม่ตั้ง → `/api/test/*` = 404 อัตโนมัติ)
- ลำดับ middleware: body parser → `/static` (= `public/`) → session (`req.user`) → **tick** → route B01 → `/api/test` → โมดูล → 404 → error handler
- **tick** (CONTRACT §0.7): ก่อนทุก request ยกเว้น `/api/test/*` `/api/health` `/static/*` server.js เรียกตามลำดับ
  1. `require('./modules/workflow').autoCancelExpired(nowIso)` (B06) ถ้ามี
  2. `require('./sla').evaluateNotifications(nowIso)` (B03) ถ้ามี
  (`/api/health` ไม่ tick เพราะ healthcheck ของ docker ยิงทุก 5 วินาที จะทำให้แจ้งเตือนเกิดก่อน test ตั้งนาฬิกา)

## 4. ไลบรารีร่วมของ B01 (ใช้ได้ทันที)

### 4.1 `src/clock.js`
| export | signature | หมายเหตุ |
|---|---|---|
| `INITIAL_ISO` | `'2026-12-01T09:00:00+07:00'` | |
| `nowIso()` | `→ string` ISO +07:00 | **ใช้ตัวนี้เป็นหลัก** |
| `now()` / `nowMs()` | `→ Date` / `→ number` | |
| `toIso(t)` | `Date\|ms\|ISO → 'YYYY-MM-DDTHH:MM:SS+07:00'` | ตัดมิลลิวินาที |
| `parseIso(str)` | `→ Date\|null` | ต้องมี offset (Z หรือ ±HH:MM) ตรวจค่าทุกช่อง |
| `toMs(t)` · `addMs(t, ms) → ISO` · `diffMs(a, b) → ms` | | QR 15 นาที · OTP 15 นาที · 168 ชม. |
| `bkkParts(t?)` | `→ {y,m,d,hh,mm,ss,dow(0=อา),ymd,hm,be}` | ตามเวลาไทย |
| `bkkDate(t?)` → `'YYYY-MM-DD'` · `beYear(t?)` → `2569` | | ปีของเลขคำขอ = `beYear(paidAt)` |
| `fromBkk('2026-12-04','16:30')` / `fromBkk(2026,12,4,16,30,0)` | `→ ISO` | |
| `addDaysYmd(ymd, n)` · `dowYmd(ymd)` | | ปฏิทินล้วน (วันทำการอยู่ใน sla.js) |
| `set(iso)` · `reset()` · `isFrozen()` | | test hook เท่านั้น |

### 4.2 `src/db.js`
| export | signature |
|---|---|
| `db` | อินสแตนซ์ better-sqlite3 (ตัวเดียวทั้งโปรเซส) |
| `tx(fn)` | `= db.transaction(fn)` (คืนฟังก์ชัน) |
| `nextSeq(name)` | `→ number` เพิ่มแบบ atomic (ไม่มีแถว → 1) |
| `setSeq(name, value)` | ใช้ใน seed |
| `resetAll()` | ล้างทุกตาราง (รวม audit/session/otp/แจ้งเตือน/ไฟล์) แล้ว `require('./seed').seed(db)` ใน transaction เดียว แล้วเรียก `onReset` hooks |
| `onReset(fn)` | ลงทะเบียนล้าง cache ในหน่วยความจำของโมดูลหลัง reset |
| `DB_PATH` `TABLES` `isEmpty()` | |

ชื่อ counter (`constants.COUNTER`): `case:<พ.ศ.>` `receipt:<พ.ศ.>` `doc:<พ.ศ.>` `draft` `payref` · รูปแบบเลข `constants.NUMBERING.caseNo(2569, 31)` → `EG-2569-000031` (`receiptNo` `docNo` `draftId(3)`→`DR-0003` `payRef(2)`→`PP-0002`)

#### Schema (ดูคอมเมนต์เต็มใน `src/db.js`)

```text
users(id, username UNIQUE NULL(ประชาชน), role, dept, name, password_hash, id_hash UNIQUE, id_enc, mobile_enc, email, registered 0/1, consent_at, created_at)
services(id 'SV-01', name, fee, fee_per_sqm, sla_days, sort)        -- SV-01 fee=ต่อฉบับ · SV-02 fee=คงที่ · SV-03 fee=ฐาน feeBase, fee_per_sqm
holidays(date 'YYYY-MM-DD' PK, name)
cases(id, draft_id UNIQUE, case_no UNIQUE, service_id, applicant_id→users.id, qty, area_sqm, fee, status, step, dept, owner, issuer, approver,
      paid_at, receipt_no UNIQUE, due_at, return_count, returned_at, return_reason, fix_deadline, reject_reason, closed_at, cancelled_at, created_at, updated_at)
case_files(id TEXT PK = fileId, case_id, doc_key, name, mime, size, data BLOB, uploaded_by, created_at)
case_events(id, case_id, at, actor, event, from_status, to_status, note)   -- ไทม์ไลน์ + ประวัติตีกลับ/ส่งแก้
payments(ref PK 'PP-0001', case_id, amount, status PENDING|PAID|VOID, qr_created_at, qr_expires_at, paid_at)
documents(doc_no PK, case_id, case_no, verify_code UNIQUE, applicant, service_id, issued_at, valid_until 'YYYY-MM-DD', signer, issued_by, signature)
notifications(id, username, case_id, case_no, level near|overdue, text, created_at, read_at, UNIQUE(username, case_id, level))
audit(id, time, username, role, event, case_no, from_status, to_status, detail)      -- trigger กัน UPDATE/DELETE
sessions(sid PK, user_id, role, dept, kind 'full'|'register', created_at)
otp_attempts(id_hash PK, fail_count, locked_until, last_fail_at)
counters(name PK, value)
```

**ความหมายคอลัมน์ของ `cases` ตามสถานะ** (B02 seed, B04, B06 ต้องใช้ตรงกัน):

| status | case_no/paid_at/due_at | dept | owner | step (SV-03) | อื่น ๆ |
|---|---|---|---|---|---|
| `DRAFT` | NULL | NULL | NULL | NULL | `draft_id` · `fee` = ค่าล่าสุดที่คำนวณ |
| `PENDING_PAYMENT` | NULL | NULL | NULL | NULL | `fee` ล็อกแล้ว (A-42) · มีแถว `payments` |
| `SUBMITTED` | มี | `registry` | NULL | 1 | |
| `IN_REVIEW` | มี | `registry` / `works` | username หรือ NULL (ส่งต่อมาแผนกใหม่ยังไม่มีผู้รับ เช่น `…000010`) | 1 / 2 | `issuer` = ทะเบียนคนแรกที่ claim |
| `NEED_FIX` | มี | คงเดิม | **คงผู้ถือเดิม** (ส่งแก้แล้วกลับคนเดิม) | คงเดิม | `returned_at` `return_reason` `fix_deadline` = returned_at + 168 ชม. · `return_count` |
| `PENDING_APPROVAL` | มี | NULL | NULL | 3 | อยู่ `/head/approvals` |
| `APPROVED` | มี | `registry` | NULL | 3 (SV-03) | `approver` · `issuer` = ผู้ออกเอกสาร (A-27) · โผล่ในคิวทะเบียนด้วย `data-owner` ว่าง |
| `COMPLETED` / `REJECTED` | มี | NULL | NULL | คงเดิม | `closed_at` (+ `reject_reason`) |
| `CANCELLED` | มี (ถ้าชำระแล้ว) | NULL | NULL | คงเดิม | `cancelled_at` |

`case_events.event`: `CREATED` `PAID` `CLAIM` `RETURN` `RESUBMIT` `FORWARD` `APPROVE` `REJECT` `ISSUE` `CANCEL` `AUTO_CANCEL` · ทุกโมดูลที่เปลี่ยนสถานะเพิ่มแถวนี้ (ไทม์ไลน์ `timeline-item` อ่านจากตารางนี้ เรียง `at, id`)

### 4.3 `src/http.js`
| export | |
|---|---|
| `fail(code, extra?, message?)` | throw `ApiError` → error handler ตอบ `{code, message, ...extra}` status ตามตาราง |
| `sendError(res, code, extra?, message?)` | ตอบทันที |
| `ApiError` `apiError()` `ERRORS` | ตาราง CONTRACT §5 + `INVALID_TIME` `BAD_REQUEST` `INTERNAL` |
| `upload` | multer memory: `upload.single('file')` / `upload.array('files')` → `req.file.buffer` (เพดาน multer 20 MB → เกินแล้ว server ตอบ 400 `FILE_TOO_LARGE`) · **การตรวจ ≤ 5,242,880 ไบต์ทำในโมดูล** (บั๊ก B02) |
| `sniffFileType(buf)` | `→ {mime:'application/pdf'\|'image/jpeg'\|'image/png', ext, kind} \| null` จาก magic bytes |
| `baseUrl(req)` | env `BASE_URL` หรือ `protocol://host` ของ request → ใช้ทำ `doc-qr data-url` |
| `isApi(req)` `wrap(fn)` `FORBIDDEN_PAGE_MSG` | |

### 4.4 `src/session.js`
| export | |
|---|---|
| `req.user` | `{id, username, name, role, dept, kind:'full'\|'register', registered, sid}` หรือ `null` |
| `createSession(res, userRow, {kind}?)` | สร้าง session + cookie `sid` (HttpOnly) · role/dept เก็บตามแถว users ตอนนี้ |
| `upgradeSession(req)` | `register` → `full` หลังลงทะเบียน |
| `destroySession(req, res)` | logout |
| `landingFor(user)` | หน้าตั้งต้น (citizen ยังไม่ลงทะเบียน → `/register`) |
| `requireApi(...roles)` | 401 `UNAUTHENTICATED` / 403 `FORBIDDEN` · ไม่ระบุ roles = ล็อกอินแล้วใครก็ได้ · session `register` = 401 |
| `requireApi.register` | สำหรับ `POST /api/auth/register` (ยอม session `register`) |
| `requirePage(...roles)` | → `/login` · citizen ยังไม่ลงทะเบียน → `/register` · บทบาทผิด → 403 `forbidden-msg` |
| `requirePage.register` | สำหรับหน้า `/register` |

### 4.5 อื่น ๆ
- `src/audit.js` → `logAudit(user, event, {caseNo, from, to, detail}) → id` · `user` = `req.user` · `event` ∈ `constants.AUDIT_EVENTS` · detail ตาม CONTRACT §6.8
- `src/crypto.js` → `encrypt(s)` `decrypt(blob)` `idHash(idNo)` `hashPassword(pw)` `verifyPassword(pw, hash)` `signDoc({docNo,caseNo,applicant,serviceId,issuedAt,validUntil,signer}) → hex` `verifyDocSignature(doc, sig) → bool` `randomCode(8)` `randomToken()`
- `src/format.js` → `thaiDateTime(iso)` `'4 ธ.ค. 2569 16:30'` · `thaiDate(ymd|iso)` `'2 ก.พ. 2570'` · `baht(1010)` `'฿1,010'` · `formatId(id)` `'3-1006-00987-65-9'` · `maskId(id)` `'X-XXXX-XXXXX-65-9'` · `maskName('สมชาย ใจดี')` `'สมชาย ใ***'` · `pct(6,7)` `'85.7%'` (ตัวหาร 0 → `'–'`) · `pctValue(6,7)` `85.7`/`null` · `esc(s)` · `timeTag(testid, iso, text?)`
- `src/constants.js` → `ROLE_LABEL` `DEPT_LABEL` `LANDING` `STATUS_LABEL` `SLA_LEVEL_LABEL` `PAYMENT_STATUS_LABEL` `DOC_LABEL` `SERVICES` (`name` `docs[{key,required,pdfOnly}]` `route` `approver` `validity`) `SV03_STEP_LABEL` `AUDIT_EVENTS` `BACKLOG_STATUSES` `CLOSED_STATUSES` `FINAL_STATUSES` `LIMITS` `NUMBERING` `COUNTER`
- `src/views/layout.js` → `sendPage(req, res, {title, body, scripts?, styles?, status?})` (ใส่ header `app-header` `user-name` `user-role` `logout-btn` `nav-*` `nav-bell` `bell-count` ให้อัตโนมัติ) · `renderPage(req, opts) → html` · `forbiddenPage(req,res)` · `notFoundPage(req,res,msg?)` · `errorPage(req,res,status,msg)` · `bellCount(username)`
- `public/common.js` → `window.Egov.api(method, url, body|FormData) → {ok,status,data}` · `Egov.thaiDateTime` `thaiDate` `baht` `maskId` `formatId` `esc` `showError(el,msg)` `clearError(el)` (โหลดทุกหน้าแล้ว)
- `POST /logout` (form ใน header) และ `GET /` (redirect ตาม `landingFor`) อยู่ใน server.js แล้ว

## 5. BUG_MODE → ใครใส่

| บั๊ก | ไฟล์ | จุด |
|---|---|---|
| B01 | `modules/citizen.js` `calcFee` | SV-03 ใช้ `area > 101` แทน `≥ 101` |
| B02 | `modules/citizen.js` อัปโหลด | `size < 5242880` แทน `≤` |
| B03 | `sla.js` `isBusinessDay` | ไม่สนตารางวันหยุด (ข้ามแค่ ส.–อา.) — ฟังก์ชันเดียวใช้ทั้งกำหนดเสร็จและวันคงเหลือ |
| B04 | `sla.js` `extendDueAt` | คืน `dueAt` เดิม (ไม่หยุดนับ) |
| B05 | `modules/citizen.js` ชำระ | QR อายุ 15:00 พอดียังจ่ายได้ (`≤` แทน `<`) |
| B06 | `modules/citizen.js` `loadCaseForViewer` | citizen เปิดคำขอคนอื่นได้ (API + หน้า เพราะหน้าเรียกฟังก์ชันนี้) |
| B07 | `modules/workflow.js` approve API | officer อนุมัติ SV-02 ได้ (ปุ่มยังซ่อน: `availableActions` ไม่เปลี่ยน) |
| B08 | `modules/workflow.js` claim | ข้ามการตรวจว่ามีผู้ถือแล้ว (คนที่ 2 ได้ 200 และเป็นผู้ถือแทน) |
| B09 | `modules/workflow.js` `GET /api/officer/queue` | ใส่ `idNo` เต็มใน JSON (หน้าจอยังปิดบัง: `queueRows` ไม่เปลี่ยน) |
| B10 | `modules/dashboard.js` `computeDashboard` | ทันกำหนด % หารด้วยรับเรื่อง (ธ.ค. → `0.0%`) |
| B11 | `modules/auth.js` unmask | ไม่เรียก `logAudit(…'UNMASK'…)` |
| B12 | `modules/workflow.js` return + `availableActions` | ตีกลับครั้งที่ 3 ได้ (API 200 `returnCount` 3 และปุ่ม `return-btn` ยังแสดง) |

## 6. Signature ที่แต่ละบล็อกต้อง export

> ฟังก์ชันใน §6 คือสิ่งที่ "บล็อกอื่นเรียก" — ต้องมีชื่อและรูปแบบตรงนี้ · ฟังก์ชันภายในอื่น ๆ ตั้งชื่อได้อิสระ
> `caseRow` = แถวจากตาราง `cases` (`SELECT * FROM cases`) · `user` = `req.user`

### 6.1 B02 · `src/seed.js`
```js
/** เรียกโดย db.resetAll() ภายใน transaction หลังล้างทุกตารางแล้ว · นาฬิกา = 2026-12-01T09:00:00+07:00 แล้ว */
function seed(db) → void
module.exports = { seed };
```
- ใส่ให้ครบ TEST-DATA §1–§12: users (เลขบัตร/เบอร์ผ่าน `crypto.encrypt` + `id_hash` · รหัสผ่าน `crypto.hashPassword('Test@1234')` · มานะ `registered=0` · ชื่อแสดงตาม CONTRACT §3) · services (SV-01 fee 20 · SV-02 500 · SV-03 fee 1000 fee_per_sqm 10 · sla 3/10/15) · holidays 4 วัน · cases 30 ใบ + `DR-0001` `DR-0002` ตามตารางคอลัมน์ §4.2 ข้างบน (**`due_at` ค่าตายตัวตาม TEST-DATA ห้ามคำนวณ** A-35) · case_files ตามเอกสารบังคับ (PDF เล็กสร้างในโค้ด ขึ้นต้น `%PDF`) · case_events (อย่างน้อย `PAID` ทุกใบ + ประวัติ claim/return/resubmit/forward/approve/close ที่รู้) · payments `PP-0001` (PENDING · 08:55 → 09:10) · documents `DOC-2569-000001` (verify `K7M2Q9XA` · `valid_until` `2027-02-02` · signer `เจ้าหน้าที่ทะเบียน 1` · `signature = crypto.signDoc(...)` · issued_at `2026-11-05T10:00:00+07:00`) · counters (`case:2569`=30 `receipt:2569`=30 `doc:2569`=1 `draft`=2 `payref`=1)
- **ห้ามใส่** audit · notifications · sessions · otp_attempts (ต้องว่างหลัง reset) · ห้ามอ่านไฟล์นอก `src/`

### 6.2 B03 · `src/sla.js`
```js
isBusinessDay(ymd) → bool                       // จ.–ศ. ที่ไม่อยู่ใน holidays (อ่าน DB ตอนเรียก) · B03: ไม่สน holidays
nextBusinessDay(ymd) → ymd                      // วันทำการถัดไปหลัง ymd
addBusinessDays(ymd, n) → ymd                   // วันทำการที่ n หลัง ymd
startDay(paidAtIso) → ymd                       // D0: วันชำระถ้าเป็นวันทำการและ < 16:30:00 ไม่งั้นวันทำการถัดไป
computeDueAt(paidAtIso, slaDays) → ISO          // addBusinessDays(D0, N) เวลา 16:30:00+07:00
businessDaysBetween(fromIso, toIso) → number    // จำนวนวันทำการในช่วง (วันที่ของ from, วันที่ของ to]
extendDueAt(dueAtIso, returnedAtIso, resubmittedAtIso) → ISO  // + businessDaysBetween(...) วันทำการ · B04: คืน dueAtIso
remainingDays(dueAtIso, nowIso) → number        // วันทำการหลังวันนี้ ถึงวันกำหนด (รวมวันกำหนด) · เลยแล้ว = 0
slaLevel(caseRow, nowIso) → 'normal'|'near'|'overdue'|'paused'|'closed'|null   // null = ยังไม่มีเลข (DRAFT/PENDING_PAYMENT)
evaluateNotifications(nowIso) → number          // เรียกจาก tick: สร้างแจ้งเตือนตาม DECISIONS §8 §18 ผู้รับ (INSERT OR IGNORE) คืนจำนวนที่เพิ่ม
module.exports = { isBusinessDay, nextBusinessDay, addBusinessDays, startDay, computeDueAt, businessDaysBetween, extendDueAt, remainingDays, slaLevel, evaluateNotifications };
```
- ผู้รับแจ้งเตือน: มี `owner` → owner · ไม่มี owner และมี `dept` (SUBMITTED/IN_REVIEW ในคิว) → officer ทุกคนของ dept (`users.role='officer' AND dept=?`) · `PENDING_APPROVAL` → ทุกคนที่ `role='head'` · `APPROVED` → `issuer` · ระดับ overdue เพิ่ม head ทุกคน (ไม่ซ้ำ) · ไม่ประเมิน NEED_FIX/ปิดแล้ว/ยกเลิก · ข้อความ `คำขอ <caseNo> ใกล้ครบกำหนด` / `คำขอ <caseNo> เกินกำหนด` · `created_at = nowIso`

### 6.3 B04 · `src/modules/citizen.js`
Route (ทั้งหมด `requireApi('citizen')` ยกเว้นที่ระบุ): `POST/GET /api/drafts` · `GET/DELETE /api/drafts/:id` · `PATCH /api/drafts/:id` (แก้ qty/area ถ้าหน้าใช้) · `POST /api/drafts/:id/files` · `DELETE /api/drafts/:id/files/:fileId` (ปุ่ม `file-remove-btn`) · `GET /api/drafts/:id/files` · `POST /api/drafts/:id/payment` · `GET /api/payments/:ref` · `GET /api/cases` · `GET /api/cases/:caseNo` (citizen·officer·head) · `POST /api/cases/:caseNo/cancel` · `POST /api/cases/:caseNo/resubmit` (multipart ไม่บังคับ) · test: `ctx.testRouter.post('/payments/:ref/pay')`
```js
calcFee(serviceId, { qty, areaSqm }, svcRow?) → number    // throw ApiError INVALID_QTY | INVALID_AREA | AREA_TOO_LARGE · svcRow ไม่ให้ = อ่าน services · B01 bug
missingDocs(caseId) → string[]                           // ชื่อไทยเอกสารบังคับที่ขาด เรียงตาม SERVICES.docs เช่น ['แบบแปลน','โฉนด']
loadCaseForViewer(user, caseNo) → caseRow                // citizen: เจ้าของเท่านั้น ไม่ใช่/ไม่มี → throw NOT_FOUND (B06 bug: ข้าม) · officer/head: ไม่มี → NOT_FOUND · บทบาทอื่น → FORBIDDEN
caseJson(caseRow, user, nowIso?) → object                // รูปแบบ CONTRACT §6.7 (citizen เจ้าของได้ idNo · officer/head ได้ idMasked เท่านั้น)
draftJson(caseRow) → { draftId, serviceId, status, fee, qty, areaSqm, files:[{fileId,name,docKey,size}], missing:[…], payment:{ref,amount,status,qrCreatedAt,qrExpiresAt}|null }
module.exports = { register, calcFee, missingDocs, loadCaseForViewer, caseJson, draftJson };
```
- ชำระสำเร็จ (ใน transaction เดียว ไม่มี await): ออก `case_no`/`receipt_no` ด้วย `nextSeq(COUNTER.caseNo(beYear(paidAt)))` · `due_at = sla.computeDueAt(paidAt, sla_days)` · status `SUBMITTED` dept `registry` step 1 (SV-03) · `case_events` `PAID`
- ส่งแก้: `due_at = sla.extendDueAt(due_at, returned_at, now)` · status `IN_REVIEW` คืน owner เดิม · ตรวจ 168 ชม. (`FIX_WINDOW_EXPIRED`)

### 6.4 B05 · `src/modules/auth.js`
Route: `POST /api/auth/thaid/start` · `POST /api/auth/thaid/verify` · `POST /api/auth/register` (`requireApi.register`) · `POST /api/auth/staff/login` (Audit `STAFF_LOGIN`) · `POST /api/auth/logout` · `GET /api/me` · `POST /api/officer/cases/:caseNo/unmask` (`requireApi('officer','head')` · Audit `UNMASK` · B11)
```js
validateIdNo(idNo) → bool                 // 13 หลักพอดี + checksum (DECISIONS §2)
findCitizenByIdNo(idNo) → userRow|null    // ผ่าน id_hash
otpLockState(idNo) → { locked: bool, lockedUntil: ISO|null, failCount }   // ให้หน้า /login แสดง lock-message/lock-until ได้
module.exports = { register, validateIdNo, findCitizenByIdNo, otpLockState };
```
- `thaid/verify` ของผู้ที่ยังไม่ลงทะเบียน → `createSession(res, user, {kind:'register'})` + `{registered:false}` · เลขบัตรที่ checksum ถูกแต่ไม่มีใน seed: สร้าง users ใหม่ (`registered=0`, ชื่อจำลองจาก ThaiD)
- `staff/login` ตอบ `{role, dept, landing: landingFor(...)}` · ประชาชนห้ามล็อกอินทางนี้

### 6.5 B06 · `src/modules/workflow.js`
Route: `GET /api/officer/queue?filter=all|unclaimed|mine` (B09 bug) · `POST /api/officer/cases/:caseNo/claim` (B08) · `…/return` (B12) · `…/forward` · `…/issue` · `POST /api/cases/:caseNo/approve` (B07) · `POST /api/cases/:caseNo/reject` · `GET /api/head/approvals` · `GET /api/cases/:caseNo/files` · `GET /api/files/:fileId` · `GET /api/cases/:caseNo/timeline` · `GET /api/documents/:docNo/pdf` · `GET /api/verify/:code` (ไม่ต้องล็อกอิน) · test: `ctx.testRouter.post('/documents/:docNo/tamper')`
```js
autoCancelExpired(nowIso) → number                         // tick: NEED_FIX ที่ now ≥ fix_deadline → CANCELLED (`cancelled_at` = `fix_deadline` และ `case_events` `AUTO_CANCEL` ที่ `at` = `fix_deadline` · TC-WORKFLOW-06)
queueRows(user, filter = 'all') → [{caseNo, serviceId, applicantName, idMasked, status, step, owner, dueAt, slaLevel}]   // เรียง BR-16 · ไม่มี idNo เสมอ
approvalRows() → [{caseNo, serviceId, applicantName, dueAt, slaLevel}]                                                 // PENDING_APPROVAL เรียง BR-16
workloadOf(username) → number                               // IN_REVIEW ที่ owner = username
availableActions(user, caseRow) → { claim, return, forward, approve, reject, issue, unmask }   // bool ตาม CONTRACT §2.6 (ใช้ render ปุ่ม · B12 ทำให้ return ยัง true)
fileAccess(user, caseRow) → 'ok'|'notfound'|'forbidden'     // DECISIONS §18 ไฟล์แนบ
caseFiles(caseId) → [{fileId, name, docKey, size}]
timeline(caseId) → [{at, actor, event, fromStatus, toStatus, note, text}]   // text = ข้อความไทยพร้อมแสดง
documentForCase(caseId) → { docNo, verifyCode, issuedAt, validUntil, signer } | null
verifyDocument(code, nowIso) → { result: 'VALID'|'EXPIRED'|'TAMPERED'|'NOT_FOUND', docNo?, applicantMasked?, serviceId?, issuedAt?, validUntil?, signer? }
module.exports = { register, autoCancelExpired, queueRows, approvalRows, workloadOf, availableActions, fileAccess, caseFiles, timeline, documentForCase, verifyDocument };
```
- ออกเอกสาร: `valid_until` ตาม `SERVICES[id].validity` · `signature = crypto.signDoc(...)` · Audit `ISSUE` detail = docNo · PDF ต้องมีบรรทัด ASCII `docNo=… caseNo=… verify=… validUntil=YYYY-MM-DD` (CONTRACT §3)
- ทุก action เขียน `logAudit` + `case_events` ใน transaction เดียว

### 6.6 B07 · `src/modules/dashboard.js`
Route: `GET /api/dashboard?period=&service=` · `GET /api/dashboard/export?format=xlsx|pdf&period=&service=` (Audit `EXPORT` detail `xlsx 2026-11 ALL`) · `requireApi('executive')`
```js
periodOptions(nowIso?) → [{ value: '2026-12', label: 'ธ.ค. 2569' }, …, { value: '2026', label: 'ทั้งปี 2569' }]  // ค่าแรก = เดือนของนาฬิกา
computeDashboard({ period, service }, nowIso?) → { received, closed, onTime, ontimePct /*number|null*/, ontimeText /*'85.7%'|'–'*/, backlog, overdue, workload: [{ username, name, count }] }  // B10 bug อยู่ที่นี่
module.exports = { register, periodOptions, computeDashboard };
```
- หน้า `/dashboard` (B10) แสดง `ontimeText` ตรง ๆ ห้ามคำนวณซ้ำ · workload ครบ 3 คน (officer ทุกคน) แม้ 0

### 6.7 B08 · `src/modules/admin-audit.js`
Route: `GET /api/audit` · `GET /api/audit/export.csv` (Audit `EXPORT` detail `audit-csv`) · `PUT|PATCH|DELETE /api/audit` และ `/api/audit/:id` → 405 `METHOD_NOT_ALLOWED` ทุกบทบาท (ก่อนตรวจสิทธิ์) · `GET /api/notifications` (`officer`,`head`) · `GET /api/admin/services` · `PUT /api/admin/services/:id` · `GET/POST /api/admin/holidays` · `DELETE /api/admin/holidays/:date` · `GET /api/admin/users` · `PUT /api/admin/users/:username` (Audit `ADMIN_CHANGE`)
```js
queryAudit({ actor, event, from, to }) → { count, items: [{ id, time, username, role, event, caseNo, fromStatus, toStatus, detail }] }  // ใหม่ → เก่า (time DESC, id DESC) · from/to = 'YYYY-MM-DD' รวมทั้งวันตามเวลาไทย
listNotifications(username) → [{ id, caseNo, level, text, createdAt }]
listServices() → [{ id, name, fee, feePerSqm, sla }]
listHolidays() → [{ date, name }]
listUsers() → [{ username, name, role, dept }]   // เฉพาะเจ้าหน้าที่ (username ไม่ว่าง)
module.exports = { register, queryAudit, listNotifications, listServices, listHolidays, listUsers };
```

### 6.8 B09 · `src/views/citizen.js` · B10 · `src/views/staff.js`
```js
module.exports = { register };   // ลงทะเบียน route หน้า HTML เท่านั้น (ไม่สร้าง API ใหม่ — ถ้าขาด API ให้ BOARD: แจ้งเจ้าของโมดูล)
```
- ใช้ `layout.sendPage` ทุกหน้า (header/nav/bell มาเอง) · กันหน้าด้วย `requirePage(...)` ตาม CONTRACT §1 (`/register` ใช้ `requirePage.register` · `/login` `/verify/:code` ไม่ต้องล็อกอิน)
- ข้อมูลในหน้า: เรียกฟังก์ชัน §6.3–§6.7 แบบ lazy require (`const wf = require('../modules/workflow')` ภายใน handler) หรือ query DB ตรงสำหรับการอ่านง่าย ๆ · การกระทำ (ปุ่ม) เรียก API ผ่าน `Egov.api()` ฝั่งเบราว์เซอร์ แล้ว reload/อัปเดต DOM
- `/citizen/cases/:caseNo` ใช้ `citizen.loadCaseForViewer` (ให้บั๊ก B06 มีผลกับหน้าด้วย) · ไม่พบ → `layout.notFoundPage` · `/officer/cases/:caseNo` ปุ่มตาม `workflow.availableActions` · `/verify/:code` ใช้ `workflow.verifyDocument` (NOT_FOUND → HTTP 404)
- ไฟล์ static ของตัวเองใน `public/citizen.js|css` (B09) · `public/staff.js|css` (B10) แล้วส่ง `scripts: ['/static/citizen.js']`

## 7. ตาราง API → เจ้าของ (CONTRACT §6)

| API | เจ้าของ |
|---|---|
| `/api/health` · `/api/test/reset` · `/api/test/clock` | B01 |
| `/api/test/payments/:ref/pay` | B04 |
| `/api/test/documents/:docNo/tamper` | B06 |
| `/api/auth/*` · `/api/me` · `POST /api/officer/cases/:caseNo/unmask` | B05 |
| `/api/drafts*` · `/api/payments/:ref` · `GET /api/cases` · `GET /api/cases/:caseNo` · `/api/cases/:caseNo/cancel` · `/api/cases/:caseNo/resubmit` | B04 |
| `/api/officer/queue` · `/api/officer/cases/:caseNo/{claim,return,forward,issue}` · `/api/cases/:caseNo/{approve,reject,files,timeline}` · `/api/files/:fileId` · `/api/documents/:docNo/pdf` · `/api/verify/:code` · `/api/head/approvals` | B06 |
| `/api/dashboard` · `/api/dashboard/export` | B07 |
| `/api/audit*` · `/api/notifications` · `/api/admin/*` | B08 |
