# TEST-RESULT · e-Service กลาง เทศบาลนครตัวอย่าง (หน่วยงานสมมติ)

> บล็อก B13 (รวมระบบ + Playwright เต็ม + BUG_MODE ทีละตัว) · รันเมื่อ 2026-11-16 · ผู้รัน B13@yolo1
> เว็บ: `docker compose up` (อิมเมจ `egov-eservice:local` · Node 20.20.2 · Express + SQLite `DB_PATH=/data/egov.db` = `app/data/egov.db`)
> ชุดทดสอบ: `app/tests` · Playwright 1.65.1 · Chromium headless · `workers: 1` · 51 TC ตาม TEST-PLAN.md (part1 22 · part2 29)
> หลักฐานทุกรอบอยู่ที่ `app/tests/runs/<รอบ>/` (`list.txt` · `results.json` · `web.log` · `server-banner.txt` · `artifacts/` ของ TC ที่ล้ม) · ตารางรวมสร้างด้วย `tests/summarize-runs.js` → `tests/runs/summary.md`

## 0. สรุปตามเกณฑ์เสร็จ

| เกณฑ์ | ผล |
|---|---|
| `TEST_MODE=1 docker compose up` แล้วรัน Playwright ชุดเต็ม | ✅ **51/51** (`normal-1`) |
| รันซ้ำทันทีโดยไม่ restart เว็บ (BUGS §3 ขั้น 2) | ✅ **51/51** (`normal-2`) |
| `BUG_MODE=B01` … `B12` ทีละตัว (restart ด้วย `docker compose up --force-recreate` ทุกตัว) | ✅ **12/12 บั๊กถูกจับ**: TC ในคอลัมน์ "TC ที่ต้องล้ม" ของ BUGS §2 ล้มครบทุกตัว · TC อื่นผ่านทั้งหมด ยกเว้นผลข้างเคียงที่ยอมรับ (B03: TC-SLA-03 · TC-RBAC-04 ตาม BUGS §2 และ TC-NOTI-02 ตาม DECISIONS §18 · B10: TC-DASH-01 · TC-DASH-03 ตาม BUGS §2) |
| รวมบั๊ก (BUGS §3 ขั้น 5) | ✅ `B03,B07` ล้ม 6 = B03 (5) ∪ B07 (1) · `B01,B05,B09` ล้ม 3 = union พอดี |
| ข้อความที่ล้ม (BUGS §3 ขั้น 4) | ✅ ทุก TC ที่ล้มบอก **ค่าจริงต่างจากค่าคาดหวัง** (ตาราง §5) ไม่มีตัวไหนล้มเพราะ timeout หรือหา element ไม่เจอ |
| ปิดบั๊กทั้งหมดอีกครั้ง (BUGS §3 ขั้น 6) | ✅ **51/51** (`normal-3`) |
| TC-NFR-04 inspection นอก Playwright | ✅ พบ 0 ครั้งทุกค่า ทั้งไบต์ดิบ DB/WAL/SHM · `.dump` ทั้งฐาน · log ของเว็บ (§6) |
| เว็บที่ไม่ตั้ง `TEST_MODE` | ✅ `/api/test/*` = 404 (`scripts/smoke.js` กับ `docker compose up` ที่ไม่ตั้ง TEST_MODE และ TC-NFR-03 ตรวจกับคอนเทนเนอร์ที่ :3001 ทุกรอบ) |

## 1. วิธีรันซ้ำ

```text
cd app
TEST_MODE=1 docker compose up --build            # เว็บ :3000 · เริ่มเว็บ = reset + seed + นาฬิกา 2026-12-01T09:00:00+07:00
cd tests && npm ci                               # ครั้งแรก (เครื่องอื่น: npx playwright install chromium)
./run-suite.sh normal-1                          # ชุดเต็ม 51 TC กับเว็บที่เปิดอยู่ → runs/normal-1/
./run-bug-matrix.sh "" "" B01 B02 B03 B04 B05 B06 B07 B08 B09 B10 B11 B12 "B03,B07" "B01,B05,B09" ""
node summarize-runs.js normal-1 normal-2 B01 … normal-3 > runs/summary.md
python3 -I inspect-pii.py ../data/egov.db runs/normal-3/web.log      # TC-NFR-04 inspection
```

