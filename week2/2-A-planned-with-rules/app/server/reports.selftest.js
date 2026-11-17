// B09 selftest · รัน: node server/reports.selftest.js            (ปกติ → ต้องผ่านหมด)
//                    BUG_MODE=B10 node server/reports.selftest.js (→ ต้องล้มเฉพาะ DASH-01/02/03 ตาม BUGS.md B10)
// express ชั่วคราว + ฐาน :memory: seed จริง + session ผ่าน util.sessions · เรียก API จริงด้วย fetch
// ตัวเลขที่คาด = ค่าในตาราง TEST-DATA ข้อ 7 (พิมพ์เป็นค่าคงที่ในไฟล์นี้ ไม่ดึงจากโค้ดที่ทดสอบ) · ค่าขอบเวลาตาม TC-DASH-04 / TC-AUDIT-03
process.env.DB_PATH = ':memory:';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const express = require('express');
const { db, initSchema, resetAll } = require('./db');
const clock = require('./clock');
const { sessions } = require('./util');
const audit = require('./audit');
const sla = require('./sla');
const { bug } = require('./bugs');

initSchema();
resetAll();

const app = express();
app.use(express.json());
for (const f of ['reports', 'audit', 'admin']) require(`./routes/${f}`)(app);
app.use((req, res) => res.status(404).json({ code: 'NOT_FOUND' }));

const fails = [];
let total = 0;
function eq(name, actual, expected) {
  total += 1;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { fails.push(name); console.log(`FAIL ${name}\n     expected ${e}\n     received ${a}`); }
}
const ok = (name, cond) => eq(name, !!cond, true);

let base;
const login = (username) => { // สร้าง session ตรง ๆ แบบเดียวกับ routes/auth.js
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  const sid = `t-${username}-${sessions.size}`;
  sessions.set(sid, { sid, userId: u.id, username: u.username, role: u.role, dept: u.dept, name: u.display_name, registered: true });
  return `sid=${sid}`;
};
async function call(method, url, cookie, body) {
  const r = await fetch(base + url, {
    method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const buf = Buffer.from(await r.arrayBuffer());
  const text = buf.toString('utf8');
  let json = null; try { json = JSON.parse(text); } catch { /* ไม่ใช่ JSON */ }
  return { status: r.status, headers: r.headers, buf, text, json };
}
const fresh = () => resetAll(); // ล้าง session ทุกคน + seed ใหม่ + นาฬิกา 1 ธ.ค. 09:00
const auditRows = (event) => db.prepare('SELECT * FROM audit WHERE event=? ORDER BY id').all(event);

// ---- อ่านไฟล์ที่ส่งออกกลับมา ----
function unzip(buf) { // ตัวอ่าน ZIP อิสระของ test (central directory → inflateRaw)
  const out = {};
  let eocd = buf.length - 22;
  while (buf.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < buf.readUInt16LE(eocd + 10); i += 1) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42), name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const data = buf.subarray(start, start + csize);
    out[name] = (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    p += 46 + nlen + elen + clen;
  }
  return out;
}
function sheetRows(buf) { // → [[A,B],...] ข้อความของเซลล์ (shared strings)
  const z = unzip(buf);
  const ss = [...z['xl/sharedStrings.xml'].matchAll(/<si><t>([^<]*)<\/t><\/si>/g)].map((m) => m[1]);
  return [...z['xl/worksheets/sheet1.xml'].matchAll(/<row [^>]*>(.*?)<\/row>/g)]
    .map((r) => [...r[1].matchAll(/<c [^>]*><v>(\d+)<\/v><\/c>/g)].map((c) => ss[Number(c[1])]));
}
async function exceljsRows(buf) { // โปรแกรมจริง: exceljs ของชุดทดสอบ B12 (ถ้าติดตั้งอยู่)
  let ExcelJS; try { ExcelJS = require(path.join(__dirname, '..', 'tests', 'node_modules', 'exceljs')); } catch { return null; }
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
  const ws = wb.worksheets[0], rows = [];
  ws.eachRow((row) => rows.push([row.getCell(1).value, row.getCell(2).value]));
  return rows;
}
// pdf-parse เก็บสถานะข้ามการเรียกใน process เดียว (ผลเพี้ยน) → อ่านทีละไฟล์ใน process ใหม่ จาก fs.readFileSync เหมือน test ของ B12
function pdfText(buf) {
  const lib = path.join(__dirname, '..', 'tests', 'node_modules', 'pdf-parse');
  if (!fs.existsSync(lib)) return null;
  const f = path.join(require('os').tmpdir(), `b09-${process.pid}-${total}.pdf`);
  fs.writeFileSync(f, buf);
  const r = spawnSync(process.execPath, ['-e',
    `require(${JSON.stringify(lib)})(require('fs').readFileSync(${JSON.stringify(f)})).then(t=>process.stdout.write(t.text),e=>{console.error(e.message);process.exit(1)})`],
  { encoding: 'utf8' });
  fs.unlinkSync(f);
  return r.status === 0 ? r.stdout : `ERROR ${r.stderr}`;
}
const PII = [/\d{13}/, /0\d{9}/, /สมชาย/, /สมหญิง/, /ปิติ/, /มานะ/];
const noPii = (name, text) => PII.forEach((re) => ok(`${name} ไม่พบ ${re}`, !re.test(text)));

// ---- CSV parser อิสระ (RFC 4180) ----
function parseCsv(s) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i += 1; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  row.push(cell); rows.push(row);
  return rows;
}

