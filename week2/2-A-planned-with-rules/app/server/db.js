// ฐานข้อมูล: node:sqlite (DatabaseSync) ตัวเดียว · schema ทุกตารางอยู่ที่นี่ (บล็อกอื่นไม่ต้องแก้)
// เวลาทุกคอลัมน์เก็บเป็น ISO +07:00 (ข้อความ) ยกเว้นระบุไว้
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const clock = require('./clock');

const DB_PATH = process.env.DB_PATH === ':memory:'
  ? ':memory:'
  : process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : path.join(__dirname, '..', 'data', 'app.db');
if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

const SCHEMA = `
-- ผู้ใช้ทุกบทบาท · ประชาชน: id_no_enc/id_hash/id_masked/mobile_enc · เจ้าหน้าที่: username/password_hash
-- เลขบัตรและเบอร์โทรเก็บเข้ารหัสเท่านั้น (NFR-04) · ค้นหาด้วย id_hash (util.hashId)
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE,                    -- เจ้าหน้าที่/บทบาทอื่น (ประชาชนเป็น NULL)
  role          TEXT NOT NULL,                  -- citizen officer head executive auditor admin
  dept          TEXT NOT NULL DEFAULT '',       -- registry | works | ''
  display_name  TEXT NOT NULL,
  password_hash TEXT,                           -- util.hashPassword
  id_no_enc     TEXT,                           -- util.encrypt(เลขบัตร 13 หลัก)
  id_hash       TEXT UNIQUE,                    -- util.hashId(เลขบัตร)
  id_masked     TEXT,                           -- X-XXXX-XXXXX-45-6 (เก็บไว้เพื่อไม่ต้อง decrypt ตอนทำคิว)
  mobile_enc    TEXT,                           -- util.encrypt(เบอร์)
  email         TEXT NOT NULL DEFAULT '',
  registered    INTEGER NOT NULL DEFAULT 0,     -- 1 = ลงทะเบียนแล้ว (ประชาชน)
  consent_at    TEXT,                           -- เวลายินยอม PDPA
  created_at    TEXT NOT NULL
);

-- ตัวนับ OTP ผิด/ล็อก ต่อเลขบัตร (key = id_hash เพราะเลขที่กรอกอาจไม่มีผู้ใช้)
CREATE TABLE IF NOT EXISTS otp_attempts (
  id_hash      TEXT PRIMARY KEY,
  fail_count   INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,                            -- ISO · NULL = ไม่ล็อก
  updated_at   TEXT
);

CREATE TABLE IF NOT EXISTS services (
  id          TEXT PRIMARY KEY,                 -- SV-01 SV-02 SV-03
  name        TEXT NOT NULL,
  fee         INTEGER NOT NULL DEFAULT 0,       -- SV-01 ต่อฉบับ · SV-02 คงที่
  fee_base    INTEGER NOT NULL DEFAULT 0,       -- SV-03 ฐาน (พื้นที่ 1-100)
  fee_per_sqm INTEGER NOT NULL DEFAULT 0,       -- SV-03 ต่อ ตร.ม. ส่วนเกิน 100
  sla         INTEGER NOT NULL,                 -- วันทำการ
  docs_json   TEXT NOT NULL DEFAULT '[]'        -- [{key,name,required,pdfOnly}] ตามลำดับที่ใช้ใน missing-docs
);

CREATE TABLE IF NOT EXISTS holidays (
  date TEXT PRIMARY KEY,                        -- YYYY-MM-DD (ค.ศ.)
  name TEXT NOT NULL
);

-- ตัวนับเลขรัน · kind: EG RC DOC (year = พ.ศ.) · DR PP (year = 0) · next = เลขที่จะออกต่อไป
CREATE TABLE IF NOT EXISTS counters (
  kind TEXT NOT NULL,
  year INTEGER NOT NULL DEFAULT 0,
  next INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (kind, year)
);

-- ร่าง/รอชำระ (DR-xxxx) · เมื่อชำระแล้วผูก case_no (ร่างยังอยู่เป็นประวัติ)
CREATE TABLE IF NOT EXISTS drafts (
  draft_id   TEXT PRIMARY KEY,                  -- DR-0003
  user_id    INTEGER NOT NULL,
  service_id TEXT NOT NULL,
  status     TEXT NOT NULL,                     -- DRAFT | PENDING_PAYMENT | SUBMITTED
  qty        INTEGER,                           -- SV-01
  area_sqm   INTEGER,                           -- SV-03
  fee        INTEGER NOT NULL,                  -- ยอดที่ล็อกตอนสร้าง (A-42)
  form_json  TEXT NOT NULL DEFAULT '{}',
  case_no    TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_drafts_user ON drafts(user_id);

-- คำขอที่มีเลขแล้ว (ชำระสำเร็จ)
CREATE TABLE IF NOT EXISTS cases (
  case_no        TEXT PRIMARY KEY,              -- EG-2569-000025
  draft_id       TEXT,                          -- NULL สำหรับ seed ประวัติ
  user_id        INTEGER NOT NULL,              -- ผู้ยื่น
  service_id     TEXT NOT NULL,
  status         TEXT NOT NULL,                 -- ตาราง 4.1 (ไม่รวม DRAFT/PENDING_PAYMENT)
  step           INTEGER,                       -- SV-03 เท่านั้น 1-3
  dept           TEXT NOT NULL DEFAULT '',      -- แผนกที่ถือเรื่องอยู่ registry | works | '' (ขั้นหัวหน้า/ปิดแล้ว)
  fee            INTEGER NOT NULL,
  qty            INTEGER,
  area_sqm       INTEGER,
  paid_at        TEXT NOT NULL,
  receipt_no     TEXT,
  due_at         TEXT NOT NULL,                 -- กำหนดเสร็จที่เก็บ (คำนวณครั้งเดียวตอนชำระ A-42)
  owner          TEXT,                          -- username ผู้ถือเรื่องตอนนี้ (NULL = ยังไม่มีผู้รับ)
  registry_owner TEXT,                          -- เจ้าหน้าที่ทะเบียนขั้นแรก = ผู้ออกเอกสาร SV-02/03 (A-27)
  works_owner    TEXT,                          -- เจ้าหน้าที่โยธา (SV-03)
  approver       TEXT,                          -- ผู้อนุมัติ/ผู้ลงนาม (username)
  approved_at    TEXT,
  return_count   INTEGER NOT NULL DEFAULT 0,
  return_reason  TEXT,                          -- เหตุผลตีกลับล่าสุด (return-reason-display)
  returned_at    TEXT,                          -- เวลาตีกลับล่าสุด (NEED_FIX)
  fix_deadline   TEXT,                          -- returned_at + 168 ชม.
  reject_reason  TEXT,
  closed_at      TEXT,                          -- COMPLETED/REJECTED = เวลาปิดงาน · CANCELLED = เวลายกเลิก
  doc_no         TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_cases_user   ON cases(user_id);
CREATE INDEX IF NOT EXISTS ix_cases_status ON cases(status);
CREATE INDEX IF NOT EXISTS ix_cases_owner  ON cases(owner);

-- ประวัติการตีกลับ/ส่งแก้ (ใช้คำนวณหยุดนับ SLA และแสดงไทม์ไลน์)
CREATE TABLE IF NOT EXISTS case_returns (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no        TEXT NOT NULL,
  seq            INTEGER NOT NULL,              -- ครั้งที่ 1, 2
  returned_by    TEXT,
  returned_at    TEXT NOT NULL,
  reason         TEXT NOT NULL,
  resubmitted_at TEXT,                          -- NULL = ยังไม่ส่งแก้
  paused_days    INTEGER                        -- วันทำการที่หยุดนับ (คิดตอนส่งแก้)
);
CREATE INDEX IF NOT EXISTS ix_returns_case ON case_returns(case_no);

-- ไทม์ไลน์ของคำขอ (case-timeline · timeline-item[data-iso])
CREATE TABLE IF NOT EXISTS timeline_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no     TEXT NOT NULL,
  time        TEXT NOT NULL,
  actor       TEXT,                             -- username (NULL = ระบบ/ประชาชน ดู actor_role)
  actor_role  TEXT,
  kind        TEXT NOT NULL,                    -- PAID SUBMITTED CLAIM RETURN RESUBMIT FORWARD APPROVE REJECT ISSUE CANCEL AUTO_CANCEL ...
  text        TEXT NOT NULL DEFAULT '',
  from_status TEXT,
  to_status   TEXT
);
CREATE INDEX IF NOT EXISTS ix_timeline_case ON timeline_events(case_no, time);

-- ไฟล์แนบ (เก็บเนื้อไฟล์เป็น BLOB) · ร่าง: draft_id · หลังชำระ: case_no
CREATE TABLE IF NOT EXISTS files (
  file_id    TEXT PRIMARY KEY,
  draft_id   TEXT,
  case_no    TEXT,
  user_id    INTEGER NOT NULL,                  -- เจ้าของ (ผู้ยื่น)
  name       TEXT NOT NULL,
  doc_key    TEXT NOT NULL,                     -- id-card map site-photo plan deed
  size       INTEGER NOT NULL,
  mime       TEXT NOT NULL,                     -- ตามชนิดจริง (magic bytes)
  content    BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_files_draft ON files(draft_id);
CREATE INDEX IF NOT EXISTS ix_files_case  ON files(case_no);

-- QR/การชำระ (PP-xxxx) · ใบเสร็จอยู่ที่แถวเดียวกัน
CREATE TABLE IF NOT EXISTS payments (
  ref           TEXT PRIMARY KEY,               -- PP-0002
  draft_id      TEXT NOT NULL,
  case_no       TEXT,                           -- ได้เมื่อชำระแล้ว
  amount        INTEGER NOT NULL,
  status        TEXT NOT NULL,                  -- PENDING | PAID | EXPIRED
  qr_created_at TEXT NOT NULL,
  qr_expires_at TEXT NOT NULL,
  paid_at       TEXT,
  receipt_no    TEXT UNIQUE,                    -- RC-2569-000031
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_payments_draft ON payments(draft_id);

-- เอกสารดิจิทัลที่ออกแล้ว · signature = HMAC-SHA256 ของฟิลด์เอกสาร (B07 กำหนดลำดับฟิลด์)
-- tamper ของ testhook แก้ฟิลด์ที่เก็บโดยไม่คำนวณลายเซ็นใหม่
CREATE TABLE IF NOT EXISTS documents (
  doc_no         TEXT PRIMARY KEY,              -- DOC-2569-000001
  case_no        TEXT NOT NULL UNIQUE,
  verify_code    TEXT NOT NULL UNIQUE,          -- [A-Z0-9]{8}
  service_id     TEXT NOT NULL,
  applicant_name TEXT NOT NULL,
  issued_at      TEXT NOT NULL,
  valid_until    TEXT NOT NULL,                 -- YYYY-MM-DD วันสุดท้ายที่ใช้ได้ (A-43)
  signer         TEXT NOT NULL,                 -- ชื่อผู้ลงนาม
  signer_username TEXT,
  issued_by      TEXT,                          -- ผู้กดออกเอกสาร (username)
  signature      TEXT NOT NULL
);

-- Audit Trail: เพิ่มได้อย่างเดียว (ไม่มี API แก้/ลบ) · time เป็น ISO +07:00 (กรองวันด้วย substr(time,1,10))
CREATE TABLE IF NOT EXISTS audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  time        TEXT NOT NULL,
  username    TEXT NOT NULL DEFAULT '',
  role        TEXT NOT NULL DEFAULT '',
  event       TEXT NOT NULL,                    -- STAFF_LOGIN CLAIM RETURN FORWARD APPROVE REJECT ISSUE UNMASK EXPORT ADMIN_CHANGE
  case_no     TEXT,
  from_status TEXT,
  to_status   TEXT,
  detail      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_audit_time ON audit(time);

-- แจ้งเตือนในระบบ (กระดิ่ง) · UNIQUE = 1 ครั้งต่อระดับต่อคำขอต่อคน (กันซ้ำที่ระดับฐานข้อมูล)
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL,                     -- ผู้รับ (เจ้าหน้าที่/หัวหน้า)
  case_no    TEXT NOT NULL,
  level      TEXT NOT NULL,                     -- near | overdue
  text       TEXT NOT NULL,                     -- คำขอ EG-2569-000024 ใกล้ครบกำหนด
  created_at TEXT NOT NULL,
  UNIQUE (username, case_no, level)
);
CREATE INDEX IF NOT EXISTS ix_noti_user ON notifications(username);

-- ค่าเบ็ดเตล็ด key/value สำหรับบล็อกที่ต้องการเก็บสถานะเล็ก ๆ
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

function initSchema() {
  db.exec(SCHEMA);
}

// transaction ซ้อนได้ (ถ้าอยู่ใน transaction แล้วก็รันต่อเลย) · BEGIN IMMEDIATE กันชนกัน
function tx(fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// เลขรันถัดไป (จำนวนเต็ม) ของ kind ในปี พ.ศ. นั้น แล้วเพิ่มตัวนับ · เรียกใน tx() เสมอ
// kind: 'EG' 'RC' 'DOC' (year = พ.ศ.) · 'DR' 'PP' (year = 0) · ตัวนับเริ่มที่ 1 ถ้ายังไม่มีแถว
// จัดรูปแบบด้วย util.formatNo('EG', 2569, n) -> EG-2569-000031
function nextNumber(kind, buddhistYear = 0) {
  const row = db.prepare('SELECT next FROM counters WHERE kind=? AND year=?').get(kind, buddhistYear);
  if (!row) {
    db.prepare('INSERT INTO counters (kind, year, next) VALUES (?,?,2)').run(kind, buddhistYear);
    return 1;
  }
  db.prepare('UPDATE counters SET next=next+1 WHERE kind=? AND year=?').run(kind, buddhistYear);
  return row.next;
}
// ให้ seed ตั้งเลขถัดไป เช่น setCounter('EG', 2569, 31)
function setCounter(kind, buddhistYear, next) {
  db.prepare(
    `INSERT INTO counters (kind, year, next) VALUES (?,?,?)
     ON CONFLICT(kind, year) DO UPDATE SET next=excluded.next`
  ).run(kind, buddhistYear, next);
}

// ล้างทุกตาราง + ตัวนับ + session + นาฬิกา แล้ว seed (ถ้ามี server/seed.js ของ B02)
function resetAll() {
  const { sessions } = require('./util'); // lazy: util ไม่ require db
  tx(() => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).all();
    for (const { name } of tables) db.exec(`DELETE FROM "${name}"`);
    db.exec('DELETE FROM sqlite_sequence');
    sessions.clear();
    clock.reset();
    const seedFile = path.join(__dirname, 'seed.js');
    if (fs.existsSync(seedFile)) require(seedFile).seed(); // error จริงของ seed ต้องโผล่ ไม่กลืน
  });
}

module.exports = { db, DB_PATH, initSchema, tx, nextNumber, setCounter, resetAll };