- `run-bug-matrix.sh`: แต่ละโหมดสั่ง `TEST_MODE=1 BUG_MODE=<โหมด> docker compose up -d --force-recreate` → รอ healthcheck → `run-suite.sh` · โหมด `""` ที่ติดกันไม่ restart (ขั้น 2) · ตรวจบรรทัดเริ่มเว็บ (`[egov] listening … TEST_MODE=1 · BUG_MODE=B03,B07`) เก็บใน `server-banner.txt` ทุกรอบ
- `run-bug-matrix.sh` เปิดคอนเทนเนอร์ `egov-notestmode` (อิมเมจเดียวกัน **ไม่ตั้ง TEST_MODE** · DB แยก) ที่ :3001 → `BASE_URL_NO_TEST_MODE` ให้ TC-NFR-03 ตรวจข้อ "ปิด hook" จริงทุกรอบ
- `run-suite.sh` เก็บ `docker compose logs -f web` ระหว่างรอบเป็น `web.log` แล้วส่งให้ TC-NFR-04 ค้นข้อมูลส่วนบุคคลใน log ด้วย (`PII_SCAN_PATHS`)
- เครื่องนี้มี Chromium build 1252 แต่ Playwright 1.65.1 ต้องการ 1255 → `run-suite.sh` สร้าง `tests/.pw-browsers/` (symlink ไป `/ms-playwright/*-1252`) แล้วตั้ง `PLAYWRIGHT_BROWSERS_PATH` เอง
- เวลา: ชุดเต็ม 80–90 วินาที · B03 ≈ 220 วินาที และ B10 ≈ 180 วินาที (soft assert รอจนครบ 10 วินาทีทุกจุดที่ผิด)

## 2. สิ่งที่ B13 แก้

### 2.1 เว็บ (2 จุด · ไฟล์ของ B01)

| ไฟล์ | อาการ | แก้ | TC |
|---|---|---|---|
| `src/db.js:49` | คอมเมนต์ใน `CREATE TABLE users` มีเบอร์จริง `-- crypto.encrypt('0812345678')` · SQLite เก็บข้อความ schema ทั้งก้อนใน `sqlite_master` → `grep -a` พบเบอร์ในไฟล์ DB | เปลี่ยนเป็น `crypto.encrypt(เบอร์มือถือ 10 หลัก)` · ลบ `data/egov.db` เก่า (สร้างจาก schema เดิม และ `CREATE TABLE IF NOT EXISTS` ไม่เขียนทับ) ให้เว็บสร้างใหม่ | TC-NFR-04 |
| `public/app.css` `.user-role` | ป้ายบทบาทในแถบหัว พื้น `rgba(255,255,255,.2)` บน `#0b5cad` ไม่ผ่าน axe `color-contrast` (serious) ในหน้าที่ใช้ CSS ร่วม เช่น หน้า 403 ของ `requirePage` | `background: var(--primary-dark); color: #fff` (ขาวบน `#08477f` ≈ 9:1) | TC-NFR-02 |

### 2.2 ชุดทดสอบ (ไม่มีการแก้ค่าคาดหวัง)

ตรวจความตรงการ์ดทั้ง 51 TC (รีวิว 3 ชุด: part1 · part2 WORKFLOW–DASH · part2 AUDIT–NFR) เทียบ TEST-PLAN/CONTRACT/TEST-DATA/DECISIONS §18: **ไม่พบค่าคาดหวังที่ผิดการ์ด** · แก้เฉพาะจุดที่อ่อนกว่าการ์ดหรือเปราะ (ล้มด้วย timeout แทนค่าต่าง):

