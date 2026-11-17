# Triage ความล้มเหลวของ web A และ web C (อ่านอย่างเดียว ไม่ได้รันอะไร)

วิธี: อ่าน log (`results/<SUITE>-on-<WEB>/none.log`), source ของ suite และ source ของเว็บ เทียบกับ CONTRACT / TEST-PLAN / DECISIONS
ระดับหลักฐาน (ตาม evidence ladder): ทุกข้อด้านล่างอยู่ที่ระดับ 2 (ชี้บรรทัด) หรือ 3 (เดินโค้ดตามขั้น) **ไม่มีข้อใดผ่านการรันซ้ำ (ระดับ 4/5)** เพราะห้ามรัน docker/node/playwright ข้อความที่ติดป้าย HYPOTHESIS = ยังไม่ได้พิสูจน์

หมายเหตุสำคัญที่ใช้ร่วมกันหลายข้อ:
- CONTRACT/TEST-PLAN/DECISIONS **ไม่มีข้อความใดกำหนด query string ของ "หน้า" เว็บ** (`/audit?event=`, `/officer/queue?filter=`, `/dashboard?period=`) มีเฉพาะ query ของ API (`CONTRACT.md:390,405,407`) และ `?draft=` ของหน้า wizard (`CONTRACT.md:31`) (ตรวจด้วย Grep `\?(period|filter|event|actor|from)=` ใน `week2_student/*.md` พบแค่บรรทัด API และตัวอย่าง `?draft=`)
- CONTRACT/TEST-PLAN **ไม่กำหนดว่าเว็บต้อง render ฝั่งเซิร์ฟเวอร์หรือฝั่ง client** และไม่กำหนดว่าการกระทำ (claim/resubmit/filter) ต้อง reload หน้าหรือไม่

---

## Web A (`C:\src\ai-vibecode-assignment\week2\egov-eservice\app`)

สถาปัตยกรรม web A (ตรวจจาก source): หน้า staff เป็น shell + สคริปต์ `defer` ที่ `fetch` API แล้ว render หลัง `load`
(`public/staff/audit.js:40-56`, `queue.js:59-66`, `dashboard.js:40-59`, `notifications.js:5-13`, `admin-holidays.js:32`)
และ **ไม่อ่าน `location.search` เลย** (Grep `location.search|URLSearchParams` ใน `public/` ไม่พบ; `server/pages/staff.js` ไม่อ่าน `req.query`; `server/pages/citizen.js:167` อ่านเฉพาะ `?draft=` ซึ่ง spec กำหนด)

