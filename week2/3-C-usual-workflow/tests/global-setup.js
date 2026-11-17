// Creates tests/testfiles/* exactly as TEST-DATA §11 (same bytes as make_testfiles.py).
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const dir = path.join(__dirname, 'testfiles');
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
function pdf(n) {
  const head = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n');
  const tail = Buffer.from('\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  return Buffer.concat([head, Buffer.alloc(n - head.length - tail.length, 0x20), tail]);
}
function png(n) {
  const chunk = (t, d) => Buffer.concat([u32(d.length), Buffer.from(t), d, u32(zlib.crc32(Buffer.concat([Buffer.from(t), d])))]);
  const ihdr = Buffer.concat([u32(1), u32(1), Buffer.from([8, 2, 0, 0, 0])]);
  const base = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, 0xff, 0, 0]))), chunk('IEND', Buffer.alloc(0))]);
  const pad = n - base.length - 12;
  return Buffer.concat([base.subarray(0, -12), chunk('tEXt', Buffer.concat([Buffer.from('k\0'), Buffer.alloc(pad - 2, 'x')])), base.subarray(-12)]);
}
function jpg(n) {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const pad = n - soi.length - app0.length - 2 - 4;
  return Buffer.concat([soi, app0, Buffer.from([0xff, 0xfe]), u16(pad + 2), Buffer.alloc(pad, 'x'), Buffer.from([0xff, 0xd9])]);
}

module.exports = async () => {
  fs.mkdirSync(dir, { recursive: true });
  const w = (name, data) => fs.writeFileSync(path.join(dir, name), data);
  for (const n of ['ok-id.pdf', 'id-card.pdf', 'map.pdf', 'plan.pdf', 'deed.pdf', ...[1, 2, 3, 4, 5, 6].map(i => `multi-${i}.pdf`)]) w(n, pdf(1024));
  w('real.jpg', jpg(1024)); w('real.png', png(1024)); w('plan-as-jpg.jpg', jpg(1024));
  for (const n of [5242879, 5242880, 5242881]) w(`size-${n}.pdf`, pdf(n));
  w('fake-text.pdf', 'hello'); w('fake-text.jpg', 'hello'); w('notes.txt', 'hello');
  w('exe-as.png', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(1022)]));
};
