// ตัวช่วย assert ที่ข้อความบอกค่าที่คาดหวังเทียบค่าจริงเสมอ (BUGS.md ข้อ 3-4: ห้ามล้มเพราะ timeout อย่างเดียว)
const { expect } = require('@playwright/test');

const fmt = (v) => JSON.stringify(v);
const short = (s, n = 240) => (s && s.length > n ? s.slice(0, n) + '…' : s);

// เทียบค่าลึก: eq(actual, expected, 'ป้าย')
function eq(actual, expected, label) {
  expect(actual, `${label}: expected ${fmt(expected)} but received ${fmt(actual)}`).toEqual(expected);
}
function ok(cond, label, detail = '') {
  expect(!!cond, `${label}${detail ? ' · ' + detail : ''}`).toBe(true);
}
function match(actual, re, label) {
  expect(String(actual), `${label}: expected to match ${re} but received ${fmt(actual)}`).toMatch(re);
}
function contains(actual, sub, label) {
  expect(String(actual), `${label}: expected to contain ${fmt(sub)} but received ${fmt(short(String(actual)))}`).toContain(sub);
}
function notContains(actual, sub, label) {
  expect(String(actual), `${label}: expected NOT to contain ${fmt(sub)}`).not.toContain(sub);
}

// ตรวจ HTTP: status(r, 403, 'ป้าย') · err(r, 409, 'ALREADY_CLAIMED', 'ข้อความ', 'ป้าย')
function status(r, expected, label) {
  expect(r.status, `${label}: expected HTTP ${expected} but received ${r.status} body=${short(r.text)}`).toBe(expected);
}
function err(r, st, code, message, label) {
  status(r, st, label);
  expect(r.body && r.body.code, `${label}: expected code ${code} but received ${short(r.text)}`).toBe(code);
  if (message) expect(r.body.message, `${label}: expected message ${fmt(message)} but received ${fmt(r.body.message)}`).toBe(message);
}

// ---- ตัวช่วย UI (web-first assertion รอจนข้อความตรงหรือหมดเวลา แล้วรายงาน Expected/Received) ----
const tid = (page, id) => page.getByTestId(id);
async function text(page, id, expected, label) {
  await expect(tid(page, id), `${label || id}: expected ${fmt(expected)}`).toHaveText(expected);
}
async function attr(loc, name, expected, label) {
  await expect(loc, `${label}: expected ${name}=${fmt(expected)}`).toHaveAttribute(name, expected);
}
async function count(loc, n, label) {
  await expect(loc, `${label}: expected count ${n}`).toHaveCount(n);
}
async function hidden(loc, label) {
  await expect(loc, `${label}: expected hidden / absent`).toBeHidden();
}

module.exports = { eq, ok, match, contains, notContains, status, err, fmt, short, tid, text, attr, count, hidden };
