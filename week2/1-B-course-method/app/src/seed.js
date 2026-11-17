'use strict';
/**
 * Seed ข้อมูลทดสอบ (B02) — ตรงทุกค่าตาม TEST-DATA §1–§12 · DECISIONS §3 §17 · CONTRACT §3 §4 · INTERFACES §4.2 §6.1
 *
 * เรียกโดย db.resetAll() ภายใน transaction หลังล้างทุกตารางแล้ว (นาฬิกา = 2026-12-01T09:00:00+07:00)
 * - กำหนดเสร็จ (due_at) ของคำขอ seed เป็นค่าตายตัวตามตาราง TEST-DATA §4.1 — ไม่คำนวณใหม่ (A-35)
 * - เลขบัตร/เบอร์โทรเก็บด้วย crypto.encrypt() + id_hash (NFR-04)
 * - ไม่ใส่ audit / notifications / sessions / otp_attempts (ต้องว่างหลัง reset)
 * - ไม่อ่านไฟล์นอก src/ (ไฟล์แนบเป็น PDF เล็กที่สร้างในโค้ด)
 */

const crypto = require('./crypto');

const PASSWORD = 'Test@1234';
const T0 = '2026-10-01T09:00:00+07:00'; // เวลาสร้างบัญชี seed

/** แปลง 'YYYY-MM-DD HH:MM' (เวลาไทย) → ISO +07:00 */
function iso(s) {
  if (!s) return null;
  const [d, t] = s.split(' ');
  return `${d}T${t.length === 5 ? t + ':00' : t}+07:00`;
}

