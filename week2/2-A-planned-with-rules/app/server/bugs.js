// BUG_MODE=B03,B07 -> bug('B03') === true · อ่านครั้งเดียวตอนเริ่ม · ไม่ตั้ง = ถูกต้อง 100%
const enabled = new Set(
  (process.env.BUG_MODE || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
);
module.exports = { bug: (code) => enabled.has(String(code).toUpperCase()) };
