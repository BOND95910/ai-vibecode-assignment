// B02 · ข้อมูล seed ตาม egov-brief/TEST-DATA.md (ตรงทุกค่า) · resetAll() เรียก seed() ภายใน transaction เดียวกับการล้าง
// ค่า dueAt/closedAt ฯลฯ เก็บตายตัวตามตาราง (A-35) ไม่คำนวณใหม่ · seed ไม่สร้าง audit และ notifications
const crypto = require('crypto');
const clock = require('./clock');
const util = require('./util');
const { db, tx, setCounter } = require('./db');

// คีย์ทดสอบของลายเซ็นเอกสาร (A-22) · B07 import ไปใช้เซ็น/ตรวจเอกสารใหม่ด้วยคีย์เดียวกัน
const SIGN_KEY = 'egov-eservice-test-sign-key';
// HMAC-SHA256 (hex) ของ docNo|caseNo|applicant|serviceId|issuedAt|validUntil|signer ตาม CONTRACT ข้อ 3
function signDocument(d) {
  const msg = [d.docNo, d.caseNo, d.applicant, d.serviceId, d.issuedAt, d.validUntil, d.signer].join('|');
  return crypto.createHmac('sha256', SIGN_KEY).update(msg).digest('hex');
}

const T = (s) => s.replace(' ', 'T') + ':00+07:00'; // '2026-11-02 10:00' -> ISO +07:00
const plusH = (iso, h) => clock.toBangkokISO(new Date(clock.parseISO(iso).getTime() + h * 3600 * 1000));

// ---- 1. บัญชี ----
const CITIZENS = [
  { key: 'SC', name: 'สมชาย ใจดี', id: '1101700123456', mobile: '0812345678', registered: 1 },
  { key: 'SY', name: 'สมหญิง รักไทย', id: '3100600987659', mobile: '0823456789', registered: 1 },
  { key: 'MN', name: 'มานะ ตั้งใจ', id: '5500400111221', mobile: null, registered: 0 },
  { key: 'PT', name: 'ปิติ มีสุข', id: '1909900555015', mobile: '0834567890', registered: 1 },
];
const STAFF = [
  ['off.reg1', 'officer', 'registry', 'เจ้าหน้าที่ทะเบียน 1'],
  ['off.reg2', 'officer', 'registry', 'เจ้าหน้าที่ทะเบียน 2'],
  ['off.works1', 'officer', 'works', 'เจ้าหน้าที่โยธา 1'],
  ['head1', 'head', '', 'หัวหน้าฝ่าย'],
  ['exec1', 'executive', '', 'ผู้บริหาร'],
  ['audit1', 'auditor', '', 'ผู้ตรวจสอบภายใน'],
  ['admin1', 'admin', '', 'ผู้ดูแลระบบ'],
];

// ---- 2. บริการ ----
const SERVICES = [
  ['SV-01', 'ขอหนังสือรับรอง', 20, 0, 0, 3, [['id-card', 'บัตรประชาชน', 1, 0]]],
  ['SV-02', 'ขออนุญาตประกอบกิจการ', 500, 0, 0, 10,
    [['id-card', 'บัตรประชาชน', 1, 0], ['map', 'แผนที่ตั้ง', 1, 0], ['site-photo', 'ภาพสถานที่', 0, 0]]],
  ['SV-03', 'ขออนุญาตก่อสร้าง/ต่อเติมอาคาร', 0, 1000, 10, 15,
    [['id-card', 'บัตรประชาชน', 1, 0], ['plan', 'แบบแปลน', 1, 1], ['deed', 'โฉนด', 1, 0]]],
];
const HOLIDAYS = [
  ['2026-12-07', 'ชดเชยวันหยุดทดสอบ (สมมติ)'], ['2026-12-10', 'วันรัฐธรรมนูญทดสอบ (สมมติ)'],
  ['2026-12-31', 'วันสิ้นปีทดสอบ (สมมติ)'], ['2027-01-01', 'วันขึ้นปีใหม่ทดสอบ (สมมติ)'],
];

