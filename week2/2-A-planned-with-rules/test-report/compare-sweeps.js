// เทียบชุด TC ที่ล้มระหว่าง sweep รอบ 1 (bug-runs) กับรอบ 2 (bug-runs-2) · ใช้: node compare-sweeps.js
const fs = require('fs'), path = require('path');
const fails = (f) => { const r = JSON.parse(fs.readFileSync(f, 'utf8')), o = [];
  (function w(s) { for (const sp of s.specs || []) for (const t of sp.tests) if (t.status !== 'expected') o.push(sp.title.split(' ')[0]); (s.suites || []).forEach(w); })(r);
  return o.sort(); };
let diff = 0;
for (const f of fs.readdirSync(path.join(__dirname, 'bug-runs')).filter((x) => x.endsWith('.json'))) {
  const a = fails(path.join(__dirname, 'bug-runs', f)), b = fails(path.join(__dirname, 'bug-runs-2', f));
  const same = JSON.stringify(a) === JSON.stringify(b); if (!same) diff++;
  console.log((same ? 'SAME ' : 'DIFF ') + f.replace('.json', '').padEnd(14) + ' r1=[' + a + '] r2=[' + b + ']');
}
console.log('รอบต่างกัน:', diff);