| TC | เดิม | แก้เป็น | เหตุผล |
|---|---|---|---|
| TC-QUEUE-02 ส่วน 1 | ไม่ตรวจ HTTP ของคนที่แพ้ · เปิด B08 แล้วล้มที่ `action-error` ว่าง (รอ 10 วินาที) | เก็บ response `POST …/claim` ของทั้งสองหน้า ต้องได้ `[200, 409]` และ body `ALREADY_CLAIMED` ก่อนตรวจหน้าจอ · `owner` = คนที่ได้ 200 · `row-owner` ตรงทั้งข้อความ | การ์ด "อีกคน … (HTTP 409 `ALREADY_CLAIMED`)" · BUGS §3 ขั้น 4 |
| TC-UPLOAD-01 | เปิด B02 แล้วล้มที่ `file-item` 0 ≠ 1 (ไม่บอกเหตุ) | ตรวจรหัสตอบของการอัปโหลดจากหน้า (`201`) ก่อนนับ `file-item` → ล้มด้วย `400 FILE_TOO_LARGE` | การ์ดตรวจ 201 ด้วย · BUGS §3 ขั้น 4 |
| TC-AUDIT-01 | `audit-count` 16 แบบ hard → เปิด B11 ไม่รู้ว่าแถวไหนหาย · `audit-actor` ใช้ `toContain` | นับแบบ soft แล้วตรวจรายแถวต่อ → รายงาน `ไม่พบแถว UNMASK off.reg2 EG-2569-000025` · `audit-actor` ตรงตัว | การ์ดกำหนดผู้ทำตรงตัว |
| TC-RBAC-06 | ตรวจ `action-error` บนจอก่อน API | ตรวจ API (400/409 + code) ก่อน แล้วจึงตรวจจอ | ล้มด้วยค่า ไม่ใช่หา element ไม่เจอ |
| `expectCounts` (TC-WORKFLOW-04 ฯลฯ) | ตรวจปุ่มที่ต้อง "ไม่มี" ก่อน → อาจผ่านหลอกถ้าหน้ายังโหลดไม่ครบ | ตรวจปุ่มที่ต้องมีก่อน แล้วจึงตรวจปุ่มที่ต้องไม่มี | กันผ่านหลอก |
| TC-WORKFLOW-06 รอบ A | ไม่ตรวจ HTTP ของการส่งแก้ | ต้อง `200` | การ์ด "ส่งแก้ → 200 `IN_REVIEW`" |
| TC-DOC-01 · TC-DASH-03 | `toContain` บรรทัด `docNo=…` / `kpi …` (`overdue=1` ตรงกับ `overdue=10` ได้) | regex ทั้งบรรทัด (ไม่มีอักษรต่อหน้า/ท้าย) | การ์ด "มีบรรทัด …" |
| TC-DASH-02 | API `ontimePct` ใช้ `toBeCloseTo(x, 1)` | `toBe(85.7)` ตรงตัว | CONTRACT §6 ตัวอย่าง `"ontimePct":85.7` |
| TC-NOTI-01/02 | API `text` ใช้ `toContain` | ตรงตัว `คำขอ EG-2569-000024 ใกล้ครบกำหนด` | CONTRACT §2.12 |
| TC-NFR-01 | ไม่ตรวจว่าหน้าเปิดได้จริง | ทุกหน้าต้อง HTTP 200 และไม่ถูกเปลี่ยนเส้นทาง | กันผ่านหลอกเมื่อได้ 403/404/`/login` |
| TC-RBAC-01 | assert 404 ไม่มีป้าย | เพิ่มป้าย `สมหญิงเปิด /citizen/cases/EG-2569-000005 (ของสมชาย) HTTP` | อ่านผลง่าย |
| TC-NFR-03 (ตัวรัน) | ข้อ "ปิด hook" ถูกข้ามถ้าไม่ตั้ง `BASE_URL_NO_TEST_MODE` | ตัวรันเปิดเว็บที่ไม่ตั้ง TEST_MODE ที่ :3001 ให้ทุกรอบ | การ์ด "ถ้ารันเว็บได้สองโหมด" (เว็บนี้รันได้) |
| TC-NFR-04 (ตัวรัน) | ค้นแค่ไฟล์ DB | เพิ่ม `web.log` ของรอบ | การ์ด "ค้นใน … log ของเว็บ" |

**ผลก่อนแก้ test** (`tests/runs/baseline/`): ชุดเดิมก็ได้ 51/51 สองรอบ และเปิดบั๊กแต่ละตัวล้มชุด TC เดียวกับรอบสุดท้ายทุกตัว → การแก้ test ไม่เปลี่ยนว่าอะไรผ่าน/ล้ม เปลี่ยนแค่ให้ข้อความล้มบอกค่าจริง และปิดช่องผ่านหลอก