// ---- 4.1 คำขอ 30 ใบ · [เลข, บริการ, qty|ตร.ม., ค่าธรรมเนียม, ผู้ยื่น, สถานะ, ขั้น, แผนก, ผู้ถือ, ทะเบียนขั้นแรก, โยธา, ผู้อนุมัติ, ชำระ, กำหนดเสร็จ, ปิด] ----
const R1 = 'off.reg1', R2 = 'off.reg2', W1 = 'off.works1', H = 'head1', N = null;
/* eslint-disable */
const ROWS = [
  [1, 'SV-01', 1, 20, 'SY', 'COMPLETED', N, '', N, R1, N, R1, '2026-10-14 10:00', '2026-10-19 16:30', '2026-10-16 14:00'],
  [2, 'SV-03', 120, 1200, 'PT', 'COMPLETED', 3, '', N, R1, W1, H, '2026-11-02 09:00', '2026-11-23 16:30', '2026-11-20 11:00'],
  [3, 'SV-01', 2, 40, 'PT', 'COMPLETED', N, '', N, R1, N, R1, '2026-11-02 09:30', '2026-11-05 16:30', '2026-11-04 15:00'],
  [4, 'SV-02', N, 500, 'SC', 'COMPLETED', N, '', N, R1, N, H, '2026-11-02 14:00', '2026-11-16 16:30', '2026-11-13 15:00'],
  [5, 'SV-01', 1, 20, 'SC', 'COMPLETED', N, '', N, R1, N, R1, '2026-11-03 11:00', '2026-11-06 16:30', '2026-11-05 10:00'],
  [6, 'SV-02', N, 500, 'PT', 'COMPLETED', N, '', N, R1, N, H, '2026-11-03 15:00', '2026-11-17 16:30', '2026-11-19 10:00'],
  [7, 'SV-02', N, 500, 'SY', 'COMPLETED', N, '', N, R1, N, H, '2026-11-04 10:00', '2026-11-18 16:30', '2026-11-18 16:00'],
  [8, 'SV-01', 1, 20, 'SY', 'REJECTED', N, '', N, R1, N, R1, '2026-11-09 10:00', '2026-11-12 16:30', '2026-11-11 09:00'],
  [9, 'SV-01', 1, 20, 'SC', 'CANCELLED', N, '', N, N, N, N, '2026-11-09 14:30', '2026-11-12 16:30', '2026-11-09 15:00'],
  [10, 'SV-03', 80, 1000, 'SY', 'IN_REVIEW', 2, 'works', N, R1, N, N, '2026-11-12 10:00', '2026-12-03 16:30', N],
  [11, 'SV-03', 150, 1500, 'SC', 'PENDING_APPROVAL', 3, '', N, R1, W1, N, '2026-11-16 10:00', '2026-12-08 16:30', N],
  [12, 'SV-03', 101, 1010, 'PT', 'IN_REVIEW', 1, 'registry', R2, R2, N, N, '2026-11-18 10:00', '2026-12-11 16:30', N],
  [13, 'SV-02', N, 500, 'SC', 'IN_REVIEW', N, 'registry', R2, R2, N, N, '2026-11-20 10:00', '2026-12-04 16:30', N],
  [14, 'SV-02', N, 500, 'PT', 'PENDING_APPROVAL', N, '', N, R1, N, N, '2026-11-20 11:00', '2026-12-04 16:30', N],
  [15, 'SV-02', N, 500, 'SY', 'IN_REVIEW', N, 'registry', R2, R2, N, N, '2026-11-20 15:00', '2026-12-04 16:30', N],
  [16, 'SV-02', N, 500, 'PT', 'IN_REVIEW', N, 'registry', R2, R2, N, N, '2026-11-23 09:00', '2026-12-08 16:30', N],
  [17, 'SV-01', 1, 20, 'SC', 'NEED_FIX', N, 'registry', R1, R1, N, N, '2026-11-23 10:00', '2026-11-27 16:30', N],
  [18, 'SV-02', N, 500, 'SC', 'IN_REVIEW', N, 'registry', R2, R2, N, N, '2026-11-24 10:00', '2026-12-09 16:30', N],
  [19, 'SV-02', N, 500, 'SY', 'APPROVED', N, 'registry', N, R1, N, H, '2026-11-24 14:00', '2026-12-09 16:30', N],
  [20, 'SV-01', 1, 20, 'SC', 'IN_REVIEW', N, 'registry', R1, R1, N, N, '2026-11-25 10:00', '2026-11-30 16:30', N],
  [21, 'SV-02', N, 500, 'SY', 'IN_REVIEW', N, 'registry', R2, R2, N, N, '2026-11-25 12:00', '2026-12-11 16:30', N],
  [22, 'SV-01', 2, 40, 'SY', 'IN_REVIEW', N, 'registry', R1, R1, N, N, '2026-11-26 10:00', '2026-12-01 16:30', N],
  [23, 'SV-01', 1, 20, 'SY', 'IN_REVIEW', N, 'registry', R1, R1, N, N, '2026-11-26 10:30', '2026-12-03 16:30', N],
  [24, 'SV-01', 1, 20, 'PT', 'SUBMITTED', N, 'registry', N, N, N, N, '2026-11-27 11:00', '2026-12-02 16:30', N],
  [25, 'SV-01', 3, 60, 'SY', 'IN_REVIEW', N, 'registry', R2, R2, N, N, '2026-11-30 10:00', '2026-12-03 16:30', N],
  [26, 'SV-01', 5, 100, 'SC', 'IN_REVIEW', N, 'registry', R2, R2, N, N, '2026-11-30 16:29', '2026-12-03 16:30', N],
  [27, 'SV-01', 1, 20, 'PT', 'IN_REVIEW', N, 'registry', R2, R2, N, N, '2026-11-30 16:30', '2026-12-04 16:30', N],
  [28, 'SV-01', 1, 20, 'SY', 'SUBMITTED', N, 'registry', N, N, N, N, '2026-12-01 08:10', '2026-12-04 16:30', N],
  [29, 'SV-01', 1, 20, 'PT', 'SUBMITTED', N, 'registry', N, N, N, N, '2026-12-01 08:20', '2026-12-04 16:30', N],
  [30, 'SV-01', 1, 20, 'SC', 'SUBMITTED', N, 'registry', N, N, N, N, '2026-12-01 08:30', '2026-12-04 16:30', N],
];
/* eslint-enable */

