# RESULT · LAB 4 · รัน 51 TC ด้วย Playwright

เว็บถูกต้อง (ไม่ตั้ง BUG_MODE) · `TEST_MODE=1` · รอบสะอาดล่าสุด: **51/51 passed** (2.5 นาที, workers 1)

รันซ้ำติดกันโดยไม่ restart เว็บ: `../test-run-2.log` 51/51 · `../test-run-3.log` 51/51 · รอบ BUG_MODE ว่างท้าย sweep 51/51 · รอบอัดวิดีโอ 51/51 (`results.json` = รอบนี้)

## รอบแรก (ก่อนแก้) และการจำแนก

`../test-run-1.log`: 48 passed · 3 failed

| TC | ที่ล้ม | จัดว่า | หลักฐาน | การแก้ |
|---|---|---|---|---|
| TC-NFR-01 | `375px to-payment-btn ต้องกดได้` (Expected enabled, Received disabled) | **test ผิด** (race: แนบไฟล์ก่อนเข้าขั้น 2) | สคริปต์จำลอง: ถ้าไม่รอขั้น 2 จะไม่มี POST /files (ตามที่พิสูจน์ในรอบก่อน) | เพิ่ม `await text(wizard-step, 2/3 แนบเอกสาร)` ก่อนแนบ |
| TC-UPLOAD-01 | `setInputFiles: payloads[1].mimeType: expected string, got number` | **test ผิด** (`.map(testFile)` ส่ง index เป็นอาร์กิวเมนต์ที่ 2) | ข้อความ error ใน test-run-1.log บรรทัด 129 | `.map((name) => testFile(name))` |
| TC-SUBMIT-01 | `row-owner ต้องว่าง: expected "" but received "ยังไม่มีผู้รับ"` | **web ผิด** | การ์ด TEST-PLAN ระบุว่าคอลัมน์ว่าง | `public/staff/queue.js` แสดงค่าว่าง |

ไม่มีการแก้ผลที่คาดหวังให้ตรงหน้าจอ · ไม่พบกรณี plan ผิด

## ผลรายข้อ (รอบสะอาดล่าสุด)

