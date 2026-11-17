# e-Service กลาง · เทศบาลนครตัวอย่าง (ระบบจำลอง)

เว็บตามโจทย์ใน [`../egov-brief/`](../egov-brief/README.md) — ประชาชนยื่นคำขอ 3 บริการ + จ่าย PromptPay QR จำลอง · เจ้าหน้าที่ตรวจ/ตีกลับ/ส่งต่อ/ออกเอกสารดิจิทัล · หัวหน้าอนุมัติ · ผู้บริหารดู Dashboard · ผู้ตรวจสอบดู Audit Trail · ผู้ดูแลแก้ค่าธรรมเนียม/SLA/วันหยุด/บทบาท — พร้อม Playwright 51 TC และ `BUG_MODE` B01–B12

> หน่วยงานสมมติ · ThaiD, PromptPay, ลายเซ็นดิจิทัล เป็นตัวจำลองทั้งหมด (OTP `123456` · ชำระผ่าน `POST /api/test/payments/<ref>/pay` · ลายเซ็น HMAC-SHA256 คีย์ทดสอบ)

## โครงสร้าง

| ที่ | คืออะไร |
|---|---|
| `app/core.js` | นาฬิกา (Asia/Bangkok, แช่แข็งเมื่อ `TEST_MODE=1`) · วันทำการ/SLA · ค่าธรรมเนียม · ตรวจไฟล์ (magic bytes) · เข้ารหัส PII · seed ตาม TEST-DATA · จุดใส่บั๊ก |
| `app/domain.js` | สิทธิ์ · คิว · แจ้งเตือน (ประเมินทุก request) · Dashboard · Audit · ร่าง/ชำระ |
| `app/server.js` | `node:http` + API ทั้งหมดตาม CONTRACT §6/§8 |
| `app/pages.js` · `app/static/` | หน้าเว็บ server-rendered + JS/CSS เล็ก ๆ (`data-testid` ตาม CONTRACT §2) |
| `tests/*.spec.js` | 51 TC ตาม TEST-PLAN (ชื่อ test ขึ้นต้นด้วยรหัส TC) · `tests/helpers.js` = สูตร RESET/CLOCK/LOGIN_C/LOGIN_S/NEW_PAID |
| `tests/global-setup.js` · `tests/make_testfiles.py` | สร้างไฟล์ทดสอบ TEST-DATA §11 (ขนาดตรงไบต์) |
| `scripts/run-bugs.js` | รันชุดเต็มทุกโหมดบั๊กแล้วเขียนตาราง triage (`reports/`) |
| `Dockerfile` · `Dockerfile.tests` · `docker-compose.yml` | web + web-nohook + tests |
| `reports/REPORT.md` | **ผลการทดสอบ + ตาราง triage BUG_MODE + สิ่งที่เลือกเอง** |
| `reports/PLAN-DAG.md` | แผนงานแบบ DAG (README ของโจทย์ §2 ขั้น 1) |

Dependency เดียวของเว็บคือ `exceljs` (ไฟล์ .xlsx) · ฝั่ง test ใช้ `@playwright/test` และ `@axe-core/playwright`

## รันด้วย Docker Compose

```bash
docker compose up -d --build --wait web                  # เว็บ http://localhost:3000 (TEST_MODE=1, ไม่มีบั๊ก)
docker compose --profile test run --rm tests             # รัน 51 TC กับ http://web:3000 → 51 passed
BUG_MODE=B03 docker compose up -d --wait --force-recreate web   # เปิดบั๊ก แล้วรัน tests ซ้ำ
docker compose --profile test run --rm tests
node scripts/run-bugs.js --docker                        # ทั้งเมทริกซ์ผ่าน compose → reports/BUG-TRIAGE-docker.generated.md
docker compose --profile test down
```

ถ้าพอร์ต 3000 ของเครื่องถูกใช้อยู่ ตั้ง `WEB_PORT=3300` ก่อนคำสั่ง (container tests คุยกับเว็บผ่านเครือข่ายของ compose จึงไม่ขึ้นกับพอร์ตนี้)
`web-nohook` คือ image เดียวกันที่ไม่ตั้ง `TEST_MODE` (TC-NFR-03 ตรวจว่า `/api/test/*` ตอบ 404) · ฐานข้อมูลอยู่ใน volume `dbdata` ที่ `/data/app.db.json` และ container tests เมานต์แบบอ่านอย่างเดียวให้ TC-NFR-04 ตรวจ

## รันบนเครื่อง (Node 24)

```bash
npm ci
PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium   # เบราว์เซอร์ลงใน node_modules
TEST_MODE=1 node app/server.js                               # เว็บ http://localhost:3000
npx playwright test                                          # เปิดเว็บเองที่พอร์ต 3100 (TEST_MODE=1) แล้วรัน 51 TC
BUG_MODE=B07 npx playwright test                             # เปิดบั๊กแล้วรันชุดเดิม
node scripts/run-bugs.js                                     # ปกติ×2 (เว็บตัวเดิม) · B01–B12 · B03,B07 · B01,B05,B09 · ปกติอีกรอบ
```

ตัวแปรสภาพแวดล้อมของเว็บ: `TEST_MODE=1` เปิด `/api/test/*` · `BUG_MODE=B03,B07` · `PORT` (3000) · `DB_PATH` (`data/app.db.json`) · `PII_KEY` / `SIGN_KEY` (มีค่าทดสอบตั้งต้น)
ตัวแปรของ test: `BASE_URL` (ถ้าตั้ง จะไม่เปิดเว็บเอง) · `DB_PATH` (ไฟล์ฐานข้อมูลของเว็บ) · `NOHOOK_URL` (เว็บที่ไม่ตั้ง TEST_MODE · ถ้าไม่ตั้ง test จะเปิดเองที่พอร์ต 3199)

## บัญชีทดสอบ (หลัง `POST /api/test/reset`)

ประชาชน (OTP `123456`): สมชาย `1101700123456` · สมหญิง `3100600987659` · ปิติ `1909900555015` · มานะ `5500400111221` (ยังไม่ลงทะเบียน)
เจ้าหน้าที่ (รหัสผ่าน `Test@1234`): `off.reg1` `off.reg2` `off.works1` `head1` `exec1` `audit1` `admin1`
