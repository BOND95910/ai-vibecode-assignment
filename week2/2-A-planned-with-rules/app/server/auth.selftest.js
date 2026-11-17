// B04 selftest: node server/auth.selftest.js
// express ชั่วคราวพอร์ตสุ่ม โหลดเฉพาะ routes/auth.js + ฐาน :memory: ที่ seed จริง · เวลาตั้งผ่าน clock.set ตรง ๆ
process.env.DB_PATH = ':memory:';
const assert = require('assert');
const express = require('express');
const { initSchema, db, resetAll } = require('./db');
const clock = require('./clock');
const util = require('./util');
const { requireRole, pageGuard, landingFor } = require('./rbac');

initSchema();
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.cookies = util.parseCookies(req); next(); });
require('./routes/auth')(app);
app.get('/t/citizen', requireRole('citizen'), (req, res) => res.json({ user: req.user.role }));
app.get('/t/staff', requireRole('officer', 'head'), (req, res) => res.json({ ok: true }));
app.get('/t/any', requireRole(), (req, res) => res.json({ ok: true }));
app.get('/p/officer', pageGuard('officer', 'head'), (req, res) => res.send('page-ok'));
app.get('/p/citizen', pageGuard('citizen'), (req, res) => res.send('page-ok'));

let base, server, n = 0;
const ok = (name) => { n++; console.log('  ok', name); };

