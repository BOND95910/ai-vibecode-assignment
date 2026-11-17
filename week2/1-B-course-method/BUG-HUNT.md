# BUG-HUNT · พิสูจน์ว่าชุด Playwright จับบั๊กตาม BUGS.md ได้

> เว็บ: `/workspace/out/week2/egov-eservice/app` · `TEST_MODE=1 BUG_MODE=<Bxx> docker compose up -d --force-recreate` ทีละตัว (อิมเมจ `egov-eservice:local` build ใหม่ก่อนเริ่ม รวมการแก้ `noti-item` จากรอบทดสอบก่อน)
> ชุดทดสอบ: `app/tests` · Playwright 1.65.1 Chromium · 51 TC · workers 1 · เว็บที่ไม่ตั้ง TEST_MODE ที่ :3001 ให้ TC-NFR-03
> คำสั่ง: `cd app/tests && ./run-bug-matrix.sh B01 B02 … B12` · ผลแต่ละรอบ `app/tests/runs/<Bxx>/` (`list.txt` `results.json` `server-banner.txt` `web.log` `artifacts/`) · สรุปบรรทัดละรอบ `app/tests/runs/summary.tsv`
> ทุกรอบตรวจบรรทัดเริ่มเว็บแล้วว่า `BUG_MODE=<Bxx>` ตรง (เช่น `[egov] listening on :3000 · TEST_MODE=1 · BUG_MODE=B03`) · รันเมื่อ 2026-11-16 13:44–14:07 น.

## ตรวจก่อนรัน: เว็บฝังบั๊กตรงจุดตาม BUGS.md (ตรรกะฝั่งเซิร์ฟเวอร์ · กติกาข้อ 4)

| บั๊ก | จุดในโค้ด | ตรงกับ "เปิดแล้วผิดอย่างไร" |
|---|---|---|
| B01 | `src/modules/citizen.js:280` `a > 101` แทน `a >= 101` | ✅ |
| B02 | `src/modules/citizen.js:214` `size < 5 MB` แทน `≤` | ✅ |
| B03 | `src/sla.js:124` วันหยุดในตารางนับเป็นวันทำการ (ข้ามแค่ ส.–อา.) | ✅ |
| B04 | `src/sla.js:221` ส่งแก้แล้วคืน `dueAt` เดิม (ไม่หยุดนับ) | ✅ |
| B05 | `src/modules/citizen.js:324` อายุ QR `≤ 15:00` แทน `<` | ✅ |
| B06 | `src/modules/citizen.js:467` ข้ามการตรวจเจ้าของ (ใช้ทั้ง API และหน้า `/citizen/cases/:no`) | ✅ |
| B07 | `src/modules/workflow.js:626` `checkDecision(…, { bugB07 })` API approve ไม่เช็กสิทธิ์ SV-02 | ✅ |
| B08 | `src/modules/workflow.js:523` ข้าม `ALREADY_CLAIMED` | ✅ |
| B09 | `src/modules/workflow.js:885` `GET /api/officer/queue` เติม `idNo` เต็ม (หน้าจอยังปิดบัง) | ✅ |
| B10 | `src/modules/dashboard.js:242` ตัวหาร = รับเรื่อง | ✅ |
| B11 | `src/modules/auth.js:386` unmask ไม่เขียน Audit | ✅ |
| B12 | `src/modules/workflow.js:238` `:545` ปุ่ม + API ตีกลับครั้งที่ 3 ได้ | ✅ |

## 4. ตารางบันทึกผล (รูปแบบ BUGS.md §4)

