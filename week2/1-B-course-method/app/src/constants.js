'use strict';
/**
 * ค่าคงที่ร่วมของทั้งระบบ (B01) — ข้อความไทยตรงตัวตาม CONTRACT §2 §4 · ตัวเลขตาม DECISIONS
 * ทุกบล็อกอ่านจากไฟล์นี้ (ห้ามพิมพ์ข้อความ/ตัวเลขซ้ำเองในโมดูล) · ค่าที่ admin แก้ได้ (ค่าธรรมเนียม SLA วันหยุด) อยู่ในฐานข้อมูล ไม่ใช่ที่นี่
 */

const ROLES = ['citizen', 'officer', 'head', 'executive', 'auditor', 'admin'];

/** ข้อความ user-role (CONTRACT §2.1) */
const ROLE_LABEL = {
  citizen: 'ประชาชน',
  officer: 'เจ้าหน้าที่',
  head: 'หัวหน้าฝ่าย',
  executive: 'ผู้บริหาร',
  auditor: 'ผู้ตรวจสอบภายใน',
  admin: 'ผู้ดูแลระบบ',
};

const DEPTS = ['registry', 'works'];
const DEPT_LABEL = { registry: 'ฝ่ายทะเบียน', works: 'ฝ่ายโยธา' };

/** หน้าตั้งต้นหลังล็อกอิน (CONTRACT §1) · citizen ที่ยังไม่ลงทะเบียน → /register */
const LANDING = {
  citizen: '/citizen',
  officer: '/officer/queue',
  head: '/head/approvals',
  executive: '/dashboard',
  auditor: '/audit',
  admin: '/admin/services',
};

/** สถานะคำขอ (CONTRACT §4.1) */
const STATUSES = [
  'DRAFT', 'PENDING_PAYMENT', 'SUBMITTED', 'IN_REVIEW', 'NEED_FIX',
  'PENDING_APPROVAL', 'APPROVED', 'COMPLETED', 'REJECTED', 'CANCELLED',
];
const STATUS_LABEL = {
  DRAFT: 'ร่าง',
  PENDING_PAYMENT: 'รอชำระเงิน',
  SUBMITTED: 'ส่งคำขอแล้ว',
  IN_REVIEW: 'กำลังตรวจสอบ',
  NEED_FIX: 'รอแก้ไขเอกสาร',
  PENDING_APPROVAL: 'รออนุมัติ',
  APPROVED: 'อนุมัติ',
  COMPLETED: 'เสร็จสิ้น',
  REJECTED: 'ไม่อนุมัติ',
  CANCELLED: 'ยกเลิก',
};

/** งานคงค้าง (DECISIONS §12) */
const BACKLOG_STATUSES = ['SUBMITTED', 'IN_REVIEW', 'NEED_FIX', 'PENDING_APPROVAL', 'APPROVED'];
/** ปิดงาน (นับใน Dashboard · SLA หยุดถาวร) */
const CLOSED_STATUSES = ['COMPLETED', 'REJECTED'];
/** สิ้นสุดแล้ว (ระดับเตือน = closed) */
const FINAL_STATUSES = ['COMPLETED', 'REJECTED', 'CANCELLED'];

/** ระดับเตือน (CONTRACT §4.2) */
const SLA_LEVELS = ['normal', 'near', 'overdue', 'paused', 'closed'];
const SLA_LEVEL_LABEL = {
  normal: 'ปกติ',
  near: 'ใกล้ครบกำหนด',
  overdue: 'เกินกำหนด',
  paused: 'หยุดนับ',
  closed: 'ปิดแล้ว',
};

/** สถานะชำระเงิน (CONTRACT §2.5 payment-status) */
const PAYMENT_STATUS_LABEL = { PENDING: 'รอชำระ', PAID: 'ชำระแล้ว', EXPIRED: 'QR หมดอายุ' };

/** ชื่อเอกสารแนบ (CONTRACT §4.3) */
const DOC_LABEL = {
  'id-card': 'บัตรประชาชน',
  map: 'แผนที่ตั้ง',
  'site-photo': 'ภาพสถานที่',
  plan: 'แบบแปลน',
  deed: 'โฉนด',
  extra: 'เอกสารเพิ่มเติม',
};
const DOC_KEYS = Object.keys(DOC_LABEL);

/**
 * แคตตาล็อกบริการแบบคงที่ (ชื่อ เอกสาร เส้นทาง) · ค่าธรรมเนียม/SLA ที่ admin แก้ได้อยู่ในตาราง services
 * docs เรียงตามลำดับที่ใช้ใน missing-docs · pdfOnly = ต้องเป็น PDF (แบบแปลน)
 * route = ลำดับขั้น: {dept} = คิวแผนก · {head:true} = ขั้นหัวหน้าอนุมัติ
 * approver: 'officer' (SV-01 ผู้ถือเรื่องอนุมัติเอง) | 'head'
 * validity: อายุเอกสาร (DECISIONS §10 · A-23) → ใช้ได้ถึง = วันออก + (days − 1) วัน หรือ + years ปี − 1 วัน
 */
