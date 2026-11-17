// B07 · เอกสารดิจิทัล: ออกเลข/รหัสตรวจ/ลายเซ็นจำลอง · ตรวจเอกสาร · PDF ขั้นต่ำเขียนมือ · tamper (testhook)
// ไม่เรียก sla.js และไม่อ่านเวลาเครื่องตรง ๆ (ใช้ clock เท่านั้น)
const crypto = require('crypto');
const clock = require('./clock');
const { db, tx, nextNumber } = require('./db');
const { formatNo, buddhistYear, thaiDateKey } = require('./util');

// ต้องตรงกับ seed.js (เอกสาร seed เซ็นด้วยคีย์เดียวกัน) · อ่าน lazy ตอนเรียก
// ponytail: ถ้า seed ยังโหลดไม่เสร็จ (require วน) จะได้ fallback ซึ่งตั้งให้เท่าค่าใน seed.js
const FALLBACK_SIGN_KEY = 'egov-eservice-test-sign-key';
function signKey() {
  try { return require('./seed').SIGN_KEY || FALLBACK_SIGN_KEY; } catch (e) { return FALLBACK_SIGN_KEY; }
}

// CONTRACT ข้อ 3: docNo|caseNo|applicant|serviceId|issuedAt|validUntil|signer · HMAC-SHA256 (hex)
function sign(d) {
  const msg = [d.docNo, d.caseNo, d.applicant, d.serviceId, d.issuedAt, d.validUntil, d.signer].join('|');
  return crypto.createHmac('sha256', signKey()).update(msg).digest('hex');
}

// แถว documents (snake_case) -> วัตถุ camelCase
const fromRow = (r) => r && {
  docNo: r.doc_no, caseNo: r.case_no, verifyCode: r.verify_code, serviceId: r.service_id,
  applicant: r.applicant_name, issuedAt: r.issued_at, validUntil: r.valid_until, signer: r.signer,
  signerUsername: r.signer_username, issuedBy: r.issued_by, signature: r.signature,
};
const getByDocNo = (docNo) => fromRow(db.prepare('SELECT * FROM documents WHERE doc_no=?').get(docNo));
const getByCaseNo = (caseNo) => fromRow(db.prepare('SELECT * FROM documents WHERE case_no=?').get(caseNo));

// BR-23: วันสุดท้ายที่ใช้ได้ (YYYY-MM-DD) จากวันออกตามเวลาไทย
function computeValidUntil(serviceId, issuedAtISO) {
  const [y, m, d] = thaiDateKey(issuedAtISO).split('-').map(Number);
  if (serviceId === 'SV-01') {
    return new Date(Date.UTC(y, m - 1, d + 89)).toISOString().slice(0, 10);
  }
  // SV-02/03: วันครบรอบปีถัดไป - 1 วัน · ออก 29 ก.พ. -> ใช้ 28 ก.พ. เป็นวันครบรอบ
  const leap = (yy) => (yy % 4 === 0 && yy % 100 !== 0) || yy % 400 === 0;
  const annDay = m === 2 && d === 29 && !leap(y + 1) ? 28 : d;
  return new Date(Date.UTC(y + 1, m - 1, annDay - 1)).toISOString().slice(0, 10);
}

const CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function newVerifyCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 8; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!db.prepare('SELECT 1 FROM documents WHERE verify_code=?').get(c)) return c;
  }
}

