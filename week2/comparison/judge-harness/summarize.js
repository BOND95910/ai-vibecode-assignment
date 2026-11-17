// สรุปผล json ของ Playwright เป็นรายการ TC ที่ล้ม:  node summarize.js <file.json>...
const fs = require('fs');
for (const f of process.argv.slice(2)) {
  let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { console.log(f, 'ERR', e.message); continue; }
  const pass = new Set(), fail = new Set(), skip = new Set();
  (function walk(s) { for (const sp of s.specs || []) { const id = (sp.title.match(/TC-[A-Z0-9]+-\d+/) || [sp.title])[0];
      const st = sp.tests.map(t => t.results.at(-1)?.status || t.status);
      if (st.every(x => x === 'passed')) pass.add(id); else if (st.some(x => x === 'skipped')) skip.add(id); else fail.add(id); }
    (s.suites || []).forEach(walk); })({ suites: j.suites });
  console.log(JSON.stringify({ f: f.split('/').slice(-2).join('/'), total: pass.size + fail.size + skip.size, pass: pass.size, fail: [...fail].sort(), skip: [...skip] }));
}
