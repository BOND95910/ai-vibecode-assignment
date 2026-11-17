// B08 · เจ้าหน้าที่/หัวหน้า: คิว · รับเรื่อง · ตีกลับ · ส่งต่อ · ออกเอกสาร · แสดงเลขเต็ม · แจ้งเตือน (CONTRACT 6.3)
// ตัวช่วยร่วม (can, record, ข้อความ error) มาจาก routes/cases.js · ตรวจสิทธิ์ที่ API ทุกครั้ง · ทุกการเปลี่ยนสถานะ = tx + timeline + audit
const { db, tx } = require('../db');
const { decrypt } = require('../util');
const { requireRole } = require('../rbac');
const clock = require('../clock');
const audit = require('../audit');
const documents = require('../documents');
const { bug } = require('../bugs');
const { M, E, err, h, getCase, can, slaLevel, record, reasonLen, RETURN_MAX } = require('./cases');

const WORKLOAD_MAX = 10;
const FIX_MS = 168 * 3600 * 1000;
const FILTERS = ['all', 'unclaimed', 'mine'];

// BR-16: กำหนดเสร็จเร็วสุดก่อน · เท่ากันเรียงเลขคำขอน้อย → มาก
const byQueueOrder = (a, b) => (clock.parseISO(a.due_at) - clock.parseISO(b.due_at)) || (a.case_no < b.case_no ? -1 : a.case_no > b.case_no ? 1 : 0);

// งานในมือ = IN_REVIEW ที่ตัวเองถือ (NEED_FIX ไม่นับ)
const workloadOf = (username) => db.prepare("SELECT COUNT(*) AS n FROM cases WHERE owner=? AND status='IN_REVIEW'").get(username).n;

function row(c, s, withIdNo) {
  const r = {
    caseNo: c.case_no, serviceId: c.service_id, applicantName: c.display_name, idMasked: c.id_masked,
    status: c.status, step: c.step || null, owner: c.owner || null, dueAt: c.due_at, slaLevel: slaLevel(c),
    dept: c.dept, can: { claim: can(c, s).claim },
  };
  // B09: ส่งเลขบัตรเต็มในแถวคิว (หน้าจอยังแสดงแบบปิดบัง)
  if (withIdNo && bug('B09')) r.idNo = decrypt(c.id_no_enc);
  return r;
}
const withApplicant = 'SELECT c.*, u.display_name, u.id_masked, u.id_no_enc FROM cases c JOIN users u ON u.id=c.user_id';