| TC | suite ที่ล้ม | verdict | หลักฐาน |
|---|---|---|---|
| TC-DASH-01 | C | SUITE-OVER-STRICT (พึ่ง render ฝั่ง server / ไม่รอ fetch) | log C-on-A: `kpis` ได้ทุกค่าเป็น `""` ที่ `dash-audit.spec.js:22` เพราะ `kpis()` ใช้ `innerText()` ทันทีหลัง `goto` (`dash-audit.spec.js:8`) ไม่มี auto-wait · web A เติมค่า KPI หลัง `EG.api('GET','/api/dashboard')` (`dashboard.js:43-51`) · spec ไม่ระบุ SSR · ข้อ `kpi-*` ใน `CONTRACT.md:212-216` กำหนดแค่ค่า · suite A และ B ผ่านบน web A · (กลไก race = HYPOTHESIS ที่หนักแน่น ยังไม่ได้รันซ้ำ) |
| TC-DASH-02 | C | SUITE-OVER-STRICT (พึ่ง URL query) | `dash-audit.spec.js:11` `page.waitForURL(u => u.searchParams.get('period') === period)` · web A เปลี่ยนตัวกรองด้วย `onchange → load()` ไม่แตะ URL (`dashboard.js:38-39`) จึง timeout 180 s · CONTRACT `period-select`/`service-select` (`CONTRACT.md:210-211`) ไม่พูดถึง URL |
| TC-DASH-03 | C | SUITE-OVER-STRICT (พึ่ง URL query) | เหมือน DASH-02: ล้มที่ `pick()` `dash-audit.spec.js:11` ผ่านการเรียกที่ `:66` |
| TC-AUDIT-01 | C | SUITE-OVER-STRICT (ไม่รอ fetch) | log: `counts` เป็น `{}` และ STAFF_LOGIN เป็น `[]` ที่ `dash-audit.spec.js:143,147` เพราะ `getByTestId('audit-row').evaluateAll(...)` (`:137`) รันทันทีหลัง `goto('/audit')` ไม่มี auto-wait · web A render แถวหลัง `EG.api('GET','/api/audit')` (`audit.js:44-53`) · HYPOTHESIS ที่หนักแน่น (ยังไม่ได้รันซ้ำ) |
| TC-AUDIT-03 | C | SUITE-OVER-STRICT (พึ่ง URL query) | `dash-audit.spec.js:227` `await p.waitForURL(/from=/)` หลังกด `audit-apply-btn` · web A `onsubmit → load()` ไม่เปลี่ยน URL (`audit.js:17,23-27`) · API ตัวกรองตรวจที่ `:219-221` ไม่ใช่จุดที่ล้ม |
| TC-QUEUE-01 | C | SUITE-OVER-STRICT (พึ่ง URL query) | log: `Expected: 9 Received: 17` ที่ `queue-sla-noti.spec.js:29` จาก `reg2.goto('/officer/queue?filter=mine')` · web A ตั้ง `filter='all'` ตายตัว ไม่อ่าน URL (`queue.js:5,11`) จึงได้คิวทั้งหมด 17 · TEST-PLAN `:369` เขียนว่า "`off.reg2` filter `mine`" และ `:362,368` ใช้ `queue-filter` (select) ไม่ใช่ URL · suite C เองใช้ `selectOption('mine')` ที่ `:22` กับ reg1 แต่ใช้ URL กับ reg2 |
| TC-RBAC-02 | C | SUITE-OVER-STRICT (พึ่ง URL query) | log: `audit-count` Expected `"1"` Received `"5"` ที่ `rbac.spec.js:47` จาก `au.goto('/audit?event=APPROVE')` · web A ไม่ใช้ query นี้ จึงแสดงทุกเหตุการณ์ (5 แถว) · ส่วน API ของ test (403/200) ผ่านก่อนถึงบรรทัดนี้ |
| TC-RBAC-04 | C | SUITE-OVER-STRICT (ไม่รอ fetch; และจะล้มต่อที่ URL query) | log: `holiday-row` ได้ `[]` ที่ `rbac.spec.js:112` (`evaluateAll` ทันทีหลัง `goto('/admin/holidays')`) · web A render หลัง `EG.api('GET','/api/admin/holidays')` (`admin-holidays.js:32`) · ต่อไปที่ `rbac.spec.js:160,172` ใช้ `/audit?event=ADMIN_CHANGE` ซึ่ง web A จะเพิกเฉยเช่นกัน (HYPOTHESIS: ยังไปไม่ถึงบรรทัดนั้นใน log) |
| TC-WORKFLOW-04 | C | SUITE-OVER-STRICT (พึ่ง URL query) | log: strict mode violation resolved to 3 elements ที่ `workflow-doc.spec.js:208` จาก `au.goto('/audit?event=FORWARD')` · web A ไม่กรองตาม URL จึงได้ทั้ง FORWARD + RETURN ×2 ของ EG-2569-000013 (`xxxxxxxxxx`) · แถวที่ถูก (`ส่งต่อให้หัวหน้าพิจารณา`) มีอยู่แล้วในผลลัพธ์ |
| TC-NFR-02 | C | UNKNOWN | ล้มที่ `nfr.spec.js:98` `keyboard: could not reach qty-input with Tab` (Tab ≤ 40 ครั้ง ที่ `:111`) ส่วน axe/label/status ผ่าน (ไม่มี soft-failure ใน log) · web A: `qty-input` เป็น `<input type=text>` ที่ build แบบ synchronous ใน `new.js:221-232` และมี `<label for>` · suite A และ B ทำ keyboard flow เดียวกันผ่านบน web A · HYPOTHESIS (ยังไม่พิสูจน์): `toHaveURL(/new\/SV-01$/)` (`:110`) ผ่านตั้งแต่ commit ก่อนสคริปต์ `defer` (`server/pages/citizen.js:35-36`) สร้างฟอร์ม แล้ว 40 Tab ถูกใช้หมด · สิ่งที่ขาด: การรันซ้ำพร้อมรอ `qty-input` visible ก่อน Tab |
| TC-NOTI-01 | C | SUITE-OVER-STRICT (ไม่รอ fetch) | log: `reg1 noti-item` ได้ `[]` ที่ `queue-sla-noti.spec.js:294` จาก `evaluateAll` ทันทีหลัง `goto('/notifications')` (`:292-293`) · **ตอบคำถามเรื่อง lazy:** web A ไม่ได้สร้างแจ้งเตือนแบบ lazy แต่ประเมินทุก request ยกเว้น `/api/test/*` (`server/index.js:29-32`, `server/notify.js:68-74`) ซึ่งตรง `CONTRACT.md:17` ข้อ 7 และ `DECISIONS.md:100` · ขั้นตอนใน TEST-PLAN `:498` ให้ login off.reg1 ที่ 09:00 เป็น request แรก ซึ่ง suite C ทำแล้ว (`:288`) · หน้า `/notifications` render หลัง `EG.api('GET','/api/notifications')` (`notifications.js:5-13`) · ตรวจ API (`:295`) ยังไปไม่ถึง จึงไม่มีข้อมูลว่า API ถูก — แต่ suite A (เทียบ `data-case-no`/`data-level`) ผ่านบน web A · สรุป: ไม่ใช่ web A แจ้งเตือนว่าง (HYPOTHESIS ที่หนักแน่น, ยังไม่ได้รันซ้ำ) |
| TC-NOTI-02 | C | SUITE-OVER-STRICT (ไม่รอ fetch) | เหมือน NOTI-01 (ใช้ `noti01()` ร่วมกัน `queue-sla-noti.spec.js:312`) |
| TC-NOTI-01 | B | SPEC-AMBIGUOUS (เอนไปทาง suite เข้มเกิน) | log B-on-A: Expected `"คำขอ EG-2569-000024 ใกล้ครบกำหนด"` Received `"…ใกล้ครบกำหนด1 ธ.ค. 2569 09:00"` ที่ `part1.spec.ts:144` (`toHaveText` เต็ม item) · web A วาง `<a>` ข้อความ + `ST.timeEl(createdAt)` ใน `<li noti-item>` (`notifications.js:9-11`) · spec: `CONTRACT.md:257` "`noti-item` | รายการ | … ข้อความ `คำขอ EG-2569-000024 ใกล้ครบกำหนด` …" และ `TEST-PLAN.md:507` "ข้อความรายการ `คำขอ …`" · ไม่ได้ห้ามมีส่วนอื่น (API มี `createdAt` ที่ `CONTRACT.md:398`) · อ่านแบบ 1 (เนื้อหา item ต้องเท่ากับข้อความ): suite B และ web B (`B-course/out/app/src/views/staff.js:836-838` คอมเมนต์ "พอดี" ย้ายเวลาออกนอก item) · อ่านแบบ 2 (item มีข้อความนี้): suite C (`toContainText` `queue-sla-noti.spec.js:298-299`), suite A (ตรวจเฉพาะ `data-*` `noti.spec.js:29`), web A, web C |
| TC-NOTI-02 | B | SPEC-AMBIGUOUS (เอนไปทาง suite เข้มเกิน) | เหมือน NOTI-01 (B) ล้มที่ `notiFlow01` `part1.spec.ts:1509→144` |

