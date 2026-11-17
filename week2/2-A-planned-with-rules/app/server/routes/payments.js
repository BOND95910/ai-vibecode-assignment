// B06 · ชำระเงิน QR จำลอง + เลขคำขอ/ใบเสร็จ (FR-08, BR-09..BR-12, CONTRACT 6.2 + ข้อ 8)
// - POST /api/drafts/:id/payment  สร้าง QR/ref ใหม่ (ล็อกยอดตอนเข้า PENDING_PAYMENT ครั้งแรก · A-42)
// - GET  /api/payments/:ref       สถานะ (EXPIRED คำนวณจากนาฬิกา)
// - payByRef(ref, amount)         ธนาคารจำลอง (testhook เรียก) · ชำระสำเร็จ = ออก EG-/RC- สร้างคำขอใน tx เดียว
const { db, tx, nextNumber } = require('../db');
const { sendError, formatNo, buddhistYear, baht } = require('../util');
const { requireRole } = require('../rbac');
const clock = require('../clock');
const { bug } = require('../bugs');
const { computeFee, missingDocs } = require('../fees');
const { computeDue } = require('../sla');

const QR_TTL_MS = 15 * 60 * 1000;
const httpErr = (status, code, message, extra) => Object.assign(new Error(message), { status, code, extra });
const E = {
  notFound: () => httpErr(404, 'NOT_FOUND', 'ไม่พบคำขอ'),
  state: () => httpErr(409, 'INVALID_STATE', 'สถานะคำขอไม่ถูกต้องสำหรับรายการนี้'),
  expired: () => httpErr(410, 'QR_EXPIRED', 'QR หมดอายุ กรุณาสร้าง QR ใหม่'),
  amount: () => httpErr(422, 'AMOUNT_MISMATCH', 'ยอดเงินไม่ตรงกับค่าธรรมเนียม'),
};

// BR-10: อายุ = เวลาปัจจุบัน − เวลาสร้าง QR · ใช้ได้เมื่ออายุ < 15:00 (15:00 พอดี = หมดอายุ)
// B05: ใช้ <= -> อายุ 15:00 พอดียังจ่ายได้ (15:00.001 ขึ้นไปจึงหมด) · ใช้ร่วมกับ GET status เพื่อให้สองทางตรงกัน
function ageExpired(p) {
  const age = clock.now().getTime() - clock.parseISO(p.qr_created_at).getTime();
  return bug('B05') ? age > QR_TTL_MS : age >= QR_TTL_MS;
}
// สถานะที่แสดง: PAID คงที่ · EXPIRED = ถูกแทนที่ด้วย QR ใหม่ หรืออายุครบ · ไม่เช่นนั้น PENDING
const effStatus = (p) => (p.status === 'PAID' ? 'PAID' : p.status === 'EXPIRED' || ageExpired(p) ? 'EXPIRED' : 'PENDING');

const view = (p) => ({
  ref: p.ref, draftId: p.draft_id, amount: p.amount, status: effStatus(p),
  qrCreatedAt: p.qr_created_at, qrExpiresAt: p.qr_expires_at,
  caseNo: p.case_no || null, receiptNo: p.receipt_no || null, paidAt: p.paid_at || null,
});

// ธนาคารจำลอง · คืน { status:'PAID', caseNo, receiptNo, duplicate } หรือ throw {status, code, message}
function payByRef(ref, amount) {
  return tx(() => {
    const p = db.prepare('SELECT * FROM payments WHERE ref=?').get(ref);
    if (!p) throw E.notFound();
    // ซ้ำ: คืนเลขเดิมโดยไม่ตรวจอายุ/ยอดอีก (callback ซ้ำหลัง 15 นาทีต้องยัง 200) · ไม่เขียนอะไร
    if (p.status === 'PAID') return { status: 'PAID', caseNo: p.case_no, receiptNo: p.receipt_no, duplicate: true };
    const d = db.prepare('SELECT * FROM drafts WHERE draft_id=?').get(p.draft_id);
    if (!d) throw E.notFound();
    if (p.status === 'EXPIRED' || ageExpired(p)) throw E.expired();
    if (amount !== p.amount) throw E.amount(); // Number เท่านั้น · NaN/ทศนิยม ไม่เท่า
    if (d.status !== 'PENDING_PAYMENT') throw E.state();

    const svc = db.prepare('SELECT sla FROM services WHERE id=?').get(d.service_id);
    const paidAt = clock.nowISO();
    const year = buddhistYear(paidAt); // ปี พ.ศ. ของเวลาชำระ (เวลาไทย)
    const caseNo = formatNo('EG', year, nextNumber('EG', year));
    const receiptNo = formatNo('RC', year, nextNumber('RC', year));
    const dueAt = computeDue(paidAt, svc.sla); // คำนวณครั้งเดียวตอนชำระ (A-42)

    db.prepare(
      `INSERT INTO cases (case_no,draft_id,user_id,service_id,status,step,dept,fee,qty,area_sqm,paid_at,receipt_no,due_at,created_at,updated_at)
       VALUES (?,?,?,?,'SUBMITTED',?,'registry',?,?,?,?,?,?,?,?)`
    ).run(caseNo, d.draft_id, d.user_id, d.service_id, d.service_id === 'SV-03' ? 1 : null, p.amount, d.qty, d.area_sqm, paidAt, receiptNo, dueAt, paidAt, paidAt);
    const ev = db.prepare(
      'INSERT INTO timeline_events (case_no,time,actor,actor_role,kind,text,from_status,to_status) VALUES (?,?,NULL,?,?,?,NULL,?)'
    );
    ev.run(caseNo, paidAt, 'citizen', 'PAID', 'ชำระค่าธรรมเนียมสำเร็จ ' + baht(p.amount), null);
    ev.run(caseNo, paidAt, 'system', 'SUBMITTED', 'ส่งคำขอแล้ว', 'SUBMITTED');
    db.prepare('UPDATE files SET case_no=? WHERE draft_id=?').run(caseNo, d.draft_id); // ผูกไฟล์เข้าคำขอ (draft_id คงไว้ให้ /api/drafts/:id)
    db.prepare("UPDATE drafts SET status='SUBMITTED', case_no=?, updated_at=? WHERE draft_id=?").run(caseNo, paidAt, d.draft_id);
    db.prepare("UPDATE payments SET status='EXPIRED' WHERE draft_id=? AND status='PENDING' AND ref<>?").run(d.draft_id, ref);
    db.prepare("UPDATE payments SET status='PAID', case_no=?, receipt_no=?, paid_at=? WHERE ref=?").run(caseNo, receiptNo, paidAt, ref);
    return { status: 'PAID', caseNo, receiptNo, duplicate: false };
  });
}

