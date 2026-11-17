'use strict';
/**
 * ฐานข้อมูล SQLite (B01) — better-sqlite3 (synchronous) · ไฟล์ตาม env DB_PATH (ค่าเริ่มต้น ./data/egov.db · ใช้ ":memory:" ได้)
 *
 * ใช้:  const { db, tx, nextSeq } = require('../db');
 *       const row = db.prepare('SELECT * FROM cases WHERE case_no = ?').get(caseNo);
 *       tx(() => { ...หลายคำสั่งแบบ atomic... })();      // หรือ db.transaction(fn)
 *
 * กติกา (ดู INTERFACES.md):
 * - เวลาทุกคอลัมน์ *_at / time / due_at เป็น ISO "YYYY-MM-DDTHH:MM:SS+07:00" จาก clock.toIso() → เทียบด้วยสตริงได้
 * - เลขบัตร/เบอร์โทรเก็บเข้ารหัสเท่านั้น (crypto.encrypt) · ค้นด้วย id_hash (crypto.idHash)
 * - better-sqlite3 เป็น sync: อ่าน-แล้ว-เขียนใน handler เดียวโดยไม่มี await คั่น = ไม่มี race (เลขไม่ซ้ำ · รับเรื่องพร้อมกัน)
 * - audit เพิ่มได้อย่างเดียว (trigger กัน UPDATE/DELETE) · ล้างได้เฉพาะ resetAll()
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'egov.db');

if (DB_PATH !== ':memory:') {
  fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });
}

const db = new Database(DB_PATH);
if (DB_PATH !== ':memory:') db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = OFF'); // seed ใส่ข้อมูลตามลำดับใดก็ได้ · ความถูกต้องดูแลในโค้ด
db.pragma('busy_timeout = 5000');

/** ลำดับตาราง (ใช้ตอนล้าง) */
const TABLES = [
  'users', 'services', 'holidays', 'cases', 'case_files', 'case_events', 'payments',
  'documents', 'notifications', 'audit', 'sessions', 'otp_attempts', 'counters',
];