### สรุป web A (นับต่อ TC×suite = 14 เซลล์)
- WEB-DEVIATES: **0**
- SUITE-OVER-STRICT: **11** (DASH-01/02/03, AUDIT-01/03, QUEUE-01, RBAC-02, RBAC-04, WORKFLOW-04, NOTI-01/02 ของ suite C)
- SPEC-AMBIGUOUS: **2** (NOTI-01/02 ของ suite B)
- UNKNOWN: **1** (NFR-02 ของ suite C)
- SUITE-WRONG: 0

รูปแบบร่วมของ suite C บน web A: (1) พึ่ง URL query ของหน้า 6 เคส (DASH-02/03, AUDIT-03, QUEUE-01, RBAC-02, WORKFLOW-04, + RBAC-04 ช่วงหลัง) (2) อ่าน DOM ด้วย `innerText`/`evaluateAll` ทันทีหลัง `goto` ไม่รอ fetch 5 เคส (DASH-01, AUDIT-01, RBAC-04, NOTI-01/02) — ทั้งสองแบบผูกกับสถาปัตยกรรม server-render + form GET ของ web C เอง (ตรวจแล้ว: web C ใช้ `data-autosubmit` form GET, `pages.js:277`, และเว็บ render ฝั่ง server)

---

## Web C (`C:\src\compare\C-usual\app`)

สถาปัตยกรรม web C: render ฝั่ง server (`pages.js`), การกระทำสำเร็จแล้ว `location.reload()` (`static/app.js:41` `reloadWith`; claim ที่ `:247-250`; resubmit ที่ `:237-243`), ตัวกรองคิวเป็น `<select data-autosubmit>` ที่ `el.form.submit()` (`static/app.js:46`, `pages.js:277`), เก็บข้อมูลเป็นไฟล์ JSON (`core.js:11,306-308`)