// เรียก API · cookie ส่งเป็นค่า sid (หรือ null) · คืน { status, body, text, sid, setCookie, location }
async function call(method, path, body, sid) {
  const r = await fetch(base + path, {
    method, redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(sid ? { cookie: 'sid=' + sid } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* html/ว่าง */ }
  const sc = r.headers.getSetCookie().find((c) => c.startsWith('sid=')) || '';
  const m = /^sid=([0-9a-f]+)/.exec(sc);
  return { status: r.status, body: json, text, sid: m ? m[1] : null, setCookie: sc, location: r.headers.get('location') };
}
const start = (idNo) => call('POST', '/api/auth/thaid/start', { idNo });
const verify = (idNo, otp, sid) => call('POST', '/api/auth/thaid/verify', { idNo, otp }, sid);
const staff = (username, password = 'Test@1234') => call('POST', '/api/auth/staff/login', { username, password });
const at = (iso) => clock.set(iso);
const SC = '1101700123456', PT = '1909900555015', MN = '5500400111221';

async function br01() {
  console.log('BR-01 / TC-AUTH-01');
  for (const [v, why] of [['110170012345', '12 หลัก'], ['11017001234567', '14 หลัก'], ['1101700123457', 'checksum ผิด'], ['11017001234ab', 'ไม่ใช่ตัวเลข']]) {
    const r = await start(v);
    assert.strictEqual(r.status, 400, why);
    assert.deepStrictEqual(r.body, { code: 'INVALID_ID', message: 'เลขบัตรประชาชนไม่ถูกต้อง' }, why);
  }
  for (const v of [SC, '3100600987659', PT, MN]) {
    const r = await start(v);
    assert.strictEqual(r.status, 200, v);
    assert.deepStrictEqual(r.body, { status: 'OTP_SENT' });
  }
  assert.strictEqual((await start(undefined)).status, 400);
  assert.strictEqual((await start(1101700123456)).status, 400); // ไม่ใช่สตริง
  assert.strictEqual((await verify('1101700123457', '123456')).status, 400);
  ok('4 ค่าตาม BR-01 + ตัวอย่างเสริม + verify ตรวจเลขเช่นกัน');
}

async function br02() {
  console.log('BR-02 / TC-AUTH-02');
  resetAll();
  await start(PT);
  let r = await verify(PT, '000000');
  assert.strictEqual(r.status, 401);
  assert.deepStrictEqual(r.body, { code: 'OTP_INVALID', message: 'รหัส OTP ไม่ถูกต้อง', attemptsLeft: 2 });
  r = await verify(PT, '000000');
  assert.strictEqual(r.status, 401); assert.strictEqual(r.body.attemptsLeft, 1);
  ok('ผิดครั้งที่ 1-2 ยังลองได้ (เหลือ 2 แล้ว 1)');

  r = await verify(PT, '000000');
  assert.strictEqual(r.status, 423);
  assert.deepStrictEqual(r.body, { code: 'LOCKED', message: 'ผิดเกินกำหนด เลขบัตรนี้ถูกล็อก 15 นาที', lockedUntil: '2026-12-01T09:15:00+07:00' });
  assert.strictEqual(r.sid, null);
  ok('ผิดครั้งที่ 3 → 423 lockedUntil = +15 นาทีนับจากครั้งที่ 3');

  r = await verify(PT, '123456');
  assert.strictEqual(r.status, 423); assert.strictEqual(r.sid, null);
  assert.strictEqual((await start(PT)).status, 423);
  ok('ล็อกอยู่: OTP ถูกก็ยัง 423 และ start ก็ 423');

  r = await verify(SC, '123456');
  assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.body, { registered: true });
  ok('สมชายล็อกอินได้ระหว่างที่ปิติถูกล็อก');

  at('2026-12-01T09:14:59+07:00');
  r = await verify(PT, '123456');
  assert.strictEqual(r.status, 423);
  assert.strictEqual((await start(PT)).status, 423);
  ok('+14:59 ยังล็อกแม้ OTP ถูก');

  at('2026-12-01T09:15:00+07:00');
  assert.strictEqual((await start(PT)).status, 200);
  r = await verify(PT, '000000');
  assert.strictEqual(r.status, 401); assert.strictEqual(r.body.attemptsLeft, 2);
  ok('+15:00 ปลดล็อก · ผิดทันทีนับเป็นครั้งที่ 1 (เหลือ 2 ไม่ล็อกซ้ำ)');
  r = await verify(PT, '123456');
  assert.strictEqual(r.status, 200); assert.ok(r.sid);
  ok('หลังปลดล็อก OTP ถูกล็อกอินได้');

  // ผิด 2 → ถูก → ผิด 2 ไม่ล็อก (หลัง RESET)
  resetAll();
  assert.strictEqual(clock.nowISO(), '2026-12-01T09:00:00+07:00');
  assert.strictEqual((await verify(PT, '1')).body.attemptsLeft, 2);
  assert.strictEqual((await verify(PT, '1')).body.attemptsLeft, 1);
  r = await verify(PT, '123456');
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await call('POST', '/api/auth/logout', undefined, r.sid)).status, 204);
  assert.strictEqual((await verify(PT, '1')).body.attemptsLeft, 2);
  r = await verify(PT, '1');
  assert.strictEqual(r.status, 401); assert.strictEqual(r.body.attemptsLeft, 1);
  ok('ผิด 2 → ถูก → ผิด 2 ไม่ล็อก (รอบใหม่ตอบเหลือ 1 ครั้ง)');

  // ล็อกแล้ว reset ต้องล้างตัวนับ/ล็อก · ฐานเก็บเฉพาะ hash ไม่ใช่เลขตรง ๆ
  await verify(PT, '1'); // ครั้งที่ 3 ของรอบ → ล็อก
  assert.strictEqual((await verify(PT, '123456')).status, 423);
  const rows = db.prepare('SELECT * FROM otp_attempts').all();
  assert.strictEqual(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes(PT));
  assert.strictEqual(rows[0].id_hash, util.hashId(PT));
  resetAll();
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM otp_attempts').get().c, 0);
  assert.strictEqual((await verify(PT, '123456')).status, 200);
  ok('ล็อกถูกล้างโดย resetAll · ตัวนับเก็บด้วย id_hash เท่านั้น');
}

