// รูปแบบวันที่/เงินบนจอ (CONTRACT ข้อ 0.2) คำนวณจากกฎ ไม่ได้อ่านจากหน้าจอ
const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

// '2026-12-04T16:30:00+07:00' -> '4 ธ.ค. 2569 16:30'
function thaiDateTime(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) throw new Error('ISO ไม่ถูกต้อง: ' + iso);
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${Number(m[1]) + 543} ${m[4]}:${m[5]}`;
}

// 1010 -> '฿1,010'
const baht = (n) => '฿' + Number(n).toLocaleString('en-US');

// en dash U+2013 ตาม CONTRACT (ค่าไม่ถูกต้อง / ทันกำหนด % เมื่อปิดงาน 0)
const DASH = '–';

// 25 -> 'EG-2569-000025'
const CASE = (n) => 'EG-2569-' + String(n).padStart(6, '0');

// ข้อความระดับเตือน / สถานะ (CONTRACT ตาราง 4.1 และ 4.2)
const LEVEL_TH = { normal: 'ปกติ', near: 'ใกล้ครบกำหนด', overdue: 'เกินกำหนด', paused: 'หยุดนับ', closed: 'ปิดแล้ว' };
const STATUS_TH = {
  DRAFT: 'ร่าง', PENDING_PAYMENT: 'รอชำระเงิน', SUBMITTED: 'ส่งคำขอแล้ว', IN_REVIEW: 'กำลังตรวจสอบ',
  NEED_FIX: 'รอแก้ไขเอกสาร', PENDING_APPROVAL: 'รออนุมัติ', APPROVED: 'อนุมัติ', COMPLETED: 'เสร็จสิ้น',
  REJECTED: 'ไม่อนุมัติ', CANCELLED: 'ยกเลิก',
};

module.exports = { thaiDateTime, baht, DASH, CASE, MONTHS, LEVEL_TH, STATUS_TH };
