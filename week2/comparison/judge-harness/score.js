// ให้คะแนน BUG-HUNT: node score.js <โฟลเดอร์ผล เช่น results/B-on-A>  (ฐาน = รอบ none ของโฟลเดอร์เดียวกัน)
const fs = require('fs'); const dir = process.argv[2];
function fails(f) { const j = JSON.parse(fs.readFileSync(f, 'utf8')), F = new Set(); (function w(s) { for (const sp of s.specs || []) { const id = (sp.title.match(/TC-[A-Z0-9]+-\d+/) || [sp.title])[0]; const st = sp.tests.map(t => t.results.at(-1)?.status || t.status); if (!st.every(x => x === 'passed')) F.add(id); } (s.suites || []).forEach(w); })({ suites: j.suites }); return F; }
const EXP = { B01: ['TC-FEE-01'], B02: ['TC-UPLOAD-01'], B03: ['TC-SLA-01', 'TC-SLA-02'], B04: ['TC-SLA-02'], B05: ['TC-PAY-01'], B06: ['TC-RBAC-01'], B07: ['TC-RBAC-02'], B08: ['TC-QUEUE-02'], B09: ['TC-PDPA-02'], B10: ['TC-DASH-02'], B11: ['TC-PDPA-03', 'TC-AUDIT-01'], B12: ['TC-WORKFLOW-04'] };
const MAY = { B03: ['TC-SLA-03', 'TC-RBAC-04'], B07: ['TC-WORKFLOW-01'], B10: ['TC-DASH-01', 'TC-DASH-03'] };
const base = fails(`${dir}/none.json`); console.log('baseline fails:', [...base].join(',') || '-');
const modes = [...Object.keys(EXP), 'B03+B07', 'B01+B05+B09']; let caught = 0, clean = 0;
for (const m of modes) {
  const parts = m.split('+'); const must = [...new Set(parts.flatMap(p => EXP[p]))], may = new Set(parts.flatMap(p => MAY[p] || []));
  const f = fails(`${dir}/${m}.json`); for (const b of base) f.delete(b);
  const miss = must.filter(x => !f.has(x)), extra = [...f].filter(x => !must.includes(x) && !may.has(x));
  if (!miss.length) caught++; if (!miss.length && !extra.length) clean++;
  console.log(m.padEnd(12), 'ล้มเพิ่มจากฐาน:', [...f].join(',') || '-', '| ควรล้มแต่ผ่าน:', miss.join(',') || '-', '| ล้มเกินรายการ:', extra.join(',') || '-');
}
console.log(`จับได้ ${caught}/${modes.length} · ไม่มี TC เกินรายการ ${clean}/${modes.length}`);