## 3. ตารางผล 51 TC × 17 รอบ (รอบสุดท้าย · `tests/runs/summary.md`)

`normal-1` = TEST_MODE=1 ไม่ตั้ง BUG_MODE · `normal-2` = รันซ้ำทันทีไม่ restart · `Bxx` = `BUG_MODE=Bxx` · `normal-3` = ปิดบั๊กทั้งหมดอีกครั้ง

| TC | normal-1 | normal-2 | B01 | B02 | B03 | B04 | B05 | B06 | B07 | B08 | B09 | B10 | B11 | B12 | B03+B07 | B01+B05+B09 | normal-3 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| TC-AUTH-01 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-AUTH-02 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-AUTH-03 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-AUTH-04 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-FEE-01 | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| TC-SUBMIT-01 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-SUBMIT-02 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-SUBMIT-03 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-UPLOAD-01 | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-UPLOAD-02 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-PAY-01 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| TC-PAY-02 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-PAY-03 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-PAY-04 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-QUEUE-01 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-QUEUE-02 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-QUEUE-03 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-SLA-01 | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| TC-SLA-02 | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| TC-SLA-03 | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| TC-NOTI-01 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-NOTI-02 | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| TC-WORKFLOW-01 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-WORKFLOW-02 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-WORKFLOW-03 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-WORKFLOW-04 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| TC-WORKFLOW-05 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-WORKFLOW-06 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-DOC-01 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-DOC-02 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-DOC-03 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-PDPA-01 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-PDPA-02 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| TC-PDPA-03 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ |
| TC-DASH-01 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-DASH-02 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-DASH-03 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-DASH-04 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-AUDIT-01 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ |
| TC-AUDIT-02 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-AUDIT-03 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-RBAC-01 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-RBAC-02 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| TC-RBAC-03 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-RBAC-04 | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| TC-RBAC-05 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-RBAC-06 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-NFR-01 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-NFR-02 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-NFR-03 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TC-NFR-04 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **ผ่าน** | 51/51 | 51/51 | 50/51 | 50/51 | 46/51 | 50/51 | 50/51 | 50/51 | 50/51 | 50/51 | 50/51 | 48/51 | 49/51 | 50/51 | 45/51 | 48/51 | 51/51 |

## 4. ตาราง triage (BUGS.md §4)

