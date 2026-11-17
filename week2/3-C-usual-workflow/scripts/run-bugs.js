// BUGS.md §3: run the full suite with no bug (twice, same server), each B01–B12 alone, the two combinations,
// then no bug again. Writes reports/bug-results.json and reports/BUG-TRIAGE.md (table §4 filled from real runs).
//   node scripts/run-bugs.js            (all)      node scripts/run-bugs.js B03 B07   (subset)
//   node scripts/run-bugs.js --docker   (same matrix through docker compose: web + tests containers)
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DOCKER = process.argv.includes('--docker');
const dc = (args, mode) => spawnSync('docker', ['compose', ...args], { cwd: ROOT, env: { ...process.env, BUG_MODE: mode }, stdio: ['ignore', 'ignore', 'inherit'] });
const PORT = 3200;
const BASE = `http://localhost:${PORT}`;
const DB = path.join(ROOT, 'data', 'bugrun.db.json');
const EXPECT = { // BUGS.md §2: [must fail, may also fail]
  B01: [['TC-FEE-01'], []], B02: [['TC-UPLOAD-01'], []], B03: [['TC-SLA-01', 'TC-SLA-02'], ['TC-SLA-03', 'TC-RBAC-04']],
  B04: [['TC-SLA-02'], []], B05: [['TC-PAY-01'], []], B06: [['TC-RBAC-01'], []], B07: [['TC-RBAC-02'], ['TC-WORKFLOW-01']],
  B08: [['TC-QUEUE-02'], []], B09: [['TC-PDPA-02'], []], B10: [['TC-DASH-02'], ['TC-DASH-01', 'TC-DASH-03']],
  B11: [['TC-PDPA-03', 'TC-AUDIT-01'], []], B12: [['TC-WORKFLOW-04'], []],
};
const expectFor = mode => {
  const must = new Set(), may = new Set();
  for (const b of mode ? mode.split(',') : []) { EXPECT[b][0].forEach(x => must.add(x)); EXPECT[b][1].forEach(x => may.add(x)); }
  return [[...must].sort(), [...may].filter(x => !must.has(x)).sort()];
};

