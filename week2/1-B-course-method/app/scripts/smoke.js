#!/usr/bin/env node
'use strict';
/**
 * smoke test ของโครง (B01): node scripts/smoke.js [BASE_URL]
 *   EXPECT_TEST_MODE=1 (ค่าเริ่มต้น) → ตรวจ reset/clock · EXPECT_TEST_MODE=0 → ตรวจว่า /api/test/* = 404
 */
const BASE = (process.argv[2] || process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const EXPECT_TEST = (process.env.EXPECT_TEST_MODE || '1') === '1';

let failed = 0;
function check(name, cond, info) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  → ' + JSON.stringify(info)}`);
  if (!cond) failed++;
}

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json, headers: res.headers };
}

(async () => {
  const h = await call('GET', '/api/health');
  check('GET /api/health → 200 {"status":"ok"}', h.status === 200 && h.text === '{"status":"ok"}', h);

  if (EXPECT_TEST) {
    const r = await call('POST', '/api/test/reset');
    check('POST /api/test/reset → {ok:true, now:2026-12-01T09:00:00+07:00}',
      r.status === 200 && r.json && r.json.ok === true && r.json.now === '2026-12-01T09:00:00+07:00', r);

    const c0 = await call('GET', '/api/test/clock');
    check('GET /api/test/clock → initial', c0.status === 200 && c0.json.now === '2026-12-01T09:00:00+07:00', c0);

    const c1 = await call('PUT', '/api/test/clock', { now: '2026-12-01T16:30:00+07:00' });
    check('PUT /api/test/clock → 200 echo', c1.status === 200 && c1.json.now === '2026-12-01T16:30:00+07:00', c1);

    await new Promise((r2) => setTimeout(r2, 1200));
    const c2 = await call('GET', '/api/test/clock');
    check('clock frozen (unchanged after 1.2s)', c2.json && c2.json.now === '2026-12-01T16:30:00+07:00', c2);

    const cz = await call('PUT', '/api/test/clock', { now: '2026-12-01T02:00:00Z' });
    check('PUT clock with Z → converted to +07:00', cz.status === 200 && cz.json.now === '2026-12-01T09:00:00+07:00', cz);

    for (const bad of ['2026-12-01 09:00', '2026-12-01T09:00:00', 'hello', '2026-13-01T09:00:00+07:00', '2026-02-30T09:00:00+07:00', 123, null]) {
      const b = await call('PUT', '/api/test/clock', { now: bad });
      check(`PUT clock ${JSON.stringify(bad)} → 400 INVALID_TIME`,
        b.status === 400 && b.json && b.json.code === 'INVALID_TIME' && typeof b.json.message === 'string', b);
    }

    const r2 = await call('POST', '/api/test/reset');
    check('reset again → clock back to initial', r2.json && r2.json.now === '2026-12-01T09:00:00+07:00', r2);
  } else {
    for (const [m, p] of [['POST', '/api/test/reset'], ['GET', '/api/test/clock'], ['PUT', '/api/test/clock'], ['POST', '/api/test/payments/PP-0001/pay']]) {
      const x = await call(m, p, m === 'GET' ? undefined : {});
      check(`${m} ${p} without TEST_MODE → 404`, x.status === 404, x);
    }
  }

  const un = await call('GET', '/api/no-such-thing');
  check('unknown API → 404 JSON {code,message}', un.status === 404 && un.json && un.json.code === 'NOT_FOUND' && un.json.message, un);

  const root = await call('GET', '/');
  check('GET / (anon) → redirect /login', root.status === 302 && root.headers.get('location') === '/login', root.status);

  const css = await call('GET', '/static/app.css');
  check('GET /static/app.css → 200', css.status === 200, css.status);

  // body ≥ 6 MB ไม่ถูกตัดเป็น 413
  const big = 'x'.repeat(6 * 1024 * 1024 + 100);
  const bigRes = await fetch(BASE + '/api/no-such-thing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ big }) });
  check('JSON body > 6 MB is accepted (no 413)', bigRes.status !== 413, bigRes.status);

  const fd = new FormData();
  fd.append('docKey', 'id-card');
  fd.append('file', new Blob([Buffer.alloc(5242881, 0x25)]), 'size-5242881.pdf');
  const mp = await fetch(BASE + '/api/no-such-thing', { method: 'POST', body: fd });
  check('multipart 5,242,881 bytes is accepted by server (no 413)', mp.status !== 413, mp.status);

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
