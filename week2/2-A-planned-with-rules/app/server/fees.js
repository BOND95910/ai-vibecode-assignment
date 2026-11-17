// B05 · ค่าธรรมเนียม + เอกสารบังคับ (BR-04 BR-05 BR-08) · ไม่ใช่ route (ไม่ export function(app)) -> index.js ไม่โหลด
// อ่านอัตราจากตาราง services สดทุกครั้ง (admin แก้ได้ · DECISIONS ข้อ 3) ห้าม cache
const { db } = require('./db');
const { bug } = require('./bugs');

const EN = '–'; // en dash ใน "1–5" "1–500" (CONTRACT ตาราง 5)
const MSG = {
  INVALID_QTY: `จำนวนฉบับต้อง 1${EN}5 ฉบับ`,
  INVALID_AREA: `กรุณาระบุพื้นที่ 1${EN}500 ตร.ม.`,
  AREA_TOO_LARGE: 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน',
};
const fail = (code) => Object.assign(new Error(MSG[code]), { status: 400, code });

const service = (id) => (typeof id === 'string' ? db.prepare('SELECT * FROM services WHERE id=?').get(id) : undefined);

// คืน { fee } หรือ throw Error{status:400, code, message}
// ค่าต้องเป็น "จำนวนเต็ม" ชนิด number เท่านั้น (ทศนิยม/ข้อความ/null -> INVALID)
function computeFee(serviceId, { qty, areaSqm } = {}) {
  const s = service(serviceId);
  if (!s) throw Object.assign(new Error('ไม่พบบริการ'), { status: 400, code: 'INVALID_SERVICE' });
  if (serviceId === 'SV-01') {
    if (!Number.isInteger(qty) || qty < 1 || qty > 5) throw fail('INVALID_QTY');
    return { fee: s.fee * qty };
  }
  if (serviceId === 'SV-03') {
    if (!Number.isInteger(areaSqm) || areaSqm < 1) throw fail('INVALID_AREA');
    if (areaSqm > 500) throw fail('AREA_TOO_LARGE');
    // B01: ใช้ > 101 แทน >= 101 -> พื้นที่ 101 ได้ฐานเฉย ๆ (฿1,000) · 102 ขึ้นไปยังถูก
    const overBase = bug('B01') ? areaSqm > 101 : areaSqm >= 101;
    return { fee: overBase ? s.fee_base + s.fee_per_sqm * (areaSqm - 100) : s.fee_base };
  }
  return { fee: s.fee }; // SV-02 คงที่
}

// เอกสาร "บังคับ" ของบริการ ตามลำดับ docs_json (= ตาราง 4.3) · [{ docKey, name, pdfOnly }]
function requiredDocs(serviceId) {
  const s = service(serviceId);
  if (!s) return [];
  return JSON.parse(s.docs_json).filter((d) => d.required).map((d) => ({ docKey: d.key, name: d.name, pdfOnly: !!d.pdfOnly }));
}

// ชื่อไทยของเอกสารบังคับที่ร่างยังไม่มี (ตามลำดับตาราง 4.3) · ว่าง = ครบ · ร่างไม่มี -> null
// เอกสาร pdfOnly นับเฉพาะไฟล์ PDF จริง (กันกรณีข้อมูลเก่าที่ไม่ผ่านการตรวจ)
function missingDocs(draftId) {
  const d = db.prepare('SELECT service_id FROM drafts WHERE draft_id=?').get(draftId);
  if (!d) return null;
  const have = db.prepare('SELECT doc_key, mime FROM files WHERE draft_id=?').all(draftId);
  return requiredDocs(d.service_id)
    .filter((r) => !have.some((f) => f.doc_key === r.docKey && (!r.pdfOnly || f.mime === 'application/pdf')))
    .map((r) => r.name);
}

module.exports = { computeFee, requiredDocs, missingDocs };