const sleep = require('node:timers/promises').setTimeout;
const { stripVTControlCharacters } = require('node:util');
async function startServer(mode) {
  if (DOCKER) {
    if (dc(['up', '-d', '--wait', '--force-recreate', 'web'], mode).status !== 0) throw new Error('compose up failed');
    return { kill: () => {} };
  }
  // a leftover server on PORT would answer the health check with the wrong BUG_MODE — refuse instead of testing it
  const busy = () => fetch(`${BASE}/api/health`).then(() => true, () => false);
  for (let i = 0; i < 25 && await busy(); i++) await sleep(200); // the previous mode's server may still be exiting
  if (await busy()) throw new Error(`port ${PORT} is already serving; stop that process first`);
  const env = { ...process.env, TEST_MODE: '1', BUG_MODE: mode, PORT: String(PORT), DB_PATH: DB };
  const child = spawn(process.execPath, [path.join(ROOT, 'app', 'server.js')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout.on('data', d => process.stdout.write(`  [server] ${d}`));
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return child; } catch { /* not up yet */ }
    await sleep(200);
  }
  child.kill();
  throw new Error('server did not start');
}
function runSuite(tag, mode) {
  // raw JSON kept under reports/ (Playwright wipes test-results/ at the start of every run)
  const out = path.join(ROOT, 'reports', DOCKER ? 'docker' : path.join('raw', 'local'), `bug-${tag}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (DOCKER) dc(['--profile', 'test', 'run', '--rm', '-e', `PW_JSON=/work/out/bug-${tag}.json`, 'tests'], mode);
  else {
    const env = { ...process.env, BASE_URL: BASE, DB_PATH: DB, PW_JSON: out };
    delete env.BUG_MODE;
    spawnSync(process.execPath, [path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js'), 'test'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'inherit'] });
  }
  const report = JSON.parse(fs.readFileSync(out, 'utf8'));
  const results = {};
  const walk = s => {
    for (const spec of s.specs || []) {
      const id = spec.title.split(' ')[0];
      const r = spec.tests[0].results.at(-1) || {};
      const msg = stripVTControlCharacters(r.errors?.[0]?.message || r.error?.message || '').split('\n').filter(l => l.trim())
        .filter((l, i) => i === 0 || /^\s*(Expected|Received|[-+] )/.test(l)).slice(0, 8).join(' | '); // keep the value diff
      results[id] = { status: r.status, ms: r.duration, msg };
    }
    (s.suites || []).forEach(walk);
  };
  report.suites.forEach(walk);
  return results;
}

(async () => {
  const only = process.argv.slice(2).filter(a => a !== '--docker');
  const plan = only.length ? only.map(m => [m, m, false])
    : [['normal-1', '', false], ['normal-2', '', true], ...Object.keys(EXPECT).map(b => [b, b, false]), ['B03,B07', 'B03,B07', false], ['B01,B05,B09', 'B01,B05,B09', false], ['normal-final', '', false]];
  const runs = [];
  let server = null;
  for (const [tag, mode, reuse] of plan) {
    if (!reuse) { server?.kill(); await sleep(500); server = await startServer(mode); }
    console.log(`== ${tag} (BUG_MODE=${mode || '-'}${reuse ? ', same server' : ''})`);
    const t0 = Date.now();
    const res = runSuite(tag.replace(/,/g, '+'), mode);
    const failed = Object.entries(res).filter(([, r]) => r.status !== 'passed').map(([id]) => id).sort();
    const [must, may] = expectFor(mode);
    const run = { tag, mode, total: Object.keys(res).length, passed: Object.values(res).filter(r => r.status === 'passed').length, failed,
      missed: must.filter(x => !failed.includes(x)), extra: failed.filter(x => !must.includes(x) && !may.includes(x)), alsoFailed: failed.filter(x => may.includes(x)),
      must, may, seconds: Math.round((Date.now() - t0) / 1000), messages: Object.fromEntries(failed.map(id => [id, res[id].msg])) };
    run.ok = run.missed.length === 0 && run.extra.length === 0 && run.total === (runs[0]?.total ?? run.total); // same suite size as the first run
    runs.push(run);
    console.log(`   ${run.passed}/${run.total} passed · failed: ${failed.join(' ') || '-'} · ${run.ok ? 'OK' : 'MISMATCH'}`);
  }
  server?.kill();
  if (DOCKER) dc(['--profile', 'test', 'down'], '');
  const suffix = DOCKER ? '-docker' : '';
  fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'reports', `bug-results${suffix}.json`), JSON.stringify({ generatedAt: new Date().toISOString(), runs }, null, 2));
  const md = ['| รอบ | BUG_MODE | TC ที่คาดว่าล้ม (BUGS.md ตาราง 2) | TC ที่ล้มจริง | TC ล้มเกินที่คาด | TC ที่ควรล้มแต่ผ่าน | ผล |', '|---|---|---|---|---|---|---|'];
  for (const r of runs) {
    const exp = r.must.length ? r.must.join(' · ') + (r.may.length ? ` (อาจล้มด้วย ${r.may.join(' · ')})` : '') : '–';
    md.push(`| ${r.tag} | ${r.mode || '(ไม่ตั้ง)'} | ${exp} | ${r.failed.join(' · ') || '–'} | ${r.extra.join(' · ') || '–'} | ${r.missed.join(' · ') || '–'} | ${r.passed}/${r.total} passed ${r.ok ? '✅' : '❌'} |`);
  }
  md.push('', '### ข้อความที่ล้ม (บรรทัดแรกของ assertion)', '');
  for (const r of runs.filter(x => x.failed.length)) for (const [id, m] of Object.entries(r.messages)) md.push(`- **${r.tag}** ${id}: \`${m.replace(/`/g, "'").slice(0, 400)}\``);
  fs.writeFileSync(path.join(ROOT, 'reports', `BUG-TRIAGE${suffix}.generated.md`), md.join('\n') + '\n');
  console.log(md.slice(0, runs.length + 2).join('\n'));
  process.exit(runs.every(r => r.ok) ? 0 : 1);
})();
