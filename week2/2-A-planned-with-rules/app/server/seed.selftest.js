// รัน: node server/seed.selftest.js · ใช้ฐานข้อมูลไฟล์ชั่วคราว (เพื่อ grep ไฟล์จริง) แล้วลบทิ้ง · ล้ม = throw
// ตัวเลขคาดหวังพิมพ์ตรงจาก TEST-DATA (ข้อ 7, 9) · ค่าจริงคำนวณจาก DB ด้วยกฎ BR-14/16/25 เอง ไม่เรียกโค้ดของบล็อกอื่น
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const tmp = path.join(os.tmpdir(), `seed-selftest-${process.pid}.db`);
process.env.DB_PATH = tmp;
const clock = require('./clock');
const u = require('./util');
const { db, initSchema, resetAll, nextNumber } = require('./db');
const { SIGN_KEY, signDocument } = require('./seed');

initSchema();
resetAll();
const cn = (n) => u.formatNo('EG', 2569, n);
const all = (sql, ...a) => db.prepare(sql).all(...a).map((r) => ({ ...r }));
const get = (sql, ...a) => { const r = db.prepare(sql).get(...a); return r && { ...r }; };
const ms = (iso) => clock.parseISO(iso).getTime();
const NOW = clock.now();

// ---- วันทำการ (จ.-ศ. ที่ไม่อยู่ในตารางวันหยุด) ----
const hol = new Set(all('SELECT date FROM holidays').map((r) => r.date));
const dk = (d) => d.toISOString().slice(0, 10);
const isWork = (d) => d.getUTCDay() % 6 !== 0 && !hol.has(dk(d));
const day = (key) => new Date(key + 'T00:00:00Z');
const addWork = (key, n) => { const d = day(key); while (n > 0) { d.setUTCDate(d.getUTCDate() + 1); if (isWork(d)) n--; } return dk(d); };
const nextWork = (key) => { const d = day(key); while (!isWork(d)) d.setUTCDate(d.getUTCDate() + 1); return dk(d); };
const remaining = (fromKey, dueKey) => { let c = 0; for (const d = day(fromKey); dk(d) < dueKey;) { d.setUTCDate(d.getUTCDate() + 1); if (isWork(d)) c++; } return c; };
const level = (c) => (NOW.getTime() > ms(c.due_at) ? 'overdue' : remaining(u.thaiDateKey(NOW), c.due_at.slice(0, 10)) <= 1 ? 'near' : 'normal');

// ---- 1. จำนวนและตัวนับ ----
assert.strictEqual(get('SELECT COUNT(*) n FROM cases').n, 30);
assert.strictEqual(get('SELECT COUNT(*) n FROM users').n, 4 + 7);
assert.strictEqual(get('SELECT COUNT(*) n FROM services').n, 3);
assert.strictEqual(get('SELECT COUNT(*) n FROM holidays').n, 4);
assert.strictEqual(get('SELECT COUNT(*) n FROM audit').n, 0);
assert.strictEqual(get('SELECT COUNT(*) n FROM notifications').n, 0);
assert.strictEqual(get('SELECT COUNT(*) n FROM documents').n, 1);
assert.strictEqual(get("SELECT COUNT(*) n FROM cases WHERE receipt_no IS NULL").n, 0);
for (let n = 1; n <= 30; n++) assert.strictEqual(get('SELECT receipt_no r FROM cases WHERE case_no=?', cn(n)).r, u.formatNo('RC', 2569, n));
assert.deepStrictEqual(all('SELECT draft_id,service_id,status,fee FROM drafts ORDER BY draft_id'),
  [{ draft_id: 'DR-0001', service_id: 'SV-01', status: 'DRAFT', fee: 40 }, { draft_id: 'DR-0002', service_id: 'SV-02', status: 'PENDING_PAYMENT', fee: 500 }]);
