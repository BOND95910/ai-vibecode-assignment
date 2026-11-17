// เทียบรหัส TC ในตาราง "สรุป 51 TC" ของ TEST-PLAN.md กับชื่อ test ใน specs/*.spec.js ว่าครบพอดี (ไม่ขาด ไม่เกิน ไม่ซ้ำ)
// ใช้: node check-coverage.js [path ของ TEST-PLAN.md]  → exit 1 ถ้าไม่ครบ
const fs = require('node:fs');
const path = require('node:path');

const PLAN = process.argv[2] || path.resolve(__dirname, '..', '..', '..', 'egov-brief', 'TEST-PLAN.md');
const SPECS = path.join(__dirname, 'specs');

const plan = fs.readFileSync(PLAN, 'utf8');
const start = plan.indexOf('## 1. สรุป 51 TC');
if (start < 0) { console.error('ไม่พบหัวข้อ "## 1. สรุป 51 TC" ใน ' + PLAN); process.exit(1); }
const end = plan.indexOf('\n## ', start + 5);
const table = plan.slice(start, end < 0 ? undefined : end);
const planCodes = [...table.matchAll(/^\|\s*(TC-[A-Z]+-\d{2})\s*\|/gm)].map((m) => m[1]);

const testCodes = [];
for (const f of fs.readdirSync(SPECS).filter((x) => x.endsWith('.spec.js'))) {
  const src = fs.readFileSync(path.join(SPECS, f), 'utf8');
  for (const m of src.matchAll(/\btest\(\s*(['"`])(TC-[A-Z]+-\d{2})[ \t]/g)) testCodes.push(m[2]);
}

const dup = (a) => a.filter((x, i) => a.indexOf(x) !== i);
const missing = planCodes.filter((c) => !testCodes.includes(c));
const extra = testCodes.filter((c) => !planCodes.includes(c));
const dups = [...new Set(dup(testCodes))];
const planDups = [...new Set(dup(planCodes))];

console.log(`TEST-PLAN ตาราง "สรุป 51 TC": ${planCodes.length} รหัส (${new Set(planCodes).size} ไม่ซ้ำ)`);
console.log(`specs/*.spec.js: ${testCodes.length} test ที่ขึ้นต้นด้วยรหัส TC (${new Set(testCodes).size} ไม่ซ้ำ)`);
if (missing.length) console.log('ขาด:', missing.join(', '));
if (extra.length) console.log('เกิน:', extra.join(', '));
if (dups.length) console.log('ซ้ำ:', dups.join(', '));
if (planDups.length) console.log('รหัสซ้ำในตารางแผน:', planDups.join(', '));

const good = planCodes.length === 51 && !missing.length && !extra.length && !dups.length && !planDups.length && testCodes.length === planCodes.length;
console.log(good ? 'ผล: ครบพอดี 51/51' : 'ผล: ไม่ครบ');
process.exit(good ? 0 : 1);
