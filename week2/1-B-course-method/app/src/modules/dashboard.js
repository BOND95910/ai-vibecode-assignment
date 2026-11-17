'use strict';
/**
 * B07 · Dashboard ผู้บริหาร + ส่งออก Excel/PDF
 *
 * ที่มา: REQUIREMENTS FR-22 FR-23 BR-25 BR-26 (A-41 A-50) · DECISIONS §12 §18 · CONTRACT §2.9 §6.4 §6.8 §7 · TEST-DATA §7 · BUGS B10
 *
 *   GET /api/dashboard?period=2026-11&service=ALL                 executive → {received, closed, onTime, ontimePct, ontimeText, backlog, overdue, workload, …}
 *   GET /api/dashboard/export?format=xlsx|pdf&period=…&service=…  executive → ไฟล์ (CONTRACT §7) + Audit EXPORT detail `xlsx 2026-11 ALL`
 *
 * นิยาม (BR-25 · DECISIONS §12 · §18 ใช้แทนถ้าขัด):
 *   รับเรื่อง          = คำขอที่มีเลขคำขอ (ชำระสำเร็จ) และ paid_at อยู่ในช่วง · รวม CANCELLED ที่เคยชำระ
 *   ปิดงาน            = COMPLETED + REJECTED ที่ closed_at อยู่ในช่วง (CANCELLED ไม่นับ)
 *   ทัน               = ปิดงานที่ closed_at ≤ due_at (รวมวินาทีที่ 16:30:00 · 16:30:01 ไม่ทัน)
 *   ทันกำหนด %        = ทัน ÷ ปิดงาน × 100 ทศนิยม 1 ตำแหน่ง ปัดครึ่งขึ้น · ปิดงาน 0 → `–` (API ontimePct = null)
 *   งานคงค้าง         = SUBMITTED + IN_REVIEW + NEED_FIX + PENDING_APPROVAL + APPROVED "ณ ตอนนี้" (ไม่ขึ้นกับช่วง · ขึ้นกับบริการ)
 *   เกินกำหนดคงค้าง   = งานคงค้างที่ไม่ใช่ NEED_FIX และ ตอนนี้ > due_at (ณ ตอนนี้ · ขึ้นกับบริการ)
 *   งานในมือรายคน     = IN_REVIEW ที่ owner = username · officer ทุกคน (แม้ 0) · ไม่ขึ้นกับตัวกรองใด ๆ (A-41)
 *   ช่วง (period)     = 'YYYY-MM' (ค.ศ. ตามเวลาไทย) หรือ 'YYYY' = ทั้งปี → รวมยอดทั้งปีแล้วคิด % จากยอดรวม (ไม่เฉลี่ย % รายเดือน · BR-26)
 *
 * BUG_MODE B10: ทันกำหนด % หารด้วย "รับเรื่อง" แทน "ปิดงาน" (พ.ย. 23.1% · ปี 23.3% · ธ.ค. 0.0% · ต.ค. 100.0%)
 *   ไฟล์ส่งออกใช้ผลจาก computeDashboard ตัวเดียวกัน → เท่าหน้าจอเสมอ (ทั้งตอนปกติและตอนเปิดบั๊ก)
 *
 * PDPA (DECISIONS §18 · BR-24): ผลลัพธ์/ไฟล์ส่งออกมีแค่ตัวเลขรวม + username เจ้าหน้าที่ · ไม่มีชื่อผู้ยื่น เลขบัตร หรือเบอร์โทร
 */

const { db } = require('../db');
const clock = require('../clock');
const { fail } = require('../http');
const { requireApi } = require('../session');
const { isBug } = require('../bugs');
const { logAudit } = require('../audit');
const { pct, pctValue, TH_MONTHS, thaiDateTime } = require('../format');
const { BACKLOG_STATUSES, CLOSED_STATUSES, SERVICES } = require('../constants');

const PERIOD_MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const PERIOD_YEAR_RE = /^(\d{4})$/;
const FORMATS = ['xlsx', 'pdf'];
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DASH = '–'; // en dash U+2013 (CONTRACT: ค่า `–` ของทันกำหนด %)

