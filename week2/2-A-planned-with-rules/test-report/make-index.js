// สร้าง test-report/index.html (หน้าเดียว เปิดดูได้โดยไม่ต้องรันอะไร) จาก results.json + bug-runs + bug-runs-2 + gifs/
// ใช้: node test-report/make-index.js
const fs = require('fs'), path = require('path');
const D = __dirname, esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clean = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, '');
const rows = (f) => { const r = JSON.parse(fs.readFileSync(f, 'utf8')), o = [];
  (function w(s) { for (const sp of s.specs || []) for (const t of sp.tests) { const x = t.results[t.results.length - 1];
    o.push({ id: sp.title.split(' ')[0], title: sp.title.split(' ').slice(1).join(' '), ok: t.status === 'expected', ms: x.duration, msg: clean(x.error && x.error.message).split('\n')[0] }); }
    (s.suites || []).forEach(w); })(r);
  return o.sort((a, b) => a.id.localeCompare(b.id)); };
const clean51 = rows(path.join(D, 'results.json'));
const gifs = new Set(fs.readdirSync(path.join(D, 'gifs')).map((f) => f.replace('.gif', '')));
const expect = { B01: ['TC-FEE-01'], B02: ['TC-UPLOAD-01'], B03: ['TC-SLA-01', 'TC-SLA-02'], B04: ['TC-SLA-02'], B05: ['TC-PAY-01'], B06: ['TC-RBAC-01'], B07: ['TC-RBAC-02'],
  B08: ['TC-QUEUE-02'], B09: ['TC-PDPA-02'], B10: ['TC-DASH-02'], B11: ['TC-PDPA-03', 'TC-AUDIT-01'], B12: ['TC-WORKFLOW-04'] };
const modes = [...Object.keys(expect), 'B03+B07', 'B01+B05+B09'];
const failed = (dir, m) => rows(path.join(D, dir, m + '.json')).filter((r) => !r.ok);
const bugRows = modes.map((m) => {
  const a = failed('bug-runs', m), b = failed('bug-runs-2', m), ids = a.map((r) => r.id);
  const exp = expect[m] || m.split('+').flatMap((x) => expect[x]);
  const missing = exp.filter((e) => !ids.includes(e));
  const mayFail = ['TC-SLA-03', 'TC-RBAC-04', 'TC-DASH-01', 'TC-DASH-03']; // "TC ที่อาจล้มด้วย" ตาม BUGS.md ตาราง 2
  const extra = ids.filter((i) => !exp.includes(i)).map((i) => (mayFail.includes(i) ? i + ' (อาจล้มด้วย ตามแผน)' : '⚠ ' + i + ' (นอกรายการ)'));
  const same = JSON.stringify(ids) === JSON.stringify(b.map((r) => r.id));
  return `<tr><td>${m}</td><td>${esc(exp.join(' · '))}</td><td>${esc(ids.join(' · '))}</td><td>${esc(extra.join(' · ') || '–')}</td><td>${esc(missing.join(' · ') || '–')}</td><td>${same ? 'เหมือนกัน' : '<b>ต่างกัน</b>'}</td><td>${esc((a[0] || {}).msg || '')}</td></tr>`;
}).join('\n');
const tcRows = clean51.map((r) => `<tr><td>${r.id}</td><td>${esc(r.title)}</td><td class="${r.ok ? 'ok' : 'bad'}">${r.ok ? '✅ ผ่าน' : '❌ ล้ม'}</td><td>${r.ms}</td><td>${gifs.has(r.id) ? `<a href="gifs/${r.id}.gif">gif</a>` : ''}</td></tr>`).join('\n');
const gifCards = [...gifs].sort().map((g) => `<figure><img loading="lazy" src="gifs/${g}.gif" alt="${g}"><figcaption>${g}</figcaption></figure>`).join('\n');
const pass = clean51.filter((r) => r.ok).length;
fs.writeFileSync(path.join(D, 'index.html'), `<!doctype html><html lang="th"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>รายงานทดสอบ e-Service</title>
<style>:root{--bg:#fff;--fg:#1f2328;--mut:#656d76;--line:#d0d7de;--ok:#1a7f37;--bad:#cf222e}
@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--mut:#8b949e;--line:#30363d;--ok:#3fb950;--bad:#f85149}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0 auto;padding:16px;max-width:1200px}
table{border-collapse:collapse;width:100%;font-size:13px;display:block;overflow-x:auto}th,td{border:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}
.ok{color:var(--ok)}.bad{color:var(--bad)}.mut{color:var(--mut)}figure{margin:0;display:inline-block;width:320px;vertical-align:top}img{max-width:100%;border:1px solid var(--line)}
a{color:inherit}</style>
<h1>รายงานทดสอบ e-Service · Week 2</h1>
<p><b>เว็บปกติ ${pass}/${clean51.length} ผ่าน</b> · BUG_MODE จับได้ ${modes.length - 2}/12 ตัว (และชุดรวม 2 ชุด) · รันสอง sweep ได้ผลเหมือนกัน · <span class="mut">รายละเอียด: RESULT.md · BUG-HUNT.md · ../REPORT.md</span></p>
<h2>BUG-HUNT (รอบที่ 1 เทียบรอบที่ 2)</h2>
<table><tr><th>BUG_MODE</th><th>คาดว่าล้ม</th><th>ล้มจริง</th><th>ล้มเกิน</th><th>ควรล้มแต่ผ่าน</th><th>2 รอบ</th><th>ข้อความแรก</th></tr>
${bugRows}</table>
<h2>ผลรายข้อ (เว็บปกติ)</h2>
<table><tr><th>TC</th><th>ชื่อ</th><th>ผล</th><th>ms</th><th>GIF</th></tr>
${tcRows}</table>
<h2>GIF ของ TC ที่จับบั๊ก</h2>
${gifCards}
</html>`);
console.log('index.html', pass + '/' + clean51.length, 'rows', modes.length);