const pp = get("SELECT * FROM payments");
assert.deepStrictEqual([pp.ref, pp.draft_id, pp.amount, pp.status, pp.qr_created_at, pp.qr_expires_at],
  ['PP-0001', 'DR-0002', 500, 'PENDING', '2026-12-01T08:55:00+07:00', '2026-12-01T09:10:00+07:00']);
// เลขถัดไป (ข้อ 12): nextNumber ใน transaction แล้ว rollback ไม่ได้ใช้ ตรวจจากตาราง counters ตรง ๆ
const ctr = Object.fromEntries(all('SELECT kind,year,next FROM counters').map((r) => [`${r.kind}-${r.year}`, r.next]));
assert.deepStrictEqual(ctr, { 'EG-2569': 31, 'RC-2569': 31, 'DOC-2569': 2, 'DR-0': 3, 'PP-0': 2 });
assert.strictEqual(u.formatNo('EG', 2569, ctr['EG-2569']), 'EG-2569-000031');
assert.strictEqual(u.formatNo('RC', 2569, ctr['RC-2569']), 'RC-2569-000031');
assert.strictEqual(u.formatNo('DOC', 2569, ctr['DOC-2569']), 'DOC-2569-000002');
assert.strictEqual(u.formatNo('DR', 0, ctr['DR-0'], 4), 'DR-0003');
assert.strictEqual(u.formatNo('PP', 0, ctr['PP-0'], 4), 'PP-0002');

// จำนวนคำขอต่อผู้ยื่น (ตาราง 1.1: สมชาย 10 · สมหญิง 11 · ปิติ 9 · มานะ 0)
for (const [name, n] of [['สมชาย ใจดี', 10], ['สมหญิง รักไทย', 11], ['ปิติ มีสุข', 9], ['มานะ ตั้งใจ', 0]]) {
  assert.strictEqual(get('SELECT COUNT(*) n FROM cases c JOIN users x ON x.id=c.user_id WHERE x.display_name=?', name).n, n, name);
}

// ---- 2. บัญชี ----
const ids = { 'สมชาย ใจดี': '1101700123456', 'สมหญิง รักไทย': '3100600987659', 'มานะ ตั้งใจ': '5500400111221', 'ปิติ มีสุข': '1909900555015' };
for (const [name, id] of Object.entries(ids)) {
  const r = get('SELECT * FROM users WHERE id_hash=?', u.hashId(id));
  assert.ok(r && r.display_name === name && r.role === 'citizen', name);
  assert.strictEqual(u.decrypt(r.id_no_enc), id);
  assert.strictEqual(r.id_masked, u.maskId(id));
  assert.strictEqual(r.username, null);
}
assert.strictEqual(get("SELECT registered r FROM users WHERE display_name='มานะ ตั้งใจ'").r, 0);
assert.strictEqual(get("SELECT mobile_enc m FROM users WHERE display_name='มานะ ตั้งใจ'").m, null);
assert.strictEqual(u.decrypt(get("SELECT mobile_enc m FROM users WHERE display_name='สมชาย ใจดี'").m), '0812345678');
assert.strictEqual(get("SELECT COUNT(*) n FROM users WHERE id_hash=?", u.hashId('1101700123457')).n, 0); // checksum ผิดไม่มีบัญชี
for (const [un, role, dept] of [['off.reg1', 'officer', 'registry'], ['off.reg2', 'officer', 'registry'], ['off.works1', 'officer', 'works'], ['head1', 'head', ''], ['exec1', 'executive', ''], ['audit1', 'auditor', ''], ['admin1', 'admin', '']]) {
  const r = get('SELECT * FROM users WHERE username=?', un);
  assert.ok(r && r.role === role && r.dept === dept, un);
  assert.ok(u.verifyPassword('Test@1234', r.password_hash) && !u.verifyPassword('test@1234', r.password_hash), un);
}