(async () => {
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  console.log(`BUG_MODE=${process.env.BUG_MODE || '(ไม่ตั้ง)'} B10=${bug('B10')}`);

  // ============ TC-DASH-01: ธ.ค. (นาฬิกา 1 ธ.ค. 09:00) ============
  fresh();
  const exec = login('exec1');
  const WL = [{ username: 'off.reg1', count: 3 }, { username: 'off.reg2', count: 9 }, { username: 'off.works1', count: 0 }];
  let r = await call('GET', '/api/dashboard?period=2026-12&service=ALL', exec);
  eq('DASH-01 ธ.ค. ALL', r.json, { received: 3, closed: 0, onTime: 0, ontimePct: null, backlog: 21, overdue: 1, workload: WL });
  eq('DASH-01 ไม่ส่ง query = ธ.ค./ALL', (await call('GET', '/api/dashboard', exec)).json.received, 3);
  noPii('DASH-01 JSON', r.text);
  const DEC = { 'SV-01': [3, 0, null, 11, 1], 'SV-02': [0, 0, null, 7, 0], 'SV-03': [0, 0, null, 3, 0] };
  for (const [sv, [rc, cl, pc, bl, ov]] of Object.entries(DEC)) {
    r = await call('GET', `/api/dashboard?period=2026-12&service=${sv}`, exec);
    eq(`DASH-01 ธ.ค. ${sv}`, [r.json.received, r.json.closed, r.json.ontimePct, r.json.backlog, r.json.overdue], [rc, cl, pc, bl, ov]);
    eq(`DASH-01 workload ไม่ขึ้นกับบริการ ${sv}`, r.json.workload, WL);
  }
  // สิทธิ์: executive เท่านั้น
  for (const u of ['off.reg1', 'head1', 'audit1', 'admin1']) {
    eq(`RBAC dashboard ${u} → 403`, (await call('GET', '/api/dashboard', login(u))).status, 403);
    eq(`RBAC export ${u} → 403`, (await call('GET', '/api/dashboard/export?format=xlsx', login(u))).status, 403);
  }
  eq('RBAC dashboard ไม่ล็อกอิน → 401', (await call('GET', '/api/dashboard')).status, 401);
  eq('INVALID_PERIOD', (await call('GET', '/api/dashboard?period=2026-13', exec)).json.code, 'INVALID_PERIOD');
  eq('INVALID_SERVICE', (await call('GET', '/api/dashboard?service=SV-09', exec)).json.code, 'INVALID_SERVICE');

  // ============ TC-DASH-02: ย้อนหลัง · [period, service, received, closed, onTime, ontimePct, backlog, overdue] ============
  const BL = { ALL: [21, 1], 'SV-01': [11, 1], 'SV-02': [7, 0], 'SV-03': [3, 0] };
  const HIST = [
    ['2026-10', 'ALL', 1, 1, 1, 100.0], ['2026-11', 'ALL', 26, 7, 6, 85.7],
    ['2026-11', 'SV-01', 12, 3, 3, 100.0], ['2026-11', 'SV-02', 10, 3, 2, 66.7], ['2026-11', 'SV-03', 4, 1, 1, 100.0],
    ['2026', 'ALL', 30, 8, 7, 87.5], ['2026', 'SV-01', 16, 4, 4, 100.0], ['2026', 'SV-02', 10, 3, 2, 66.7], ['2026', 'SV-03', 4, 1, 1, 100.0],
  ];
  for (const [per, sv, rc, cl, on, pc] of HIST) {
    r = await call('GET', `/api/dashboard?period=${per}&service=${sv}`, exec);
    eq(`DASH-02 ${per} ${sv} รับเรื่อง/ปิดงาน/ทัน`, [r.json.received, r.json.closed, r.json.onTime], [rc, cl, on]);
    eq(`DASH-02 ${per} ${sv} ontimePct`, r.json.ontimePct, pc);
    eq(`DASH-02 ${per} ${sv} คงค้าง/เกินกำหนด ณ ตอนนี้`, [r.json.backlog, r.json.overdue], BL[sv]);
  }
  ok('DASH-02 ปีรวมแล้วคิด % (87.5 ไม่ใช่ 92.9)', (await call('GET', '/api/dashboard?period=2026&service=ALL', exec)).json.ontimePct !== 92.9);

  // ============ TC-DASH-03: ส่งออก ============
  fresh();
  const ex2 = login('exec1');
  const LAB = ['รับเรื่อง', 'ปิดงาน', 'ทันกำหนด %', 'งานคงค้าง', 'เกินกำหนดคงค้าง'];
  const xlsxCheck = async (name, per, vals) => {
    const x = await call('GET', `/api/dashboard/export?format=xlsx&period=${per}&service=ALL`, ex2);
    eq(`${name} 200 xlsx`, [x.status, x.headers.get('content-type')], [200, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
    eq(`${name} PK header`, x.buf.subarray(0, 2).toString(), 'PK');
    const want = [['ตัวชี้วัด', 'ค่า'], ...LAB.map((l, i) => [l, vals[i]])];
    eq(`${name} แถว 1–6 (ตัวอ่านอิสระ)`, sheetRows(x.buf), want);
    const ej = await exceljsRows(x.buf);
    if (ej) eq(`${name} แถว 1–6 (exceljs)`, ej, want); else console.log(`SKIP ${name} exceljs ไม่ได้ติดตั้ง`);
    noPii(name, JSON.stringify(sheetRows(x.buf)));
  };
  await xlsxCheck('DASH-03 xlsx พ.ย.', '2026-11', ['26', '7', '85.7%', '21', '1']);
  const pd = await call('GET', '/api/dashboard/export?format=pdf&period=2026-11&service=ALL', ex2);
  eq('DASH-03 pdf Content-Type', [pd.status, pd.headers.get('content-type')], [200, 'application/pdf']);
  eq('DASH-03 pdf %PDF', pd.buf.subarray(0, 5).toString(), '%PDF-');
  eq('DASH-03 pdf บรรทัด kpi (ไบต์ดิบ)', pd.buf.toString('latin1').includes('(kpi received=26 closed=7 ontime=85.7% backlog=21 overdue=1)'), true);
  const pt = pdfText(pd.buf);
  if (pt !== null) {
    eq('DASH-03 pdf บรรทัด kpi (pdf-parse)', pt.split('\n').map((s) => s.trim()).filter((s) => s.startsWith('kpi ')),
      ['kpi received=26 closed=7 ontime=85.7% backlog=21 overdue=1']);
    noPii('DASH-03 pdf', pt);
  } else console.log('SKIP DASH-03 pdf-parse ไม่ได้ติดตั้ง');
  await xlsxCheck('DASH-03 xlsx ธ.ค.', '2026-12', ['3', '0', '–', '21', '1']);
  const pd2 = await call('GET', '/api/dashboard/export?format=pdf&period=2026-12&service=ALL', ex2);
  eq('DASH-03 pdf ธ.ค. ontime=-', pd2.buf.toString('latin1').includes('(kpi received=3 closed=0 ontime=- backlog=21 overdue=1)'), true);
  const pt2 = pdfText(pd2.buf);
  if (pt2 !== null) eq('DASH-03 pdf ธ.ค. (pdf-parse)', pt2.split('\n').map((x) => x.trim()).filter((x) => x.startsWith('kpi ')), ['kpi received=3 closed=0 ontime=- backlog=21 overdue=1']);
  eq('DASH-03 format ผิด → 400', (await call('GET', '/api/dashboard/export?format=csv', ex2)).json.code, 'INVALID_FORMAT');
  // Audit EXPORT: xlsx พ.ย. · pdf พ.ย. · xlsx ธ.ค. · pdf ธ.ค. (4 ครั้งสำเร็จ; 403/400 ไม่บันทึก)
  eq('DASH-03 Audit EXPORT', auditRows('EXPORT').map((a) => [a.username, a.role, a.detail]), [
    ['exec1', 'executive', 'xlsx 2026-11 ALL'], ['exec1', 'executive', 'pdf 2026-11 ALL'],
    ['exec1', 'executive', 'xlsx 2026-12 ALL'], ['exec1', 'executive', 'pdf 2026-12 ALL'],
  ]);

  // ============ TC-DASH-04: ค่าขอบ ============
  fresh();
  const ex3 = login('exec1');
  const closeAs = (no, status, iso) => {
    clock.set(iso);
    db.prepare('UPDATE cases SET status=?, closed_at=?, owner=NULL WHERE case_no=?').run(status, iso, `EG-2569-0000${no}`);
  };
  const dueOf = (no) => db.prepare('SELECT due_at FROM cases WHERE case_no=?').get(`EG-2569-0000${no}`).due_at;
  eq('DASH-04 กำหนดเสร็จทั้ง 3 ใบ', [25, 26, 23].map(dueOf), Array(3).fill('2026-12-03T16:30:00+07:00'));
  const dec = async () => (await call('GET', '/api/dashboard?period=2026-12&service=ALL', ex3)).json;
  closeAs(25, 'COMPLETED', '2026-12-03T16:29:59+07:00');
  let d = await dec(); eq('DASH-04 16:29:59 ทัน → ปิด/ทัน', [d.closed, d.onTime], [1, 1]);
  closeAs(26, 'REJECTED', '2026-12-03T16:30:00+07:00');
  d = await dec(); eq('DASH-04 16:30:00 ทัน (REJECTED นับ) → ปิด/ทัน', [d.closed, d.onTime], [2, 2]);
  closeAs(23, 'COMPLETED', '2026-12-03T16:30:01+07:00');
  d = await dec(); eq('DASH-04 16:30:01 ไม่ทัน → ปิด/ทัน', [d.closed, d.onTime], [3, 2]);
  eq('DASH-04 คงค้างหลังปิด 3 ใบ', d.backlog, 18);
  if (!bug('B10')) eq('DASH-04 ontimePct = 66.7', d.ontimePct, 66.7);
  eq('DASH-04 workload หลังปิด (off.reg2 9→7, off.reg1 3→2)', d.workload.map((w) => w.count), [2, 7, 0]);

  // ปัดครึ่งขึ้น (หน่วยของ pct ตรง ๆ · ไม่มีใน seed จึงทดสอบที่ฟังก์ชัน)
  const { pct } = require('./routes/reports');
  eq('pct 1/16 = 6.25 → 6.3', pct(1, 16), 6.3);
  eq('pct 5/16 = 31.25 → 31.3', pct(5, 16), 31.3);
  eq('pct 6/7', pct(6, 7), 85.7);
  eq('pct 2/3', pct(2, 3), 66.7);
  eq('pct 1/3', pct(1, 3), 33.3);
  eq('pct 7/8', pct(7, 8), 87.5);
  eq('pct 0/3 = 0 (ไม่ใช่ null)', pct(0, 3), 0);
  eq('pct x/0 = null', pct(0, 0), null);

  // ============ TC-AUDIT-03: กรองวันที่ตามเวลาไทย ============
  fresh();
  const au = login('audit1'); // login() ไม่เขียน audit (ต่างจาก auth จริง) → สร้างแถวเองตามตาราง L1..L5
  const L = [
    ['2026-11-30T23:59:59+07:00', 'off.reg1'], ['2026-12-01T00:00:00+07:00', 'off.reg2'], ['2026-12-01T23:59:59+07:00', 'off.works1'],
    ['2026-12-02T00:00:00+07:00', 'off.reg1'], ['2026-12-02T09:00:00+07:00', 'audit1'],
  ];
  for (const [iso, actor] of L) { clock.set(iso); audit({ actor, role: 'officer', event: 'STAFF_LOGIN' }); }
  clock.reset();
  const q = async (qs) => { const j = (await call('GET', `/api/audit?${qs}`, au)).json; return [j.count, j.items.map((i) => i.time)]; };
  const T = L.map((x) => x[0]);
  eq('AUDIT-03 12-01..12-01 = L2,L3 (ใหม่→เก่า)', await q('from=2026-12-01&to=2026-12-01'), [2, [T[2], T[1]]]);
  eq('AUDIT-03 11-30..11-30 = L1', await q('from=2026-11-30&to=2026-11-30'), [1, [T[0]]]);
  eq('AUDIT-03 11-30..12-01 = L1 L2 L3', await q('from=2026-11-30&to=2026-12-01'), [3, [T[2], T[1], T[0]]]);
  eq('AUDIT-03 from 12-02 = L4 L5', await q('from=2026-12-02'), [2, [T[4], T[3]]]);
  eq('AUDIT-03 to 11-30 = L1', await q('to=2026-11-30'), [1, [T[0]]]);
  eq('AUDIT-03 12-01..12-02 = L2..L5', await q('from=2026-12-01&to=2026-12-02'), [4, [T[4], T[3], T[2], T[1]]]);
  eq('AUDIT-03 + actor off.reg2 = L2', await q('from=2026-12-01&to=2026-12-01&actor=off.reg2'), [1, [T[1]]]);
  eq('AUDIT-03 from ผิดรูปแบบ → 400', (await call('GET', '/api/audit?from=1/12/2026', au)).json.code, 'INVALID_DATE');
  // ลำดับ: เวลาเท่ากันเรียง id มาก → น้อย · ฟิลด์ครบ
  clock.set('2026-12-05T10:00:00+07:00');
  const a1 = audit({ actor: 'off.reg1', role: 'officer', event: 'CLAIM', caseNo: 'EG-2569-000028', fromStatus: 'SUBMITTED', toStatus: 'IN_REVIEW' });
  const a2 = audit({ actor: 'off.reg2', role: 'officer', event: 'UNMASK', caseNo: 'EG-2569-000025', detail: 'ตรวจสอบตัวตนซ้ำ' });
  clock.reset();
  r = await call('GET', '/api/audit', au);
  eq('AUDIT sorted: id เท่ากันเวลา → มากก่อน', r.json.items.slice(0, 2).map((i) => i.id), [a2, a1]);
  eq('AUDIT ฟิลด์แถว CLAIM', r.json.items[1], { id: a1, time: '2026-12-05T10:00:00+07:00', username: 'off.reg1', role: 'officer', event: 'CLAIM',
    caseNo: 'EG-2569-000028', fromStatus: 'SUBMITTED', toStatus: 'IN_REVIEW', detail: '' });
  eq('AUDIT count = items', r.json.count, r.json.items.length);
  eq('AUDIT event filter', (await call('GET', '/api/audit?event=UNMASK', au)).json.items.map((i) => i.id), [a2]);
  eq('AUDIT สิทธิ์ admin → 403', (await call('GET', '/api/audit', login('admin1'))).status, 403);
  eq('AUDIT สิทธิ์ exec → 403', (await call('GET', '/api/audit', login('exec1'))).status, 403);
  eq('AUDIT ไม่ล็อกอิน → 401', (await call('GET', '/api/audit')).status, 401);

  // ============ TC-AUDIT-02: 405 ============
  const before = db.prepare('SELECT * FROM audit ORDER BY id').all();
  const firstId = (await call('GET', '/api/audit', au)).json.items[0].id;
  for (const who of ['admin1', 'audit1', 'exec1', 'off.reg1']) {
    const ck = login(who);
    for (const [m, u] of [['PUT', `/api/audit/${firstId}`], ['PATCH', `/api/audit/${firstId}`], ['DELETE', `/api/audit/${firstId}`],
      ['PUT', '/api/audit'], ['PATCH', '/api/audit'], ['DELETE', '/api/audit'], ['DELETE', '/api/audit/999999'], ['PUT', '/api/audit/999999']]) {
      r = await call(m, u, ck, m === 'DELETE' ? undefined : { detail: 'x' });
      eq(`AUDIT-02 ${who} ${m} ${u}`, [r.status, r.json && r.json.code, r.json && r.json.message], [405, 'METHOD_NOT_ALLOWED', 'Method Not Allowed']);
    }
  }
  eq('AUDIT-02 ไม่ล็อกอิน DELETE → 405', (await call('DELETE', '/api/audit/1')).status, 405);
  eq('AUDIT-02 แถวเดิมไม่เปลี่ยน', db.prepare('SELECT * FROM audit ORDER BY id').all(), before);

  // ============ CSV ============
  fresh();
  const au2 = login('audit1');
  clock.set('2026-12-02T09:00:00+07:00');
  audit({ actor: 'off.reg1', role: 'officer', event: 'RETURN', caseNo: 'EG-2569-000020', fromStatus: 'IN_REVIEW', toStatus: 'NEED_FIX', detail: 'ขาดเอกสาร, "บัตร"\nบรรทัดสอง' });
  clock.set('2026-12-03T09:00:00+07:00');
  audit({ actor: 'off.reg2', role: 'officer', event: 'CLAIM', caseNo: 'EG-2569-000028', fromStatus: 'SUBMITTED', toStatus: 'IN_REVIEW' });
  audit({ actor: 'head1', role: 'head', event: 'STAFF_LOGIN' });
  clock.reset();
  const js = (await call('GET', '/api/audit', au2)).json.items; // ก่อนส่งออก (การส่งออกเพิ่มแถว EXPORT)
  r = await call('GET', '/api/audit/export.csv', au2);
  eq('CSV 200 + Content-Type', [r.status, /^text\/csv; charset=utf-8/i.test(r.headers.get('content-type'))], [200, true]);
  eq('CSV แถวแรก', r.text.split('\n')[0], 'time,username,role,event,caseNo,fromStatus,toStatus,detail');
  eq('CSV ไม่มี BOM', r.buf[0] !== 0xEF, true);
  const rows = parseCsv(r.text);
  eq('CSV จำนวนแถวข้อมูล = JSON', rows.length - 1, js.length);
  eq('CSV เนื้อหา+ลำดับ = JSON (escape , " ขึ้นบรรทัดใหม่)', rows.slice(1),
    js.map((i) => [i.time, i.username, i.role, i.event, i.caseNo || '', i.fromStatus || '', i.toStatus || '', i.detail]));
  ok('CSV detail มี " ถูก escape เป็น ""', r.text.includes('"ขาดเอกสาร, ""บัตร""\nบรรทัดสอง"'));
  r = await call('GET', '/api/audit/export.csv?actor=off.reg2&from=2026-12-03&to=2026-12-03', au2);
  eq('CSV ตามตัวกรอง', parseCsv(r.text).slice(1).map((x) => x[3]), ['CLAIM']);
  eq('CSV Audit EXPORT audit-csv (2 ครั้ง)', auditRows('EXPORT').map((a) => [a.username, a.role, a.detail]), [['audit1', 'auditor', 'audit-csv'], ['audit1', 'auditor', 'audit-csv']]);
  eq('CSV หลังส่งออก count เพิ่ม', (await call('GET', '/api/audit', au2)).json.count, js.length + 2);
  eq('CSV admin → 403', (await call('GET', '/api/audit/export.csv', login('admin1'))).status, 403);
  eq('CSV PUT → 405', (await call('PUT', '/api/audit/export.csv', au2)).status, 405);

  // ============ TC-RBAC-04 / TC-RBAC-06: admin ============
  fresh();
  const ad = login('admin1');
  const svc = async (id) => (await call('GET', '/api/admin/services', ad)).json.items.find((s) => s.id === id);
  r = await call('GET', '/api/admin/services', ad);
  eq('ADMIN GET services', r.json.items.map((s) => [s.id, s.fee, s.feePerSqm, s.sla]), [['SV-01', 20, 0, 3], ['SV-02', 500, 0, 10], ['SV-03', 1000, 10, 15]]);
  eq('ADMIN SV-03 feeBase', r.json.items[2].feeBase, 1000);
  for (const u of ['exec1', 'off.reg1', 'audit1', 'head1']) {
    for (const [m, p, b] of [['GET', '/api/admin/services'], ['PUT', '/api/admin/services/SV-01', { fee: 21 }], ['GET', '/api/admin/holidays'],
      ['POST', '/api/admin/holidays', { date: '2027-05-05', name: 'x' }], ['DELETE', '/api/admin/holidays/2026-12-07'],
      ['GET', '/api/admin/users'], ['PUT', '/api/admin/users/audit1', { role: 'executive', dept: '' }]]) {
      eq(`ADMIN ${u} ${m} ${p} → 403`, (await call(m, p, login(u), b)).status, 403);
    }
  }
  eq('ADMIN ไม่ล็อกอิน → 401', (await call('GET', '/api/admin/services')).status, 401);
  eq('ADMIN ไม่มีสิทธิ์ ไม่แก้ค่า/ไม่เขียน audit', [(await svc('SV-01')).fee, auditRows('ADMIN_CHANGE').length], [20, 0]);

  // RBAC-06 ช่วงค่า (ลำดับตามตาราง)
  const FEE_MSG = 'ค่าธรรมเนียมต้องเป็นจำนวนเต็ม 0–100,000 บาท', SLA_MSG = 'SLA ต้องเป็นจำนวนเต็ม 1–60 วันทำการ';
  const put = (body) => call('PUT', '/api/admin/services/SV-01', ad, body);
  const bad = async (name, body, code, msg, keep) => {
    r = await put(body);
    eq(`RBAC-06 ${name}`, [r.status, r.json.code, r.json.message], [400, code, msg]);
    eq(`RBAC-06 ${name} ค่าไม่เปลี่ยน`, keep(await svc('SV-01')), true);
  };
  await bad('fee −1', { fee: -1 }, 'INVALID_FEE', FEE_MSG, (s) => s.fee === 20);
  eq('RBAC-06 fee 0 → 200', (await put({ fee: 0 })).status, 200);
  eq('RBAC-06 fee 0 เก็บแล้ว', (await svc('SV-01')).fee, 0);
  eq('RBAC-06 fee 100000 → 200', (await put({ fee: 100000 })).status, 200);
  await bad('fee 100001', { fee: 100001 }, 'INVALID_FEE', FEE_MSG, (s) => s.fee === 100000);
  await bad('fee 12.5', { fee: 12.5 }, 'INVALID_FEE', FEE_MSG, (s) => s.fee === 100000);
  await bad('fee "abc"', { fee: 'abc' }, 'INVALID_FEE', FEE_MSG, (s) => s.fee === 100000);
  await bad('sla 0', { sla: 0 }, 'INVALID_SLA', SLA_MSG, (s) => s.sla === 3);
  eq('RBAC-06 sla 1 → 200', (await put({ sla: 1 })).status, 200);
  eq('RBAC-06 sla 60 → 200', (await put({ sla: 60 })).status, 200);
  await bad('sla 61', { sla: 61 }, 'INVALID_SLA', SLA_MSG, (s) => s.sla === 60);
  await bad('sla 2.5', { sla: 2.5 }, 'INVALID_SLA', SLA_MSG, (s) => s.sla === 60);
  await bad('fee ถูก + sla ผิด → ไม่แก้ fee', { fee: 7, sla: 0 }, 'INVALID_SLA', SLA_MSG, (s) => s.fee === 100000);
  r = await call('POST', '/api/admin/holidays', ad, { date: '2026-12-07', name: 'ซ้ำ' });
  eq('RBAC-06 วันหยุดซ้ำ', [r.status, r.json.code, r.json.message], [409, 'DUPLICATE_HOLIDAY', 'มีวันหยุดนี้อยู่แล้ว']);
  eq('RBAC-06 holiday ยัง 4', (await call('GET', '/api/admin/holidays', ad)).json.items.length, 4);
  eq('RBAC-06 วันเสาร์ 2026-12-05 → 201', (await call('POST', '/api/admin/holidays', ad, { date: '2026-12-05', name: 'วันเสาร์' })).status, 201);
  eq('RBAC-06 วันที่ไม่มีจริง → 400', (await call('POST', '/api/admin/holidays', ad, { date: '2026-02-30', name: 'x' })).status, 400);
  r = await call('PUT', '/api/admin/users/admin1', ad, { role: 'executive', dept: '' });
  eq('RBAC-06 SELF_ROLE_CHANGE', [r.status, r.json.code, r.json.message], [409, 'SELF_ROLE_CHANGE', 'ไม่สามารถเปลี่ยนบทบาทของตัวเองได้']);
  eq('RBAC-06 admin1 ยัง admin', db.prepare("SELECT role FROM users WHERE username='admin1'").get().role, 'admin');
  eq('RBAC-06 Audit ADMIN_CHANGE = 5 (ปฏิเสธไม่บันทึก)', auditRows('ADMIN_CHANGE').map((a) => a.detail), [
    'SV-01 fee 20 → 0', 'SV-01 fee 0 → 100000', 'SV-01 sla 3 → 1', 'SV-01 sla 1 → 60', 'holiday add 2026-12-05']);
  eq('RBAC-06 Audit ผู้ทำ', [...new Set(auditRows('ADMIN_CHANGE').map((a) => a.username + '/' + a.role))], ['admin1/admin']);

  // RBAC-04 ลำดับธุรกิจ
  fresh();
  const ad2 = login('admin1');
  eq('RBAC-04 holiday 4 แถว', (await call('GET', '/api/admin/holidays', ad2)).json.items.map((h) => h.date), ['2026-12-07', '2026-12-10', '2026-12-31', '2027-01-01']);
  eq('RBAC-04 dueAt ก่อนเพิ่มวันหยุด', sla.computeDue('2026-12-01T09:00:00+07:00', 3), '2026-12-04T16:30:00+07:00');
  r = await call('PUT', '/api/admin/services/SV-01', ad2, { fee: 25, sla: 3 });
  eq('RBAC-04 SV-01 fee 25', [r.status, r.json.fee, r.json.sla], [200, 25, 3]);
  eq('RBAC-04 SV-02 fee 600', (await call('PUT', '/api/admin/services/SV-02', ad2, { fee: 600 })).json.fee, 600);
  eq('RBAC-04 เฉพาะค่าที่เปลี่ยนจริงถูกบันทึก (sla 3 → 3 ไม่บันทึก)', auditRows('ADMIN_CHANGE').map((a) => a.detail), ['SV-01 fee 20 → 25', 'SV-02 fee 500 → 600']);
  eq('RBAC-04 คำขอเดิม fee ยัง ฿20 (A-42)', db.prepare("SELECT fee FROM cases WHERE case_no='EG-2569-000030'").get().fee, 20);
  eq('RBAC-04 ร่าง DR-0002 ยอดล็อก ฿500 (A-42)', db.prepare("SELECT fee FROM drafts WHERE draft_id='DR-0002'").get().fee, 500);
  eq('RBAC-04 SV-01 sla 5', (await call('PUT', '/api/admin/services/SV-01', ad2, { sla: 5 })).status, 200);
  eq('RBAC-04 detail sla', auditRows('ADMIN_CHANGE')[2].detail, 'SV-01 sla 3 → 5');
  // SV-03
  r = await call('PUT', '/api/admin/services/SV-03', ad2, { feeBase: 1000, feePerSqm: 10, sla: 15 });
  eq('RBAC-04 SV-03 ไม่เปลี่ยน → 200 ไม่บันทึก', [r.status, auditRows('ADMIN_CHANGE').length], [200, 3]);
  r = await call('PUT', '/api/admin/services/SV-03', ad2, { feeBase: 1200, feePerSqm: 12, sla: 20 });
  eq('RBAC-04 SV-03 แก้ 3 ค่า', [r.status, r.json.feeBase, r.json.feePerSqm, r.json.sla], [200, 1200, 12, 20]);
  eq('RBAC-04 SV-03 detail', auditRows('ADMIN_CHANGE').slice(3).map((a) => a.detail), ['SV-03 feeBase 1000 → 1200', 'SV-03 feePerSqm 10 → 12', 'SV-03 sla 15 → 20']);
  eq('RBAC-04 SV-03 feePerSqm 100001 → 400', (await call('PUT', '/api/admin/services/SV-03', ad2, { feePerSqm: 100001 })).json.code, 'INVALID_FEE');
  eq('RBAC-04 บริการไม่มี → 404', (await call('PUT', '/api/admin/services/SV-99', ad2, { fee: 1 })).status, 404);
  // วันหยุด: เพิ่ม → มีผลกับการคำนวณใหม่ · ไม่แตะ dueAt เดิม (A-42)
  const dueBefore = db.prepare('SELECT case_no, due_at FROM cases ORDER BY case_no').all();
  r = await call('POST', '/api/admin/holidays', ad2, { date: '2026-12-02', name: 'วันหยุดทดสอบ' });
  eq('RBAC-04 เพิ่มวันหยุด 201', [r.status, r.json], [201, { date: '2026-12-02', name: 'วันหยุดทดสอบ' }]);
  eq('RBAC-04 holiday 5 แถว', (await call('GET', '/api/admin/holidays', ad2)).json.items.length, 5);
  eq('RBAC-04 dueAt เดิมไม่ถูกคำนวณใหม่', db.prepare('SELECT case_no, due_at FROM cases ORDER BY case_no').all(), dueBefore);
  eq('RBAC-04 dueAt ใหม่ข้าม 2 ธ.ค. → 8 ธ.ค. (SLA 3)', sla.computeDue('2026-12-01T09:00:00+07:00', 3), '2026-12-08T16:30:00+07:00');
  eq('RBAC-04 detail holiday add', auditRows('ADMIN_CHANGE').pop().detail, 'holiday add 2026-12-02');
  // ผู้ใช้
  r = await call('GET', '/api/admin/users', ad2);
  eq('RBAC-04 users 7 คน (เจ้าหน้าที่/บทบาทอื่น ไม่มีประชาชน)', r.json.items.map((u) => u.username),
    ['off.reg1', 'off.reg2', 'off.works1', 'head1', 'exec1', 'audit1', 'admin1']);
  ok('RBAC-04 users ไม่มีรหัสผ่าน/เลขบัตร', !/password|id_no|mobile|hash/i.test(r.text));
  r = await call('PUT', '/api/admin/users/exec1', ad2, { role: 'auditor', dept: '' });
  eq('RBAC-04 exec1 → auditor', [r.status, r.json.role, db.prepare("SELECT role FROM users WHERE username='exec1'").get().role], [200, 'auditor', 'auditor']);
  eq('RBAC-04 detail role', auditRows('ADMIN_CHANGE').pop().detail, 'exec1 role executive → auditor');
  r = await call('PUT', '/api/admin/users/off.reg1', ad2, { role: 'officer', dept: 'works' });
  eq('RBAC-04 dept เปลี่ยน', [r.status, auditRows('ADMIN_CHANGE').pop().detail], [200, 'off.reg1 dept registry → works']);
  const n0 = auditRows('ADMIN_CHANGE').length;
  eq('RBAC-04 role ผิด → 400', (await call('PUT', '/api/admin/users/head1', ad2, { role: 'root', dept: '' })).json.code, 'INVALID_ROLE');
  eq('RBAC-04 dept ผิด → 400', (await call('PUT', '/api/admin/users/head1', ad2, { role: 'head', dept: 'x' })).json.code, 'INVALID_DEPT');
  eq('RBAC-04 ผู้ใช้ไม่มี → 404', (await call('PUT', '/api/admin/users/nobody', ad2, { role: 'head', dept: '' })).status, 404);
  eq('RBAC-04 ปฏิเสธแล้วไม่บันทึก', auditRows('ADMIN_CHANGE').length, n0);
  r = await call('DELETE', '/api/admin/holidays/2026-12-02', ad2);
  eq('RBAC-04 ลบวันหยุด', [r.status, (await call('GET', '/api/admin/holidays', ad2)).json.items.length, auditRows('ADMIN_CHANGE').pop().detail], [200, 4, 'holiday delete 2026-12-02']);
  eq('RBAC-04 ลบซ้ำ → 404', (await call('DELETE', '/api/admin/holidays/2026-12-02', ad2)).status, 404);

  // ============ จบ ============
  server.close();
  console.log(`\n${total - fails.length}/${total} ผ่าน${fails.length ? ` · ล้ม ${fails.length}: ${fails.join(' | ')}` : ''}`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