/** ป้าย 5 ช่อง KPI ตามลำดับ CONTRACT §7 (แถว 2–6 ของ xlsx) และ testid บนจอ (CONTRACT §2.9) */
const KPI_DEFS = [
  { key: 'received', label: 'รับเรื่อง', testid: 'kpi-received', en: 'Received' },
  { key: 'closed', label: 'ปิดงาน', testid: 'kpi-closed', en: 'Closed' },
  { key: 'ontimeText', label: 'ทันกำหนด %', testid: 'kpi-ontime-pct', en: 'On-time %' },
  { key: 'backlog', label: 'งานคงค้าง', testid: 'kpi-backlog', en: 'Backlog (now)' },
  { key: 'overdue', label: 'เกินกำหนดคงค้าง', testid: 'kpi-overdue', en: 'Overdue backlog (now)' },
];

// ---------------------------------------------------------------------------
// ตัวกรอง
// ---------------------------------------------------------------------------

/** ค่าจาก query → สตริงที่ตัดช่องว่างแล้ว ('' ถ้าไม่มี) */
function q(v) {
  if (Array.isArray(v)) v = v[0];
  return v === undefined || v === null ? '' : String(v).trim();
}

/** เดือนปัจจุบันของนาฬิกา (เวลาไทย) → 'YYYY-MM' */
function currentPeriod(nowIso) {
  const p = clock.bkkParts(nowIso || clock.nowIso());
  return `${p.y}-${String(p.m).padStart(2, '0')}`;
}

/** รหัสบริการที่รู้จัก (แคตตาล็อก + ตาราง services) */
function knownServiceIds() {
  const ids = new Set(Object.keys(SERVICES));
  for (const r of db.prepare('SELECT id FROM services').all()) ids.add(r.id);
  return ids;
}

/**
 * ตรวจ/เติมค่าตัวกรอง · ค่าว่าง → ค่าเริ่มต้น (เดือนของนาฬิกา · ALL)
 * รูปแบบผิด → throw ApiError BAD_REQUEST (หน้า /dashboard ใช้ isValidFilters ถ้าอยาก fallback แทน)
 * @returns {{ period: string, service: string }}
 */
function resolveFilters({ period, service } = {}, nowIso) {
  let p = q(period);
  let s = q(service).toUpperCase();
  if (!p) p = currentPeriod(nowIso);
  if (!s) s = 'ALL';
  if (!PERIOD_MONTH_RE.test(p) && !PERIOD_YEAR_RE.test(p)) fail('BAD_REQUEST', { field: 'period' });
  if (s !== 'ALL' && !knownServiceIds().has(s)) fail('BAD_REQUEST', { field: 'service' });
  return { period: p, service: s };
}

/** true ถ้าตัวกรองถูกรูปแบบ (ค่าว่างถือว่าถูก = ใช้ค่าเริ่มต้น) */
function isValidFilters(filters, nowIso) {
  try {
    resolveFilters(filters, nowIso);
    return true;
  } catch (e) {
    return false;
  }
}

/** ป้ายของช่วง: '2026-12' → 'ธ.ค. 2569' · '2026' → 'ทั้งปี 2569' */
function periodLabel(period) {
  let m = PERIOD_MONTH_RE.exec(period);
  if (m) return `${TH_MONTHS[Number(m[2]) - 1]} ${Number(m[1]) + 543}`;
  m = PERIOD_YEAR_RE.exec(period);
  if (m) return `ทั้งปี ${Number(m[1]) + 543}`;
  return String(period || '');
}

/** ป้ายของบริการ: 'ALL' → 'ทุกบริการ' · 'SV-01' → 'SV-01 ขอหนังสือรับรอง' */
function serviceLabel(service) {
  if (!service || service === 'ALL') return 'ทุกบริการ';
  const svc = SERVICES[service];
  return svc ? `${service} ${svc.name}` : service;
}

/** เวลา ISO อยู่ในช่วงหรือไม่ (เทียบตามเวลาไทย) */
function inPeriod(iso, period) {
  if (!iso) return false;
  const p = clock.bkkParts(iso);
  const m = PERIOD_MONTH_RE.exec(period);
  if (m) return p.y === Number(m[1]) && p.m === Number(m[2]);
  return p.y === Number(period);
}

/**
 * ตัวเลือก period-select (CONTRACT §2.9 · A-41): ค่าแรก = เดือนของนาฬิกา แล้วย้อนไปจนถึงเดือนแรกที่มีข้อมูล
 * ตามด้วย "ทั้งปี" ของปีปัจจุบันย้อนไปถึงปีแรกที่มีข้อมูล
 * ณ seed (นาฬิกา 1 ธ.ค. 2569): 2026-12 · 2026-11 · 2026-10 · 2026
 * @param {string} [nowIso]
 * @param {string} [include] ช่วงที่เลือกอยู่ (ถ้าไม่อยู่ในรายการจะถูกเพิ่มให้)
 * @returns {{ value: string, label: string }[]}
 */
