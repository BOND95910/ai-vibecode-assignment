// ตัวห่อ APIRequestContext: ไม่โยนข้อผิดพลาดเมื่อ status ไม่ใช่ 2xx คืน { status, body, text, headers, buf }
const { expect } = require('@playwright/test');
const { eq, status, short } = require('./check');

async function call(r, method, url, opts = {}) {
  const res = await r.fetch(url, {
    method,
    data: opts.data,
    multipart: opts.multipart,
    headers: opts.headers,
    maxRedirects: opts.maxRedirects,
  });
  const buf = await res.body();
  const headers = res.headers();
  const text = buf.toString('utf8');
  let body = null;
  if ((headers['content-type'] || '').includes('json')) {
    try { body = JSON.parse(text); } catch { body = null; }
  }
  return { status: res.status(), body, text, headers, buf };
}
const get = (r, url, o) => call(r, 'GET', url, o);
const post = (r, url, data, o = {}) => call(r, 'POST', url, { ...o, data });
const put = (r, url, data, o = {}) => call(r, 'PUT', url, { ...o, data });
const patch = (r, url, data, o = {}) => call(r, 'PATCH', url, { ...o, data });
const del = (r, url, o) => call(r, 'DELETE', url, o);

// ---- บัญชี (TEST-DATA ข้อ 1) ----
const CITIZENS = {
  somchai: { idNo: '1101700123456', name: 'สมชาย ใจดี', full: '1-1017-00123-45-6', masked: 'X-XXXX-XXXXX-45-6' },
  somying: { idNo: '3100600987659', name: 'สมหญิง รักไทย', full: '3-1006-00987-65-9', masked: 'X-XXXX-XXXXX-65-9' },
  mana: { idNo: '5500400111221', name: 'มานะ ตั้งใจ', full: '5-5004-00111-22-1', masked: 'X-XXXX-XXXXX-22-1' },
  piti: { idNo: '1909900555015', name: 'ปิติ มีสุข', full: '1-9099-00555-01-5', masked: 'X-XXXX-XXXXX-01-5' },
};
const STAFF = {
  'off.reg1': { name: 'เจ้าหน้าที่ทะเบียน 1', role: 'officer', dept: 'registry', landing: '/officer/queue' },
  'off.reg2': { name: 'เจ้าหน้าที่ทะเบียน 2', role: 'officer', dept: 'registry', landing: '/officer/queue' },
  'off.works1': { name: 'เจ้าหน้าที่โยธา 1', role: 'officer', dept: 'works', landing: '/officer/queue' },
  head1: { name: 'หัวหน้าฝ่าย', role: 'head', dept: undefined, landing: '/head/approvals' },
  exec1: { name: 'ผู้บริหาร', role: 'executive', dept: undefined, landing: '/dashboard' },
  audit1: { name: 'ผู้ตรวจสอบภายใน', role: 'auditor', dept: undefined, landing: '/audit' },
  admin1: { name: 'ผู้ดูแลระบบ', role: 'admin', dept: undefined, landing: '/admin/services' },
};
const PASSWORD = 'Test@1234';
const OTP = '123456';

// LOGIN_C: POST /api/auth/thaid/start แล้ว verify (CONTRACT 6.1)
async function loginC(r, idNo, otp = OTP) {
  const s = await post(r, '/api/auth/thaid/start', { idNo });
  status(s, 200, `LOGIN_C ${idNo} start`);
  const v = await post(r, '/api/auth/thaid/verify', { idNo, otp });
  status(v, 200, `LOGIN_C ${idNo} verify`);
  return v.body;
}
// LOGIN_S: POST /api/auth/staff/login
async function loginS(r, username, password = PASSWORD) {
  const v = await post(r, '/api/auth/staff/login', { username, password });
  status(v, 200, `LOGIN_S ${username}`);
  return v.body;
}
async function loginAs(r, who) {
  if (CITIZENS[who]) return loginC(r, CITIZENS[who].idNo);
  if (STAFF[who]) return loginS(r, who);
  throw new Error('ไม่รู้จักผู้ใช้ ' + who);
}

module.exports = { call, get, post, put, patch, del, CITIZENS, STAFF, PASSWORD, OTP, loginC, loginS, loginAs, expect, eq, short };
