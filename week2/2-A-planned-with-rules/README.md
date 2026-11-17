# e-Service เทศบาลนครตัวอย่าง · Week 2 LAB

เว็บ e-Service ภาครัฐ (ประชาชนยื่นคำขอ · เจ้าหน้าที่ · หัวหน้า · ผู้บริหาร · ผู้ตรวจ · ผู้ดูแล) สร้างตามโจทย์ใน `../egov-brief/`

## รัน

```text
cd app
docker compose up --build            # http://localhost:3000  (เปลี่ยนด้วย PORT=… และตั้ง BASE_URL ให้ตรง)
TEST_MODE=1 BUG_MODE=B03,B07 docker compose up --build   # โหมดฝังบั๊กสำหรับ LAB 5
```

Stack: Node 24 + Express 4 + `node:sqlite` (ไม่มี build step) · ทดสอบ: `cd app/tests && npm i && BASE_URL=http://localhost:3000 npx playwright test`

## งานที่ส่ง

| LAB | ไฟล์ |
|---|---|
| 2 แผน | `PLAN.md` · `blocks.json` · `dag.png` · `gantt-plan.png` |
| 3 สร้างเว็บ + รายงานแผน vs จริง | `app/` · `REPORT.md` · `gantt-actual.png` · `compare.png` · `run-times.log` |
| 4 รัน 51 TC | `test-report/RESULT.md` · `test-report/results.json` · `test-report/gifs/` |
| 5 BUG-HUNT B01–B12 | `test-report/BUG-HUNT.md` · `test-report/bug-runs/` (รอบ 1) · `test-report/bug-runs-2/` (รอบ 2) · `test-report/bughunt.sh` · `test-report/compare-sweeps.js` |
| สรุปหน้าเดียว | `test-report/index.html` (เปิดในเบราว์เซอร์ได้เลย ตารางผล + GIF) สร้างด้วย `node test-report/make-index.js` |

## ผลสั้น ๆ

- เว็บปกติ: 51/51 (รันซ้ำติดกัน ไม่ restart, และบน Docker Compose)
- BUG_MODE: จับได้ 12/12 · ชุดรวมเท่ากับ union · มีผลข้างเคียงนอกรายการ 1 ข้อ (B03 → TC-NOTI-02) บันทึกไว้
- ข้อสมมติ/ข้อที่ยังเปิดของเว็บ: `app/QUESTIONS.md`

## ข้อสังเกตและข้อจำกัด (อ่านก่อนใช้ผล)

1. **บั๊กที่ล้มเกินรายการ (B03 → TC-NOTI-02):** เปิด B03 แล้ว TC-NOTI-02 ล้มด้วย ซึ่ง BUGS.md ข้อ 2 ไม่ได้ระบุ สาเหตุคือกำหนดเสร็จของคำขอ `…000016` เลื่อน (B03 ทำให้ตารางวันหยุดว่าง → ระดับ `near` หาย) จัดเป็นผลข้างเคียงของบั๊กที่ตั้งใจใส่ ไม่ใช่ test ผิด ไม่ได้แก้ assert รายละเอียด: `test-report/BUG-HUNT.md` ข้อ A
2. **B08:** เดิมล้มด้วย "หา element ไม่เจอ" ซึ่ง BUGS.md ข้อ 4 ไม่ยอมรับ จึงสลับลำดับ assert ให้ตรวจ Audit CLAIM ก่อน (ค่าที่คาดหวังเท่าเดิม) ตอนนี้ล้มด้วย `expected 1 but received 2` · มีรอบรันซ้ำรอบหนึ่งที่ล้ม 24 ข้อ สงสัยว่ารอบเก่าที่หยุดไว้ค้างแย่งพอร์ต แต่ **ยังพิสูจน์ไม่ได้** ผลที่ใช้เป็นหลักฐานคือรอบเดี่ยวถัดมา · รายละเอียด: `BUG-HUNT.md` ข้อ B
3. **เวลา "จริง":** มาจาก subagent ของ Claude Code ในเครื่องเดียว บันทึกมือใน `run-times.log` ไม่ใช่ agent-team (`dagplan.py run`) ที่ login หลายบัญชี จึงไม่มี token ledger · ตัวเลข B13 (85.1 นาที) รวมเวลาแก้เทสต์ รอ BUG_MODE 15 รอบ และการจำแนกผล ไม่ใช่เวลางานล้วน · รายละเอียด: `REPORT.md`
