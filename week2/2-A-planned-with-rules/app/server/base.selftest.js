// รัน: node server/base.selftest.js  (ใช้ฐานข้อมูลในหน่วยความจำ) · ล้ม = throw
process.env.DB_PATH = ':memory:';
const assert = require('assert');
const clock = require('./clock');
const u = require('./util');
const { db, initSchema, tx, nextNumber, setCounter, resetAll } = require('./db');
const audit = require('./audit');
const { bug } = require('./bugs');

initSchema();

// รูปแบบแสดงผล
assert.strictEqual(u.thaiDateTime('2026-12-04T16:30:00+07:00'), '4 ธ.ค. 2569 16:30');
assert.strictEqual(u.thaiDateTime('2026-12-04T09:30:00Z'), '4 ธ.ค. 2569 16:30'); // UTC -> เวลาไทย
assert.strictEqual(u.thaiDate('2027-02-02'), '2 ก.พ. 2570');
assert.strictEqual(u.baht(1010), '฿1,010');
assert.strictEqual(u.baht(100000), '฿100,000');
assert.strictEqual(u.maskId('3100600987659'), 'X-XXXX-XXXXX-65-9');
assert.strictEqual(u.formatId('3100600987659'), '3-1006-00987-65-9');
assert.strictEqual(u.formatNo('EG', 2569, 31), 'EG-2569-000031');
assert.strictEqual(u.formatNo('DR', 0, 3, 4), 'DR-0003');
assert.strictEqual(u.buddhistYear('2026-12-31T23:59:00+07:00'), 2569);
assert.strictEqual(u.buddhistYear('2027-01-01T00:00:00+07:00'), 2570);
assert.strictEqual(u.buddhistYear('2026-12-31T17:30:00Z'), 2570); // 00:30 ไทยของ 1 ม.ค.

// เข้ารหัส
const enc = u.encrypt('1101700123456');
assert.ok(!enc.includes('1101700123456'));
assert.notStrictEqual(enc, u.encrypt('1101700123456')); // IV สุ่ม
assert.strictEqual(u.decrypt(enc), '1101700123456');
assert.throws(() => u.decrypt(enc.slice(0, -4) + 'AAAA')); // GCM ตรวจแก้ไข
assert.strictEqual(u.hashId('1-1017-00123-45-6'), u.hashId('1101700123456'));
assert.ok(u.verifyPassword('Test@1234', u.hashPassword('Test@1234')));
assert.ok(!u.verifyPassword('x', u.hashPassword('Test@1234')));

// นาฬิกา
assert.strictEqual(clock.nowISO(), '2026-12-01T09:00:00+07:00');
clock.set('2026-12-01T16:30:00+07:00');
assert.strictEqual(clock.nowISO(), '2026-12-01T16:30:00+07:00');
for (const bad of ['2026-12-01T16:30:00', '2026-02-30T10:00:00+07:00', 'abc', null, 5]) {
  assert.throws(() => clock.set(bad), /INVALID_TIME/);
}
assert.strictEqual(clock.nowISO(), '2026-12-01T16:30:00+07:00'); // ค่าผิดไม่ทำให้นาฬิกาเปลี่ยน

// ตัวนับ + transaction
assert.deepStrictEqual([nextNumber('EG', 2569), nextNumber('EG', 2569), nextNumber('EG', 2570)], [1, 2, 1]);
setCounter('EG', 2569, 31);
assert.strictEqual(nextNumber('EG', 2569), 31);
assert.throws(() => tx(() => { nextNumber('RC', 2569); throw new Error('x'); }));
assert.strictEqual(nextNumber('RC', 2569), 1); // rollback แล้วตัวนับไม่ขยับ

// audit + reset ล้างทุกอย่างและ session
audit({ actor: 'off.reg1', role: 'officer', event: 'CLAIM', caseNo: 'EG-2569-000024' });
const row = db.prepare('SELECT * FROM audit').get();
assert.strictEqual(row.time, '2026-12-01T16:30:00+07:00');
u.sessions.set('sid1', { username: 'x' });
resetAll();
assert.strictEqual(u.sessions.size, 0);
assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM audit').get().n, 0);
// counters ถูก seed ตั้งค่าไว้ (B02) จึงไม่ว่าง: ตรวจว่า reset ซ้ำได้ค่าเดิมทุกครั้ง
const snap = () => JSON.stringify(db.prepare('SELECT * FROM counters ORDER BY 1,2').all());
const s1 = snap();
resetAll();
assert.strictEqual(snap(), s1);
assert.strictEqual(clock.nowISO(), '2026-12-01T09:00:00+07:00');

// ตารางที่โจทย์ต้องใช้ครบ
const have = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
for (const t of ['users', 'cases', 'drafts', 'files', 'payments', 'documents', 'audit', 'notifications', 'services', 'holidays', 'counters', 'timeline_events', 'otp_attempts', 'case_returns', 'meta']) {
  assert.ok(have.includes(t), 'missing table ' + t);
}
// แจ้งเตือนซ้ำ (คน+คำขอ+ระดับ) ถูกกันด้วย UNIQUE
const ins = () => db.prepare("INSERT INTO notifications (username,case_no,level,text,created_at) VALUES ('a','c','near','t','x')").run();
ins();
assert.throws(ins, /UNIQUE/);
assert.strictEqual(bug('B03'), false); // ไม่ตั้ง BUG_MODE = ถูกต้อง
console.log('base.selftest OK');
