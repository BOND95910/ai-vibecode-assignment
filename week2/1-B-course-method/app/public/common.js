/* common.js (B01) — ตัวช่วยฝั่งเบราว์เซอร์ที่ทุกหน้าโหลด: window.Egov
 *   Egov.api(method, url, body) → Promise<{ok, status, data}>  (JSON · body FormData = multipart)
 *   Egov.thaiDateTime(iso) "4 ธ.ค. 2569 16:30" · Egov.thaiDate(ymd|iso) · Egov.baht(1010) "฿1,010"
 *   Egov.maskId(id) · Egov.formatId(id) · Egov.esc(str)
 *   Egov.showError(el, msg) / Egov.clearError(el)
 * ต้องให้ผลตรงกับ src/format.js
 */
(function () {
  'use strict';
  var TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  var OFFSET = 7 * 3600 * 1000;

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function bkk(iso) {
    var d = new Date(new Date(iso).getTime() + OFFSET);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes() };
  }

  function thaiDateTime(iso) {
    if (!iso) return '';
    var p = bkk(iso);
    return p.d + ' ' + TH_MONTHS[p.m - 1] + ' ' + (p.y + 543) + ' ' + pad(p.hh) + ':' + pad(p.mm);
  }

  function thaiDate(v) {
    if (!v) return '';
    var y, m, d;
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      var a = v.split('-'); y = +a[0]; m = +a[1]; d = +a[2];
    } else {
      var p = bkk(v); y = p.y; m = p.m; d = p.d;
    }
    return d + ' ' + TH_MONTHS[m - 1] + ' ' + (y + 543);
  }

  function baht(n) {
    if (n === null || n === undefined || n === '' || !isFinite(Number(n))) return '–';
    return '฿' + Math.round(Number(n)).toLocaleString('en-US');
  }

  function formatId(id) {
    var s = String(id || '').replace(/\D/g, '');
    if (s.length !== 13) return String(id || '');
    return s[0] + '-' + s.slice(1, 5) + '-' + s.slice(5, 10) + '-' + s.slice(10, 12) + '-' + s[12];
  }

  function maskId(id) {
    var s = String(id || '').replace(/\D/g, '');
    if (s.length !== 13) return 'X-XXXX-XXXXX-XX-X';
    return 'X-XXXX-XXXXX-' + s.slice(10, 12) + '-' + s[12];
  }

  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(v) { return v === null || v === undefined ? '' : String(v).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }

  function api(method, url, body) {
    var opts = { method: method, headers: { Accept: 'application/json' }, credentials: 'same-origin' };
    if (body instanceof FormData) {
      opts.body = body;
    } else if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(url, opts).then(function (res) {
      var ct = res.headers.get('content-type') || '';
      var p = ct.indexOf('application/json') >= 0 ? res.json() : Promise.resolve(null);
      return p.then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
    });
  }

  function showError(el, msg) {
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
  }
  function clearError(el) {
    if (!el) return;
    el.textContent = '';
    el.hidden = true;
  }

  window.Egov = {
    api: api, thaiDateTime: thaiDateTime, thaiDate: thaiDate, baht: baht,
    formatId: formatId, maskId: maskId, esc: esc, showError: showError, clearError: clearError
  };
})();