async function br03() {
  console.log('BR-03 / TC-AUTH-03');
  resetAll();
  let r = await verify(MN, '123456');
  assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.body, { registered: false });
  assert.ok(/HttpOnly/i.test(r.setCookie), 'คุกกี้ sid ต้อง HttpOnly');
  const sid = r.sid;
  ok('มานะ: registered:false + คุกกี้ HttpOnly');

  r = await call('GET', '/api/me', undefined, sid);
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.name, 'มานะ ตั้งใจ'); assert.strictEqual(r.body.registered, false);
  assert.strictEqual((await call('GET', '/t/citizen', undefined, sid)).status, 403);
  assert.strictEqual((await call('GET', '/t/any', undefined, sid)).status, 403);
  r = await call('GET', '/p/citizen', undefined, sid);
  assert.strictEqual(r.status, 302); assert.strictEqual(r.location, '/register');
  ok('คุกกี้ยังไม่ลงทะเบียนใช้ได้เฉพาะ /register + /api/me (requireRole 403 · pageGuard → /register)');

  const reg = (b, s = sid) => call('POST', '/api/auth/register', b, s);
  for (const m of ['081234567', '08123456789', '1812345678', '08123abcde', '', undefined, 812345678]) {
    r = await reg({ mobile: m, consent: true });
    assert.strictEqual(r.status, 400, String(m)); assert.strictEqual(r.body.code, 'INVALID_MOBILE');
    assert.strictEqual(r.body.message, 'เบอร์มือถือต้องเป็นตัวเลข 10 หลักขึ้นต้นด้วย 0');
  }
  r = await reg({ mobile: '0845678901', consent: false });
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'CONSENT_REQUIRED');
  assert.strictEqual(r.body.message, 'กรุณายินยอมการประมวลผลข้อมูลส่วนบุคคล (PDPA)');
  assert.strictEqual((await reg({ mobile: '0845678901' })).body.code, 'CONSENT_REQUIRED');
  assert.strictEqual(db.prepare("SELECT registered FROM users WHERE display_name='มานะ ตั้งใจ'").get().registered, 0);
  ok('เบอร์ 9/11/ไม่ขึ้นต้น 0/มีตัวอักษร/ว่าง → INVALID_MOBILE · ไม่ติ๊กยินยอม → CONSENT_REQUIRED · ยังไม่ลงทะเบียน');

  assert.strictEqual((await call('POST', '/api/auth/register', { mobile: '0845678901', consent: true })).status, 401);
  r = await reg({ mobile: '0845678901', email: '', consent: true, name: 'ชื่ออื่น', displayName: 'ชื่ออื่น' });
  assert.strictEqual(r.status, 201);
  const u = db.prepare("SELECT * FROM users WHERE id_hash=?").get(util.hashId(MN));
  assert.strictEqual(u.registered, 1); assert.strictEqual(u.display_name, 'มานะ ตั้งใจ');
  assert.strictEqual(u.email, ''); assert.ok(u.consent_at);
  assert.notStrictEqual(u.mobile_enc, '0845678901'); assert.ok(!u.mobile_enc.includes('0845678901'));
  assert.strictEqual(util.decrypt(u.mobile_enc), '0845678901');
  ok('ลงทะเบียนสำเร็จ 201 · เบอร์เข้ารหัส · ชื่อจาก ThaiD ไม่ถูกแก้ · อีเมลว่างได้');

  assert.strictEqual((await call('GET', '/t/citizen', undefined, sid)).status, 200);
  r = await reg({ mobile: '0845678901', consent: true });
  assert.strictEqual(r.status, 409);
  r = await verify(MN, '123456');
  assert.deepStrictEqual(r.body, { registered: true });
  r = await call('GET', '/p/citizen', undefined, r.sid);
  assert.strictEqual(r.status, 200);
  ok('session เดิมใช้ /citizen ได้ทันที · ลงทะเบียนซ้ำ 409 · ล็อกอินอีกครั้ง registered:true');

  resetAll(); // reset ทำให้มานะกลับไปยังไม่ลงทะเบียน (TC step 8)
  r = await verify(MN, '123456');
  assert.deepStrictEqual(r.body, { registered: false });
  assert.strictEqual((await reg({ mobile: '081234567', consent: true }, r.sid)).body.code, 'INVALID_MOBILE');
  assert.strictEqual((await reg({ mobile: '0845678901', consent: false }, r.sid)).body.code, 'CONSENT_REQUIRED');
  ok('หลัง RESET มานะกลับเป็น registered:false (INVALID_MOBILE / CONSENT_REQUIRED ไม่ใช่ 409)');

  // ประชาชนที่ลงทะเบียนแล้ว (สมชาย) ที่ไม่ใช่ citizen ใหม่
  r = await verify(SC, '123456');
  assert.strictEqual((await call('POST', '/api/auth/register', { mobile: '0845678901', consent: true }, r.sid)).status, 409);
  // เลข checksum ถูกแต่ไม่มีใน ThaiD จำลอง: ไม่ออก session
  r = await verify('1234567890121', '123456');
  assert.strictEqual(validCheck('1234567890121'), true);
  assert.strictEqual(r.status, 401); assert.strictEqual(r.sid, null);
  ok('สมชาย (ลงทะเบียนแล้ว) สมัครซ้ำ 409 · เลขที่ไม่มีใน seed ไม่ได้ session');
}
const validCheck = (id) => { let s = 0; for (let i = 0; i < 12; i++) s += +id[i] * (13 - i); return (11 - (s % 11)) % 10 === +id[12]; };

