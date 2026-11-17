// สรุปจาก list reporter (.log) เมื่อไม่มี json:  node summarize-log.js <file.log>...
const fs = require('fs');
for (const f of process.argv.slice(2)) {
  const pass = new Set(), fail = new Set();
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = /^\s+(✘|✓)\s+\d+\s.*?(TC-[A-Z0-9]+-\d+)/.exec(l); if (!m) continue;
    (m[1] === '✓' ? pass : fail).add(m[2]);
  }
  for (const x of fail) pass.delete(x);
  console.log(JSON.stringify({ f: f.split('/').slice(-2).join('/'), total: pass.size + fail.size, pass: pass.size, fail: [...fail].sort() }));
}
