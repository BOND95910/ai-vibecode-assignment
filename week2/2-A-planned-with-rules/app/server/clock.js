// นาฬิกากลางของระบบ: ทุกกฎธุรกิจอ่านเวลาจากที่นี่เท่านั้น (ห้าม new Date() ตรง ๆ)
// แช่แข็งที่ค่าที่ตั้งไว้เสมอ (A-37) · ค่าเริ่มต้น = ค่าหลัง reset
const DEFAULT_ISO = '2026-12-01T09:00:00+07:00';
const OFFSET_MS = 7 * 3600 * 1000;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

let current = new Date(DEFAULT_ISO);

function pad(n) { return String(n).padStart(2, '0'); }

// Date -> 'YYYY-MM-DDTHH:mm:ss+07:00' (ตัดมิลลิวินาที)
function toBangkokISO(date) {
  const d = new Date(date.getTime() + OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+07:00`;
}

// แปลง ISO ที่ "ต้องมี offset" เป็น Date · ไม่ถูกต้อง -> null (รวมวันที่ไม่มีจริง เช่น 30 ก.พ.)
function parseISO(iso) {
  if (typeof iso !== 'string') return null;
  const m = ISO_RE.exec(iso);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map((v) => (v === undefined ? 0 : Number(v)));
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59) return null;
  const chk = new Date(Date.UTC(y, mo - 1, d));
  if (chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d) return null;
  const t = new Date(iso);
  return isNaN(t.getTime()) ? null : t;
}

module.exports = {
  DEFAULT_ISO,
  now: () => new Date(current.getTime()),
  nowISO: () => toBangkokISO(current),
  // ตั้งนาฬิกา · ISO ไม่ถูกต้อง/ไม่มี offset -> throw (testhook ตอบ 400 INVALID_TIME)
  set(iso) {
    const t = parseISO(iso);
    if (!t) throw Object.assign(new Error('INVALID_TIME'), { code: 'INVALID_TIME' });
    current = t;
  },
  reset() { current = new Date(DEFAULT_ISO); },
  toBangkokISO,
  parseISO,
};