// ตาราง 4.4 · ประวัติตีกลับ (paused_days ตามตาราง · ครั้งที่ 2 ของ F01 ยังไม่ส่งแก้)
const RETURNS = {
  17: [
    [1, '2026-11-24 11:00', '2026-11-25 10:00', 1, 'ภาพบัตรประชาชนไม่ชัด กรุณาถ่ายใหม่'],
    [2, '2026-11-27 14:00', null, null, 'ชื่อในเอกสารไม่ตรงกับบัตร กรุณาแก้ไข'],
  ],
  23: [
    [1, '2026-11-27 10:00', '2026-11-30 10:00', 1, 'ภาพเอกสารเบลอ อ่านเลขไม่ได้'],
    [2, '2026-11-30 14:00', '2026-12-01 08:30', 1, 'ข้อมูลในแบบฟอร์มไม่ครบถ้วน'],
  ],
};

const DOC1 = { // ตาราง 5
  docNo: 'DOC-2569-000001', caseNo: 'EG-2569-000005', verifyCode: 'K7M2Q9XA', serviceId: 'SV-01',
  applicant: 'สมชาย ใจดี', issuedAt: T('2026-11-05 10:00'), validUntil: '2027-02-02', signer: 'เจ้าหน้าที่ทะเบียน 1',
};

// PDF จริงขนาดเล็ก 1,024 ไบต์ (หัว %PDF + เว้นวรรค + %%EOF) ตาม make_testfiles.py ในข้อ 11
function pdf(n) {
  const head = '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n', tail = '\ntrailer<</Root 1 0 R>>\n%%EOF\n';
  return Buffer.from(head + ' '.repeat(n - head.length - tail.length) + tail, 'latin1');
}
const FILES_BY_SERVICE = {
  'SV-01': [['id-card', 'id-card.pdf']],
  'SV-02': [['id-card', 'id-card.pdf'], ['map', 'map.pdf']],
  'SV-03': [['id-card', 'id-card.pdf'], ['plan', 'plan.pdf'], ['deed', 'deed.pdf']],
};