module.exports = function (app) {
  const citizen = requireRole('citizen');
  const wrap = (res, fn) => {
    try { return fn(); } catch (e) {
      if (e && e.status && e.code) return sendError(res, e.status, e.code, e.message, e.extra);
      throw e;
    }
  };

  // สร้าง QR ใหม่ (ซ้ำได้ ref ใหม่ทุกครั้ง · ref เก่าที่ยังรอชำระถูกยกเลิก)
  app.post('/api/drafts/:id/payment', citizen, (req, res) => wrap(res, () => {
    const out = tx(() => {
      const d = db.prepare('SELECT * FROM drafts WHERE draft_id=? AND user_id=?').get(req.params.id, req.user.userId);
      if (!d) throw E.notFound(); // ของคนอื่น/ไม่มี = 404 เหมือนกัน
      if (d.status === 'SUBMITTED') throw E.state();
      const missing = missingDocs(d.draft_id); // ตรวจซ้ำทุกครั้ง (ไฟล์ลบได้ตอน PENDING_PAYMENT)
      if (missing.length) throw httpErr(409, 'MISSING_DOCS', 'ยังขาดเอกสาร: ' + missing.join(', '), { missing });

      const now = clock.now();
      const nowISO = clock.toBangkokISO(now);
      let amount = d.fee;
      if (d.status === 'DRAFT') { // เข้า PENDING_PAYMENT ครั้งแรก = ล็อกยอดจากอัตราปัจจุบัน (BR-11/A-42)
        try { amount = computeFee(d.service_id, { qty: d.qty, areaSqm: d.area_sqm }).fee; } catch (e) { throw httpErr(e.status || 400, e.code || 'INVALID_FEE', e.message); }
        db.prepare("UPDATE drafts SET status='PENDING_PAYMENT', fee=?, updated_at=? WHERE draft_id=?").run(amount, nowISO, d.draft_id);
      }
      // PENDING_PAYMENT อยู่แล้ว: ใช้ drafts.fee ที่ล็อกไว้ (ไม่คิดใหม่)
      db.prepare("UPDATE payments SET status='EXPIRED' WHERE draft_id=? AND status='PENDING'").run(d.draft_id);
      const ref = formatNo('PP', 0, nextNumber('PP', 0), 4);
      const expiresISO = clock.toBangkokISO(new Date(now.getTime() + QR_TTL_MS));
      db.prepare('INSERT INTO payments (ref,draft_id,amount,status,qr_created_at,qr_expires_at,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(ref, d.draft_id, amount, 'PENDING', nowISO, expiresISO, nowISO);
      return { ref, amount, qrCreatedAt: nowISO, qrExpiresAt: expiresISO };
    });
    res.status(201).json(out);
  }));

  // สถานะการชำระ · เจ้าของเท่านั้น (คนอื่น/ไม่มี/ร่างถูกลบ = 404)
  app.get('/api/payments/:ref', citizen, (req, res) => wrap(res, () => {
    const p = db.prepare(
      'SELECT p.* FROM payments p JOIN drafts d ON d.draft_id=p.draft_id WHERE p.ref=? AND d.user_id=?'
    ).get(req.params.ref, req.user.userId);
    if (!p) throw E.notFound();
    res.json(view(p));
  }));
};

module.exports.payByRef = payByRef;