| บั๊ก | TC ที่คาดว่าล้ม (จากตาราง 2) | TC ที่ล้มจริง | TC ล้มเกินที่คาด | TC ที่ควรล้มแต่ผ่าน | ผล |
|---|---|---|---|---|---|
| (ปกติ) | – | – | – | – | ✅ 51/51 passed (`normal-1` · `normal-2` ไม่ restart · `normal-3` หลังปิดบั๊ก) |
| B01 | TC-FEE-01 | TC-FEE-01 | – | – | ✅ 50 passed · 1 failed |
| B02 | TC-UPLOAD-01 | TC-UPLOAD-01 | – | – | ✅ 50 passed · 1 failed |
| B03 | TC-SLA-01 · TC-SLA-02 (อาจล้มด้วย TC-SLA-03 · TC-RBAC-04) | TC-SLA-01 · TC-SLA-02 · TC-SLA-03 · TC-RBAC-04 · TC-NOTI-02 | TC-NOTI-02 (ส่วน B ส. 5 ธ.ค.: `…000016` นับ จ. 7 ธ.ค. เป็นวันทำการ → วันคงเหลือ 2 แทน 1 → ไม่เกิด `near` · ยอมรับตาม DECISIONS §18 "B03 กระทบอะไร" · ดู Q1) | – | ✅ 46 passed · 5 failed (TC-SLA-03 · TC-RBAC-04 · TC-NOTI-02 = ผลข้างเคียงที่ยอมรับ) |
| B04 | TC-SLA-02 | TC-SLA-02 | – | – | ✅ 50 passed · 1 failed |
| B05 | TC-PAY-01 | TC-PAY-01 | – | – | ✅ 50 passed · 1 failed |
| B06 | TC-RBAC-01 | TC-RBAC-01 | – | – | ✅ 50 passed · 1 failed |
| B07 | TC-RBAC-02 | TC-RBAC-02 | – | – | ✅ 50 passed · 1 failed (TC-WORKFLOW-01 ผ่าน เพราะบั๊กเปิดเฉพาะ officer + SV-02) |
| B08 | TC-QUEUE-02 (ส่วน 3 ต่อกัน ล้มแน่นอน) | TC-QUEUE-02 | – | – | ✅ 50 passed · 1 failed (ล้มตั้งแต่ส่วน 1: claim พร้อมกันได้ 200 ทั้งคู่ · กำหนดได้ ไม่พึ่ง race) |
| B09 | TC-PDPA-02 | TC-PDPA-02 | – | – | ✅ 50 passed · 1 failed |
| B10 | TC-DASH-02 (อาจล้มด้วย TC-DASH-01 · TC-DASH-03) | TC-DASH-01 · TC-DASH-02 · TC-DASH-03 | – (ทั้งสองอยู่ในรายการ "อาจล้มด้วย") | – | ✅ 48 passed · 3 failed |
| B11 | TC-PDPA-03 · TC-AUDIT-01 | TC-PDPA-03 · TC-AUDIT-01 | – | – | ✅ 49 passed · 2 failed |
| B12 | TC-WORKFLOW-04 | TC-WORKFLOW-04 | – | – | ✅ 50 passed · 1 failed |
| B03,B07 | union ของ B03 + B07 | TC-SLA-01 · TC-SLA-02 · TC-SLA-03 · TC-NOTI-02 · TC-RBAC-02 · TC-RBAC-04 | – (= B03 ∪ B07 พอดี) | – | ✅ 45 passed · 6 failed |
| B01,B05,B09 | TC-FEE-01 · TC-PAY-01 · TC-PDPA-02 | TC-FEE-01 · TC-PAY-01 · TC-PDPA-02 | – | – | ✅ 48 passed · 3 failed |

ทุกบั๊กอยู่ที่ตรรกะฝั่งเซิร์ฟเวอร์ตาม INTERFACES §5 (`isBug()` ใน `modules/citizen.js` B01 B02 B05 B06 · `sla.js` B03 B04 · `modules/workflow.js` B07 B08 B09 B12 · `modules/dashboard.js` B10 · `modules/auth.js` B11) · `BUG_MODE` แยกด้วยจุลภาค ตัดช่องว่าง ไม่สนตัวพิมพ์ · ไม่ตั้ง = เว็บถูกต้อง

## 5. ข้อความที่ล้ม: ค่าจริง vs ค่าคาดหวัง (BUGS §3 ขั้น 4)

