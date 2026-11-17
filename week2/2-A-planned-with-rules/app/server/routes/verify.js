// B07 · GET /api/verify/:code (สาธารณะ) · GET /api/documents/:docNo/pdf (citizen เจ้าของ · officer · head)
// หน้า HTML /verify/:code เป็นของ B11 ไม่อยู่ที่นี่
const { db } = require('../db');
const { sendError, sessions, hashId } = require('../util');
const documents = require('../documents');

// TODO(B04): เมื่อ rbac.js เสร็จ ให้สลับไปใช้ getSession/requireRole ของมันทั้งหมด (ตอนนี้ใช้ถ้ามี ไม่มีก็อ่าน sessions ตรง ๆ)
function sessionOf(req) {
  let rbac = null;
  try { rbac = require('../rbac'); } catch (e) { /* B04 ยังไม่เสร็จ */ }
  if (rbac && typeof rbac.getSession === 'function') return rbac.getSession(req) || null;
  return (req.cookies && sessions.get(req.cookies.sid)) || null;
}

// ผู้ใช้ (แถว users) ของ session · รูปแบบ session ตาม util.js: { username, role, idNo, ... } · รับ userId ด้วยถ้า B04 ใส่ให้
function userOf(s) {
  if (s.userId) return db.prepare('SELECT * FROM users WHERE id=?').get(s.userId);
  if (s.idNo) return db.prepare('SELECT * FROM users WHERE id_hash=?').get(hashId(s.idNo));
  if (s.username) return db.prepare('SELECT * FROM users WHERE username=?').get(s.username);
  return null;
}

module.exports = function (app) {
  app.get('/api/verify/:code', (req, res) => {
    const r = documents.verify(req.params.code);
    res.status(r.result === 'NOT_FOUND' ? 404 : 200).json(r);
  });

  app.get('/api/documents/:docNo/pdf', (req, res) => {
    const s = sessionOf(req);
    if (!s) return sendError(res, 401, 'UNAUTHENTICATED', 'กรุณาเข้าสู่ระบบ');
    const role = s.role || (userOf(s) || {}).role;
    if (!['citizen', 'officer', 'head'].includes(role)) {
      return sendError(res, 403, 'FORBIDDEN', 'ไม่มีสิทธิ์ทำรายการนี้');
    }
    const doc = documents.getByDocNo(req.params.docNo);
    if (doc && role === 'citizen') {
      const c = db.prepare('SELECT user_id FROM cases WHERE case_no=?').get(doc.caseNo);
      const u = userOf(s);
      if (!c || !u || c.user_id !== u.id) return sendError(res, 404, 'NOT_FOUND', 'ไม่พบเอกสาร'); // ไม่เปิดเผยว่ามีอยู่
    }
    if (!doc) return sendError(res, 404, 'NOT_FOUND', 'ไม่พบเอกสาร');
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${doc.docNo}.pdf"`,
    }).send(documents.pdfBuffer(doc));
  });
};