async function staffTests() {
  console.log('FR-03 / TC-AUTH-04 / RBAC');
  resetAll();
  const T = [
    ['off.reg1', 'officer', 'registry', '/officer/queue', 'เจ้าหน้าที่ทะเบียน 1'],
    ['off.reg2', 'officer', 'registry', '/officer/queue', 'เจ้าหน้าที่ทะเบียน 2'],
    ['off.works1', 'officer', 'works', '/officer/queue', 'เจ้าหน้าที่โยธา 1'],
    ['head1', 'head', '', '/head/approvals', 'หัวหน้าฝ่าย'],
    ['exec1', 'executive', '', '/dashboard', 'ผู้บริหาร'],
    ['audit1', 'auditor', '', '/audit', 'ผู้ตรวจสอบภายใน'],
    ['admin1', 'admin', '', '/admin/services', 'ผู้ดูแลระบบ'],
  ];
  const sids = {};
  for (const [u, role, dept, landing, name] of T) {
    let r = await staff(u);
    assert.strictEqual(r.status, 200, u);
    assert.deepStrictEqual(r.body, { role, dept, landing }, u);
    assert.ok(/HttpOnly/i.test(r.setCookie));
    sids[u] = r.sid;
    r = await call('GET', '/api/me', undefined, r.sid);
    assert.deepStrictEqual(r.body, { username: u, name, role, dept, registered: true }, u);
  }
  ok('7 บัญชี: role/dept/landing/ชื่อ ถูกต้อง');

  const a = db.prepare("SELECT * FROM audit WHERE event='STAFF_LOGIN' ORDER BY id").all();
  assert.deepStrictEqual(a.map((x) => x.username), T.map((t) => t[0]));
  assert.ok(a.every((x, i) => x.role === T[i][1] && x.time === '2026-12-01T09:00:00+07:00'));
  ok('Audit STAFF_LOGIN 7 แถว (เวลาจาก clock)');

  for (const [u, p] of [['off.reg1', 'wrong'], ['off.reg1', ''], ['nobody', 'Test@1234'], ['', ''], [undefined, undefined], ['off.reg1', null]]) {
    const r = await staff(u, p); // null = ส่ง password เป็น null (ไม่ใช่สตริง)
    assert.strictEqual(r.status, 401);
    assert.deepStrictEqual(r.body, { code: 'INVALID_CREDENTIALS', message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    assert.strictEqual(r.sid, null);
  }
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM audit WHERE event='STAFF_LOGIN'").get().c, 7);
  ok('รหัสผ่านผิด/ไม่มีผู้ใช้ → 401 INVALID_CREDENTIALS · ไม่บันทึก Audit');

  // RBAC middleware
  let r = await call('GET', '/t/staff');
  assert.strictEqual(r.status, 401); assert.deepStrictEqual(r.body, { code: 'UNAUTHENTICATED', message: 'กรุณาเข้าสู่ระบบ' });
  r = await call('GET', '/t/staff', undefined, 'deadbeef');
  assert.strictEqual(r.status, 401);
  for (const u of ['exec1', 'audit1', 'admin1']) {
    r = await call('GET', '/t/staff', undefined, sids[u]);
    assert.strictEqual(r.status, 403); assert.deepStrictEqual(r.body, { code: 'FORBIDDEN', message: 'ไม่มีสิทธิ์ทำรายการนี้' });
  }
  for (const u of ['off.reg1', 'off.works1', 'head1']) assert.strictEqual((await call('GET', '/t/staff', undefined, sids[u])).status, 200);
  assert.strictEqual((await call('GET', '/t/citizen', undefined, sids['off.reg1'])).status, 403);
  assert.strictEqual((await call('GET', '/t/any', undefined, sids.admin1)).status, 200);
  ok('requireRole: 401 ไม่ล็อกอิน/คุกกี้มั่ว · 403 บทบาทไม่ตรง · ผ่านตามบทบาท');

  r = await call('GET', '/p/officer');
  assert.strictEqual(r.status, 302); assert.strictEqual(r.location, '/login');
  r = await call('GET', '/p/officer', undefined, sids.exec1);
  assert.strictEqual(r.status, 403);
  assert.ok(r.text.includes('data-testid="forbidden-msg"') && r.text.includes('ไม่มีสิทธิ์เข้าถึงหน้านี้'));
  assert.ok(r.text.includes('data-testid="app-header"') && r.text.includes('data-role="executive"') && r.text.includes('ผู้บริหาร'));
  assert.strictEqual((await call('GET', '/p/officer', undefined, sids.head1)).text, 'page-ok');
  r = await call('GET', '/p/officer', undefined, sids['off.works1']);
  assert.strictEqual(r.text, 'page-ok');
  ok('pageGuard: anon → 302 /login · บทบาทไม่ตรง → 403 + forbidden-msg + header · ผ่าน → 200');

  assert.deepStrictEqual(
    [['citizen', true], ['citizen', false], ['officer'], ['head'], ['executive'], ['auditor'], ['admin']].map((x) => landingFor(...x)),
    ['/citizen', '/register', '/officer/queue', '/head/approvals', '/dashboard', '/audit', '/admin/services']);
  ok('landingFor ตาม CONTRACT ข้อ 1');

  // logout/me
  r = await call('POST', '/api/auth/logout', undefined, sids.exec1);
  assert.strictEqual(r.status, 204);
  assert.strictEqual((await call('GET', '/api/me', undefined, sids.exec1)).status, 401);
  assert.strictEqual(util.sessions.has(sids.exec1), false);
  assert.strictEqual((await call('GET', '/api/me')).status, 401);
  assert.strictEqual((await call('POST', '/api/auth/logout')).status, 204);
  ok('logout 204 ลบ session · /api/me หลัง logout และไม่ล็อกอิน → 401');

  // admin เปลี่ยนบทบาท: session เดิมคง snapshot, ล็อกอินครั้งถัดไปอ่านสด
  db.prepare("UPDATE users SET role='auditor' WHERE username='exec1'").run();
  r = await staff('exec1');
  assert.deepStrictEqual(r.body, { role: 'auditor', dept: '', landing: '/audit' });
  db.prepare("UPDATE users SET role='officer', dept='works' WHERE username='head1'").run();
  assert.strictEqual((await call('GET', '/api/me', undefined, sids.head1)).body.role, 'head'); // session เดิมไม่เปลี่ยน
  r = await staff('head1');
  assert.deepStrictEqual(r.body, { role: 'officer', dept: 'works', landing: '/officer/queue' });
  ok('role/dept อ่านสดจาก users ทุกครั้งที่ staff login · session เดิมไม่เปลี่ยน');

  // ล็อกอินซ้ำ: session เดิมของคุกกี้นั้นถูกทิ้ง
  const first = (await staff('admin1')).sid;
  const second = await call('POST', '/api/auth/staff/login', { username: 'off.reg1', password: 'Test@1234' }, first);
  assert.strictEqual(util.sessions.has(first), false);
  assert.strictEqual((await call('GET', '/api/me', undefined, second.sid)).body.username, 'off.reg1');

  // reset ล้าง session ทุกคน
  resetAll();
  assert.strictEqual((await call('GET', '/api/me', undefined, second.sid)).status, 401);
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM audit").get().c, 0);
  ok('ล็อกอินซ้ำทิ้ง session เดิม · resetAll ล้าง session');
}

(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;
  resetAll();
  try {
    await br01(); await br02(); await br03(); await staffTests();
    console.log(`\nauth.selftest: ผ่านทั้งหมด ${n} กลุ่ม`);
  } catch (e) {
    console.error('\nFAIL', e);
    process.exitCode = 1;
  } finally {
    clock.reset();
    server.close();
  }
})();