const SCHEMA = `
-- ผู้ใช้ทุกบทบาท (ประชาชน + เจ้าหน้าที่)
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE,                 -- เจ้าหน้าที่: 'off.reg1' … · ประชาชน: NULL
  role          TEXT NOT NULL,               -- citizen|officer|head|executive|auditor|admin
  dept          TEXT,                        -- registry|works (officer) · อื่น ๆ NULL
  name          TEXT NOT NULL,               -- ชื่อแสดง/ชื่อ-สกุล (เช่น 'สมชาย ใจดี' · 'เจ้าหน้าที่ทะเบียน 1')
  password_hash TEXT,                        -- เจ้าหน้าที่: crypto.hashPassword · ประชาชน NULL
  id_hash       TEXT UNIQUE,                 -- ประชาชน: crypto.idHash(เลขบัตร 13 หลัก) ใช้ค้นหา
  id_enc        TEXT,                        -- ประชาชน: crypto.encrypt(เลขบัตร 13 หลัก)   (NFR-04)
  mobile_enc    TEXT,                        -- crypto.encrypt(เบอร์มือถือ 10 หลัก)           (NFR-04)
  email         TEXT,                        -- ว่างได้
  registered    INTEGER NOT NULL DEFAULT 0,  -- ประชาชนที่ลงทะเบียน (/register) แล้ว = 1 · เจ้าหน้าที่ = 1
  consent_at    TEXT,                        -- เวลายินยอม PDPA
  created_at    TEXT NOT NULL
);

-- บริการ (ค่าที่ admin แก้ได้ · ชื่อ/เอกสาร/เส้นทางอยู่ใน constants.SERVICES)
CREATE TABLE IF NOT EXISTS services (
  id          TEXT PRIMARY KEY,              -- 'SV-01' 'SV-02' 'SV-03'
  name        TEXT NOT NULL,
  fee         INTEGER NOT NULL,              -- SV-01 ต่อฉบับ (20) · SV-02 คงที่ (500) · SV-03 ฐาน feeBase (1000)
  fee_per_sqm INTEGER,                       -- SV-03 ต่อ ตร.ม. ส่วนเกิน 100 (10) · อื่น NULL
  sla_days    INTEGER NOT NULL,              -- 3 / 10 / 15
  sort        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS holidays (
  date TEXT PRIMARY KEY,                     -- 'YYYY-MM-DD' (ค.ศ.)
  name TEXT NOT NULL
);

-- คำขอ + ร่าง (แถวเดียวกัน: ร่าง/รอชำระยังไม่มี case_no)
CREATE TABLE IF NOT EXISTS cases (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id      TEXT UNIQUE,                 -- 'DR-0001' (คำขอประวัติใน seed อาจเป็น NULL)
  case_no       TEXT UNIQUE,                 -- 'EG-2569-000001' ออกเมื่อชำระสำเร็จ
  service_id    TEXT NOT NULL,
  applicant_id  INTEGER NOT NULL,            -- users.id ของประชาชน
  qty           INTEGER,                     -- SV-01 จำนวนฉบับ
  area_sqm      INTEGER,                     -- SV-03 พื้นที่
  fee           INTEGER NOT NULL,            -- ยอดที่ "ล็อก" ตอนเข้า PENDING_PAYMENT (A-42) · ร่างเก็บยอดล่าสุดที่คำนวณ
  status        TEXT NOT NULL,               -- constants.STATUSES
  step          INTEGER,                     -- SV-03: 1 ทะเบียน · 2 โยธา · 3 หัวหน้า · อื่น NULL
  dept          TEXT,                        -- คิวแผนกที่คำขออยู่ตอนนี้ registry|works · ขั้นหัวหน้า/ปิด/ร่าง = NULL
  owner         TEXT,                        -- username ผู้ถือเรื่องตอนนี้ (NULL = ยังไม่มีผู้รับ) · คงไว้ระหว่าง NEED_FIX
  issuer        TEXT,                        -- username เจ้าหน้าที่ทะเบียนที่รับเรื่องขั้นแรก = ผู้ออกเอกสาร (A-27)
  approver      TEXT,                        -- username ผู้อนุมัติ (= ผู้ลงนาม)
  paid_at       TEXT,                        -- เวลาชำระสำเร็จ (= เวลายื่น · D0 ของ SLA)
  receipt_no    TEXT UNIQUE,                 -- 'RC-2569-000001'
  due_at        TEXT,                        -- กำหนดเสร็จ (seed = ค่าตายตัว A-35)
  return_count  INTEGER NOT NULL DEFAULT 0,
  returned_at   TEXT,                        -- เวลาตีกลับครั้งล่าสุด
  return_reason TEXT,                        -- เหตุผลตีกลับครั้งล่าสุด (return-reason-display)
  fix_deadline  TEXT,                        -- returned_at + 168 ชม. (เฉพาะตอน NEED_FIX)
  reject_reason TEXT,
  closed_at     TEXT,                        -- เวลา COMPLETED / REJECTED
  cancelled_at  TEXT,                        -- เวลา CANCELLED
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS ix_cases_applicant ON cases(applicant_id);
CREATE INDEX IF NOT EXISTS ix_cases_status ON cases(status);
CREATE INDEX IF NOT EXISTS ix_cases_paid ON cases(paid_at);

-- ไฟล์แนบ (เก็บเนื้อไฟล์ใน DB → reset ล้างได้ทันที)
CREATE TABLE IF NOT EXISTS case_files (
  id          TEXT PRIMARY KEY,              -- fileId (รูปแบบอิสระ เช่น 'F-000001' หรือสุ่ม)
  case_id     INTEGER NOT NULL,
  doc_key     TEXT NOT NULL,                 -- id-card|map|site-photo|plan|deed|extra
  name        TEXT NOT NULL,                 -- ชื่อไฟล์เดิม
  mime        TEXT NOT NULL,                 -- จาก magic bytes: application/pdf|image/jpeg|image/png
  size        INTEGER NOT NULL,
  data        BLOB NOT NULL,
  uploaded_by INTEGER,                       -- users.id
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_files_case ON case_files(case_id);

-- ไทม์ไลน์ของคำขอ (case-timeline) และประวัติตีกลับ/ส่งแก้ (ใช้คิดหยุดนับ)
CREATE TABLE IF NOT EXISTS case_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id     INTEGER NOT NULL,
  at          TEXT NOT NULL,
  actor       TEXT,                          -- username เจ้าหน้าที่ · 'citizen' · 'system'
  event       TEXT NOT NULL,                 -- CREATED|PAID|CLAIM|RETURN|RESUBMIT|FORWARD|APPROVE|REJECT|ISSUE|CANCEL|AUTO_CANCEL
  from_status TEXT,
  to_status   TEXT,
  note        TEXT                           -- เหตุผล/หมายเหตุ
);
CREATE INDEX IF NOT EXISTS ix_events_case ON case_events(case_id);

-- รายการชำระ (QR จำลอง)
CREATE TABLE IF NOT EXISTS payments (
  ref           TEXT PRIMARY KEY,            -- 'PP-0001'
  case_id       INTEGER NOT NULL,
  amount        INTEGER NOT NULL,
  status        TEXT NOT NULL,               -- PENDING|PAID|VOID (EXPIRED คิดจากเวลาได้ หรือเก็บก็ได้)
  qr_created_at TEXT NOT NULL,
  qr_expires_at TEXT NOT NULL,               -- created + 15:00
  paid_at       TEXT
);
CREATE INDEX IF NOT EXISTS ix_pay_case ON payments(case_id);

-- เอกสารดิจิทัลที่ออกแล้ว
CREATE TABLE IF NOT EXISTS documents (
  doc_no      TEXT PRIMARY KEY,              -- 'DOC-2569-000001'
  case_id     INTEGER NOT NULL,
  case_no     TEXT NOT NULL,
  verify_code TEXT NOT NULL UNIQUE,          -- [A-Z0-9]{8}
  applicant   TEXT NOT NULL,                 -- ชื่อ-สกุลเต็ม (ฟิลด์ที่ลงนาม)
  service_id  TEXT NOT NULL,
  issued_at   TEXT NOT NULL,                 -- ISO +07:00
  valid_until TEXT NOT NULL,                 -- 'YYYY-MM-DD' วันสุดท้ายที่ใช้ได้ (A-43)
  signer      TEXT NOT NULL,                 -- ชื่อแสดงผู้ลงนาม เช่น 'เจ้าหน้าที่ทะเบียน 1'
  issued_by   TEXT,                          -- username ผู้กดออกเอกสาร
  signature   TEXT NOT NULL                  -- crypto.signDoc(...) hex
);

-- แจ้งเตือนในระบบ (กระดิ่ง) · 1 ครั้งต่อระดับต่อคำขอต่อคน → UNIQUE + INSERT OR IGNORE
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL,                  -- ผู้รับ (เจ้าหน้าที่/หัวหน้า)
  case_id    INTEGER NOT NULL,
  case_no    TEXT NOT NULL,
  level      TEXT NOT NULL,                  -- near|overdue
  text       TEXT NOT NULL,                  -- 'คำขอ EG-2569-000024 ใกล้ครบกำหนด' / '… เกินกำหนด'
  created_at TEXT NOT NULL,
  read_at    TEXT,
  UNIQUE(username, case_id, level)
);

-- Audit Trail (เพิ่มได้อย่างเดียว)
CREATE TABLE IF NOT EXISTS audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  time        TEXT NOT NULL,                 -- ISO +07:00 จาก clock
  username    TEXT NOT NULL,
  role        TEXT NOT NULL,
  event       TEXT NOT NULL,                 -- constants.AUDIT_EVENTS
  case_no     TEXT,
  from_status TEXT,
  to_status   TEXT,
  detail      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_audit_time ON audit(time);

-- session (cookie 'sid' HttpOnly) · role/dept = ภาพ ณ เวลาล็อกอิน (admin เปลี่ยนบทบาท → มีผลล็อกอินครั้งถัดไป)
CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  role       TEXT NOT NULL,
  dept       TEXT,
  kind       TEXT NOT NULL DEFAULT 'full',   -- 'full' | 'register' (ประชาชนยังไม่ลงทะเบียน: ใช้ได้แค่ /register)
  created_at TEXT NOT NULL
);

-- ตัวนับ OTP ผิด / การล็อก ต่อเลขบัตร
CREATE TABLE IF NOT EXISTS otp_attempts (
  id_hash      TEXT PRIMARY KEY,             -- crypto.idHash(เลขบัตร)
  fail_count   INTEGER NOT NULL DEFAULT 0,   -- ผิดติดกัน
  locked_until TEXT,                         -- ISO +07:00 (เวลาครั้งที่ 3 + 15 นาที)
  last_fail_at TEXT
);

-- ตัวนับเลขลำดับ: 'case:2569' 'receipt:2569' 'doc:2569' 'draft' 'payref' (constants.COUNTER)
CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
`;

