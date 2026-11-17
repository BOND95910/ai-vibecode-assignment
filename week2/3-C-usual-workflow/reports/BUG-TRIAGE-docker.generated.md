| รอบ | BUG_MODE | TC ที่คาดว่าล้ม (BUGS.md ตาราง 2) | TC ที่ล้มจริง | TC ล้มเกินที่คาด | TC ที่ควรล้มแต่ผ่าน | ผล |
|---|---|---|---|---|---|---|
| normal-1 | (ไม่ตั้ง) | – | – | – | – | 51/51 passed ✅ |
| normal-2 | (ไม่ตั้ง) | – | – | – | – | 51/51 passed ✅ |
| B01 | B01 | TC-FEE-01 | TC-FEE-01 | – | – | 50/51 passed ✅ |
| B02 | B02 | TC-UPLOAD-01 | TC-UPLOAD-01 | – | – | 50/51 passed ✅ |
| B03 | B03 | TC-SLA-01 · TC-SLA-02 (อาจล้มด้วย TC-RBAC-04 · TC-SLA-03) | TC-RBAC-04 · TC-SLA-01 · TC-SLA-02 | – | – | 48/51 passed ✅ |
| B04 | B04 | TC-SLA-02 | TC-SLA-02 | – | – | 50/51 passed ✅ |
| B05 | B05 | TC-PAY-01 | TC-PAY-01 | – | – | 50/51 passed ✅ |
| B06 | B06 | TC-RBAC-01 | TC-RBAC-01 | – | – | 50/51 passed ✅ |
| B07 | B07 | TC-RBAC-02 (อาจล้มด้วย TC-WORKFLOW-01) | TC-RBAC-02 | – | – | 50/51 passed ✅ |
| B08 | B08 | TC-QUEUE-02 | TC-QUEUE-02 | – | – | 50/51 passed ✅ |
| B09 | B09 | TC-PDPA-02 | TC-PDPA-02 | – | – | 50/51 passed ✅ |
| B10 | B10 | TC-DASH-02 (อาจล้มด้วย TC-DASH-01 · TC-DASH-03) | TC-DASH-01 · TC-DASH-02 · TC-DASH-03 | – | – | 48/51 passed ✅ |
| B11 | B11 | TC-AUDIT-01 · TC-PDPA-03 | TC-AUDIT-01 · TC-PDPA-03 | – | – | 49/51 passed ✅ |
| B12 | B12 | TC-WORKFLOW-04 | TC-WORKFLOW-04 | – | – | 50/51 passed ✅ |
| B03,B07 | B03,B07 | TC-RBAC-02 · TC-SLA-01 · TC-SLA-02 (อาจล้มด้วย TC-RBAC-04 · TC-SLA-03 · TC-WORKFLOW-01) | TC-RBAC-02 · TC-RBAC-04 · TC-SLA-01 · TC-SLA-02 | – | – | 47/51 passed ✅ |
| B01,B05,B09 | B01,B05,B09 | TC-FEE-01 · TC-PAY-01 · TC-PDPA-02 | TC-FEE-01 · TC-PAY-01 · TC-PDPA-02 | – | – | 48/51 passed ✅ |
| normal-final | (ไม่ตั้ง) | – | – | – | – | 51/51 passed ✅ |

### ข้อความที่ล้ม (บรรทัดแรกของ assertion)