const SERVICES = {
  'SV-01': {
    id: 'SV-01',
    name: 'ขอหนังสือรับรอง',
    docs: [{ key: 'id-card', required: true }],
    route: [{ dept: 'registry' }],
    approver: 'officer',
    validity: { days: 90 },
  },
  'SV-02': {
    id: 'SV-02',
    name: 'ขออนุญาตประกอบกิจการ',
    docs: [
      { key: 'id-card', required: true },
      { key: 'map', required: true },
      { key: 'site-photo', required: false },
    ],
    route: [{ dept: 'registry' }, { head: true }],
    approver: 'head',
    validity: { years: 1 },
  },
  'SV-03': {
    id: 'SV-03',
    name: 'ขออนุญาตก่อสร้าง/ต่อเติมอาคาร',
    docs: [
      { key: 'id-card', required: true },
      { key: 'plan', required: true, pdfOnly: true },
      { key: 'deed', required: true },
    ],
    route: [{ dept: 'registry' }, { dept: 'works' }, { head: true }],
    approver: 'head',
    validity: { years: 1 },
  },
};
const SERVICE_IDS = Object.keys(SERVICES);

/** case-step ของ SV-03 (CONTRACT §2.6 · A-40) */
const SV03_STEP_LABEL = {
  1: 'ขั้นตอน 1/3 · ฝ่ายทะเบียน',
  2: 'ขั้นตอน 2/3 · ฝ่ายโยธา',
  3: 'ขั้นตอน 3/3 · หัวหน้าฝ่าย',
};

/** เหตุการณ์ Audit (DECISIONS §13) */
const AUDIT_EVENTS = [
  'STAFF_LOGIN', 'CLAIM', 'RETURN', 'FORWARD', 'APPROVE',
  'REJECT', 'ISSUE', 'UNMASK', 'EXPORT', 'ADMIN_CHANGE',
];

/** ตัวเลขกฎธุรกิจ (DECISIONS) */
const LIMITS = {
  TEST_OTP: '123456',            // A-05
  OTP_MAX_FAIL: 3,               // A-06 ผิด 3 ครั้งติดกัน → ล็อก
  OTP_LOCK_MS: 15 * 60 * 1000,   // A-06 ล็อก 15 นาทีนับจากครั้งที่ 3 (14:59 ยังล็อก · 15:00 ปลด)
  SV01_QTY_MIN: 1, SV01_QTY_MAX: 5,       // จำนวนฉบับ
  SV03_AREA_MIN: 1, SV03_AREA_MAX: 500,   // ตร.ม.
  SV03_BASE_AREA: 100,                    // 1–100 → ฐาน · ส่วนเกิน 100 คิดต่อ ตร.ม.
  MAX_FILE_BYTES: 5242880,       // A-10 ≤ 5 MB (รวมค่านี้)
  MAX_FILES: 5,                  // A-10 ต่อคำขอ
  QR_TTL_MS: 15 * 60 * 1000,     // A-15 ใช้ได้ถ้า (ชำระ − สร้าง) < 15:00
  CUTOFF_HM: '16:30',            // A-03 ตัดรอบ
  DUE_HM: '16:30',               // กำหนดเสร็จเวลา 16:30
  NEAR_DAYS: 1,                  // A-17 วันคงเหลือ ≤ 1 → ใกล้ครบกำหนด
  MAX_WORKLOAD: 10,              // A-19
  MAX_RETURNS: 2,                // A-20
  FIX_WINDOW_MS: 168 * 3600 * 1000, // A-21 7 วันปฏิทิน
  REASON_MIN: 10,                // A-12 เหตุผลตีกลับ/ไม่อนุมัติ ≥ 10 ตัวอักษร
  ADMIN_FEE_MIN: 0, ADMIN_FEE_MAX: 100000, // A-53
  ADMIN_SLA_MIN: 1, ADMIN_SLA_MAX: 60,     // A-53
};

/** รูปแบบเลข (DECISIONS §6 §7 §10 · TEST-DATA §12) */
const NUMBERING = {
  caseNo: (be, n) => `EG-${be}-${String(n).padStart(6, '0')}`,
  receiptNo: (be, n) => `RC-${be}-${String(n).padStart(6, '0')}`,
  docNo: (be, n) => `DOC-${be}-${String(n).padStart(6, '0')}`,
  draftId: (n) => `DR-${String(n).padStart(4, '0')}`,
  payRef: (n) => `PP-${String(n).padStart(4, '0')}`,
};

/** ชื่อ counter ในตาราง counters (ใช้กับ db.nextSeq) */
const COUNTER = {
  caseNo: (be) => `case:${be}`,
  receiptNo: (be) => `receipt:${be}`,
  docNo: (be) => `doc:${be}`,
  draftId: 'draft',
  payRef: 'payref',
};

module.exports = {
  ROLES, ROLE_LABEL, DEPTS, DEPT_LABEL, LANDING,
  STATUSES, STATUS_LABEL, BACKLOG_STATUSES, CLOSED_STATUSES, FINAL_STATUSES,
  SLA_LEVELS, SLA_LEVEL_LABEL, PAYMENT_STATUS_LABEL,
  DOC_LABEL, DOC_KEYS, SERVICES, SERVICE_IDS, SV03_STEP_LABEL,
  AUDIT_EVENTS, LIMITS, NUMBERING, COUNTER,
};