function periodOptions(nowIso, include) {
  const now = clock.bkkParts(nowIso || clock.nowIso());
  const first = db
    .prepare("SELECT MIN(paid_at) AS t FROM cases WHERE case_no IS NOT NULL AND paid_at IS NOT NULL")
    .get();
  let fy = now.y;
  let fm = now.m;
  if (first && first.t) {
    const f = clock.bkkParts(first.t);
    if (f.y * 12 + f.m < now.y * 12 + now.m) {
      fy = f.y;
      fm = f.m;
    }
  }
  // กันรายการยาวเกิน (ข้อมูลเก่ามาก) — ย้อนได้สูงสุด 36 เดือน
  const MAX_MONTHS = 36;
  if (now.y * 12 + now.m - (fy * 12 + fm) >= MAX_MONTHS) {
    const idx = now.y * 12 + (now.m - 1) - (MAX_MONTHS - 1);
    fy = Math.floor(idx / 12);
    fm = (idx % 12) + 1;
  }

  const months = [];
  for (let y = now.y, m = now.m; y * 12 + m >= fy * 12 + fm; ) {
    const value = `${y}-${String(m).padStart(2, '0')}`;
    months.push({ value, label: periodLabel(value) });
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  const years = [];
  for (let y = now.y; y >= fy; y -= 1) years.push({ value: String(y), label: periodLabel(String(y)) });

  const opts = months.concat(years);
  const inc = q(include);
  if (inc && (PERIOD_MONTH_RE.test(inc) || PERIOD_YEAR_RE.test(inc)) && !opts.some((o) => o.value === inc)) {
    opts.push({ value: inc, label: periodLabel(inc) });
  }
  return opts;
}

/** ตัวเลือก service-select (CONTRACT §2.9) */
function serviceOptions() {
  const ids = [...knownServiceIds()].sort();
  return [{ value: 'ALL', label: serviceLabel('ALL') }].concat(ids.map((id) => ({ value: id, label: serviceLabel(id) })));
}

// ---------------------------------------------------------------------------
// คำนวณ
// ---------------------------------------------------------------------------

/** งานในมือรายเจ้าหน้าที่: officer ทุกคน (แม้ 0) + ผู้ถือ IN_REVIEW ที่ไม่ใช่ officer แล้ว (เช่นถูกเปลี่ยนบทบาท) · เรียงตาม username */
function workloadRows() {
  const officers = db
    .prepare("SELECT username, name FROM users WHERE role = 'officer' AND username IS NOT NULL")
    .all();
  const counts = db
    .prepare("SELECT owner, COUNT(*) AS n FROM cases WHERE status = 'IN_REVIEW' AND owner IS NOT NULL GROUP BY owner")
    .all();
  const byUser = new Map(officers.map((o) => [o.username, { username: o.username, name: o.name, count: 0 }]));
  for (const c of counts) {
    if (!byUser.has(c.owner)) {
      const u = db.prepare('SELECT name FROM users WHERE username = ?').get(c.owner);
      byUser.set(c.owner, { username: c.owner, name: u ? u.name : c.owner, count: 0 });
    }
    byUser.get(c.owner).count = c.n;
  }
  return [...byUser.values()].sort((a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : 0));
}

/**
 * ตัวเลข Dashboard (INTERFACES §6.6) — หน้าจอ, API และไฟล์ส่งออกใช้ผลจากฟังก์ชันนี้ตัวเดียว
 * @param {{ period?: string, service?: string }} filters ค่าว่าง = เดือนของนาฬิกา / ALL · รูปแบบผิด → throw BAD_REQUEST
 * @param {string} [nowIso] ค่าเริ่มต้น = clock.nowIso()
 */
function computeDashboard(filters = {}, nowIso) {
  const now = nowIso || clock.nowIso();
  const { period, service } = resolveFilters(filters, now);
  const nowMs = clock.toMs(now);

  const rows = db
    .prepare(
      `SELECT service_id, status, paid_at, closed_at, due_at
         FROM cases
        WHERE case_no IS NOT NULL ${service === 'ALL' ? '' : 'AND service_id = ?'}`
    )
    .all(...(service === 'ALL' ? [] : [service]));

  let received = 0;
  let closed = 0;
  let onTime = 0;
  let backlog = 0;
  let overdue = 0;
  for (const r of rows) {
    // ตามช่วงเวลา
    if (r.paid_at && inPeriod(r.paid_at, period)) received += 1;
    if (CLOSED_STATUSES.includes(r.status) && r.closed_at && inPeriod(r.closed_at, period)) {
      closed += 1;
      // ทัน ⇔ closed_at ≤ กำหนดเสร็จ (รวมวินาทีที่ 16:30:00 · DECISIONS §18)
      if (r.due_at && clock.toMs(r.closed_at) <= clock.toMs(r.due_at)) onTime += 1;
    }
    // ณ ตอนนี้ (ไม่ขึ้นกับช่วง · A-41)
    if (BACKLOG_STATUSES.includes(r.status)) {
      backlog += 1;
      if (r.status !== 'NEED_FIX' && r.due_at && nowMs > clock.toMs(r.due_at)) overdue += 1;
    }
  }

  // B10: หารด้วยรับเรื่องแทนปิดงาน
  const denominator = isBug('B10') ? received : closed;
  const ontimePct = pctValue(onTime, denominator); // number | null
  const ontimeText = pct(onTime, denominator); // '85.7%' | '–'

  return {
    period,
    periodLabel: periodLabel(period),
    service,
    serviceLabel: serviceLabel(service),
    asOf: clock.toIso(now),
    received,
    closed,
    onTime,
    ontimePct,
    ontimeText,
    backlog,
    overdue,
    workload: workloadRows(),
  };
}

/** แถว KPI 5 ช่องพร้อมข้อความที่แสดงบนจอ: [{ key, label, testid, text }] (หน้า /dashboard และไฟล์ส่งออกใช้ร่วมกัน) */
function kpiRows(d) {
  return KPI_DEFS.map((k) => ({ key: k.key, label: k.label, testid: k.testid, en: k.en, text: String(d[k.key]) }));
}

/** บรรทัด ASCII ที่เครื่องอ่านได้ใน PDF (CONTRACT §7) · ปิดงาน 0 → ontime=- */
function kpiLine(d) {
  const ontime = d.ontimeText === DASH ? '-' : d.ontimeText;
  return `kpi received=${d.received} closed=${d.closed} ontime=${ontime} backlog=${d.backlog} overdue=${d.overdue}`;
}

// ---------------------------------------------------------------------------
// ส่งออก
// ---------------------------------------------------------------------------

/** .xlsx: ชีตแรก แถว 1 = `ตัวชี้วัด` `ค่า` · แถว 2–6 = 5 KPI (ค่าเป็นข้อความตามจอ) · ชีตที่ 2 = ช่วง/บริการ/งานในมือ */
async function buildXlsx(d) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'e-Service';
  wb.created = clock.now();
  wb.modified = clock.now();

  const ws = wb.addWorksheet('Dashboard');
  ws.columns = [{ width: 22 }, { width: 14 }];
  ws.addRow(['ตัวชี้วัด', 'ค่า']).font = { bold: true };
  for (const k of kpiRows(d)) {
    const row = ws.addRow([k.label, k.text]);
    row.getCell(2).numFmt = '@'; // เก็บเป็นข้อความตามที่แสดงบนจอ
    row.getCell(2).alignment = { horizontal: 'right' };
  }

  const info = wb.addWorksheet('รายละเอียด');
  info.columns = [{ width: 26 }, { width: 30 }];
  info.addRow(['ช่วงเวลา', `${d.period} (${d.periodLabel})`]);
  info.addRow(['บริการ', d.service === 'ALL' ? `ALL (${d.serviceLabel})` : d.serviceLabel]);
  info.addRow(['ข้อมูล ณ', thaiDateTime(d.asOf)]);
  info.addRow(['หมายเหตุ', 'งานคงค้าง/เกินกำหนดคงค้าง = ค่า ณ ตอนนี้']);
  info.addRow([]);
  info.addRow(['งานในมือรายเจ้าหน้าที่ (username)', 'จำนวนเรื่อง (กำลังตรวจสอบ)']).font = { bold: true };
  for (const w of d.workload) info.addRow([w.username, w.count]);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** .pdf: ข้อความ ASCII ทั้งหมด (ฟอนต์มาตรฐาน) · มีบรรทัด `kpi received=… overdue=…` บรรทัดเดียว (CONTRACT §7) */
function buildPdf(d) {
  const PDFDocument = require('pdfkit');
  const line = kpiLine(d);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 56,
      info: {
        Title: `e-Service Dashboard ${d.period} ${d.service}`,
        Subject: line,
        Author: 'e-Service',
        Producer: 'e-Service',
        Creator: 'e-Service',
        CreationDate: clock.now(),
        ModDate: clock.now(),
      },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const wide = doc.page.width - left - doc.page.margins.right;
    const [y, m] = d.period.split('-');
    const periodEn = m ? `${y}-${m} (BE ${Number(y) + 543}, month ${Number(m)})` : `${y} (BE ${Number(y) + 543}, full year)`;

    doc.font('Helvetica-Bold').fontSize(16).text('e-Service Dashboard Report', left, 56, { width: wide });
    doc.font('Helvetica').fontSize(10).fillColor('#444444')
      .text('Example Municipality (fictional) - executive summary, aggregate figures only', { width: wide });
    doc.moveDown(0.8).fillColor('#000000').fontSize(11);
    doc.text(`Period: ${periodEn}`);
    doc.text(`Service: ${d.service}`);
    doc.text(`As of: ${d.asOf.slice(0, 16).replace('T', ' ')} (UTC+07:00)`);
    doc.moveDown(0.8);

    // บรรทัดที่เครื่องอ่านได้ (บรรทัดเดียว ไม่ตัดคำ)
    doc.font('Courier').fontSize(10).text(line, left, doc.y, { lineBreak: false });
    doc.moveDown(1.6);

    // ตาราง KPI (เท่าจอ)
    doc.font('Helvetica-Bold').fontSize(12).text('Indicator', left, doc.y, { continued: false });
    let rowY = doc.y + 4;
    doc.font('Helvetica').fontSize(11);
    for (const k of kpiRows(d)) {
      const val = k.text === DASH ? '-' : k.text;
      doc.text(k.en, left, rowY, { width: 260, lineBreak: false });
      doc.text(val, left + 270, rowY, { width: 100, align: 'right', lineBreak: false });
      rowY += 18;
    }
    doc.moveTo(left, rowY + 2).lineTo(left + 370, rowY + 2).strokeColor('#999999').stroke();
    rowY += 14;

    doc.font('Helvetica-Bold').fontSize(12).text('Workload (cases in review, by officer username)', left, rowY, { lineBreak: false });
    rowY += 20;
    doc.font('Helvetica').fontSize(11);
    for (const w of d.workload) {
      doc.text(w.username, left, rowY, { width: 260, lineBreak: false });
      doc.text(String(w.count), left + 270, rowY, { width: 100, align: 'right', lineBreak: false });
      rowY += 18;
    }
    rowY += 10;
    doc.font('Helvetica').fontSize(9).fillColor('#444444').text(
      'On-time = closed (completed or rejected) at or before the due time. Backlog and overdue are current values. ' +
        'Yearly figures are summed over months before computing the percentage.',
      left,
      rowY,
      { width: wide }
    );
    doc.end();
  });
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