const AUDIT_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
`;

db.exec(SCHEMA);
db.exec(AUDIT_TRIGGERS);

/** ห่อฟังก์ชันเป็น transaction (คืนฟังก์ชัน) — เหมือน db.transaction(fn) */
function tx(fn) {
  return db.transaction(fn);
}

const stmtNextSeq = db.prepare(
  'INSERT INTO counters(name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value'
);
/** เพิ่มตัวนับแบบ atomic แล้วคืนค่าใหม่ (เริ่ม 1 ถ้ายังไม่มี) · nextSeq('case:2569') → 31 */
function nextSeq(name) {
  return stmtNextSeq.get(name).value;
}

/** ตั้งค่าตัวนับ (ใช้ใน seed) · setSeq('case:2569', 30) */
function setSeq(name, value) {
  db.prepare('INSERT INTO counters(name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run(name, value);
}

/** ล้างทุกตาราง (รวม audit) + รีเซ็ต AUTOINCREMENT · ใช้ภายใน resetAll เท่านั้น */
function wipeAll() {
  db.exec('DROP TRIGGER IF EXISTS audit_no_update; DROP TRIGGER IF EXISTS audit_no_delete;');
  for (const t of TABLES) db.exec(`DELETE FROM ${t};`);
  db.exec("DELETE FROM sqlite_sequence;");
  db.exec(AUDIT_TRIGGERS);
}

const resetHooks = [];
/** ลงทะเบียนฟังก์ชันที่ต้องเรียกหลัง reset (ล้าง cache ในหน่วยความจำของโมดูล) */
function onReset(fn) {
  resetHooks.push(fn);
}

/** โหลด src/seed.js ถ้ามี (บล็อก B02) · ไม่มีไฟล์ → null */
function loadSeed() {
  try {
    return require('./seed');
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes("'./seed'")) return null;
    throw e;
  }
}

/**
 * ล้างทุกอย่างแล้ว seed ใหม่ตาม TEST-DATA (ใน transaction เดียว) แล้วเรียก onReset hooks
 * ผู้เรียกต้อง clock.reset() ก่อน (testhooks ทำให้)
 */
function resetAll() {
  const seedMod = loadSeed();
  db.transaction(() => {
    wipeAll();
    if (seedMod && typeof seedMod.seed === 'function') seedMod.seed(db);
    else console.warn('[db] src/seed.js not found — database left empty after reset');
  })();
  for (const fn of resetHooks) fn();
}

/** true ถ้ายังไม่มีข้อมูลบริการ (DB ใหม่) */
function isEmpty() {
  return db.prepare('SELECT COUNT(*) AS n FROM services').get().n === 0;
}

module.exports = { db, DB_PATH, TABLES, tx, nextSeq, setSeq, resetAll, onReset, isEmpty };