| บั๊ก | TC ที่คาดว่าล้ม (จากตาราง 2) | TC ที่ล้มจริง | TC ล้มเกินที่คาด | TC ที่ควรล้มแต่ผ่าน | ผล |
|---|---|---|---|---|---|
| (ปกติ) | – | – | – | – | 51/51 passed (`final-1` `final-2` และ `after-bughunt` หลังปิดบั๊ก) |
| B01 | TC-FEE-01 | TC-FEE-01 | – | – | 50 passed · 1 failed ✅ |
| B02 | TC-UPLOAD-01 | TC-UPLOAD-01 | – | – | 50 passed · 1 failed ✅ |
| B03 | TC-SLA-01 · TC-SLA-02 (อาจล้มด้วย TC-SLA-03 · TC-RBAC-04) | TC-SLA-01 · TC-SLA-02 · TC-SLA-03 · TC-RBAC-04 · TC-NOTI-02 | TC-NOTI-02 (นอกรายการ "อาจล้มด้วย" ดู triage) | – | 46 passed · 5 failed ✅ จับได้ |
| B04 | TC-SLA-02 | TC-SLA-02 | – | – | 50 passed · 1 failed ✅ |
| B05 | TC-PAY-01 | TC-PAY-01 | – | – | 50 passed · 1 failed ✅ |
| B06 | TC-RBAC-01 | TC-RBAC-01 | – | – | 50 passed · 1 failed ✅ |
| B07 | TC-RBAC-02 | TC-RBAC-02 | – | – | 50 passed · 1 failed ✅ |
| B08 | TC-QUEUE-02 (ส่วน 3 ต่อกัน ล้มแน่นอน) | TC-QUEUE-02 | – | – | 50 passed · 1 failed ✅ |
| B09 | TC-PDPA-02 | TC-PDPA-02 | – | – | 50 passed · 1 failed ✅ |
| B10 | TC-DASH-02 (อาจล้มด้วย TC-DASH-01 · TC-DASH-03) | TC-DASH-01 · TC-DASH-02 · TC-DASH-03 | – (อยู่ในรายการ "อาจล้มด้วย") | – | 48 passed · 3 failed ✅ |
| B11 | TC-PDPA-03 · TC-AUDIT-01 | TC-PDPA-03 · TC-AUDIT-01 | – | – | 49 passed · 2 failed ✅ |
| B12 | TC-WORKFLOW-04 | TC-WORKFLOW-04 | – | – | 50 passed · 1 failed ✅ |

**จับได้ 12/12** · ไม่มี TC ที่ควรล้มแต่ผ่าน → ไม่ต้องแก้เว็บหรือ test

## 6. ข้อความที่ล้ม (BUGS.md §3 ขั้น 4: ต้องบอกค่าจริงต่างจากค่าคาดหวัง)

| บั๊ก | ผลรัน | สรุป |
|---|---|---|
| B01 | TC-FEE-01 `SV-03 101` `fee-total` expected `฿1,010` received `฿1,000` | ✅ จับได้ตรงจุด |
| B02 | TC-UPLOAD-01 `size-5242880.pdf` expected 201 received 400 `FILE_TOO_LARGE` `ไฟล์ใหญ่เกิน 5 MB` | ✅ |
| B03 | TC-SLA-01 แถว c `dueAt` expected `2026-12-08T16:30:00+07:00` received `2026-12-07T16:30:00+07:00` · TC-SLA-02 expected `12-08` received `12-07` · TC-SLA-03 `sla-level` expected `ใกล้ครบกำหนด` received `ปกติ` · TC-RBAC-04 `dueAt` expected `12-08` received `12-04` (วันหยุด 2 ธ.ค. ที่เพิ่มไม่ถูกนับ) · TC-NOTI-02 ส่วน B `off.reg2 @5 ธ.ค.` ขาด `EG-2569-000016\|near` | ✅ จับได้ · ผลข้างเคียงดู triage |
| B04 | TC-SLA-02 `dueAt` expected `2026-12-08T16:30:00+07:00` received `2026-12-04T16:30:00+07:00` | ✅ ตรงตัวอย่างใน BUGS.md |
| B05 | TC-PAY-01 ชำระที่ 09:10:00 expected 410 received 200 `PAID` `EG-2569-000031` | ✅ ตรงตัวอย่างใน BUGS.md |
| B06 | TC-RBAC-01 สมหญิงเปิด `/citizen/cases/EG-2569-000005` expected 404 received 200 | ✅ |
| B07 | TC-RBAC-02 `POST /api/cases/EG-2569-000014/approve` expected 403 received 200 `APPROVED` | ✅ ยิง API ตรง ไม่ผ่านหลอกแบบตัวอย่าง B07 ใน BUGS §6 |
| B08 | TC-QUEUE-02 claim พร้อมกัน `off.reg1 → 200 · off.reg2 → 200` expected `[200, 409]` | ✅ (ล้มตั้งแต่ส่วน 1 พร้อมกัน จึงไม่ถึงส่วน 3 ต่อกัน · B08 ข้ามการตรวจผู้ถือจึงล้มแน่นอนไม่พึ่ง race) |
| B09 | TC-PDPA-02 `GET /api/officer/queue?filter=all` พบสตริงเลขบัตร 13 หลัก expected `[]` received 19 รายการ | ✅ |
| B10 | TC-DASH-01 `kpi-ontime-pct` expected `–` received `0.0%` · TC-DASH-02 พ.ย. expected `85.7%` received `23.1%` · TC-DASH-03 expected `85.7%` received `23.1%` | ✅ ตรงตัวอย่างใน BUGS.md |
| B11 | TC-PDPA-03 UNMASK `audit-count` expected `1` received `0` · TC-AUDIT-01 `audit-count` expected `16` received `15` | ✅ |
| B12 | TC-WORKFLOW-04 `return-btn` expected 0 received 1 (…000023 ตีกลับครบ 2 ครั้งแล้ว) | ✅ |

