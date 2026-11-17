# งานหลัก (B) · e-Service กลาง เทศบาลนครตัวอย่าง — ทำตามวิธีของคอร์สทีละขั้น

ผลงานที่ส่งคือโฟลเดอร์นี้ ทำตาม LAB Week 2: ให้ `dag-planner` แตกงาน → ให้ `agent-team` สร้างเว็บ → รัน Playwright 51 TC → เปิด `BUG_MODE` B01–B12 ทีละตัว
รันโดยใช้พรอมต์ของคอร์สเป็นทางหลัก ใน container ที่ config สะอาด (ไม่มี rule/hook เพิ่มของผู้ทำ) โดยมี Claude orchestrator สั่งต่อทีละขั้นตามพรอมต์ของคอร์ส
อีกสองแบบ (A: ใช้กฎของเราคุม, C: วิธีที่ผู้ทำใช้ปกติ) ทำไว้เทียบ ดู [`../comparison/`](../comparison/)

## สิ่งที่ได้

| อะไร | อยู่ที่ |
|---|---|
| แผน DAG + Gantt + แผนเทียบจริง | `PLAN.md` · `dag.png` · `gantt-plan.png` · `gantt-actual.png` · `compare.png` · `blocks.json` |
| รายงานแผน vs จริง รายบล็อก (นาที โทเคน บัญชี) | `REPORT.md` |
| เว็บ + Dockerfile + docker-compose | `app/` (Node 20 · Express · SQLite · หน้า HTML ฝั่งเซิร์ฟเวอร์) |
| ชุด Playwright 51 TC | `app/tests/e2e/` (`part1.spec.ts` 22 TC · `part2.spec.ts` 29 TC) |
| ผลรันชุดเต็ม + BUG-HUNT ทุกรอบ | `app/tests/runs/<รอบ>/` (`list.txt` · `results.json`) · สรุป `app/tests/runs/summary.md` · `app/TEST-RESULT.md` |
| ตาราง triage ตาม BUGS.md §4 | `BUG-HUNT.md` |
| GIF/รายงาน HTML ของแต่ละ TC | `test-report/` |

## วิธีรัน

```text
cd app
TEST_MODE=1 docker compose up --build                 # เว็บที่ http://localhost:3000 (เริ่มเว็บ = reset + seed + นาฬิกา 2026-12-01T09:00:00+07:00)
TEST_MODE=1 BUG_MODE=B03,B07 docker compose up --build  # เปิดบั๊กตามรหัส (ไม่ตั้ง = เว็บถูกต้อง)

cd tests && npm ci && npx playwright install chromium
BASE_URL=http://localhost:3000 DB_PATH=<พาธไฟล์ ../data/egov.db บนเครื่องที่รันเทสต์> npx playwright test
```

`DB_PATH` ใช้กับ TC-NFR-04 (ตรวจว่าฐานข้อมูลไม่มีเลขบัตร/เบอร์ตรง ๆ) · TC-NFR-03 ตรวจเว็บที่ไม่ตั้ง `TEST_MODE` เมื่อตั้ง `BASE_URL_NO_TEST_MODE` ไว้
สคริปต์ที่ใช้จริงในงานนี้คือ `app/tests/run-suite.sh` และ `app/tests/run-bug-matrix.sh` (เขียนสำหรับรันใน container ของคอร์ส)

## ผล