| บั๊ก · TC | assert ที่ล้ม | คาดหวัง | ได้จริง | ตรงกับ "เปิดแล้วผิดอย่างไร" (BUGS §2) |
|---|---|---|---|---|
| B01 · TC-FEE-01 | `fee-total` SV-03 101 ตร.ม. (+ API `fee`) | `฿1,010` (1010) | `฿1,000` (1000) | ✅ |
| B02 · TC-UPLOAD-01 | หน้าอัปโหลด `size-5242880.pdf` | `201` | `400 {"code":"FILE_TOO_LARGE","message":"ไฟล์ใหญ่เกิน 5 MB"}` | ✅ |
| B03 · TC-SLA-01 | แถว c `dueAt` (+ `sla-due` `data-iso`/ข้อความ) · แถว d … | `2026-12-08T16:30:00+07:00` · แถว d `2026-12-11…` | `2026-12-07T16:30:00+07:00` · แถว d `2026-12-09…` | ✅ |
| B03 · TC-SLA-02 | `dueAt` หลังส่งแก้ | `2026-12-08T16:30:00+07:00` | `2026-12-07T16:30:00+07:00` | ✅ ("หยุดนับ … ได้ 7 ธ.ค. แทน 8 ธ.ค.") |
| B03 · TC-SLA-03 | ส่วน B ศ. 4 ธ.ค. 09:00 `sla-level` / `data-level` / API `slaLevel` | `ใกล้ครบกำหนด` / `near` | `ปกติ` / `normal` | ✅ (อาจล้มด้วย) |
| B03 · TC-RBAC-04 | `dueAt` หลังเพิ่มวันหยุด 2 ธ.ค. | `2026-12-08T16:30:00+07:00` | `2026-12-04T16:30:00+07:00` | ✅ (อาจล้มด้วย) |
| B03 · TC-NOTI-02 | ส่วน B `off.reg2` @5 ธ.ค. `GET /api/notifications` | มี `EG-2569-000016\|near` (10 รายการ) | ไม่มี (9 รายการ) | ผลข้างเคียงตาม DECISIONS §18 (Q1) |
| B04 · TC-SLA-02 | `dueAt` หลังตีกลับ พ. 2 ธ.ค. ส่งแก้ พฤ. 3 ธ.ค. | `2026-12-08T16:30:00+07:00` | `2026-12-04T16:30:00+07:00` | ✅ |
| B05 · TC-PAY-01 | ชำระ `PP-0001` ที่ 09:10:00 (อายุ 15:00) | `410` | `200 {"status":"PAID","caseNo":"EG-2569-000031",…}` | ✅ |
| B06 · TC-RBAC-01 | สมหญิงเปิด `/citizen/cases/EG-2569-000005` (ของสมชาย) | `404` | `200` | ✅ |
| B07 · TC-RBAC-02 | `off.reg2` `POST /api/cases/EG-2569-000014/approve` | `403` | `200 {"caseNo":"EG-2569-000014","status":"APPROVED"}` | ✅ |
| B08 · TC-QUEUE-02 | claim `…000028` พร้อมกันสองหน้า | `[200, 409]` | `[200, 200]` | ✅ |
| B09 · TC-PDPA-02 | `GET /api/officer/queue` ไม่มีเลข 13 หลัก/key `idNo` | `[]` / `false` | `$.items[i].idNo = "3100600987659"` … / `true` | ✅ |
| B10 · TC-DASH-02 | `kpi-ontime-pct` + API `ontimePct` | พ.ย. `85.7%` · ปี 2569 `87.5%` · ต.ค. `100.0%` | พ.ย. `23.1%` · ปี 2569 `23.3%` · ต.ค. `100.0%` (ผ่าน) | ✅ |
| B10 · TC-DASH-01 / TC-DASH-03 | ธ.ค. `kpi-ontime-pct` / พ.ย. ก่อนส่งออก | `–` / `85.7%` | `0.0%` / `23.1%` | ✅ (อาจล้มด้วย) |
| B11 · TC-PDPA-03 | `/audit` กรอง `UNMASK` `audit-count` | `1` | `0` | ✅ |
| B11 · TC-AUDIT-01 | `audit-count` ไม่กรอง + แถว UNMASK | `16` + มีแถว | `15` + `ไม่พบแถว UNMASK off.reg2 EG-2569-000025` | ✅ |
| B12 · TC-WORKFLOW-04 | `return-btn` ของ `…000020` หลังตีกลับครบ 2 ครั้ง | `0` | `1` | ✅ |

ข้อความเต็มทุกจุด (รวม soft assert) อยู่ท้าย `tests/runs/summary.md` และใน `tests/runs/<รอบ>/list.txt`

## 6. TC-NFR-04 inspection (นอก Playwright · DECISIONS §18 "เข้ารหัส at rest")

- วิธีเข้ารหัสที่เว็บใช้ (`src/crypto.js`): เลขบัตรและเบอร์โทรเก็บเป็น **AES-256-GCM** (IV สุ่ม 12 ไบต์ต่อค่า · รูปแบบ `v1:<base64(iv|tag|ciphertext)>`) · ค้นเลขบัตรด้วย **HMAC-SHA256** (`users.id_hash`) · รหัสผ่านเจ้าหน้าที่ **scrypt** · คีย์เป็นคีย์ทดสอบ (ตั้งทับด้วย env `PII_KEY`) · HTTPS = Q-08 ไม่ทดสอบ
- ตรวจหลังรอบ `normal-3` (TC-NFR-04 ทำให้มานะลงทะเบียนเบอร์ `0845678901` แล้ว): `python3 -I tests/inspect-pii.py data/egov.db tests/runs/normal-3/web.log tests/runs/normal-3/web-full.log`
  - ไฟล์: `egov.db` 15.9 MB · `egov.db-wal` 9.3 MB · `egov.db-shm` · log ของเว็บ 2 ไฟล์
  - ประชาชน 4 แถว: `id_enc` และ `mobile_enc` ขึ้นต้น `v1:` ครบ 4/4
  - ค่าทั้ง 12 (`1101700123456` `3100600987659` `1909900555015` `5500400111221` `0812345678` `0823456789` `0834567890` `0845678901` และรูปแบบมีขีด 4 ค่า): **พบ 0 ครั้งทุกค่า** ทั้งไบต์ดิบ (เหมือน `grep -a -c`) · ข้อความ `.dump` ทั้งฐาน (`iterdump`) · log
  - ตัวควบคุมบวก (ใน TC-NFR-04): สมชาย `GET /api/cases/EG-2569-000005` ได้ `idNo` = `1101700123456`