// caseRow = แถวตาราง cases · ผู้ลงนาม: signerName ถ้าไม่ส่ง = ชื่อของ cases.approver · issuedBy = username ผู้กดออก
// คืน { docNo, caseNo, verifyCode, serviceId, applicant, issuedAt, validUntil, signer, ... } (ไม่แตะตาราง cases — B08 ผูก doc_no เอง)
function issue(caseRow, signerName, issuedBy) {
  return tx(() => {
    if (db.prepare('SELECT 1 FROM documents WHERE case_no=?').get(caseRow.case_no)) {
      throw Object.assign(new Error('สถานะคำขอไม่ถูกต้องสำหรับรายการนี้'), { status: 409, code: 'INVALID_STATE' });
    }
    const nameOf = (where, v) => {
      const u = db.prepare(`SELECT display_name FROM users WHERE ${where}=?`).get(v);
      return u ? u.display_name : null;
    };
    const applicant = nameOf('id', caseRow.user_id) || '';
    const signer = signerName || (caseRow.approver && nameOf('username', caseRow.approver)) || caseRow.approver || '';
    const issuedAt = clock.nowISO();
    const doc = {
      docNo: formatNo('DOC', buddhistYear(issuedAt), nextNumber('DOC', buddhistYear(issuedAt))),
      caseNo: caseRow.case_no,
      verifyCode: newVerifyCode(),
      serviceId: caseRow.service_id,
      applicant,
      issuedAt,
      validUntil: computeValidUntil(caseRow.service_id, issuedAt),
      signer,
      signerUsername: caseRow.approver || null,
      issuedBy: issuedBy || null,
    };
    doc.signature = sign(doc);
    db.prepare(
      `INSERT INTO documents (doc_no, case_no, verify_code, service_id, applicant_name, issued_at, valid_until,
         signer, signer_username, issued_by, signature) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(doc.docNo, doc.caseNo, doc.verifyCode, doc.serviceId, doc.applicant, doc.issuedAt, doc.validUntil,
      doc.signer, doc.signerUsername, doc.issuedBy, doc.signature);
    return doc;
  });
}

// 'สมชาย ใจดี' -> 'สมชาย ใ***' · ไม่มีนามสกุล -> 'ชื่อ ***' (A-54)
function maskName(full) {
  const s = String(full || '').trim();
  const i = s.search(/\s/);
  if (i < 0) return `${s} ***`;
  const surname = s.slice(i).trim();
  return `${s.slice(0, i)} ${Array.from(surname)[0]}***`;
}

// ตรวจเอกสารด้วยรหัส · TAMPERED/NOT_FOUND ไม่คืนฟิลด์อื่น
function verify(code) {
  const doc = fromRow(db.prepare('SELECT * FROM documents WHERE verify_code=?').get(String(code)));
  if (!doc) return { result: 'NOT_FOUND' };
  const a = Buffer.from(sign(doc)), b = Buffer.from(String(doc.signature));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { result: 'TAMPERED' };
  // หมดอายุตอน 00:00 ของวันถัดจากวันสุดท้าย (เวลาไทย) = วันที่ไทยตอนนี้ > validUntil
  const expired = thaiDateKey(clock.now()) > doc.validUntil;
  return {
    result: expired ? 'EXPIRED' : 'VALID',
    docNo: doc.docNo, applicantMasked: maskName(doc.applicant), serviceId: doc.serviceId,
    issuedAt: doc.issuedAt, validUntil: doc.validUntil, signer: doc.signer,
  };
}

// testhook: แก้ applicant ที่เก็บโดยไม่เซ็นใหม่
function tamper(docNo) {
  return db.prepare("UPDATE documents SET applicant_name = applicant_name || ' (แก้ไข)' WHERE doc_no=?")
    .run(docNo).changes > 0;
}

// ---- PDF ขั้นต่ำ (เขียนมือ ไม่ใช้ไลบรารี) ----
// หน้าเพจแสดงบรรทัด ASCII (ฟอนต์มาตรฐาน Helvetica เรนเดอร์ไทยไม่ได้) · ข้อความไทยทั้งหมดอยู่ใน /Subject ของ Info dict
// เป็น UTF-16BE (ไฟล์ยังเป็น ASCII ล้วนเพราะเขียนเป็น hex) ค้น/ดึงเป็นข้อความได้ · ponytail: ไม่มี QR ในไฟล์ (QR อยู่หน้าเคส doc-qr)
const hex16 = (s) => 'FEFF' + Buffer.from(s, 'utf16le').swap16().toString('hex').toUpperCase();
const pdfEsc = (s) => s.replace(/[\\()]/g, '\\$&');

function pdfBuffer(docOrNo) {
  const d = typeof docOrNo === 'string' ? getByDocNo(docOrNo)
    : docOrNo.doc_no ? fromRow(docOrNo) : docOrNo;
  if (!d) return null;
  const base = process.env.BASE_URL || 'http://localhost:3000';
  const lines = [
    [16, 'e-Service Digital Document (simulated signature)'],
    [12, `docNo=${d.docNo} caseNo=${d.caseNo} verify=${d.verifyCode} validUntil=${d.validUntil}`],
    [10, `Verify online: ${base}/verify/${d.verifyCode}`],
    [10, `Signature (HMAC-SHA256): ${d.signature}`],
  ];
  const content = 'BT\n' + lines.map(([sz, t], i) =>
    `/F1 ${sz} Tf 1 0 0 1 50 ${780 - i * 28} Tm (${pdfEsc(t)}) Tj`).join('\n') + '\nET\n';
  const thai = [
    `เลขเอกสาร ${d.docNo}`, `เลขคำขอ ${d.caseNo}`, `ชื่อผู้ยื่น ${d.applicant}`, `บริการ ${d.serviceId}`,
    `วันออก ${d.issuedAt}`, `วันหมดอายุ ${d.validUntil}`, `ผู้ลงนาม ${d.signer}`, `รหัสตรวจสอบ ${d.verifyCode}`,
  ].join('\n');
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>',
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
    `<</Length ${Buffer.byteLength(content, 'latin1')}>>\nstream\n${content}endstream`,
    `<</Title<${hex16('เอกสารดิจิทัล ' + d.docNo)}>/Subject<${hex16(thai)}>/Producer(egov-eservice)>>`,
  ];
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('') +
    `trailer\n<</Size ${objs.length + 1}/Root 1 0 R/Info 6 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

module.exports = { issue, verify, pdfBuffer, tamper, maskName, computeValidUntil, getByDocNo, getByCaseNo, sign };