module.exports = function (app) {
  const staff = requireRole('officer', 'head');
  const officer = requireRole('officer');

  // คิว: SUBMITTED / IN_REVIEW / APPROVED ที่ขั้นปัจจุบันอยู่ที่แผนกของเจ้าหน้าที่ (head เห็นทุกแผนก อ่านอย่างเดียว) · NEED_FIX/PENDING_APPROVAL/ปิดแล้ว ไม่อยู่ในคิว
  app.get('/api/officer/queue', staff, (req, res) => {
    const s = req.user;
    const filter = FILTERS.includes(req.query.filter) ? req.query.filter : 'all';
    let rows = db.prepare(`${withApplicant} WHERE c.status IN ('SUBMITTED','IN_REVIEW','APPROVED') AND c.dept<>''`).all();
    if (s.role === 'officer') rows = rows.filter((c) => c.dept === s.dept);
    if (filter === 'unclaimed') rows = rows.filter((c) => !c.owner && (c.status === 'SUBMITTED' || c.status === 'IN_REVIEW'));
    if (filter === 'mine') rows = rows.filter((c) => c.owner === s.username && c.status === 'IN_REVIEW');
    rows.sort(byQueueOrder);
    res.json({ items: rows.map((c) => row(c, s, true)), workload: s.role === 'officer' ? workloadOf(s.username) : null });
  });

  // หน้า /head/approvals: PENDING_APPROVAL ทุกแผนก (ไม่มีใน CONTRACT 6.3 · B08 เพิ่ม)
  app.get('/api/head/approvals', requireRole('head'), (req, res) => {
    const rows = db.prepare(`${withApplicant} WHERE c.status='PENDING_APPROVAL'`).all().sort(byQueueOrder);
    res.json({ items: rows.map((c) => row(c, req.user)) });
  });

  // ---- รับเรื่อง · ลำดับ: สิทธิ์ (403) → ALREADY_CLAIMED → (สถานะ INVALID_STATE) → WORKLOAD_LIMIT ----
  app.post('/api/officer/cases/:caseNo/claim', officer, h((req, res) => {
    const s = req.user;
    const out = tx(() => {
      const c = getCase(req.params.caseNo);
      if (!c) throw err.notFound();
      if (c.dept && c.dept !== s.dept) throw err.forbidden(); // ข้ามแผนก
      // B08: ข้ามการตรวจว่ามีผู้ถือแล้ว → คนที่สองได้ 200 และเป็นผู้ถือแทน
      if (c.owner && !bug('B08')) throw E(409, 'ALREADY_CLAIMED', M.claimed);
      if (!c.dept || (c.status !== 'SUBMITTED' && c.status !== 'IN_REVIEW')) throw err.state(); // เช่น ยกเลิกชนะ · อนุมัติแล้ว · ปิดแล้ว
      if (workloadOf(s.username) >= WORKLOAD_MAX) throw E(409, 'WORKLOAD_LIMIT', M.workload);
      const now = clock.nowISO();
      // atomic: owner IS NULL ใน WHERE (B08 ปล่อยให้เขียนทับ)
      const r = db.prepare(
        `UPDATE cases SET owner=?, status='IN_REVIEW',
           registry_owner=CASE WHEN ?='registry' AND registry_owner IS NULL THEN ? ELSE registry_owner END,
           works_owner=CASE WHEN ?='works' THEN ? ELSE works_owner END, updated_at=?
         WHERE case_no=? AND status IN ('SUBMITTED','IN_REVIEW') AND dept=? ${bug('B08') ? '' : 'AND owner IS NULL'}`
      ).run(s.username, s.dept, s.username, s.dept, s.username, now, c.case_no, c.dept);
      if (!r.changes) throw E(409, 'ALREADY_CLAIMED', M.claimed);
      record(c, { kind: 'CLAIM', text: s.dept === 'works' ? 'รับเรื่อง (ฝ่ายโยธา)' : 'รับเรื่อง', actor: s.username, role: 'officer', from: c.status, to: 'IN_REVIEW', event: 'CLAIM', time: now });
      return { owner: s.username };
    });
    res.json(out);
  }));

  // ---- ตีกลับ · ลำดับ: ผู้ถือ (403) → สถานะ (409) → RETURN_LIMIT (409) → เหตุผล (400) ----
  app.post('/api/officer/cases/:caseNo/return', officer, h((req, res) => {
    const s = req.user;
    const out = tx(() => {
      const c = getCase(req.params.caseNo);
      if (!c) throw err.notFound();
      if (c.owner !== s.username) throw err.forbidden();
      if (c.status !== 'IN_REVIEW') throw err.state();
      if (c.return_count >= RETURN_MAX && !bug('B12')) throw E(409, 'RETURN_LIMIT', M.returnLimit); // B12: ตีกลับครั้งที่ 3 ได้
      const reason = req.body && req.body.reason;
      if (reasonLen(reason) < 10) throw E(400, 'REASON_TOO_SHORT', M.reasonShort);
      const now = clock.nowISO();
      const deadline = clock.toBangkokISO(new Date(clock.now().getTime() + FIX_MS));
      const n = c.return_count + 1;
      // NEED_FIX: ผู้ถือเดิมยังอยู่ (คืนให้เมื่อส่งแก้) · คิว/งานในมือกรองด้วยสถานะ
      const r = db.prepare(
        `UPDATE cases SET status='NEED_FIX', return_count=?, return_reason=?, returned_at=?, fix_deadline=?, updated_at=?
         WHERE case_no=? AND status='IN_REVIEW' AND owner=?`
      ).run(n, reason.trim(), now, deadline, now, c.case_no, s.username);
      if (!r.changes) throw err.state();
      db.prepare('INSERT INTO case_returns (case_no,seq,returned_by,returned_at,reason) VALUES (?,?,?,?,?)').run(c.case_no, n, s.username, now, reason.trim());
      record(c, { kind: 'RETURN', text: `ตีกลับครั้งที่ ${n}: ${reason.trim()}`, actor: s.username, role: 'officer', from: 'IN_REVIEW', to: 'NEED_FIX', event: 'RETURN', detail: reason.trim(), time: now });
      return { status: 'NEED_FIX', returnCount: n };
    });
    res.json(out);
  }));

  // ---- ส่งต่ออัตโนมัติตามเส้นทาง (ไม่มีช่องเลือกปลายทาง) ----
  // SV-02: ทะเบียน → PENDING_APPROVAL · SV-03: ขั้น 1 ทะเบียน → ขั้น 2 โยธา (IN_REVIEW ไม่มีผู้ถือ) → ขั้น 3 PENDING_APPROVAL · SV-01 ไม่มี forward (409)
  app.post('/api/officer/cases/:caseNo/forward', officer, h((req, res) => {
    const s = req.user;
    const out = tx(() => {
      const c = getCase(req.params.caseNo);
      if (!c) throw err.notFound();
      if (c.owner !== s.username) throw err.forbidden();
      if (c.status !== 'IN_REVIEW' || c.service_id === 'SV-01') throw err.state();
      const note = typeof (req.body && req.body.note) === 'string' ? req.body.note.trim().slice(0, 500) : '';
      const now = clock.nowISO();
      let to, step, text, set;
      if (c.service_id === 'SV-03' && (c.step || 1) === 1) {
        to = 'IN_REVIEW'; step = 2; text = 'ผ่านขั้นทะเบียน ส่งต่อฝ่ายโยธา'; set = { dept: 'works', step: 2 };
      } else {
        to = 'PENDING_APPROVAL'; step = c.service_id === 'SV-03' ? 3 : null; text = 'ส่งต่อให้หัวหน้าฝ่ายอนุมัติ'; set = { dept: '', step };
      }
      const r = db.prepare(
        `UPDATE cases SET status=?, dept=?, step=?, owner=NULL, updated_at=? WHERE case_no=? AND status='IN_REVIEW' AND owner=?`
      ).run(to, set.dept, set.step, now, c.case_no, s.username);
      if (!r.changes) throw err.state();
      record(c, { kind: 'FORWARD', text: note ? `${text}: ${note}` : text, actor: s.username, role: 'officer', from: 'IN_REVIEW', to, event: 'FORWARD', detail: note, time: now });
      return step ? { status: to, step } : { status: to };
    });
    res.json(out);
  }));

  // ---- ออกเอกสาร: เฉพาะผู้ออกเอกสาร (A-27 = registry_owner · SV-01 = ผู้ถือที่อนุมัติ) · เฉพาะ APPROVED ----
  app.post('/api/officer/cases/:caseNo/issue', officer, h((req, res) => {
    const s = req.user;
    const out = tx(() => {
      const c = getCase(req.params.caseNo);
      if (!c) throw err.notFound();
      if (c.registry_owner !== s.username) throw err.forbidden();
      if (c.status !== 'APPROVED') throw err.state();
      const doc = documents.issue(c, undefined, s.username); // ผู้ลงนาม = ชื่อผู้อนุมัติ · throw 409 INVALID_STATE ถ้ามีเอกสารแล้ว
      const now = clock.nowISO();
      const r = db.prepare(
        `UPDATE cases SET status='COMPLETED', doc_no=?, closed_at=?, owner=NULL, dept='', updated_at=? WHERE case_no=? AND status='APPROVED'`
      ).run(doc.docNo, now, now, c.case_no);
      if (!r.changes) throw err.state();
      record(c, { kind: 'ISSUE', text: `ออกเอกสาร ${doc.docNo}`, actor: s.username, role: 'officer', from: 'APPROVED', to: 'COMPLETED', event: 'ISSUE', detail: doc.docNo, time: now });
      return { docNo: doc.docNo, verifyCode: doc.verifyCode, status: 'COMPLETED' };
    });
    res.json(out);
  }));

  // ---- แสดงเลขเต็ม (officer/head เท่านั้น) · เหตุผลไม่ว่าง (หลังตัดช่องว่าง) · บันทึก Audit UNMASK เฉพาะที่สำเร็จ ----
  app.post('/api/officer/cases/:caseNo/unmask', staff, h((req, res) => {
    const s = req.user;
    const c = getCase(req.params.caseNo);
    if (!c) throw err.notFound();
    const reason = req.body && req.body.reason;
    if (typeof reason !== 'string' || !reason.trim()) throw E(400, 'REASON_REQUIRED', M.reasonRequired);
    const u = db.prepare('SELECT id_no_enc FROM users WHERE id=?').get(c.user_id);
    // B11: ไม่บันทึก Audit UNMASK
    if (!bug('B11')) audit({ actor: s.username, role: s.role, event: 'UNMASK', caseNo: c.case_no, detail: reason.trim() });
    res.json({ idNo: decrypt(u.id_no_enc) });
  }));

  // ---- แจ้งเตือน (กระดิ่ง): ของผู้ใช้นั้นเท่านั้น · bell-count = จำนวนทั้งหมด · request นี้ผ่าน hook ประเมินแล้ว ----
  app.get('/api/notifications', staff, (req, res) => {
    const items = db.prepare('SELECT id, case_no, level, text, created_at FROM notifications WHERE username=? ORDER BY id DESC').all(req.user.username)
      .map((n) => ({ id: Number(n.id), caseNo: n.case_no, level: n.level, text: n.text, createdAt: n.created_at }));
    res.json({ items });
  });
};
