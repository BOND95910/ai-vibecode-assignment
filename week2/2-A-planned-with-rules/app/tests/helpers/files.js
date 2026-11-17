// ตัวสร้างไฟล์ทดสอบอัปโหลด ตาม TEST-DATA ข้อ 11 (พอร์ตจาก make_testfiles.py ตรงไบต์)
const zlib = require('node:zlib');

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };

function pdf(n) {
  const head = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n', 'latin1');
  const tail = Buffer.from('\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');
  const pad = n - head.length - tail.length;
  if (pad < 0) throw new Error('pdf เล็กเกินไป');
  return Buffer.concat([head, Buffer.alloc(pad, 0x20), tail]);
}

function png(n) {
  const chunk = (t, d) => {
    const td = Buffer.concat([Buffer.from(t, 'latin1'), d]);
    return Buffer.concat([u32(d.length), td, u32(crc32(td))]);
  };
  const ihdr = Buffer.concat([u32(1), u32(1), Buffer.from([8, 2, 0, 0, 0])]);
  const base = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, 0xff, 0, 0]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  const pad = n - base.length - 12;
  const text = Buffer.concat([Buffer.from('k\0', 'latin1'), Buffer.alloc(pad - 2, 0x78)]);
  return Buffer.concat([base.subarray(0, base.length - 12), chunk('tEXt', text), base.subarray(base.length - 12)]);
}

function jpg(n) {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const pad = n - soi.length - app0.length - 2 - 4;
  const len = Buffer.alloc(2);
  len.writeUInt16BE(pad + 2);
  return Buffer.concat([soi, app0, Buffer.from([0xff, 0xfe]), len, Buffer.alloc(pad, 0x78), Buffer.from([0xff, 0xd9])]);
}

const MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', png: 'image/png', txt: 'text/plain' };
const mimeOf = (name) => MIME[name.split('.').pop()] || 'application/octet-stream';

// คืน { name, mimeType, buffer } พร้อมส่งเข้า Playwright (setInputFiles / multipart)
function testFile(name, mimeOverride) {
  let buf;
  let m;
  if (/^(ok-id|id-card|map|plan|deed|multi-\d)\.pdf$/.test(name)) buf = pdf(1024);
  else if (name === 'real.jpg' || name === 'plan-as-jpg.jpg') buf = jpg(1024);
  else if (name === 'real.png') buf = png(1024);
  else if ((m = /^size-(\d+)\.pdf$/.exec(name))) buf = pdf(Number(m[1]));
  else if (name === 'fake-text.pdf' || name === 'fake-text.jpg' || name === 'notes.txt') buf = Buffer.from('hello');
  else if (name === 'exe-as.png') buf = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(1022)]);
  else throw new Error('ไม่รู้จักไฟล์ทดสอบ: ' + name);
  return { name, mimeType: mimeOverride || mimeOf(name), buffer: buf };
}

// ไฟล์บังคับของแต่ละบริการ [docKey, ชื่อไฟล์] (TEST-PLAN ข้อ 0 · NEW_PAID)
const REQUIRED_DOCS = {
  'SV-01': [['id-card', 'id-card.pdf']],
  'SV-02': [['id-card', 'id-card.pdf'], ['map', 'map.pdf']],
  'SV-03': [['id-card', 'id-card.pdf'], ['plan', 'plan.pdf'], ['deed', 'deed.pdf']],
};

module.exports = { testFile, REQUIRED_DOCS, pdf, png, jpg };
