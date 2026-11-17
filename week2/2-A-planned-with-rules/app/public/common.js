// B10 · ตัวช่วยกลางฝั่งหน้าเว็บ (B11 ใช้ร่วม อ่านอย่างเดียว) · โหลดได้ทั้งในเบราว์เซอร์ (window.EG) และ Node (server/pages/citizen.js require)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EG = factory();
})(this, function () {
  var MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  // CONTRACT ตาราง 4.1 / 4.2
  var STATUS_TH = {
    DRAFT: 'ร่าง', PENDING_PAYMENT: 'รอชำระเงิน', SUBMITTED: 'ส่งคำขอแล้ว', IN_REVIEW: 'กำลังตรวจสอบ',
    NEED_FIX: 'รอแก้ไขเอกสาร', PENDING_APPROVAL: 'รออนุมัติ', APPROVED: 'อนุมัติ', COMPLETED: 'เสร็จสิ้น',
    REJECTED: 'ไม่อนุมัติ', CANCELLED: 'ยกเลิก',
  };
  var LEVEL_TH = { normal: 'ปกติ', near: 'ใกล้ครบกำหนด', overdue: 'เกินกำหนด', paused: 'หยุดนับ', closed: 'ปิดแล้ว' };
  var STEP_TH = { 1: 'ฝ่ายทะเบียน', 2: 'ฝ่ายโยธา', 3: 'หัวหน้าฝ่าย' };

  function pad(n) { return n < 10 ? '0' + n : String(n); }
  // '2026-12-04T16:30:00+07:00' -> '4 ธ.ค. 2569 16:30' (เวลาไทยเสมอ ไม่ขึ้นกับ timezone เครื่อง)
  function thaiDateTime(iso) {
    var b = new Date(new Date(iso).getTime() + 7 * 3600 * 1000);
    return b.getUTCDate() + ' ' + MONTHS[b.getUTCMonth()] + ' ' + (b.getUTCFullYear() + 543) + ' ' + pad(b.getUTCHours()) + ':' + pad(b.getUTCMinutes());
  }
  function baht(n) { return '฿' + Number(n).toLocaleString('en-US'); }
  // 3100600987659 -> 3-1006-00987-65-9
  function formatId(s) {
    var d = String(s).replace(/\D/g, '');
    return d.length === 13 ? d.replace(/^(\d)(\d{4})(\d{5})(\d{2})(\d)$/, '$1-$2-$3-$4-$5') : String(s);
  }

  var api = null, h = null, fakeQr = null;
  if (typeof document !== 'undefined') {
    // สร้าง DOM แบบปลอดภัย (textContent เท่านั้น ไม่ใช้ innerHTML) · attrs: text class testid on<event> และ attribute อื่น ๆ
    h = function (tag, attrs) {
      var el = document.createElement(tag);
      for (var k in attrs || {}) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'text') el.textContent = v;
        else if (k === 'class') el.className = v;
        else if (k === 'testid') el.setAttribute('data-testid', v);
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
      var add = function (c) {
        if (c === null || c === undefined || c === false) return;
        if (Array.isArray(c)) c.forEach(add);
        else el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      };
      for (var i = 2; i < arguments.length; i++) add(arguments[i]);
      return el;
    };

    // fetch JSON/multipart -> { status, ok, body } · 401 นอกหน้า login = กลับ /login
    api = function (method, url, body) {
      var opts = { method: method, credentials: 'same-origin', headers: {} };
      if (body !== undefined && body !== null) {
        if (typeof FormData !== 'undefined' && body instanceof FormData) opts.body = body;
        else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
      }
      return fetch(url, opts).then(function (r) {
        return r.text().then(function (t) {
          var j = null;
          try { j = t ? JSON.parse(t) : null; } catch (e) { /* ไม่ใช่ JSON */ }
          if (r.status === 401 && url.indexOf('/api/auth/') !== 0) location.href = '/login';
          return { status: r.status, ok: r.ok, body: j };
        });
      });
    };

    // QR จำลอง: ลายจุดคงที่จากข้อความ (ไม่ใช่ QR จริง) · คืน <svg data-testid=...>
    fakeQr = function (seed, label, testid) {
      var N = 21, ns = 'http://www.w3.org/2000/svg', s = 7;
      for (var i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0;
      var svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', '0 0 ' + N + ' ' + N);
      svg.setAttribute('class', 'qr');
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', label);
      if (testid) svg.setAttribute('data-testid', testid);
      var local = function (v) { return v < 7 ? v : v >= N - 7 ? v - (N - 7) : -1; }; // พิกัดใน finder 7x7 หรือ -1
      var ring = function (x, y) { var d = Math.max(Math.abs(x - 3), Math.abs(y - 3)); return d === 3 || d <= 1; };
      for (var y = 0; y < N; y++) {
        for (var x = 0; x < N; x++) {
          s = (s * 1103515245 + 12345) >>> 0;
          var lx = local(x), ly = local(y);
          var isFinder = lx >= 0 && ly >= 0 && !(x >= 7 && x < N - 7) && !(y >= 7 && y < N - 7) && !(lx >= 0 && ly >= 0 && x >= N - 7 && y >= N - 7);
          var on = isFinder ? ring(lx, ly) : (s >>> 16) % 2 === 0;
          if (!on) continue;
          var r = document.createElementNS(ns, 'rect');
          r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', 1); r.setAttribute('height', 1);
          r.setAttribute('fill', '#000');
          svg.appendChild(r);
        }
      }
      return svg;
    };

    document.addEventListener('click', function (e) {
      var t = e.target.closest && e.target.closest('[data-testid="logout-btn"]');
      if (!t) return;
      fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).finally(function () { location.href = '/login'; });
    });
  }

  return { MONTHS: MONTHS, STATUS_TH: STATUS_TH, LEVEL_TH: LEVEL_TH, STEP_TH: STEP_TH, thaiDateTime: thaiDateTime, baht: baht, formatId: formatId, h: h, api: api, fakeQr: fakeQr };
});