ไม่มีตัวไหนล้มเพราะหา element ไม่เจอหรือ timeout ล้วน ๆ (บรรทัด `Timeout: 10000ms` ในข้อความ = ช่วงรอของ assert ที่แสดงค่าที่ได้จริงแล้ว)

## 5. Triage ผลที่ไม่ตรงที่คาด

| อาการ | ตรวจแล้วพบ | สรุป / ทำอะไร |
|---|---|---|
| B03 → **TC-NOTI-02 ล้มเกิน** (ไม่อยู่ในคอลัมน์ "อาจล้มด้วย" ของ BUGS.md) | ส่วน B ของ TC-NOTI-02 ที่ ส. 5 ธ.ค. 10:00: seed `…000016` มีกำหนด 8 ธ.ค. 16:30 (TEST-DATA บรรทัด 79 · ไม่เปลี่ยนเมื่อเปิดบั๊ก ตามกติกาข้อ 2) ต้องได้ "ใกล้ครบกำหนด (เหลือ 1: อ.8 ธ.ค.)" (TEST-DATA บรรทัด 236 · 241) · เมื่อเปิด B03 ฟังก์ชันวันทำการนับ จ.7 ธ.ค. (วันหยุด) เป็นวันทำการ → วันคงเหลือ = 2 → ระดับ `ปกติ` → ไม่เกิดแจ้งเตือน `near` ของ off.reg2 · เป็นกลไกเดียวกับ TC-SLA-03 ส่วน B ที่ BUGS.md ระบุไว้แล้ว และ **DECISIONS §18 แถว "B03 กระทบอะไร"**: "ฟังก์ชันวันทำการตัวเดียวใช้ทั้งกำหนดเสร็จและวันคงเหลือ → TC ที่ใช้วันคงเหลือข้ามวันหยุดล้มด้วยได้" (§18 ใช้แทนถ้าขัด) | **ไม่ใช่บั๊กรั่ว / ไม่ใช่ test พึ่งกัน** (TC-NOTI-02 RESET เองทุกส่วน · seed `dueAt` ไม่เปลี่ยน) → ไม่แก้เว็บ/test · **แผนไม่ครบ:** คอลัมน์ "อาจล้มด้วย" ของ B03 ใน BUGS.md ควรมี TC-NOTI-02 → ส่งเป็นคำถามถึง TA |
| B10 → TC-DASH-01 · TC-DASH-03 ล้มด้วย | อยู่ในคอลัมน์ "อาจล้มด้วย" (ใช้สูตรเดียวกัน) | ✅ ยอมรับ |
| B03 → TC-SLA-03 · TC-RBAC-04 ล้มด้วย | อยู่ในคอลัมน์ "อาจล้มด้วย" | ✅ ยอมรับ |
| TC ที่ควรล้มแต่ผ่าน | ไม่มี | – |

## คำถามถึง TA

1. BUGS.md §2 แถว B03 คอลัมน์ "TC ที่อาจล้มด้วย" ระบุ TC-SLA-03 · TC-RBAC-04 แต่ TC-NOTI-02 ส่วน B (`…000016` near ที่ 5 ธ.ค.) ล้มด้วยกลไกเดียวกับ TC-SLA-03 ตาม DECISIONS §18 — ขอเพิ่ม TC-NOTI-02 ในคอลัมน์นั้น (และในตาราง §4 แถว B03) ได้หรือไม่

## ขั้นที่ไม่ได้รันในรอบนี้

- BUGS.md §3 ขั้น 5 (รวม `B03,B07` และ `B01,B05,B09`) ไม่อยู่ในคำสั่งรอบนี้ · รอบ B13 เดิมเคยรันไว้ (`app/TEST-RESULT.md`) ก่อนการแก้ `noti-item`
- ขั้น 6 (ปิดบั๊กทั้งหมดอีกครั้ง): รันแล้ว `after-bughunt` = 51/51 · เว็บที่ :3000 ตอนนี้เปิดด้วย `TEST_MODE=1` ไม่ตั้ง BUG_MODE
