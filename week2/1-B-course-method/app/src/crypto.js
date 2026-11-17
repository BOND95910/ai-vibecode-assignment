'use strict';
/**
 * Crypto helpers (B01)
 * - PII at rest (NFR-04 · DECISIONS §11): เลขบัตร/เบอร์โทร เข้ารหัส AES-256-GCM · ค้นหาด้วย HMAC (idHash)
 * - ลายเซ็นเอกสารจำลอง (CONTRACT §3 · A-22): HMAC-SHA256 ของ docNo|caseNo|applicant|serviceId|issuedAt|validUntil|signer
 * - รหัสผ่านเจ้าหน้าที่: scrypt
 * คีย์เป็น "คีย์ทดสอบ" (ตั้งทับได้ด้วย env PII_KEY / DOC_SIGN_KEY) — ไม่ใช่ CA จริง
 */

const crypto = require('crypto');

const PII_KEY = crypto.createHash('sha256').update(process.env.PII_KEY || 'egov-sample-city-test-pii-key-v1').digest();
const LOOKUP_KEY = crypto.createHash('sha256').update('lookup:' + (process.env.PII_KEY || 'egov-sample-city-test-pii-key-v1')).digest();
const DOC_SIGN_KEY = process.env.DOC_SIGN_KEY || 'egov-sample-city-test-signing-key-v1';

/** เข้ารหัสข้อความ → "v1:<base64(iv12|tag16|ciphertext)>" · null/undefined/'' → null */
function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', PII_KEY, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

/** ถอดรหัสค่าจาก encrypt() · null → null */
function decrypt(blob) {
  if (!blob) return null;
  const s = String(blob);
  if (!s.startsWith('v1:')) throw new Error('crypto.decrypt: unknown format');
  const raw = Buffer.from(s.slice(3), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', PII_KEY, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

/** HMAC แบบกำหนดได้ (deterministic) ของเลขบัตร 13 หลัก → hex · ใช้ค้นผู้ใช้ (users.id_hash / otp_attempts.id_hash) */
function idHash(idNo) {
  return crypto.createHmac('sha256', LOOKUP_KEY).update(String(idNo)).digest('hex');
}

/** scrypt hash รหัสผ่าน → "scrypt$<salt hex>$<hash hex>" (N=4096 เร็วพอสำหรับ reset บ่อย) */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 32, { N: 4096, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}

/** ตรวจรหัสผ่านกับค่าจาก hashPassword (timing-safe) */
function verifyPassword(pw, stored) {
  if (!stored || typeof pw !== 'string') return false;
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const h = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 32, { N: 4096, r: 8, p: 1 });
  const ref = Buffer.from(hashHex, 'hex');
  return ref.length === h.length && crypto.timingSafeEqual(ref, h);
}

/** ลำดับฟิลด์ที่ลงนาม (คงที่ · CONTRACT §3) */
const SIGNED_FIELDS = ['docNo', 'caseNo', 'applicant', 'serviceId', 'issuedAt', 'validUntil', 'signer'];

/** ลายเซ็นจำลองของเอกสาร → hex · doc = {docNo, caseNo, applicant, serviceId, issuedAt, validUntil, signer} */
function signDoc(doc) {
  const payload = SIGNED_FIELDS.map((k) => (doc[k] === null || doc[k] === undefined ? '' : String(doc[k]))).join('|');
  return crypto.createHmac('sha256', DOC_SIGN_KEY).update(payload, 'utf8').digest('hex');
}

/** true ถ้าลายเซ็นตรงกับฟิลด์ที่เก็บ */
function verifyDocSignature(doc, signature) {
  const expect = Buffer.from(signDoc(doc), 'hex');
  const got = Buffer.from(String(signature || ''), 'hex');
  return got.length === expect.length && crypto.timingSafeEqual(got, expect);
}

const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
/** รหัสสุ่ม [A-Z0-9]{n} (verify code = 8 ตัว) */
function randomCode(n = 8) {
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return s;
}

/** token สุ่มสำหรับ session id */
function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

module.exports = {
  encrypt,
  decrypt,
  idHash,
  hashPassword,
  verifyPassword,
  SIGNED_FIELDS,
  signDoc,
  verifyDocSignature,
  randomCode,
  randomToken,
};
