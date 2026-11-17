# แผนงานแบบ DAG (README §2 ขั้น 1)

> `dag-planner` / `agent-team` ของรายวิชาไม่มีในเครื่องนี้ จึงแตกงานเองตามลำดับเดียวกัน · กราฟนี้คือการแบ่งงานที่ใช้จริง (ทำเสร็จตามลำดับนี้)

```mermaid
graph TD
  R[อ่าน brief: USER-STORIES · REQUIREMENTS · CONTRACT · TEST-DATA · TEST-PLAN · BUGS] --> CORE
  CORE["T1 app/core.js<br/>นาฬิกา · วันทำการ/SLA · ค่าธรรมเนียม · ตรวจไฟล์ · เข้ารหัส · seed · จุดบั๊ก"] --> DOM
  DOM["T2 app/domain.js<br/>สิทธิ์ · คิว · แจ้งเตือน · Dashboard · Audit · ร่าง/ชำระ"] --> API
  DOM --> PAGES
  API["T3 app/server.js<br/>API ตาม CONTRACT §6 + test hook §8"] --> SMOKE
  PAGES["T4 app/pages.js + static/app.js + app.css<br/>หน้า + data-testid ตาม CONTRACT §2"] --> SMOKE
  SMOKE[T5 smoke: reset · คิว 17 แถว · แจ้งเตือน 3 รายการ] --> TH
  TH["T6 tests/helpers.js · global-setup.js · playwright.config.js<br/>RESET · CLOCK · LOGIN · NEW_PAID · ไฟล์ทดสอบ"] --> S1 & S2 & S3 & S4 & S5 & S6 & S7
  S1[T7a auth.spec 4 TC] --> FULL
  S2[T7b submit.spec 10 TC] --> FULL
  S3[T7c queue-sla-noti.spec 8 TC] --> FULL
  S4[T7d workflow-doc.spec 12 TC] --> FULL
  S5[T7e dash-audit.spec 7 TC] --> FULL
  S6[T7f rbac.spec 6 TC] --> FULL
  S7[T7g nfr.spec 4 TC] --> FULL
  FULL[T8 ชุดเต็ม 51/51 ×2] --> BUG
  BUG["T9 scripts/run-bugs.js<br/>B01–B12 + รวม 2 ชุด"] --> TRI
  API --> DOCK
  PAGES --> DOCK
  DOCK["T10 Dockerfile · Dockerfile.tests · docker-compose.yml"] --> DBUG[T11 เมทริกซ์ผ่าน compose]
  TRI[T12 reports/REPORT.md ตาราง triage] --> REV
  DBUG --> REV[T13 ตรวจทาน scrutinize + simplify → รันเมทริกซ์ซ้ำ]
```

| งาน | ขึ้นกับ | ไฟล์ที่แตะ | ชนกับ (ห้ามทำขนานกัน) |
|---|---|---|---|
| T1 core | อ่าน brief | `app/core.js` | – |
| T2 domain | T1 | `app/domain.js` | – |
| T3 API | T2 | `app/server.js` | T4 ใช้ชื่อ error/รูปแบบ JSON เดียวกัน (ตกลงผ่าน CONTRACT §5–6) |
| T4 หน้าเว็บ | T2 | `app/pages.js` `app/static/*` | T3 (เรียก API) |
| T6 test infra | T3 T4 | `tests/helpers.js` `tests/global-setup.js` `playwright.config.js` | ทุก spec |
| T7a–g spec | T6 | `tests/*.spec.js` (คนละไฟล์) | ขนานกันได้ แต่ **รันได้ทีละ worker** เพราะใช้ state เซิร์ฟเวอร์ร่วม (reset ต้น TC) |
| T9 bug runner | T8 | `scripts/run-bugs.js` | – |
| T10 docker | T3 T4 | `Dockerfile*` `docker-compose.yml` `.dockerignore` | – |

จุดเสี่ยงที่วางไว้ในแผน: (1) บั๊กต้องอยู่ฝั่งเซิร์ฟเวอร์และกระทบเฉพาะจุด → ใส่ใน T1–T3 เท่านั้น ไม่ใส่ใน test · (2) ค่าคาดหวังใน T7 มาจากตาราง TEST-PLAN/TEST-DATA ไม่อ่านจากหน้าจอ · (3) เวลาอ่านจากนาฬิกาทดสอบเท่านั้น (T1)