| TC | suite ที่ล้ม | verdict | หลักฐาน |
|---|---|---|---|
| TC-NOTI-01 | B | SPEC-AMBIGUOUS (เอนไปทาง suite เข้มเกิน) | log B-on-C: Received `"…ใกล้ครบกำหนด 1 ธ.ค. 2569 09:00"` (เวลาอยู่ใน `<li>` นอก `<a>` `pages.js:292`) · spec และการอ่านสองแบบเหมือนกรณี web A ข้างบน · web C ตรงกับ web A (ทั้งคู่ใส่เวลาใน item) มีเพียง web B ที่แยกเวลาออก |
| TC-NOTI-02 | B | SPEC-AMBIGUOUS (เอนไปทาง suite เข้มเกิน) | เหมือน NOTI-01 (`notiFlow01` ใช้ร่วม) |
| TC-QUEUE-01 | B | SUITE-OVER-STRICT (race กับ navigation ของ filter; HYPOTHESIS ที่หนักแน่น) | log: `locator.evaluateAll: Execution context was destroyed, most likely because of a navigation` ที่ `helpers.ts:545` ผ่าน `queueOrder` (`part1.spec.ts:75`) หลัง `selectOption('unclaimed')` (`:1106-1107`) · web C ส่ง form GET ทันทีเมื่อเปลี่ยน select (`static/app.js:46`) · `CONTRACT.md:190` ระบุแค่ว่า `queue-filter` เป็น select · suite B เขียนให้ SPA (web B) ไม่ reload · ผลลัพธ์คิวจริงของ web C ไม่ได้ถูกประเมิน (ล้มก่อนเทียบ) · suite C และ A ผ่านบน web C |
| TC-QUEUE-03 | B | SUITE-OVER-STRICT (race กับ reload หลัง claim; HYPOTHESIS) | log: `page.goto: net::ERR_ABORTED at /officer/queue` ที่ `helpers.ts:583` (ขั้น 2, `part1.spec.ts:1224-1227`) · suite คลิก `claim-btn` แล้ว poll owner จาก API แล้ว `goto` · web C ตอบ claim แล้วจึง `location.reload()` (`static/app.js:247-250`) ซึ่งอาจมาขัด `goto` ที่กำลังโหลดอยู่ → ERR_ABORTED · spec ไม่บังคับว่าหลัง claim ห้าม reload · ตัวเลข workload/เพดาน 10 ของ web C ถูกตรวจแล้วโดย suite A, C ซึ่งผ่าน |
| TC-WORKFLOW-03 | B | SUITE-OVER-STRICT (race กับ reload หลัง claim; HYPOTHESIS) | log: `page.goto: net::ERR_ABORTED at /officer/cases/EG-2569-000012` ที่ `part2.spec.ts:907` ขั้น 6 (คลิก `claim-btn` `:905` → poll API `:906` → `goto`) · กลไกเดียวกับ QUEUE-03 |
| TC-NFR-04 | A, B | SUITE-OVER-STRICT (ผูกกับ SQLite) | spec **ไม่ได้กำหนดชนิดฐานข้อมูล**: `CONTRACT.md:21` "`DB_PATH` ชี้ไฟล์ฐานข้อมูล **(ถ้าใช้ฐานข้อมูลไฟล์)**" · `TEST-PLAN.md:1113` "**ตามชนิดฐานข้อมูลของกลุ่ม** เช่น SQLite …" · `DECISIONS.md:122` "เปิดคอลัมน์ในฐานข้อมูลต้องไม่เห็นเลข 13 หลักตรง ๆ (inspection)" · suite A ใช้ `DatabaseSync` อ่าน SQLite (`suiteA/helpers/db.js:7-9` → `file is not a database`) · suite B บังคับหัวไฟล์ `SQLite format 3` (`part2.spec.ts:2777` → Received `""`) · web C เขียน JSON ที่ `DB_PATH` (`core.js:306-308`) และเข้ารหัส PII ด้วย AES-256-GCM (`core.js:110`) · **ตรวจเพิ่ม (Grep -a -c บนไฟล์ปัจจุบัน `C:\src\compare\judge\cdata2\app.db.json`):** ค่า PII 13 หลักและเบอร์ที่ spec ระบุ (`1101700123456` ฯลฯ, รูปแบบมีขีด) นับได้ 0 ทุกค่า → เนื้อหา spec-compliant ในไฟล์นั้น (ระดับ 4 เฉพาะสแนปช็อตขณะตรวจ ไม่ใช่การรัน test เต็ม · ยังไม่ได้ตรวจ positive control `idNo` ผ่าน API) |
| TC-WORKFLOW-06 | A | SUITE-OVER-STRICT (ผูกกับ SPA ที่ไม่ reload) | log A-on-C: `response.json: … Response body is not available for a response that was navigated away from` ที่ `suiteA/specs/workflow.spec.js:385` · suite อ่าน `res.json()` หลังคลิก (`:379-385`) ขณะ web C `reloadWith()` ทันทีที่ `r.ok` (`static/app.js:237-243`) · HTTP 200 ผ่านแล้ว (`:384`) · `CONTRACT.md:381` กำหนดเพียง `POST …/resubmit` → 200 `{"status":"IN_REVIEW","dueAt"}` ไม่กำหนดพฤติกรรมของหน้า · ขั้น 168:00 (รอบ B) ยังไม่ได้ประเมินเพราะล้มก่อน |

