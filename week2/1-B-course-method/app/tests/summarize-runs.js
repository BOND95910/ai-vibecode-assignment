#!/usr/bin/env node
// สรุปผลจาก tests/runs/<รอบ>/results.json เป็นตาราง markdown (ใช้ทำ TEST-RESULT.md)
//   node summarize-runs.js normal-1 normal-2 B01 B02 ...      → ตาราง TC × รอบ + ข้อความที่ล้ม
'use strict';
const fs = require('fs');
const path = require('path');
const runs = process.argv.slice(2);
const strip = (s) => String(s || '').replace(/\u001b\[[0-9;]*m/g, '');
const data = {};
const order = [];
for (const run of runs) {
  const f = path.join(__dirname, 'runs', run, 'results.json');
  if (!fs.existsSync(f)) { console.error('missing', f); continue; }
  const r = JSON.parse(fs.readFileSync(f, 'utf8'));
  const res = {};
  const walk = (s) => {
    for (const x of s.suites || []) walk(x);
    for (const sp of s.specs || []) for (const t of sp.tests) {
      const id = sp.title.split(' ')[0];
      if (!order.includes(id)) order.push(id);
      const last = t.results[t.results.length - 1] || {};
      const errs = (last.errors && last.errors.length ? last.errors : last.error ? [last.error] : []).map((e) => strip(e.message || e.value || ''));
      const err = errs.map((e, i) => (errs.length > 1 ? `[${i + 1}/${errs.length}] ` : '') + e.split('\n').filter((l) => l.trim() && !/^\s*(Call log:|- |\d+ × |at |>?\s*\d+ \||\|)/.test(l)).slice(0, 6).join('\n')).join('\n');
      res[id] = { status: last.status, ms: last.duration, err, title: sp.title };
    }
  };
  for (const s of r.suites) walk(s);
  data[run] = res;
}
const out = [];
out.push('| TC | ' + runs.join(' | ') + ' |');
out.push('|---|' + runs.map(() => '---').join('|') + '|');
for (const id of order) {
  out.push('| ' + id + ' | ' + runs.map((run) => {
    const x = data[run] && data[run][id];
    return !x ? '?' : x.status === 'passed' ? '✅' : '❌';
  }).join(' | ') + ' |');
}
out.push('| **ผ่าน** | ' + runs.map((run) => {
  const v = Object.values(data[run] || {});
  return `${v.filter((x) => x.status === 'passed').length}/${v.length}`;
}).join(' | ') + ' |');
console.log(out.join('\n'));
console.log('\n<!-- failures -->');
for (const run of runs) {
  for (const id of order) {
    const x = data[run] && data[run][id];
    if (x && x.status !== 'passed') {
      const lines = x.err.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
      console.log(`### ${run} · ${id} (${x.status})\n\`\`\`text\n${lines.slice(0, 30).join('\n')}\n\`\`\``);
    }
  }
}