// ---- 3. คิว (ข้อ 9) · เรียงตาม BR-16: due_at แล้วเลขคำขอ ----
const byQueue = (a, b) => ms(a.due_at) - ms(b.due_at) || a.case_no.localeCompare(b.case_no);
const regQueue = all("SELECT * FROM cases WHERE dept='registry' AND status IN ('SUBMITTED','IN_REVIEW','APPROVED')").sort(byQueue);
// [เลข, บริการ, สถานะ, ผู้ถือ, กำหนดเสร็จ, ระดับ] ตาราง 9.1 แถว 1-17
const Q91 = [
  [20, 'SV-01', 'IN_REVIEW', 'off.reg1', '2026-11-30T16:30', 'overdue'], [22, 'SV-01', 'IN_REVIEW', 'off.reg1', '2026-12-01T16:30', 'near'],
  [24, 'SV-01', 'SUBMITTED', null, '2026-12-02T16:30', 'near'], [23, 'SV-01', 'IN_REVIEW', 'off.reg1', '2026-12-03T16:30', 'normal'],
  [25, 'SV-01', 'IN_REVIEW', 'off.reg2', '2026-12-03T16:30', 'normal'], [26, 'SV-01', 'IN_REVIEW', 'off.reg2', '2026-12-03T16:30', 'normal'],
  [13, 'SV-02', 'IN_REVIEW', 'off.reg2', '2026-12-04T16:30', 'normal'], [15, 'SV-02', 'IN_REVIEW', 'off.reg2', '2026-12-04T16:30', 'normal'],
  [27, 'SV-01', 'IN_REVIEW', 'off.reg2', '2026-12-04T16:30', 'normal'], [28, 'SV-01', 'SUBMITTED', null, '2026-12-04T16:30', 'normal'],
  [29, 'SV-01', 'SUBMITTED', null, '2026-12-04T16:30', 'normal'], [30, 'SV-01', 'SUBMITTED', null, '2026-12-04T16:30', 'normal'],
  [16, 'SV-02', 'IN_REVIEW', 'off.reg2', '2026-12-08T16:30', 'normal'], [18, 'SV-02', 'IN_REVIEW', 'off.reg2', '2026-12-09T16:30', 'normal'],
  [19, 'SV-02', 'APPROVED', null, '2026-12-09T16:30', 'normal'], [12, 'SV-03', 'IN_REVIEW', 'off.reg2', '2026-12-11T16:30', 'normal'],
  [21, 'SV-02', 'IN_REVIEW', 'off.reg2', '2026-12-11T16:30', 'normal'],
];
assert.strictEqual(regQueue.length, 17);
assert.deepStrictEqual(
  regQueue.map((c) => [c.case_no, c.service_id, c.status, c.owner, c.due_at.slice(0, 16), level(c)]),
  Q91.map(([n, s, st, o, d, l]) => [cn(n), s, st, o, d, l]));
assert.deepStrictEqual(regQueue.filter((c) => !c.owner && c.status !== 'APPROVED').map((c) => c.case_no), [24, 28, 29, 30].map(cn)); // unclaimed
assert.strictEqual(regQueue.filter((c) => c.owner === 'off.reg1' && c.status === 'IN_REVIEW').length, 3);
assert.strictEqual(regQueue.filter((c) => c.owner === 'off.reg2' && c.status === 'IN_REVIEW').length, 9);
const works = all("SELECT * FROM cases WHERE dept='works' AND status IN ('SUBMITTED','IN_REVIEW')").sort(byQueue);
assert.deepStrictEqual(works.map((c) => [c.case_no, c.step, c.owner, c.due_at.slice(0, 16)]), [[cn(10), 2, null, '2026-12-03T16:30']]);
assert.strictEqual(get("SELECT COUNT(*) n FROM cases WHERE owner='off.works1'").n, 0);
const appr = all("SELECT * FROM cases WHERE status='PENDING_APPROVAL'").sort(byQueue);
assert.deepStrictEqual(appr.map((c) => c.case_no), [cn(14), cn(11)]);
assert.deepStrictEqual(all("SELECT case_no FROM cases WHERE status IN ('NEED_FIX')").map((r) => r.case_no), [cn(17)]); // ไม่อยู่ในคิว