### สรุป web C (นับต่อ TC×suite = 8 เซลล์)
- WEB-DEVIATES: **0**
- SUITE-OVER-STRICT: **6** (QUEUE-01 B, QUEUE-03 B, WORKFLOW-03 B, NFR-04 A, NFR-04 B, WORKFLOW-06 A)
- SPEC-AMBIGUOUS: **2** (NOTI-01/02 ของ suite B)
- UNKNOWN: 0
- SUITE-WRONG: 0

---

## ข้อค้นพบสำคัญ

1. **ไม่พบ WEB-DEVIATES ในเซลล์ที่ได้รับมอบหมายทั้ง 22 เซลล์ของ web A และ web C** ทุกความล้มเหลวอธิบายได้ด้วยสมมติฐานฝั่ง suite หรือ spec กำกวม (แต่ส่วนที่ติด HYPOTHESIS ยังไม่ได้รันยืนยัน)
2. **เหตุผลเดียวกันครอบ 11 จาก 14 เซลล์ของ web A (suite C):** suite C ผูกกับสถาปัตยกรรมของ web C เอง (server-render, query string บนหน้า, form GET) — spec ไม่ได้กำหนดสิ่งเหล่านี้ (หน้า web A ไม่อ่าน URL query เลย ตรวจแล้ว) และไม่รอ fetch ก่อนอ่าน DOM
3. **SPEC-AMBIGUOUS จริงเพียงจุดเดียว: เนื้อหาของ `noti-item`** (`CONTRACT.md:257`, `TEST-PLAN.md:507`) web A และ web C ใส่เวลาแจ้งเตือนไว้ใน item เดียวกัน, web B แยกเวลาออก และ suite B ตีความว่า item ต้องมีข้อความพอดี (`toHaveText`); suite A/C ตรวจแบบ contains/`data-*` ผ่านทั้งสองเว็บ · ข้อเสนอ (HYPOTHESIS ว่าเป็นทางแก้ที่ปลอดภัย ยังไม่ได้ทดสอบ): ให้ TA ระบุใน CONTRACT ว่า "ข้อความของ `noti-item` ต้อง `toContainText` หรือเนื้อหาต้องเท่ากับ" อย่างใดอย่างหนึ่ง
4. **TC-NFR-04 ล้มทั้ง suite A และ B บน web C เพราะผูก SQLite** ทั้งที่ spec เขียนว่า "ตามชนิดฐานข้อมูลของกลุ่ม" และ "ถ้าใช้ฐานข้อมูลไฟล์" และไฟล์ JSON ของ web C ไม่มีค่า PII ตรง ๆ (นับ 0)
5. **ที่ยังไม่รู้ (UNKNOWN):** TC-NFR-02 (suite C บน web A) ไม่ทราบสาเหตุที่แท้จริง ต้องรันซ้ำพร้อมรอ `qty-input` ก่อนกด Tab เพื่อแยก "race" ออกจาก "web ผิด"
6. **คำแนะนำเพื่อความยุติธรรมของการเทียบ:** การรันซ้ำระดับ 4 ที่ควรทำเป็นอันดับแรกคือ suite C บน web A โดยแก้เฉพาะ (ก) ใช้ `selectOption`/กรอกฟอร์มแทน URL query และ (ข) ใช้ `expect(...).toHaveCount/…` (auto-wait) แทน `evaluateAll`/`innerText` ทันที — ถ้าผ่านแปลว่า 11 เซลล์ข้างต้นเป็นปัญหา suite ล้วน