| TC | ชื่อ | ผล | ms | GIF |
|---|---|---|---|---|
| TC-AUDIT-01 | เหตุการณ์และฟิลด์ใน Audit | ✅ | 2012 | [gif](gifs/TC-AUDIT-01.gif) |
| TC-AUDIT-02 | Audit แก้/ลบไม่ได้ (405) | ✅ | 622 |  |
| TC-AUDIT-03 | กรองช่วงวันที่ตามเวลาไทย | ✅ | 1322 |  |
| TC-AUTH-01 | เลขบัตร 13 หลัก + checksum | ✅ | 2483 |  |
| TC-AUTH-02 | OTP ผิด 3 ครั้งล็อก 15 นาที | ✅ | 1779 |  |
| TC-AUTH-03 | ลงทะเบียนครั้งแรก | ✅ | 3540 |  |
| TC-AUTH-04 | เจ้าหน้าที่ SSO จำลองและหน้าตั้งต้นตามบทบาท | ✅ | 4496 |  |
| TC-DASH-01 | Dashboard ตัวเลขเริ่มต้น | ✅ | 686 |  |
| TC-DASH-02 | Dashboard ย้อนหลัง พ.ย. ต.ค. รายปี | ✅ | 1446 | [gif](gifs/TC-DASH-02.gif) |
| TC-DASH-03 | ส่งออก Excel/PDF เท่าหน้าจอ และไม่มีข้อมูลส่วนบุคคล | ✅ | 10192 |  |
| TC-DASH-04 | ค่าขอบ "ทันกำหนด" 16:29:59 / 16:30:00 / 16:30:01 | ✅ | 3121 |  |
| TC-DOC-01 | ออกเอกสารและข้อมูลใน PDF | ✅ | 2504 |  |
| TC-DOC-02 | ตรวจเอกสาร /verify | ✅ | 1223 |  |
| TC-DOC-03 | เอกสารหมดอายุและลายเซ็นไม่ตรง | ✅ | 3161 |  |
| TC-FEE-01 | ค่าธรรมเนียม SV-01/SV-02/SV-03 | ✅ | 1242 | [gif](gifs/TC-FEE-01.gif) |
| TC-NFR-01 | Responsive 375/768/1280 | ✅ | 8161 |  |
| TC-NFR-02 | WCAG: axe + คีย์บอร์ด + label + สถานะไม่ใช้สีอย่างเดียว | ✅ | 12308 |  |
| TC-NFR-03 | Health เวลาโหลด และผลซ้ำได้ | ✅ | 2742 |  |
| TC-NFR-04 | เข้ารหัสข้อมูลส่วนบุคคลที่เก็บ (inspection) | ✅ | 460 |  |
| TC-NOTI-01 | ผู้รับแจ้งเตือนตามระดับ | ✅ | 2560 |  |
| TC-NOTI-02 | ไม่แจ้งซ้ำ ข้ามระดับ และขั้นรออนุมัติ/รอออกเอกสาร | ✅ | 4039 |  |
| TC-PAY-01 | อายุ QR 15:00 | ✅ | 833 | [gif](gifs/TC-PAY-01.gif) |
| TC-PAY-02 | ยอดเงินและ callback ซ้ำ | ✅ | 447 |  |
| TC-PAY-03 | ชำระพร้อมกัน เลขไม่ซ้ำ | ✅ | 739 |  |
| TC-PAY-04 | เลขคำขอข้ามปี 2569 → 2570 | ✅ | 1332 |  |
| TC-PDPA-01 | ปิดบังเลขบัตรบนจอ | ✅ | 2000 |  |
| TC-PDPA-02 | API (JSON) ไม่ส่งเลขบัตรเต็ม | ✅ | 333 |  |
| TC-PDPA-03 | แสดงเลขเต็มต้องมีเหตุผลและ Audit | ✅ | 1532 | [gif](gifs/TC-PDPA-03.gif) |
| TC-QUEUE-01 | ลำดับคิวและขอบเขตแผนก | ✅ | 1579 |  |
| TC-QUEUE-02 | รับเรื่องซ้อน (พร้อมกันและต่อกัน) | ✅ | 1967 | [gif](gifs/TC-QUEUE-02.gif) |
| TC-QUEUE-03 | งานในมือสูงสุด 10 | ✅ | 3580 |  |
| TC-RBAC-01 | ประชาชนเปิดคำขอคนอื่นไม่ได้ (IDOR) | ✅ | 855 | [gif](gifs/TC-RBAC-01.gif) |
| TC-RBAC-02 | เจ้าหน้าที่อนุมัติ SV-02 ไม่ได้ (API) | ✅ | 1395 | [gif](gifs/TC-RBAC-02.gif) |
| TC-RBAC-03 | ตารางสิทธิ์หน้า/API ตามบทบาท | ✅ | 9696 |  |
| TC-RBAC-04 | ผู้ดูแลระบบ: บริการ วันหยุด ผู้ใช้ และยอดที่ล็อก | ✅ | 2377 |  |
| TC-RBAC-05 | สิทธิ์เปิด/ดาวน์โหลดไฟล์แนบ | ✅ | 1785 |  |
| TC-RBAC-06 | ผู้ดูแลระบบ: ช่วงค่าที่ยอมรับ | ✅ | 2623 |  |
| TC-SLA-01 | กำหนดเสร็จตามตารางวันที่ | ✅ | 5297 | [gif](gifs/TC-SLA-01.gif) |
| TC-SLA-02 | หยุดนับ SLA ระหว่างรอแก้ไข | ✅ | 4094 | [gif](gifs/TC-SLA-02.gif) |
| TC-SLA-03 | ระดับเตือน ปกติ/ใกล้/เกิน | ✅ | 4513 |  |
| TC-SUBMIT-01 | ยื่นคำขอ SV-01 ครบวงจร | ✅ | 1337 |  |
| TC-SUBMIT-02 | เอกสารบังคับครบก่อนชำระ | ✅ | 1074 |  |
| TC-SUBMIT-03 | ร่าง การลบร่าง และการยกเลิก | ✅ | 4861 |  |
| TC-UPLOAD-01 | ขนาดและจำนวนไฟล์ | ✅ | 3514 | [gif](gifs/TC-UPLOAD-01.gif) |
| TC-UPLOAD-02 | ชนิดไฟล์จากเนื้อไฟล์ | ✅ | 1287 |  |
| TC-WORKFLOW-01 | SV-01 อนุมัติ + ออกเอกสาร | ✅ | 913 |  |
| TC-WORKFLOW-02 | SV-02 ผ่านหัวหน้า | ✅ | 3470 |  |
| TC-WORKFLOW-03 | SV-03 สามขั้นตอน | ✅ | 3235 |  |
| TC-WORKFLOW-04 | ตีกลับสูงสุด 2 ครั้ง และผลหลังครบ | ✅ | 3494 | [gif](gifs/TC-WORKFLOW-04.gif) |
| TC-WORKFLOW-05 | เหตุผล ≥ 10 ตัวอักษร (ตีกลับ/ไม่อนุมัติ) | ✅ | 4233 |  |
| TC-WORKFLOW-06 | เวลาแก้ไข 168 ชั่วโมง | ✅ | 2363 |  |