- **B01** TC-FEE-01: `Error: area 101 | Expected: "฿1,010" | Received: "฿1,000" |   - area 101 getByTestId('fee-total') with timeout 5000ms |   - waiting for getByTestId('fee-total') |        - unexpected value "฿1,000"`
- **B02** TC-UPLOAD-01: `Error: size 5242880 accepted | Expected: 1 | Received: 0 |   - size 5242880 accepted getByTestId('file-item') with timeout 5000ms |   - waiting for getByTestId('file-item') |        - unexpected value "0"`
- **B03** TC-RBAC-04: `Error: step 7 | - Expected  - 1 | + Received  + 1 | -   "dueAt": "2026-12-08T16:30:00+07:00", | +   "dueAt": "2026-12-04T16:30:00+07:00",`
- **B03** TC-SLA-01: `Error: row c dueAt (paid 2026-12-01T16:30:00+07:00) | Expected: "2026-12-08T16:30:00+07:00" | Received: "2026-12-07T16:30:00+07:00"`
- **B03** TC-SLA-02: `Error: part 1 dueAt (paused Thu 3) | Expected: "2026-12-08T16:30:00+07:00" | Received: "2026-12-07T16:30:00+07:00"`
- **B04** TC-SLA-02: `Error: part 1 dueAt (paused Thu 3) | Expected: "2026-12-08T16:30:00+07:00" | Received: "2026-12-04T16:30:00+07:00"`
- **B05** TC-PAY-01: `Error: expect(received).toEqual(expected) // deep equality | - Expected  - 2 | + Received  + 2 | -   "code": "QR_EXPIRED", | +   "code": undefined, | -   "status": 410, | +   "status": 200,`
- **B06** TC-RBAC-01: `Error: UI other citizen case HTTP | Expected: 404 | Received: 200`
- **B07** TC-RBAC-02: `Error: off.reg2 approves SV-02 PENDING_APPROVAL | - Expected  - 2 | + Received  + 2 | -   "code": "FORBIDDEN", | -   "status": 403, | +   "code": undefined, | +   "status": 200,`
- **B08** TC-QUEUE-02: `Error: exactly one claim succeeds | - Expected  - 1 | + Received  + 1 | -   409, | +   200,`
- **B09** TC-PDPA-02: `Error: off.reg1 GET /api/officer/queue?filter=all: 13-digit run | Received: ["1101700123456", "3100600987659", "1909900555015", "3100600987659", "3100600987659", "1101700123456", "1101700123456", "3100600987659", "1909900555015", "3100600987659", …]`
- **B10** TC-DASH-01: `Error: expect(received).toEqual(expected) // deep equality | - Expected  - 1 | + Received  + 1 | -   "ontime-pct": "–", | +   "ontime-pct": "0.0%",`
- **B10** TC-DASH-02: `Error: 2026-11 ALL | - Expected  - 1 | + Received  + 1 | -   "ontime-pct": "85.7%", | +   "ontime-pct": "23.1%",`
- **B10** TC-DASH-03: `Error: expect(received).toEqual(expected) // deep equality | - Expected  - 1 | + Received  + 1 | -   "ontime-pct": "85.7%", | +   "ontime-pct": "23.1%",`
- **B11** TC-AUDIT-01: `Error: expect(received).toEqual(expected) // deep equality | - Expected  - 1 | + Received  + 0 | -   "UNMASK": 1,`
- **B11** TC-PDPA-03: `Error: expect(locator).toHaveText(expected) failed | Expected: "1" | Received: "0" |   - Expect "toHaveText" getByTestId('audit-count') with timeout 5000ms |   - waiting for getByTestId('audit-count') |        - unexpected value "0"`
- **B12** TC-WORKFLOW-04: `Error: 3rd return EG-2569-000020 | - Expected  - 3 | + Received  + 3 | -   "code": "RETURN_LIMIT", | -   "message": "ตีกลับได้สูงสุด 2 ครั้ง", | -   "status": 409, | +   "code": undefined, | +   "message": undefined,`
- **B03,B07** TC-RBAC-02: `Error: off.reg2 approves SV-02 PENDING_APPROVAL | - Expected  - 2 | + Received  + 2 | -   "code": "FORBIDDEN", | -   "status": 403, | +   "code": undefined, | +   "status": 200,`
- **B03,B07** TC-RBAC-04: `Error: step 7 | - Expected  - 1 | + Received  + 1 | -   "dueAt": "2026-12-08T16:30:00+07:00", | +   "dueAt": "2026-12-04T16:30:00+07:00",`
- **B03,B07** TC-SLA-01: `Error: row c dueAt (paid 2026-12-01T16:30:00+07:00) | Expected: "2026-12-08T16:30:00+07:00" | Received: "2026-12-07T16:30:00+07:00"`
- **B03,B07** TC-SLA-02: `Error: part 1 dueAt (paused Thu 3) | Expected: "2026-12-08T16:30:00+07:00" | Received: "2026-12-07T16:30:00+07:00"`
- **B01,B05,B09** TC-FEE-01: `Error: area 101 | Expected: "฿1,010" | Received: "฿1,000" |   - area 101 getByTestId('fee-total') with timeout 5000ms |   - waiting for getByTestId('fee-total') |        - unexpected value "฿1,000"`
- **B01,B05,B09** TC-PAY-01: `Error: expect(received).toEqual(expected) // deep equality | - Expected  - 2 | + Received  + 2 | -   "code": "QR_EXPIRED", | +   "code": undefined, | -   "status": 410, | +   "status": 200,`
- **B01,B05,B09** TC-PDPA-02: `Error: off.reg1 GET /api/officer/queue?filter=all: 13-digit run | Received: ["1101700123456", "3100600987659", "1909900555015", "3100600987659", "3100600987659", "1101700123456", "1101700123456", "3100600987659", "1909900555015", "3100600987659", …]`
