// สร้างเมทริกซ์ TC × (ชุดเทสต์ × เว็บ) จากผล clean ทั้ง 9 เซลล์ + ฉันทามติ 2-ใน-3
const fs = require('fs');
function failsOf(S, W) {
  const base = `results/${S}-on-${W}/none`;
  if (fs.existsSync(base + '.json')) {
    const j = JSON.parse(fs.readFileSync(base + '.json', 'utf8')), pass = new Set(), fail = new Set();
    (function walk(s) { for (const sp of s.specs || []) { const id = (sp.title.match(/TC-[A-Z0-9]+-\d+/) || [sp.title])[0];
      const st = sp.tests.map(t => t.results.at(-1)?.status || t.status); (st.every(x => x === 'passed') ? pass : fail).add(id); }
      (s.suites || []).forEach(walk); })({ suites: j.suites });
    return { pass, fail };
  }
  const pass = new Set(), fail = new Set();
  for (const l of fs.readFileSync(base + '.log', 'utf8').split('\n')) { const m = /^\s+(✘|✓)\s+\d+\s.*?(TC-[A-Z0-9]+-\d+)/.exec(l); if (m) (m[1] === '✓' ? pass : fail).add(m[2]); }
  for (const x of fail) pass.delete(x); return { pass, fail };
}
const R = {}; for (const S of 'ABC') for (const W of 'ABC') R[S + W] = failsOf(S, W);
const ids = new Set(); Object.values(R).forEach(r => [...r.pass, ...r.fail].forEach(x => ids.add(x)));
const out = { summary: {}, perWeb: {} };
for (const S of 'ABC') for (const W of 'ABC') out.summary[`${S}-suite on ${W}-web`] = `${R[S + W].pass.size}/51`;
for (const W of 'ABC') {
  const rows = [];
  for (const id of [...ids].sort()) {
    const v = 'ABC'.split('').map(S => R[S + W].fail.has(id) ? 'F' : 'p');
    const nf = v.filter(x => x === 'F').length; if (nf) rows.push({ id, A: v[0], B: v[1], C: v[2], failIn: nf });
  }
  out.perWeb[W] = rows;
}
console.log(JSON.stringify(out.summary, null, 1));
for (const W of 'ABC') { console.log(`\n== web ${W}: TC ที่ล้มในอย่างน้อย 1 ชุด (suiteA suiteB suiteC) ==`);
  for (const r of out.perWeb[W]) console.log(r.id.padEnd(16), r.A, r.B, r.C, r.failIn >= 2 ? '← ฉันทามติ: เว็บน่าจะเบี่ยง' : '← ล้มชุดเดียว'); }
fs.writeFileSync('matrix.json', JSON.stringify(out, null, 1));