function seed() {
  tx(() => {
    const ins = (table, obj) => {
      const k = Object.keys(obj);
      return db.prepare(`INSERT INTO ${table} (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...Object.values(obj));
    };
    const created = '2026-10-01T08:00:00+07:00';

    // ผู้ใช้
    const uid = {};
    for (const c of CITIZENS) {
      uid[c.key] = Number(ins('users', {
        role: 'citizen', display_name: c.name, id_no_enc: util.encrypt(c.id), id_hash: util.hashId(c.id),
        id_masked: util.maskId(c.id), mobile_enc: util.encrypt(c.mobile), email: '', registered: c.registered,
        consent_at: c.registered ? created : null, created_at: created,
      }).lastInsertRowid);
    }
    for (const [username, role, dept, name] of STAFF) {
      ins('users', { username, role, dept, display_name: name, password_hash: util.hashPassword('Test@1234'), email: '', registered: 1, created_at: created });
    }

    // บริการ · วันหยุด
    for (const [id, name, fee, base, per, sla, docs] of SERVICES) {
      ins('services', {
        id, name, fee, fee_base: base, fee_per_sqm: per, sla,
        docs_json: JSON.stringify(docs.map(([key, n, required, pdfOnly]) => ({ key, name: n, required: !!required, pdfOnly: !!pdfOnly }))),
      });
    }
    for (const [date, name] of HOLIDAYS) ins('holidays', { date, name });

    // คำขอ 30 ใบ + ไฟล์ + ไทม์ไลน์ + ประวัติตีกลับ
    let fileSeq = 0;
    const addFile = (fields) => ins('files', { file_id: 'F-' + util.pad(++fileSeq, 4), size: 1024, mime: 'application/pdf', content: pdf(1024), ...fields });
    for (const [n, svc, amount, fee, who, status, step, dept, owner, regOwner, worksOwner, approver, paid, due, closed] of ROWS) {
      const caseNo = util.formatNo('EG', 2569, n), paidAt = T(paid), closedAt = closed ? T(closed) : null;
      const rets = RETURNS[n] || [];
      const last = rets[rets.length - 1];
      const needFix = status === 'NEED_FIX';
      ins('cases', {
        case_no: caseNo, user_id: uid[who], service_id: svc, status, step, dept, fee,
        qty: svc === 'SV-01' ? amount : null, area_sqm: svc === 'SV-03' ? amount : null,
        paid_at: paidAt, receipt_no: util.formatNo('RC', 2569, n), due_at: T(due),
        owner, registry_owner: regOwner, works_owner: worksOwner, approver,
        approved_at: status === 'APPROVED' ? T('2026-11-30 15:00') : status === 'COMPLETED' ? plusH(closedAt, -0.5) : null,
        return_count: rets.length,
        return_reason: last ? last[4] : null,
        returned_at: needFix ? T(last[1]) : null,
        fix_deadline: needFix ? plusH(T(last[1]), 168) : null, // 27 พ.ย. 14:00 + 168 ชม. = 4 ธ.ค. 14:00
        reject_reason: status === 'REJECTED' ? 'เอกสารไม่ครบถ้วนตามข้อกำหนดของบริการ' : null,
        closed_at: closedAt,
        doc_no: n === 5 ? DOC1.docNo : null,
        created_at: paidAt, updated_at: closedAt || paidAt,
      });
      for (const [seq, ra, rs, pd, reason] of rets) {
        ins('case_returns', { case_no: caseNo, seq, returned_by: regOwner, returned_at: T(ra), reason, resubmitted_at: rs ? T(rs) : null, paused_days: pd });
      }
      for (const [docKey, name] of FILES_BY_SERVICE[svc]) {
        addFile({ case_no: caseNo, user_id: uid[who], name, doc_key: docKey, created_at: paidAt });
      }

      // ไทม์ไลน์ (เวลาระหว่างขั้นเป็นค่ากำหนดเองตามลำดับ · TEST-DATA ระบุเฉพาะเวลาชำระ/ตีกลับ/ปิดงาน/อนุมัติ A01)
      const ev = (time, kind, text, actor, actorRole, from, to) =>
        ins('timeline_events', { case_no: caseNo, time, actor, actor_role: actorRole, kind, text, from_status: from, to_status: to });
      ev(paidAt, 'PAID', 'ชำระค่าธรรมเนียมสำเร็จ ' + util.baht(fee), N, 'citizen', N, N);
      ev(paidAt, 'SUBMITTED', 'ส่งคำขอแล้ว', N, 'system', N, 'SUBMITTED');
      if (status === 'CANCELLED') { ev(closedAt, 'CANCEL', 'ผู้ยื่นยกเลิกคำขอ', N, 'citizen', 'SUBMITTED', 'CANCELLED'); continue; }
      if (status === 'SUBMITTED') continue;
      ev(plusH(paidAt, 1), 'CLAIM', 'รับเรื่อง', regOwner, 'officer', 'SUBMITTED', 'IN_REVIEW');
      if (rets.length) { // F01 F02
        for (const [seq, ra, rs, , reason] of rets) {
          ev(T(ra), 'RETURN', `ตีกลับครั้งที่ ${seq}: ${reason}`, regOwner, 'officer', 'IN_REVIEW', 'NEED_FIX');
          if (rs) ev(T(rs), 'RESUBMIT', `ส่งแก้ไขครั้งที่ ${seq}`, N, 'citizen', 'NEED_FIX', 'IN_REVIEW');
        }
        continue;
      }
      if (status === 'IN_REVIEW' && step !== 2) continue;
      const toApproval = (t) => ev(t, 'FORWARD', 'ส่งต่อให้หัวหน้าฝ่ายอนุมัติ', worksOwner || regOwner, 'officer', 'IN_REVIEW', 'PENDING_APPROVAL');
      if (svc === 'SV-03') {
        ev(plusH(paidAt, 2), 'FORWARD', 'ผ่านขั้นทะเบียน ส่งต่อฝ่ายโยธา', regOwner, 'officer', 'IN_REVIEW', 'IN_REVIEW');
        if (worksOwner) {
          ev(plusH(paidAt, 3), 'CLAIM', 'รับเรื่อง (ฝ่ายโยธา)', worksOwner, 'officer', 'IN_REVIEW', 'IN_REVIEW');
          toApproval(plusH(paidAt, 4));
        }
      } else if (svc === 'SV-02' && status !== 'REJECTED') toApproval(plusH(paidAt, 2));
      if (status === 'APPROVED') ev(T('2026-11-30 15:00'), 'APPROVE', 'อนุมัติ', H, 'head', 'PENDING_APPROVAL', 'APPROVED');
      if (status === 'REJECTED') ev(closedAt, 'REJECT', 'ไม่อนุมัติ: เอกสารไม่ครบถ้วนตามข้อกำหนดของบริการ', regOwner, 'officer', 'IN_REVIEW', 'REJECTED');
      if (status === 'COMPLETED') {
        const approverRole = approver === H ? 'head' : 'officer';
        ev(plusH(closedAt, -0.5), 'APPROVE', 'อนุมัติ', approver, approverRole, approverRole === 'head' ? 'PENDING_APPROVAL' : 'IN_REVIEW', 'APPROVED');
        ev(closedAt, 'ISSUE', n === 5 ? `ออกเอกสาร ${DOC1.docNo}` : 'ออกเอกสาร', regOwner, 'officer', 'APPROVED', 'COMPLETED');
      }
    }

    // ร่างของสมชาย (ไม่มีเลขคำขอ) · DR-0002 รอชำระ PP-0001
    ins('drafts', { draft_id: 'DR-0001', user_id: uid.SC, service_id: 'SV-01', status: 'DRAFT', qty: 2, area_sqm: null, fee: 40, created_at: '2026-12-01T08:30:00+07:00', updated_at: '2026-12-01T08:30:00+07:00' });
    ins('drafts', { draft_id: 'DR-0002', user_id: uid.SC, service_id: 'SV-02', status: 'PENDING_PAYMENT', qty: null, area_sqm: null, fee: 500, created_at: '2026-12-01T08:40:00+07:00', updated_at: '2026-12-01T08:55:00+07:00' });
    for (const [docKey, name] of FILES_BY_SERVICE['SV-02']) {
      addFile({ draft_id: 'DR-0002', user_id: uid.SC, name, doc_key: docKey, created_at: '2026-12-01T08:50:00+07:00' });
    }
    ins('payments', { ref: 'PP-0001', draft_id: 'DR-0002', amount: 500, status: 'PENDING', qr_created_at: '2026-12-01T08:55:00+07:00', qr_expires_at: '2026-12-01T09:10:00+07:00', created_at: '2026-12-01T08:55:00+07:00' });

    // เอกสารที่ออกแล้ว 1 ใบ (ลายเซ็นคำนวณจริงด้วย SIGN_KEY)
    ins('documents', {
      doc_no: DOC1.docNo, case_no: DOC1.caseNo, verify_code: DOC1.verifyCode, service_id: DOC1.serviceId,
      applicant_name: DOC1.applicant, issued_at: DOC1.issuedAt, valid_until: DOC1.validUntil, signer: DOC1.signer,
      signer_username: R1, issued_by: R1, signature: signDocument(DOC1),
    });

    // ตัวนับ (ข้อ 12)
    setCounter('EG', 2569, 31); setCounter('RC', 2569, 31); setCounter('DOC', 2569, 2);
    setCounter('DR', 0, 3); setCounter('PP', 0, 2);
  });
}

module.exports = { seed, SIGN_KEY, signDocument };