| เกณฑ์ | ผล | หลักฐาน |
|---|---|---|
| ชุดเต็ม 51 TC (ผู้ทำรายงานเอง) | 51/51 ซ้ำ 3 รอบ | `app/tests/runs/normal-1..3`, `final-1..2` |
| BUG-HUNT B01–B12 | 12/12 บั๊กถูกจับ · `B03,B07` และ `B01,B05,B09` = union พอดี | `BUG-HUNT.md` · `app/tests/runs/` |
| รันชุดเทสต์ B ซ้ำบนเครื่องภายนอก container ผ่าน docker compose ของ B | 51/51 | `../comparison/` (ตาราง 3×3) |
| ชุดเทสต์ของอีกสองแบบรันกับเว็บ B | A: 48/51 · C: 33/51 | `../comparison/` — ทุกข้อที่ล้มอธิบายแล้ว ไม่พบกรณีที่เว็บละเมิดข้อความใน spec ตรง ๆ (จำแนกจากการอ่านโค้ด/log ยังไม่ได้รันยืนยันซ้ำ) |

### ข้อควรรู้ (ตรงไปตรงมา)

1. **TC-NOTI-02 ล้มเพิ่มเมื่อเปิด B03** นอกรายการที่ BUGS.md บอกว่า "อาจล้มด้วย" (ผลข้างเคียงของวันหยุดต่อการแจ้งเตือน) — จดไว้ใน `BUG-HUNT.md` แล้วและแบบ A ก็เป็นเหมือนกัน
2. **จุดอ่อนของเว็บ B ที่ชุดเทสต์ของคนอื่นเจอ** (ไม่ผิดตัวอักษรของ spec แต่เสี่ยงถ้าผู้ตรวจอ่านเข้มกว่า):
   - เรนเดอร์ `<p data-testid="thaid-error|fee-error|upload-error|action-error" hidden>` ว่างไว้ตลอด ส่วน TEST-PLAN เขียน "ไม่มี" — ถ้าตรวจด้วย `count()==0` จะไม่ผ่าน (เว็บ C ลบ element ทิ้ง)
   - `audit-case-no` ของเหตุการณ์ EXPORT/ADMIN_CHANGE เป็นช่องว่าง ไม่ใช่ `–`
   - ตอบ test hook `pay` ด้วยฟิลด์เพิ่ม (`amount`, `paidAt`) เกิน 4 ฟิลด์ที่ CONTRACT ยกเป็นตัวอย่าง
   - บรรทัด `docNo=… validUntil=…` ใน PDF อยู่ใน metadata (Subject) และข้อความของ pdfkit ที่บีบอัด — ค้นได้จากไบต์ดิบหรืออ่านด้วยตัวอ่าน PDF ไม่ใช่ตัวอ่านที่ดึงเฉพาะ `(…) Tj`
   - หลังส่งแก้ไขสำเร็จ หน้าเว็บ `location.reload()` ทันที ทำให้เทสต์ที่อ่าน body ของ response หลังคลิกอ่านไม่ได้ (TC-WORKFLOW-06 ของชุด A)
3. **รันตามคอร์สตัวอักษรไม่ได้เต็มรูป**: แผนแรกกระจายงานให้บัญชี Codex (`cyolo`/review) ซึ่งไม่มีในเครื่องนี้ จึงใช้ `yolo1`/`yolo2` (Claude) ทั้ง 13 บล็อก — ดูแผนที่ไม่ได้ใช้ใน `PLAN-whatif.md` / `blocks-mixed.json`
4. **โควตา 5 ชั่วโมง**: `yolo2` เต็มกลางงาน บล็อก B09 และ B12 ล้มครั้งแรกแล้ว retry สำเร็จบน `yolo1` (ดู `REPORT.md` คอลัมน์ "ครั้ง" และ event `worker_stop`)
5. ตัวเลขเวลา/โทเคนของทั้งงาน (3 ชม. 6 นาที · output ~1.19M · ~$72 ตามราคาลิสต์) และข้อจำกัดของการวัด อยู่ใน [`../comparison/COMPARISON.md`](../comparison/COMPARISON.md)

ที่มา: โจทย์ `../egov-brief/` (ชุด TA ห้ามแก้) · เว็บเป็นของสมมติ ไม่ใช้ชื่อ/ตราหน่วยงานจริง · ThaiD/PromptPay/ลายเซ็นเป็นตัวจำลอง