// ---- 4. KPI (BR-25) คำนวณเองจาก DB ----
const kpi = (period, svc) => {
  const cs = all('SELECT * FROM cases').filter((c) => !svc || c.service_id === svc);
  const received = cs.filter((c) => c.paid_at.startsWith(period)).length;
  const closed = cs.filter((c) => ['COMPLETED', 'REJECTED'].includes(c.status) && c.closed_at.startsWith(period));
  const ontime = closed.filter((c) => ms(c.closed_at) <= ms(c.due_at)).length;
  const pct = closed.length ? (Math.round((ontime / closed.length) * 1000 + 1e-9) / 10).toFixed(1) : '–';
  const open = cs.filter((c) => ['SUBMITTED', 'IN_REVIEW', 'NEED_FIX', 'PENDING_APPROVAL', 'APPROVED'].includes(c.status));
  const overdue = open.filter((c) => c.status !== 'NEED_FIX' && NOW.getTime() > ms(c.due_at)).length;
  return { received, closed: closed.length, ontime, pct, backlog: open.length, overdue };
};
const E = (received, closed, ontime, pct, backlog, overdue) => ({ received, closed, ontime, pct, backlog, overdue });
assert.deepStrictEqual(kpi('2026-12'), E(3, 0, 0, '–', 21, 1)); // 7.1
assert.deepStrictEqual(kpi('2026-12', 'SV-01'), E(3, 0, 0, '–', 11, 1)); // 7.2
assert.deepStrictEqual(kpi('2026-12', 'SV-02'), E(0, 0, 0, '–', 7, 0));
assert.deepStrictEqual(kpi('2026-12', 'SV-03'), E(0, 0, 0, '–', 3, 0));
assert.deepStrictEqual(kpi('2026-11'), E(26, 7, 6, '85.7', 21, 1)); // 7.3
assert.deepStrictEqual(kpi('2026-11', 'SV-01'), E(12, 3, 3, '100.0', 11, 1));
assert.deepStrictEqual(kpi('2026-11', 'SV-02'), E(10, 3, 2, '66.7', 7, 0));
assert.deepStrictEqual(kpi('2026-11', 'SV-03'), E(4, 1, 1, '100.0', 3, 0));
assert.deepStrictEqual(kpi('2026-10'), E(1, 1, 1, '100.0', 21, 1));
assert.deepStrictEqual(kpi('2026'), E(30, 8, 7, '87.5', 21, 1));
assert.deepStrictEqual(kpi('2026', 'SV-01'), E(16, 4, 4, '100.0', 11, 1));
assert.deepStrictEqual(kpi('2026', 'SV-02'), E(10, 3, 2, '66.7', 7, 0));
assert.deepStrictEqual(kpi('2026', 'SV-03'), E(4, 1, 1, '100.0', 3, 0));
// ตัวชี้วัดต้องมาจากตัวหารปิดงาน ไม่ใช่รับเรื่อง (กันบั๊ก B10 ในข้อมูล): 6/26 = 23.1 ≠ 85.7
assert.notStrictEqual((6 / 26 * 100).toFixed(1), kpi('2026-11').pct);

// ---- 5. ความสอดคล้องของ dueAt ใน TEST-DATA (ตรวจ ไม่ปรับ): paid + SLA วันทำการ + หยุดนับ · หลัง 16:30 นับจากวันทำการถัดไป ----
const sla = Object.fromEntries(all('SELECT id,sla FROM services').map((r) => [r.id, r.sla]));
const paused = Object.fromEntries(all('SELECT case_no, SUM(paused_days) p FROM case_returns GROUP BY case_no').map((r) => [r.case_no, r.p || 0]));
for (const c of all('SELECT * FROM cases')) {
  const d = u.thaiDateKey(c.paid_at), late = c.paid_at.slice(11, 16) >= '16:30';
  const base = late ? addWork(nextWork(d), 1) : nextWork(d); // D0
  const want = addWork(base, sla[c.service_id] + (paused[c.case_no] || 0)) + 'T16:30:00+07:00';
  assert.strictEqual(c.due_at, want, `${c.case_no} dueAt ตาม TEST-DATA ไม่ตรงกฎ (paid ${c.paid_at}, SLA ${sla[c.service_id]})`);
}

