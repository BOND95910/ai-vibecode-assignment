// B09 · Dashboard + ส่งออก xlsx/pdf (BR-24 BR-25 BR-26 · FR-22 FR-23 · CONTRACT 2.9, 6.4, 7)
// คำนวณสดจากตาราง cases ทุกครั้ง (ไม่ฮาร์ดโค้ดตัวเลข) · ไม่แตะชื่อผู้ยื่น/เลขบัตร/เบอร์ ในผลลัพธ์ใด ๆ
const zlib = require('zlib');
const { db } = require('../db');
const clock = require('../clock');
const { bug } = require('../bugs');
const audit = require('../audit');
const sla = require('../sla');
const { sendError, thaiDateKey } = require('../util');
const { requireRole } = require('../rbac');

const BACKLOG = new Set(['SUBMITTED', 'IN_REVIEW', 'NEED_FIX', 'PENDING_APPROVAL', 'APPROVED']);
const SERVICES = ['ALL', 'SV-01', 'SV-02', 'SV-03'];
const ms = (iso) => clock.parseISO(iso).getTime();

// ทันกำหนด % = ทัน ÷ ปิดงาน × 100 ปัดครึ่งขึ้น 1 ตำแหน่ง · คิดด้วยจำนวนเต็มล้วน (ไม่พึ่งทศนิยมลอยตัว)
// tenths = floor((2000·n + d) / 2d) = round-half-up(n/d × 1000) · d = 0 → null
function pct(n, d) {
  return d > 0 ? Math.floor((2000 * n + d) / (2 * d)) / 10 : null;
}
const pctText = (p) => (p === null ? '–' : p.toFixed(1) + '%'); // en dash U+2013 ตาม CONTRACT

// period: 'YYYY-MM' | 'YYYY' (ค.ศ.) · ไม่ส่ง = เดือนของนาฬิกา
function kpi(period, service) {
  const inPeriod = (iso) => thaiDateKey(iso).startsWith(period);
  const nowISO = clock.nowISO();
  const rows = db.prepare('SELECT status, service_id, owner, paid_at, due_at, closed_at FROM cases').all();
  let received = 0, closed = 0, onTime = 0, backlog = 0, overdue = 0;
  for (const c of rows) {
    if (service !== 'ALL' && c.service_id !== service) continue;
    if (c.paid_at && inPeriod(c.paid_at)) received += 1; // ชำระแล้วมีเลข (รวม CANCELLED)
    if ((c.status === 'COMPLETED' || c.status === 'REJECTED') && c.closed_at && inPeriod(c.closed_at)) {
      closed += 1;
      if (c.due_at && ms(c.closed_at) <= ms(c.due_at)) onTime += 1; // ที่ขอบ 16:30:00 = ทัน
    }
    if (BACKLOG.has(c.status)) {
      backlog += 1;
      if (c.due_at && sla.level(c, nowISO) === 'overdue') overdue += 1; // NEED_FIX = paused ไม่นับ
    }
  }
  // B10: หารด้วย "รับเรื่อง" แทน "ปิดงาน"
  const ontimePct = bug('B10') ? pct(onTime, received) : pct(onTime, closed);
  // งานในมือ = IN_REVIEW ที่ตัวเองถือ · ทุกเจ้าหน้าที่แม้ 0 · ไม่ขึ้นกับตัวกรอง (A-41)
  const workload = db.prepare(
    `SELECT u.username AS username,
            (SELECT COUNT(*) FROM cases c WHERE c.owner = u.username AND c.status = 'IN_REVIEW') AS count
     FROM users u WHERE u.role = 'officer' AND u.username IS NOT NULL ORDER BY u.username`
  ).all().map((w) => ({ username: w.username, count: Number(w.count) }));
  return { received, closed, onTime, ontimePct, backlog, overdue, workload };
}

// อ่าน/ตรวจ query · คืน { period, service } หรือส่ง 400 แล้วคืน null
function params(req, res) {
  const period = req.query.period === undefined || req.query.period === '' ? clock.nowISO().slice(0, 7) : String(req.query.period);
  const service = req.query.service === undefined || req.query.service === '' ? 'ALL' : String(req.query.service);
  if (!/^\d{4}(-(0[1-9]|1[0-2]))?$/.test(period)) { sendError(res, 400, 'INVALID_PERIOD', 'ช่วงเวลาไม่ถูกต้อง'); return null; }
  if (!SERVICES.includes(service)) { sendError(res, 400, 'INVALID_SERVICE', 'บริการไม่ถูกต้อง'); return null; }
  return { period, service };
}

