// ตัวอ่านฐานข้อมูลของเว็บสำหรับ TC-NFR-04 (inspection) ด้วย node:sqlite
const fs = require('node:fs');

// รวมข้อความทุกคอลัมน์ทุกตาราง (ทั้งข้อความและ BLOB) เป็นสตริงเดียว เทียบกับ `sqlite3 app.db .dump`
function dumpAll(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    const parts = [];
    for (const { name } of tables) {
      parts.push('## ' + name);
      for (const row of db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all()) {
        for (const v of Object.values(row)) {
          if (v == null) continue;
          if (v instanceof Uint8Array) {
            const b = Buffer.from(v);
            parts.push(b.toString('latin1'), b.toString('utf8'));
          } else parts.push(String(v));
        }
      }
    }
    return { text: parts.join('\n'), tables: tables.map((t) => t.name) };
  } finally {
    db.close();
  }
}

// ไบต์ดิบของไฟล์ฐานข้อมูล (+ ไฟล์ -wal/-journal ถ้ามี) เทียบกับ `grep -a -c`
function rawFiles(dbPath) {
  const out = [];
  for (const p of [dbPath, dbPath + '-wal', dbPath + '-journal']) {
    if (fs.existsSync(p)) out.push({ path: p, buf: fs.readFileSync(p) });
  }
  return out;
}

function countOccurrences(haystack, needle) {
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

module.exports = { dumpAll, rawFiles, countOccurrences };