// ---- 6. ไฟล์แนบ · ตีกลับ · เอกสาร · ใบเสร็จ ----
for (const [svc, keys] of Object.entries({ 'SV-01': 'id-card', 'SV-02': 'id-card,map', 'SV-03': 'id-card,plan,deed' })) {
  for (const c of all('SELECT case_no FROM cases WHERE service_id=?', svc)) {
    assert.strictEqual(all('SELECT doc_key FROM files WHERE case_no=? ORDER BY file_id', c.case_no).map((f) => f.doc_key).join(','), keys, c.case_no);
  }
}
for (const f of all('SELECT * FROM files')) {
  assert.strictEqual(f.size, 1024); assert.strictEqual(f.content.length, 1024); assert.strictEqual(Buffer.from(f.content).subarray(0, 4).toString(), '%PDF');
}
assert.strictEqual(all("SELECT * FROM files WHERE draft_id='DR-0002'").length, 2);
assert.strictEqual(all("SELECT * FROM files WHERE draft_id='DR-0001'").length, 0);
assert.deepStrictEqual(all('SELECT case_no,seq,returned_at,resubmitted_at,paused_days FROM case_returns ORDER BY case_no,seq'), [
  { case_no: cn(17), seq: 1, returned_at: '2026-11-24T11:00:00+07:00', resubmitted_at: '2026-11-25T10:00:00+07:00', paused_days: 1 },
  { case_no: cn(17), seq: 2, returned_at: '2026-11-27T14:00:00+07:00', resubmitted_at: null, paused_days: null },
  { case_no: cn(23), seq: 1, returned_at: '2026-11-27T10:00:00+07:00', resubmitted_at: '2026-11-30T10:00:00+07:00', paused_days: 1 },
  { case_no: cn(23), seq: 2, returned_at: '2026-11-30T14:00:00+07:00', resubmitted_at: '2026-12-01T08:30:00+07:00', paused_days: 1 },
]);
const f01 = get('SELECT * FROM cases WHERE case_no=?', cn(17));
assert.deepStrictEqual([f01.return_count, f01.fix_deadline, f01.due_at, f01.owner], [2, '2026-12-04T14:00:00+07:00', '2026-11-27T16:30:00+07:00', 'off.reg1']);
assert.strictEqual(get('SELECT return_count n FROM cases WHERE case_no=?', cn(23)).n, 2);
const doc = get('SELECT * FROM documents');
assert.deepStrictEqual([doc.doc_no, doc.case_no, doc.verify_code, doc.issued_at, doc.valid_until, doc.signer], ['DOC-2569-000001', cn(5), 'K7M2Q9XA', '2026-11-05T10:00:00+07:00', '2027-02-02', 'เจ้าหน้าที่ทะเบียน 1']);
assert.strictEqual(doc.signature, require('crypto').createHmac('sha256', SIGN_KEY).update(['DOC-2569-000001', cn(5), 'สมชาย ใจดี', 'SV-01', doc.issued_at, '2027-02-02', 'เจ้าหน้าที่ทะเบียน 1'].join('|')).digest('hex'));
assert.strictEqual(doc.signature, signDocument({ docNo: doc.doc_no, caseNo: doc.case_no, applicant: doc.applicant_name, serviceId: doc.service_id, issuedAt: doc.issued_at, validUntil: doc.valid_until, signer: doc.signer }));
assert.strictEqual(u.thaiDate(doc.valid_until), '2 ก.พ. 2570');
assert.strictEqual(new Date(Date.UTC(2026, 10, 5) + 89 * 864e5).toISOString().slice(0, 10), doc.valid_until); // ออก + 89 วัน
assert.strictEqual(get('SELECT doc_no d FROM cases WHERE case_no=?', cn(5)).d, 'DOC-2569-000001');
assert.strictEqual(get('SELECT closed_at c FROM cases WHERE case_no=?', cn(5)).c, doc.issued_at);
assert.ok(get('SELECT COUNT(*) n FROM timeline_events WHERE case_no=?', cn(5)).n >= 5);
// ไทม์ไลน์ทุกใบเรียงเวลาไม่ย้อน และไม่เกินนาฬิกา
for (const c of all('SELECT case_no FROM cases')) {
  const t = all('SELECT time FROM timeline_events WHERE case_no=? ORDER BY id', c.case_no).map((r) => ms(r.time));
  assert.deepStrictEqual(t, [...t].sort((a, b) => a - b), c.case_no);
  assert.ok(t[t.length - 1] <= NOW.getTime(), c.case_no);
}