## GIF

มี GIF ของ TC ที่จับบั๊กใน `gifs/` (TC-FEE-01, UPLOAD-01, SLA-01/02, PAY-01, RBAC-01/02, QUEUE-02, PDPA-03, AUDIT-01, DASH-02, WORKFLOW-04) · **ไม่มี GIF ของ TC-PDPA-02** เพราะเป็นการตรวจ API ล้วน ไม่เปิดหน้าเว็บ · GIF ได้จากวิดีโอ Playwright (`VIDEO=1`) แปลงด้วย ffmpeg ไม่ได้ใช้ Claude in Chrome บันทึกหน้าจอ · TC ที่ไม่ได้ทำ GIF ยังมีผลใน `results.json`

## รันบน Docker Compose (คำสั่งเดียว)

```text
cd week2/egov-eservice/app
PORT=3222 BASE_URL=http://localhost:3222 docker compose up --build -d     # ค่าเริ่มต้นคือพอร์ต 3000
cd tests && BASE_URL=http://localhost:3222 npx playwright test
```

- ผล: คอนเทนเนอร์ `healthy` · **51/51 passed (1.9 นาที)** กับเว็บใน container
- รอบแรกบน container ได้ 50/51: TC-DOC-01 ล้ม `doc-qr data-url: expected http://localhost:3222/verify/… received http://localhost:3000/verify/…` สาเหตุ (PROVEN จากข้อความ): ผมเปิดพอร์ต 3222 แต่ไม่ได้ตั้ง `BASE_URL` ของเว็บให้ตรง (ค่าเริ่มต้นใน compose คือ 3000) ลิงก์ QR จึงชี้ผิดพอร์ต → **ไม่ใช่บั๊กเว็บ/ไม่ใช่ test ผิด เป็นการตั้งค่าตอนรันของผมเอง** รันใหม่โดยตั้ง `BASE_URL` ให้ตรงแล้วผ่าน
- ที่เครื่องนี้พอร์ต 3000 มีโปรแกรมอื่นใช้อยู่ จึงใช้ 3222 (compose) และ 3111 (รัน node ตรงตอน sweep) · ไม่ได้ทดสอบ `docker compose up` ที่พอร์ต 3000 จริงบนเครื่องนี้