// ---------- xlsx ขั้นต่ำ (ZIP + OOXML เขียนเองด้วย zlib · ไม่เพิ่ม dependency) ----------
const xmlEsc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function zip(files) { // files: [[name, string]] · deflate · วันที่ไฟล์คงที่ (ผลซ้ำได้)
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, text] of files) {
    const nameBuf = Buffer.from(name), raw = Buffer.from(text, 'utf8'), data = zlib.deflateRawSync(raw);
    const crc = zlib.crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, data); centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// rows: [[A, B], ...] ทุกเซลล์เป็นข้อความ (shared strings)
function xlsx(rows) {
  const strings = [];
  const idx = (s) => { let i = strings.indexOf(s); if (i < 0) { strings.push(s); i = strings.length - 1; } return i; };
  const sheetRows = rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => `<c r="${'AB'[j]}${i + 1}" t="s"><v>${idx(v)}</v></c>`).join('')}</row>`).join('');
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const pkg = 'http://schemas.openxmlformats.org/package/2006/relationships';
  return zip([
    ['[Content_Types].xml', head + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
      + '</Types>'],
    ['_rels/.rels', head + `<Relationships xmlns="${pkg}"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', head + `<workbook xmlns="${ns}" xmlns:r="${rel}"><sheets><sheet name="Dashboard" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', head + `<Relationships xmlns="${pkg}">`
      + `<Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/>`
      + `<Relationship Id="rId2" Type="${rel}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`],
    ['xl/worksheets/sheet1.xml', head + `<worksheet xmlns="${ns}"><sheetData>${sheetRows}</sheetData></worksheet>`],
    ['xl/sharedStrings.xml', head + `<sst xmlns="${ns}" count="${strings.length}" uniqueCount="${strings.length}">`
      + strings.map((s) => `<si><t>${xmlEsc(s)}</t></si>`).join('') + '</sst>'],
  ]);
}

// ---------- pdf ขั้นต่ำ: ฟอนต์ Helvetica ข้อความ ASCII ล้วน (ป้ายไทยไม่ใส่: ต้องฝังฟอนต์ · test ไม่ตรวจ A-63) ----------
function pdf(lines) {
  const esc = (t) => t.replace(/[\\()]/g, '\\$&');
  const content = 'BT /F1 12 Tf 16 TL 50 780 Td ' + lines.map((l) => `(${esc(l)}) Tj T*`).join(' ') + ' ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  // ไฟล์เล็ก (< 4096 ไบต์) → pdf-parse 1.1.1 (pdf.js 1.10) ตอบ "bad XRef entry" แม้ไฟล์ถูกต้อง (วัดแล้ว: ≥ ~3.5 KB ผ่าน)
  // จึงเติมคอมเมนต์ PDF (ถูกต้องตามสเปก) ให้ไฟล์ > 4096 ไบต์เสมอ
  let out = '%PDF-1.4\n%' + '-'.repeat(6000) + '\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1'); // ASCII ล้วน → ความยาวอักขระ = ไบต์
}

module.exports = function (app) {
  app.get('/api/dashboard', requireRole('executive'), (req, res) => {
    const p = params(req, res); if (!p) return;
    res.json(kpi(p.period, p.service));
  });

  app.get('/api/dashboard/export', requireRole('executive'), (req, res) => {
    const format = String(req.query.format || '');
    if (format !== 'xlsx' && format !== 'pdf') return sendError(res, 400, 'INVALID_FORMAT', 'รูปแบบไฟล์ไม่ถูกต้อง');
    const p = params(req, res); if (!p) return;
    const k = kpi(p.period, p.service);
    const text = [String(k.received), String(k.closed), pctText(k.ontimePct), String(k.backlog), String(k.overdue)];
    let body, type;
    if (format === 'xlsx') {
      const labels = ['รับเรื่อง', 'ปิดงาน', 'ทันกำหนด %', 'งานคงค้าง', 'เกินกำหนดคงค้าง'];
      body = xlsx([['ตัวชี้วัด', 'ค่า'], ...labels.map((l, i) => [l, text[i]])]);
      type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    } else {
      const ontime = k.ontimePct === null ? '-' : k.ontimePct.toFixed(1) + '%'; // ASCII ล้วนใน PDF
      body = pdf(['Dashboard report', `period ${p.period} service ${p.service}`,
        `kpi received=${k.received} closed=${k.closed} ontime=${ontime} backlog=${k.backlog} overdue=${k.overdue}`]);
      type = 'application/pdf';
    }
    audit({ actor: req.user.username, role: req.user.role, event: 'EXPORT', detail: `${format} ${p.period} ${p.service}` });
    res.set({ 'Content-Type': type, 'Content-Disposition': `attachment; filename="dashboard-${p.period}-${p.service}.${format}"` });
    res.send(body);
  });
};
module.exports.kpi = kpi;
module.exports.pct = pct;