/** เลื่อนเวลา ISO +07:00 ไป n นาที (ผลยังเป็น +07:00) */
function shift(isoStr, minutes) {
  const ms = Date.parse(isoStr) + minutes * 60000 + 7 * 3600000;
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+07:00`;
}

/** PDF จริงขนาดเล็ก (ขึ้นต้น %PDF · ลงท้าย %%EOF) */
function tinyPdf(label) {
  const head = '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n';
  const body = `% egov seed file: ${label}\n`;
  const tail = '\ntrailer<</Root 1 0 R>>\n%%EOF\n';
  return Buffer.from(head + body + tail, 'latin1');
}

// ---------------------------------------------------------------- 1. บัญชี
const CITIZENS = [
  { key: 'somchai', name: 'สมชาย ใจดี', idNo: '1101700123456', mobile: '0812345678', registered: 1 },
  { key: 'somying', name: 'สมหญิง รักไทย', idNo: '3100600987659', mobile: '0823456789', registered: 1 },
  { key: 'mana', name: 'มานะ ตั้งใจ', idNo: '5500400111221', mobile: null, registered: 0 },
  { key: 'piti', name: 'ปิติ มีสุข', idNo: '1909900555015', mobile: '0834567890', registered: 1 },
];

const STAFF = [
  { username: 'off.reg1', name: 'เจ้าหน้าที่ทะเบียน 1', role: 'officer', dept: 'registry' },
  { username: 'off.reg2', name: 'เจ้าหน้าที่ทะเบียน 2', role: 'officer', dept: 'registry' },
  { username: 'off.works1', name: 'เจ้าหน้าที่โยธา 1', role: 'officer', dept: 'works' },
  { username: 'head1', name: 'หัวหน้าฝ่าย', role: 'head', dept: null },
  { username: 'exec1', name: 'ผู้บริหาร', role: 'executive', dept: null },
  { username: 'audit1', name: 'ผู้ตรวจสอบภายใน', role: 'auditor', dept: null },
  { username: 'admin1', name: 'ผู้ดูแลระบบ', role: 'admin', dept: null },
];

// ---------------------------------------------------------------- 2. บริการ · 3. วันหยุด
const SERVICES = [
  { id: 'SV-01', name: 'ขอหนังสือรับรอง', fee: 20, fee_per_sqm: null, sla_days: 3, sort: 1 },
  { id: 'SV-02', name: 'ขออนุญาตประกอบกิจการ', fee: 500, fee_per_sqm: null, sla_days: 10, sort: 2 },
  { id: 'SV-03', name: 'ขออนุญาตก่อสร้าง/ต่อเติมอาคาร', fee: 1000, fee_per_sqm: 10, sla_days: 15, sort: 3 },
];

const HOLIDAYS = [
  { date: '2026-12-07', name: 'ชดเชยวันหยุดทดสอบ (สมมติ)' },
  { date: '2026-12-10', name: 'วันรัฐธรรมนูญทดสอบ (สมมติ)' },
  { date: '2026-12-31', name: 'วันสิ้นปีทดสอบ (สมมติ)' },
  { date: '2027-01-01', name: 'วันขึ้นปีใหม่ทดสอบ (สมมติ)' },
];

/** เอกสารบังคับต่อบริการ (TEST-DATA §4.1 ท้ายตาราง) */
const REQUIRED_FILES = {
  'SV-01': [['id-card', 'id-card.pdf']],
  'SV-02': [['id-card', 'id-card.pdf'], ['map', 'map.pdf']],
  'SV-03': [['id-card', 'id-card.pdf'], ['plan', 'plan.pdf'], ['deed', 'deed.pdf']],
};

// ---------------------------------------------------------------- 4. คำขอ 30 ใบ (TEST-DATA §4.1 · ค่าตายตัว)
// n, ป้าย, บริการ, qty, area, fee, ผู้ยื่น, สถานะ, ชำระเมื่อ, กำหนดเสร็จ, ปิด/ยกเลิก
// flow = ประวัติเหตุการณ์ (ใช้สร้าง case_events และคอลัมน์ owner/dept/step/issuer/approver)
const CASES = [
  { n: 1, tag: 'H01', sv: 'SV-01', qty: 1, fee: 20, who: 'somying', status: 'COMPLETED', paid: '2026-10-14 10:00', due: '2026-10-19 16:30', closed: '2026-10-16 14:00' },
  { n: 2, tag: 'H05', sv: 'SV-03', area: 120, fee: 1200, who: 'piti', status: 'COMPLETED', paid: '2026-11-02 09:00', due: '2026-11-23 16:30', closed: '2026-11-20 11:00' },
  { n: 3, tag: 'H02', sv: 'SV-01', qty: 2, fee: 40, who: 'piti', status: 'COMPLETED', paid: '2026-11-02 09:30', due: '2026-11-05 16:30', closed: '2026-11-04 15:00' },
  { n: 4, tag: 'H06', sv: 'SV-02', fee: 500, who: 'somchai', status: 'COMPLETED', paid: '2026-11-02 14:00', due: '2026-11-16 16:30', closed: '2026-11-13 15:00' },
  { n: 5, tag: 'H03', sv: 'SV-01', qty: 1, fee: 20, who: 'somchai', status: 'COMPLETED', paid: '2026-11-03 11:00', due: '2026-11-06 16:30', closed: '2026-11-05 10:00' },
  { n: 6, tag: 'H08', sv: 'SV-02', fee: 500, who: 'piti', status: 'COMPLETED', paid: '2026-11-03 15:00', due: '2026-11-17 16:30', closed: '2026-11-19 10:00' },
  { n: 7, tag: 'H07', sv: 'SV-02', fee: 500, who: 'somying', status: 'COMPLETED', paid: '2026-11-04 10:00', due: '2026-11-18 16:30', closed: '2026-11-18 16:00' },
  { n: 8, tag: 'H04', sv: 'SV-01', qty: 1, fee: 20, who: 'somying', status: 'REJECTED', paid: '2026-11-09 10:00', due: '2026-11-12 16:30', closed: '2026-11-11 09:00', rejectReason: 'เอกสารประกอบไม่ครบถ้วนตามที่กำหนด' },
  { n: 9, tag: 'X01', sv: 'SV-01', qty: 1, fee: 20, who: 'somchai', status: 'CANCELLED', paid: '2026-11-09 14:30', due: '2026-11-12 16:30', cancelled: '2026-11-09 15:00' },
  { n: 10, tag: 'W01', sv: 'SV-03', area: 80, fee: 1000, who: 'somying', status: 'IN_REVIEW', paid: '2026-11-12 10:00', due: '2026-12-03 16:30',
    flow: [['CLAIM', 'off.reg1', '2026-11-12 11:00'], ['FORWARD', 'off.reg1', '2026-11-13 10:00']] },
  { n: 11, tag: 'P02', sv: 'SV-03', area: 150, fee: 1500, who: 'somchai', status: 'PENDING_APPROVAL', paid: '2026-11-16 10:00', due: '2026-12-08 16:30',
    flow: [['CLAIM', 'off.reg1', '2026-11-16 11:00'], ['FORWARD', 'off.reg1', '2026-11-17 10:00'],
      ['CLAIM', 'off.works1', '2026-11-17 13:00'], ['FORWARD', 'off.works1', '2026-11-20 10:00']] },
  { n: 12, tag: 'R09', sv: 'SV-03', area: 101, fee: 1010, who: 'piti', status: 'IN_REVIEW', paid: '2026-11-18 10:00', due: '2026-12-11 16:30',
    flow: [['CLAIM', 'off.reg2', '2026-11-18 11:00']] },
  { n: 13, tag: 'R01', sv: 'SV-02', fee: 500, who: 'somchai', status: 'IN_REVIEW', paid: '2026-11-20 10:00', due: '2026-12-04 16:30',
    flow: [['CLAIM', 'off.reg2', '2026-11-20 11:00']] },
  { n: 14, tag: 'P01', sv: 'SV-02', fee: 500, who: 'piti', status: 'PENDING_APPROVAL', paid: '2026-11-20 11:00', due: '2026-12-04 16:30',
    flow: [['CLAIM', 'off.reg1', '2026-11-20 13:00'], ['FORWARD', 'off.reg1', '2026-11-26 10:00']] },
  { n: 15, tag: 'R02', sv: 'SV-02', fee: 500, who: 'somying', status: 'IN_REVIEW', paid: '2026-11-20 15:00', due: '2026-12-04 16:30',
    flow: [['CLAIM', 'off.reg2', '2026-11-20 16:00']] },
  { n: 16, tag: 'R03', sv: 'SV-02', fee: 500, who: 'piti', status: 'IN_REVIEW', paid: '2026-11-23 09:00', due: '2026-12-08 16:30',
    flow: [['CLAIM', 'off.reg2', '2026-11-23 10:00']] },
  { n: 17, tag: 'F01', sv: 'SV-01', qty: 1, fee: 20, who: 'somchai', status: 'NEED_FIX', paid: '2026-11-23 10:00', due: '2026-11-27 16:30',
    flow: [['CLAIM', 'off.reg1', '2026-11-23 11:00'],
      ['RETURN', 'off.reg1', '2026-11-24 11:00', 'ภาพบัตรประชาชนไม่ชัด กรุณาถ่ายใหม่'],
      ['RESUBMIT', 'citizen', '2026-11-25 10:00'],
      ['RETURN', 'off.reg1', '2026-11-27 14:00', 'ชื่อในเอกสารไม่ตรงกับบัตร กรุณาแก้ไข']] },
  { n: 18, tag: 'R04', sv: 'SV-02', fee: 500, who: 'somchai', status: 'IN_REVIEW', paid: '2026-11-24 10:00', due: '2026-12-09 16:30',
    flow: [['CLAIM', 'off.reg2', '2026-11-24 11:00']] },
  { n: 19, tag: 'A01', sv: 'SV-02', fee: 500, who: 'somying', status: 'APPROVED', paid: '2026-11-24 14:00', due: '2026-12-09 16:30',
    flow: [['CLAIM', 'off.reg1', '2026-11-24 15:00'], ['FORWARD', 'off.reg1', '2026-11-27 10:00'], ['APPROVE', 'head1', '2026-11-30 15:00']] },
  { n: 20, tag: 'O01', sv: 'SV-01', qty: 1, fee: 20, who: 'somchai', status: 'IN_REVIEW', paid: '2026-11-25 10:00', due: '2026-11-30 16:30',
    flow: [['CLAIM', 'off.reg1', '2026-11-25 11:00']] },
  { n: 21, tag: 'R08', sv: 'SV-02', fee: 500, who: 'somying', status: 'IN_REVIEW', paid: '2026-11-25 12:00', due: '2026-12-11 16:30',
    flow: [['CLAIM', 'off.reg2', '2026-11-25 13:00']] },
  { n: 22, tag: 'N02', sv: 'SV-01', qty: 2, fee: 40, who: 'somying', status: 'IN_REVIEW', paid: '2026-11-26 10:00', due: '2026-12-01 16:30',
    flow: [['CLAIM', 'off.reg1', '2026-11-26 11:00']] },
  { n: 23, tag: 'F02', sv: 'SV-01', qty: 1, fee: 20, who: 'somying', status: 'IN_REVIEW', paid: '2026-11-26 10:30', due: '2026-12-03 16:30',
    flow: [['CLAIM', 'off.reg1', '2026-11-26 11:30'],
      ['RETURN', 'off.reg1', '2026-11-27 10:00', 'ภาพเอกสารเบลอ อ่านเลขไม่ได้'],
      ['RESUBMIT', 'citizen', '2026-11-30 10:00'],
      ['RETURN', 'off.reg1', '2026-11-30 14:00', 'ข้อมูลในแบบฟอร์มไม่ครบถ้วน'],
      ['RESUBMIT', 'citizen', '2026-12-01 08:30']] },
  { n: 24, tag: 'N01', sv: 'SV-01', qty: 1, fee: 20, who: 'piti', status: 'SUBMITTED', paid: '2026-11-27 11:00', due: '2026-12-02 16:30' },
  { n: 25, tag: 'R05', sv: 'SV-01', qty: 3, fee: 60, who: 'somying', status: 'IN_REVIEW', paid: '2026-11-30 10:00', due: '2026-12-03 16:30',
    flow: [['CLAIM', 'off.reg2', '2026-11-30 11:00']] },
  { n: 26, tag: 'R07', sv: 'SV-01', qty: 5, fee: 100, who: 'somchai', status: 'IN_REVIEW', paid: '2026-11-30 16:29', due: '2026-12-03 16:30',
    flow: [['CLAIM', 'off.reg2', '2026-11-30 16:45']] },
  { n: 27, tag: 'R06', sv: 'SV-01', qty: 1, fee: 20, who: 'piti', status: 'IN_REVIEW', paid: '2026-11-30 16:30', due: '2026-12-04 16:30',
    flow: [['CLAIM', 'off.reg2', '2026-11-30 16:50']] },
  { n: 28, tag: 'S01', sv: 'SV-01', qty: 1, fee: 20, who: 'somying', status: 'SUBMITTED', paid: '2026-12-01 08:10', due: '2026-12-04 16:30' },
  { n: 29, tag: 'S02', sv: 'SV-01', qty: 1, fee: 20, who: 'piti', status: 'SUBMITTED', paid: '2026-12-01 08:20', due: '2026-12-04 16:30' },
  { n: 30, tag: 'S03', sv: 'SV-01', qty: 1, fee: 20, who: 'somchai', status: 'SUBMITTED', paid: '2026-12-01 08:30', due: '2026-12-04 16:30' },
];

/** ประวัติของคำขอที่ปิดแล้ว (สร้างจากเส้นทางบริการ) */
function closedFlow(c) {
  const closed = iso(c.closed);
  const claimAt = shift(iso(c.paid), 60);
  const t = (min) => shift(closed, -min);
  if (c.status === 'REJECTED') {
    return [['CLAIM', 'off.reg1', claimAt], ['REJECT', 'off.reg1', closed, c.rejectReason]];
  }
  if (c.status === 'CANCELLED') return [['CANCEL', 'citizen', iso(c.cancelled)]];
  // COMPLETED
  if (c.sv === 'SV-01') {
    return [['CLAIM', 'off.reg1', claimAt], ['APPROVE', 'off.reg1', t(30)], ['ISSUE', 'off.reg1', closed]];
  }
  if (c.sv === 'SV-02') {
    return [['CLAIM', 'off.reg1', claimAt], ['FORWARD', 'off.reg1', t(180)], ['APPROVE', 'head1', t(60)], ['ISSUE', 'off.reg1', closed]];
  }
  return [ // SV-03
    ['CLAIM', 'off.reg1', claimAt], ['FORWARD', 'off.reg1', shift(claimAt, 24 * 60)],
    ['CLAIM', 'off.works1', shift(claimAt, 26 * 60)], ['FORWARD', 'off.works1', t(24 * 60)],
    ['APPROVE', 'head1', t(60)], ['ISSUE', 'off.reg1', closed],
  ];
}

const FORWARD_NOTE = 'ตรวจสอบแล้ว ส่งต่อขั้นถัดไป';

/**
 * เดินเหตุการณ์ตามลำดับ → คืน { events[], state } ที่ state = คอลัมน์ owner/dept/step/issuer/approver/... ณ ตอนนี้
 * ใช้กฎเดียวกับ INTERFACES §4.2 (ความหมายคอลัมน์ตามสถานะ)
 */
function playFlow(c, flow) {
  const sv3 = c.sv === 'SV-03';
  const st = {
    status: 'SUBMITTED', dept: 'registry', owner: null, step: sv3 ? 1 : null, issuer: null, approver: null,
    return_count: 0, returned_at: null, return_reason: null, fix_deadline: null,
    reject_reason: null, closed_at: null, cancelled_at: null,
  };
  const events = [];
  const ev = (at, actor, event, from, to, note) => events.push({ at, actor, event, from, to, note: note || null });

  for (const [event, actor, atRaw, note] of flow) {
    const at = atRaw.includes('T') ? atRaw : iso(atRaw);
    const from = st.status;
    switch (event) {
      case 'CLAIM':
        st.status = 'IN_REVIEW';
        st.owner = actor;
        if (st.dept === 'registry' && !st.issuer) st.issuer = actor;
        break;
      case 'RETURN':
        st.status = 'NEED_FIX';
        st.return_count += 1;
        st.returned_at = at;
        st.return_reason = note;
        st.fix_deadline = shift(at, 168 * 60);
        break;
      case 'RESUBMIT':
        st.status = 'IN_REVIEW';
        st.fix_deadline = null;
        break;
      case 'FORWARD':
        if (sv3 && st.step === 1) { // ทะเบียน → โยธา (ยังไม่มีผู้รับ)
          st.step = 2; st.dept = 'works'; st.owner = null; st.status = 'IN_REVIEW';
        } else { // → หัวหน้าฝ่าย
          if (sv3) st.step = 3;
          st.dept = null; st.owner = null; st.status = 'PENDING_APPROVAL';
        }
        break;
      case 'APPROVE':
        st.status = 'APPROVED';
        st.approver = actor;
        st.dept = 'registry';
        st.owner = null;
        break;
      case 'ISSUE':
        st.status = 'COMPLETED';
        st.dept = null; st.owner = null;
        st.closed_at = at;
        break;
      case 'REJECT':
        st.status = 'REJECTED';
        st.approver = actor;
        st.dept = null; st.owner = null;
        st.reject_reason = note;
        st.closed_at = at;
        break;
      case 'CANCEL':
        st.status = 'CANCELLED';
        st.dept = null; st.owner = null;
        st.cancelled_at = at;
        break;
      default:
        throw new Error('seed: unknown event ' + event);
    }
    ev(at, actor, event, from, st.status, note || (event === 'FORWARD' ? FORWARD_NOTE : null));
  }
  return { events, state: st };
}

// ---------------------------------------------------------------- เก็บ hash รหัสผ่านไว้ในโปรเซส (reset บ่อย · scrypt ช้า)
let pwCache = null;
function passwordHashes() {
  if (!pwCache) {
    pwCache = {};
    for (const s of STAFF) pwCache[s.username] = crypto.hashPassword(PASSWORD);
  }
  return pwCache;
}

// ---------------------------------------------------------------- seed()
function seed(db) {
  const insUser = db.prepare(`INSERT INTO users
    (username, role, dept, name, password_hash, id_hash, id_enc, mobile_enc, email, registered, consent_at, created_at)
    VALUES (@username, @role, @dept, @name, @password_hash, @id_hash, @id_enc, @mobile_enc, @email, @registered, @consent_at, @created_at)`);

  // 1. บัญชี
  const userId = {};
  for (const c of CITIZENS) {
    const r = insUser.run({
      username: null, role: 'citizen', dept: null, name: c.name, password_hash: null,
      id_hash: crypto.idHash(c.idNo), id_enc: crypto.encrypt(c.idNo), mobile_enc: crypto.encrypt(c.mobile),
      email: null, registered: c.registered, consent_at: c.registered ? T0 : null, created_at: T0,
    });
    userId[c.key] = Number(r.lastInsertRowid);
  }
  const pw = passwordHashes();
  for (const s of STAFF) {
    insUser.run({
      username: s.username, role: s.role, dept: s.dept, name: s.name, password_hash: pw[s.username],
      id_hash: null, id_enc: null, mobile_enc: null, email: null, registered: 1, consent_at: null, created_at: T0,
    });
  }

  // 2. บริการ · 3. วันหยุด
  const insSvc = db.prepare('INSERT INTO services (id, name, fee, fee_per_sqm, sla_days, sort) VALUES (@id, @name, @fee, @fee_per_sqm, @sla_days, @sort)');
  for (const s of SERVICES) insSvc.run(s);
  const insHol = db.prepare('INSERT INTO holidays (date, name) VALUES (@date, @name)');
  for (const h of HOLIDAYS) insHol.run(h);

  // 4. คำขอ
  const insCase = db.prepare(`INSERT INTO cases
    (draft_id, case_no, service_id, applicant_id, qty, area_sqm, fee, status, step, dept, owner, issuer, approver,
     paid_at, receipt_no, due_at, return_count, returned_at, return_reason, fix_deadline, reject_reason, closed_at, cancelled_at, created_at, updated_at)
    VALUES (@draft_id, @case_no, @service_id, @applicant_id, @qty, @area_sqm, @fee, @status, @step, @dept, @owner, @issuer, @approver,
     @paid_at, @receipt_no, @due_at, @return_count, @returned_at, @return_reason, @fix_deadline, @reject_reason, @closed_at, @cancelled_at, @created_at, @updated_at)`);
  const insEvent = db.prepare('INSERT INTO case_events (case_id, at, actor, event, from_status, to_status, note) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insFile = db.prepare(`INSERT INTO case_files (id, case_id, doc_key, name, mime, size, data, uploaded_by, created_at)
    VALUES (?, ?, ?, ?, 'application/pdf', ?, ?, ?, ?)`);
  const insPay = db.prepare(`INSERT INTO payments (ref, case_id, amount, status, qr_created_at, qr_expires_at, paid_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);

  const addFiles = (caseId, sv, uploader, at, prefix) => {
    for (const [docKey, name] of REQUIRED_FILES[sv]) {
      const data = tinyPdf(`${prefix} ${name}`);
      insFile.run(`sf-${prefix}-${docKey}`, caseId, docKey, name, data.length, data, uploader, at);
    }
  };

  const caseIdByNo = {};
  for (const c of CASES) {
    const caseNo = `EG-2569-${String(c.n).padStart(6, '0')}`;
    const receiptNo = `RC-2569-${String(c.n).padStart(6, '0')}`;
    const paidAt = iso(c.paid);
    const createdAt = shift(paidAt, -10);
    const flow = c.flow || (['COMPLETED', 'REJECTED', 'CANCELLED'].includes(c.status) ? closedFlow(c) : []);
    const { events, state } = playFlow(c, flow);
    if (state.status !== c.status) throw new Error(`seed: ${caseNo} flow ends at ${state.status}, expected ${c.status}`);
    const lastAt = events.length ? events[events.length - 1].at : paidAt;

    const r = insCase.run({
      draft_id: null, case_no: caseNo, service_id: c.sv, applicant_id: userId[c.who],
      qty: c.sv === 'SV-01' ? c.qty : null, area_sqm: c.sv === 'SV-03' ? c.area : null, fee: c.fee,
      status: state.status, step: state.step, dept: state.dept, owner: state.owner, issuer: state.issuer, approver: state.approver,
      paid_at: paidAt, receipt_no: receiptNo, due_at: iso(c.due),
      return_count: state.return_count, returned_at: state.returned_at, return_reason: state.return_reason,
      fix_deadline: state.status === 'NEED_FIX' ? state.fix_deadline : null,
      reject_reason: state.reject_reason, closed_at: state.closed_at, cancelled_at: state.cancelled_at,
      created_at: createdAt, updated_at: lastAt,
    });
    const caseId = Number(r.lastInsertRowid);
    caseIdByNo[caseNo] = caseId;

    insEvent.run(caseId, createdAt, 'citizen', 'CREATED', null, 'DRAFT', null);
    insEvent.run(caseId, paidAt, 'citizen', 'PAID', 'PENDING_PAYMENT', 'SUBMITTED', receiptNo);
    for (const e of events) insEvent.run(caseId, e.at, e.actor, e.event, e.from, e.to, e.note);

    addFiles(caseId, c.sv, userId[c.who], createdAt, String(c.n).padStart(6, '0'));
  }

  // 4.2 ร่างและรอชำระของสมชาย
  const dr1 = insCase.run({
    draft_id: 'DR-0001', case_no: null, service_id: 'SV-01', applicant_id: userId.somchai, qty: 2, area_sqm: null, fee: 40,
    status: 'DRAFT', step: null, dept: null, owner: null, issuer: null, approver: null,
    paid_at: null, receipt_no: null, due_at: null, return_count: 0, returned_at: null, return_reason: null, fix_deadline: null,
    reject_reason: null, closed_at: null, cancelled_at: null,
    created_at: '2026-11-30T15:00:00+07:00', updated_at: '2026-11-30T15:00:00+07:00',
  });
  insEvent.run(Number(dr1.lastInsertRowid), '2026-11-30T15:00:00+07:00', 'citizen', 'CREATED', null, 'DRAFT', null);

  const dr2 = insCase.run({
    draft_id: 'DR-0002', case_no: null, service_id: 'SV-02', applicant_id: userId.somchai, qty: null, area_sqm: null, fee: 500,
    status: 'PENDING_PAYMENT', step: null, dept: null, owner: null, issuer: null, approver: null,
    paid_at: null, receipt_no: null, due_at: null, return_count: 0, returned_at: null, return_reason: null, fix_deadline: null,
    reject_reason: null, closed_at: null, cancelled_at: null,
    created_at: '2026-12-01T08:45:00+07:00', updated_at: '2026-12-01T08:55:00+07:00',
  });
  const dr2Id = Number(dr2.lastInsertRowid);
  insEvent.run(dr2Id, '2026-12-01T08:45:00+07:00', 'citizen', 'CREATED', null, 'DRAFT', null);
  addFiles(dr2Id, 'SV-02', userId.somchai, '2026-12-01T08:50:00+07:00', 'DR-0002');

  // 6. ชำระเงิน: รายการค้าง PP-0001 (สร้าง 08:55 หมดอายุ 09:10 · อายุ 15:00 พอดีเมื่อ 09:10:00)
  insPay.run('PP-0001', dr2Id, 500, 'PENDING', '2026-12-01T08:55:00+07:00', '2026-12-01T09:10:00+07:00', null);

  // 5. เอกสารที่ออกแล้ว DOC-2569-000001 (EG-2569-000005 ของสมชาย)
  const doc = {
    docNo: 'DOC-2569-000001',
    caseNo: 'EG-2569-000005',
    applicant: 'สมชาย ใจดี',
    serviceId: 'SV-01',
    issuedAt: '2026-11-05T10:00:00+07:00',
    validUntil: '2027-02-02',
    signer: 'เจ้าหน้าที่ทะเบียน 1',
  };
  db.prepare(`INSERT INTO documents (doc_no, case_id, case_no, verify_code, applicant, service_id, issued_at, valid_until, signer, issued_by, signature)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    doc.docNo, caseIdByNo[doc.caseNo], doc.caseNo, 'K7M2Q9XA', doc.applicant, doc.serviceId,
    doc.issuedAt, doc.validUntil, doc.signer, 'off.reg1', crypto.signDoc(doc),
  );
  db.prepare("UPDATE case_events SET note = ? WHERE case_id = ? AND event = 'ISSUE'").run(doc.docNo, caseIdByNo[doc.caseNo]);

  // 12. ตัวนับ → เลขถัดไป EG-2569-000031 · RC-2569-000031 · DOC-2569-000002 · DR-0003 · PP-0002 (EG-2570 เริ่ม 1 เอง)
  const insCounter = db.prepare('INSERT INTO counters (name, value) VALUES (?, ?)');
  insCounter.run('case:2569', 30);
  insCounter.run('receipt:2569', 30);
  insCounter.run('doc:2569', 1);
  insCounter.run('draft', 2);
  insCounter.run('payref', 1);
}

module.exports = { seed, CASES, CITIZENS, STAFF };