## 7. คำถามถึง TA (แผน/โจทย์ ไม่ได้แก้เอง)

| # | เรื่อง | รายละเอียด | ข้อเสนอ |
|---|---|---|---|
| Q1 | B03 ทำ TC-NOTI-02 ล้มด้วย แต่ BUGS §2 / TEST-PLAN §18 ไม่ได้ระบุ | ส่วน B ประเมินที่ ส. 5 ธ.ค. · บั๊ก B03 นับ จ. 7 ธ.ค. (วันหยุด) เป็นวันทำการ → `…000016` (กำหนด อ. 8 ธ.ค.) และ `…000011` เหลือ 2 วันแทน 1 → ไม่ได้ `near` → `off.reg2` 9 แทน 10 · `head1` 14 แทน 15 · DECISIONS §18 "B03 กระทบอะไร" อนุญาตไว้ ("TC ที่ใช้วันคงเหลือข้ามวันหยุดล้มด้วยได้") | เพิ่ม TC-NOTI-02 ในคอลัมน์ "TC ที่อาจล้มด้วย" ของ B03 |
| Q2 | TC-UPLOAD-02 นับไฟล์ผ่าน `GET /api/drafts/:id` แต่ CONTRACT §6 ไม่มีฟิลด์ไฟล์ | CONTRACT กำหนดแค่ `{items:[{draftId,serviceId,status,fee}]}` · เว็บนี้ส่ง `files[]` เพิ่ม (test ใช้ `files[]` หรือ `fileCount`) | ระบุใน CONTRACT ว่า `GET /api/drafts/:id` ต้องมี `files[]` (หรือ `fileCount`) |
| Q3 | TC-NFR-04 การ์ดเขียนว่า inspection นอก Playwright แต่ชุดนี้ทำทั้งสองแบบ | ใน Playwright ตรวจไบต์ดิบของ `DB_PATH` (+ log ที่ส่งมา) · นอก Playwright ตรวจ `.dump` เพิ่ม (§6) | ยืนยันว่ายอมรับแบบนี้ |

## 8. ไฟล์ที่เกี่ยวข้อง

| ไฟล์ | คืออะไร |
|---|---|
| `tests/e2e/part1.spec.ts` · `tests/e2e/part2.spec.ts` · `tests/e2e/helpers.ts` | ชุด Playwright 51 TC (B11 · B12 · แก้ตาม §2.2) |
| `tests/run-suite.sh` · `tests/run-bug-matrix.sh` · `tests/summarize-runs.js` · `tests/inspect-pii.py` | ตัวรัน/สรุปผล/inspection (B13) |
| `tests/runs/{normal-1,normal-2,B01…B12,B03+B07,B01+B05+B09,normal-3}/` | หลักฐานรอบสุดท้าย · `tests/runs/summary.tsv` สรุปบรรทัดละรอบ · `tests/runs/summary.md` ตาราง + ข้อความล้มทั้งหมด |
| `tests/runs/baseline/` | รอบก่อนแก้ test (ผลผ่าน/ล้มเหมือนรอบสุดท้าย) |
| `tests/test-results/results.json` · `tests/playwright-report/index.html` | รอบ `npx playwright test` ธรรมดา (reporter ตาม config) กับเว็บถูกต้องหลังรอบสุดท้าย: 51 passed · `.last-run.json` = `passed` |