// ---- 7. reset ซ้ำ 2 ครั้งผลเหมือนเดิม (ตัดคอลัมน์สุ่ม: เข้ารหัส IV / salt รหัสผ่าน) ----
const RANDOM = new Set(['password_hash', 'id_no_enc', 'mobile_enc']);
const snapshot = () => {
  const out = {};
  for (const { name } of all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
    out[name] = all(`SELECT * FROM "${name}"`).map((r) => JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, RANDOM.has(k) ? (v ? 'x' : v) : Buffer.isBuffer(v) || v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v]))));
  }
  return out;
};
const s1 = snapshot();
resetAll();
const s2 = snapshot();
resetAll();
assert.deepStrictEqual(snapshot(), s1);
assert.deepStrictEqual(s2, s1);
assert.strictEqual(get('SELECT COUNT(*) n FROM cases').n, 30);

// ---- 8. ไฟล์ DB ไม่มีเลขบัตร/เบอร์ตรง ๆ (ทั้งเลขล้วนและรูปแบบมีขีด) ----
// ponytail: อ่านไฟล์หลักอย่างเดียว (journal_mode ตั้งต้น = DELETE ข้อมูลอยู่ในไฟล์หลัก) ถ้าเปิด WAL ต้องอ่าน -wal ด้วย
const raw = fs.readFileSync(tmp);
assert.ok(raw.length > 10000);
assert.ok(raw.includes(Buffer.from('K7M2Q9XA')), 'ไฟล์ที่อ่านต้องมีข้อมูล seed จริง (กัน grep ว่างเปล่าผ่านฟรี)');
for (const id of [...Object.values(ids), '1101700123457']) {
  assert.ok(!raw.includes(Buffer.from(id)), 'พบเลขบัตรตรง ๆ ในไฟล์ DB: ' + id);
  assert.ok(!raw.includes(Buffer.from(u.formatId(id))), 'พบเลขบัตรแบบมีขีดในไฟล์ DB: ' + id);
}
for (const m of ['0812345678', '0823456789', '0834567890']) assert.ok(!raw.includes(Buffer.from(m)), 'พบเบอร์ตรง ๆ ในไฟล์ DB: ' + m);
// ตัวควบคุม: grep แบบเดียวกันต้องเจอเลขบัตรเมื่อมีการเขียนตรง ๆ จริง (พิสูจน์ว่าตัวตรวจล้มได้)
db.prepare("INSERT INTO meta (key,value) VALUES ('x','1101700123456')").run();
assert.ok(fs.readFileSync(tmp).includes(Buffer.from('1101700123456')), 'ตัวตรวจต้องเห็นเลขที่เขียนตรง ๆ');
db.prepare("DELETE FROM meta WHERE key='x'").run();

db.close();
for (const f of [tmp, tmp + '-wal', tmp + '-shm', tmp + '-journal']) fs.rmSync(f, { force: true });
console.log('seed.selftest OK');
