# Week 2 · e-Service กลาง เทศบาลนครตัวอย่าง

| ลำดับ | โฟลเดอร์ | คืออะไร |
|---|---|---|
| **1 · งานหลักที่ส่ง** | [`1-B-course-method/`](1-B-course-method/README.md) | ทำตามวิธีของคอร์สทีละขั้น (`dag-planner` → `agent-team` → Playwright 51 TC → BUG_MODE B01–B12) ใน container ที่ config สะอาด |
| 2 · แนบเปรียบเทียบ | [`2-A-planned-with-rules/`](2-A-planned-with-rules/README.md) | วิธีคอร์ส + กฎ/hook ที่เราสร้างคุมอีกชั้น (Sonnet 5.5) |
| 3 · แนบเปรียบเทียบ | [`3-C-usual-workflow/`](3-C-usual-workflow/README.md) | ไม่ใช้วิธีคอร์ส ใช้วิธีทำงานปกติของผู้ทำ พรอมต์เดียว (Opus 5.5) |
| ผลเทียบ | [`comparison/`](comparison/COMPARISON.md) | ตรวจไขว้ 3 ชุดเทสต์ × 3 เว็บ · BUG-HUNT ข้ามชุด · เวลา · โทเคน · ราคา · ข้อจำกัด |
| โจทย์ | `egov-brief/` | ชุดโจทย์จาก TA (อ่านอย่างเดียว) |

## สรุปสั้น

- B (งานหลัก): ชุดเทสต์ของตัวเอง 51/51 · BUG-HUNT 12/12 · ผ่านชุดของ A 48/51 และชุดของ C 33/51 โดยไม่พบจุดที่เว็บผิด spec ตรง ๆ
- เทียบสามแบบ: ความถูกต้องใกล้เคียงกัน · C ถูกสุด (output 0.48M โทเคน) · B ได้อาร์ติแฟกต์ของคอร์สครบแต่แพงสุด (~$72 ตามราคาลิสต์) · A เร็วสุดแต่ผู้ทำคุมต่อเนื่อง
- ข้อควรระวังของ B: element ข้อความ error ที่ซ่อนไว้ตลอด · `audit-case-no` ว่างแทน `–` — รายละเอียดใน [`comparison/COMPARISON.md`](comparison/COMPARISON.md)
