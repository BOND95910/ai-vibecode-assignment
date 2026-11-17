// B11 · ตัวช่วยร่วมของหน้าเจ้าหน้าที่ (ใช้ EG จาก /common.js) · window.ST
(function () {
  var EG = window.EG, h = EG.h;
  var bootEl = document.getElementById('boot');
  var boot = {};
  try { boot = bootEl ? JSON.parse(bootEl.textContent) : {}; } catch (e) { /* ไม่มีข้อมูลเริ่มต้น */ }

  var DASH = '–'; // en dash U+2013
  function svcLabel(id) { return boot.services && boot.services[id] ? id + ' ' + boot.services[id] : String(id); }

  // กล่องข้อความของหน้า: มี action-error หรือ action-success อย่างละไม่เกิน 1 ตัวเสมอ (test ใช้ getByTestId แบบ strict)
  function box() { return document.getElementById('msg'); }
  function clearMsg() { var b = box(); if (b) b.textContent = ''; }
  function showError(text) {
    var b = box(); if (!b) return;
    b.textContent = '';
    b.appendChild(h('p', { class: 'msg-error', testid: 'action-error', role: 'alert', text: text }));
  }
  function showOk(text) {
    var b = box(); if (!b) return;
    b.textContent = '';
    b.appendChild(h('p', { class: 'msg-ok', testid: 'action-success', role: 'status', text: text }));
  }
  // ข้อความจาก API ตรง ๆ (ไม่แต่งเอง) · ไม่มี body = บอกรหัส HTTP
  function errText(r) { return r && r.body && r.body.message ? r.body.message : 'เกิดข้อผิดพลาด (HTTP ' + (r ? r.status : '?') + ')'; }
  function netError() { showError('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่'); }

  function view() { return document.getElementById('view'); }
  function setView(nodes) {
    var v = view(); if (!v) return;
    v.textContent = '';
    [].concat(nodes).forEach(function (n) { if (n) v.appendChild(n); });
    v.setAttribute('aria-busy', 'false');
  }

  function statusBadge(status, testid) {
    return h('span', { class: 'badge', testid: testid, 'data-status': status, text: EG.STATUS_TH[status] || status });
  }
  function levelBadge(level, testid) {
    if (!level) return h('span', { testid: testid, text: DASH });
    return h('span', { class: 'badge', testid: testid, 'data-level': level, text: EG.LEVEL_TH[level] || level });
  }
  function timeEl(iso, testid) {
    if (!iso) return h('span', { testid: testid, text: DASH });
    return h('time', { testid: testid, 'data-iso': iso, datetime: iso, text: EG.thaiDateTime(iso) });
  }
  // 2026-12-07 -> 7 ธ.ค. 2569
  function thaiDay(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
    return m ? Number(m[3]) + ' ' + EG.MONTHS[Number(m[2]) - 1] + ' ' + (Number(m[1]) + 543) : ymd;
  }
  // ช่องกรอก + label ผูกด้วย for/id
  function field(id, label, control) { return h('div', { class: 'field' }, h('label', { for: id, text: label }), control); }

  window.ST = {
    boot: boot, DASH: DASH, svcLabel: svcLabel, clearMsg: clearMsg, showError: showError, showOk: showOk, errText: errText, netError: netError,
    view: view, setView: setView, statusBadge: statusBadge, levelBadge: levelBadge, timeEl: timeEl, thaiDay: thaiDay, field: field,
  };
})();