function register(app) {
  app.get('/api/dashboard', requireApi('executive'), (req, res) => {
    const d = computeDashboard({ period: req.query.period, service: req.query.service });
    res.json(d);
  });

  app.get('/api/dashboard/export', requireApi('executive'), async (req, res) => {
    const format = q(req.query.format).toLowerCase();
    if (!FORMATS.includes(format)) fail('BAD_REQUEST', { field: 'format' });
    const d = computeDashboard({ period: req.query.period, service: req.query.service });

    const buf = format === 'xlsx' ? await buildXlsx(d) : await buildPdf(d);
    // บันทึกหลังสร้างไฟล์สำเร็จเท่านั้น (A-36) · detail `<format> <period> <service>`
    logAudit(req.user, 'EXPORT', { detail: `${format} ${d.period} ${d.service}` });

    const filename = `dashboard-${d.period}-${d.service}.${format}`;
    res.set('Content-Type', format === 'xlsx' ? XLSX_MIME : 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.set('Cache-Control', 'no-store');
    res.send(buf);
  });
}

module.exports = {
  register,
  periodOptions,
  serviceOptions,
  computeDashboard,
  resolveFilters,
  isValidFilters,
  periodLabel,
  serviceLabel,
  kpiRows,
  kpiLine,
  buildXlsx,
  buildPdf,
  KPI_DEFS,
};
