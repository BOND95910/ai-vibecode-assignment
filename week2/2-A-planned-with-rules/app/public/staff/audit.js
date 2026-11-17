// B11 · /audit (auditor) · อ่านอย่างเดียว: ไม่มีปุ่มแก้/ลบ · ข้อมูลจาก GET /api/audit · ส่งออก CSV จาก /api/audit/export.csv
(function () {
  var EG = window.EG, ST = window.ST, h = EG.h;
  var EVENTS = ['STAFF_LOGIN', 'CLAIM', 'RETURN', 'FORWARD', 'APPROVE', 'REJECT', 'ISSUE', 'UNMASK', 'EXPORT', 'ADMIN_CHANGE'];
  var seq = 0;

  var actor = h('input', { type: 'text', id: 'audit-filter-actor', testid: 'audit-filter-actor', autocomplete: 'off', autocapitalize: 'none' });
  var event = h('select', { id: 'audit-filter-event', testid: 'audit-filter-event' },
    h('option', { value: '', text: 'ทั้งหมด' }), EVENTS.map(function (e) { return h('option', { value: e, text: e }); }));
  var from = h('input', { type: 'date', id: 'audit-filter-from', testid: 'audit-filter-from' });
  var to = h('input', { type: 'date', id: 'audit-filter-to', testid: 'audit-filter-to' });
  var apply = h('button', { type: 'submit', class: 'btn', testid: 'audit-apply-btn', text: 'ค้นหา' });
  var csv = h('a', { class: 'btn secondary', testid: 'audit-export-csv-btn', download: '', text: 'ส่งออก CSV' });
  var count = h('strong', { testid: 'audit-count' });
  var out = h('div');

  var form = h('form', { class: 'filters', novalidate: '', onsubmit: function (e) { e.preventDefault(); load(); } },
    ST.field('audit-filter-actor', 'ผู้ทำรายการ (username)', actor), ST.field('audit-filter-event', 'เหตุการณ์', event),
    ST.field('audit-filter-from', 'ตั้งแต่วันที่', from), ST.field('audit-filter-to', 'ถึงวันที่', to), apply);
  ST.setView([form, h('p', null, 'พบ ', count, ' รายการ ', csv), out]);

  // ตัวกรองที่ใช้อยู่จริง (ค่าตอนกดค้นหา) · CSV ส่งออกเท่าที่แสดงบนจอ
  function query() {
    var q = [];
    [['actor', actor], ['event', event], ['from', from], ['to', to]].forEach(function (p) { if (p[1].value) q.push(p[0] + '=' + encodeURIComponent(p[1].value.trim())); });
    return q.join('&');
  }

  function row(it) {
    return h('tr', { testid: 'audit-row', 'data-id': it.id, 'data-event': it.event, 'data-actor': it.username, 'data-case-no': it.caseNo || '' },
      h('td', null, ST.timeEl(it.time, 'audit-time')),
      h('td', { testid: 'audit-actor', text: it.username }),
      h('td', { testid: 'audit-role', text: it.role }),
      h('td', { testid: 'audit-event', text: it.event }),
      h('td', { testid: 'audit-case-no', text: it.caseNo || ST.DASH }),
      h('td', { testid: 'audit-transition', text: it.fromStatus && it.toStatus ? it.fromStatus + ' → ' + it.toStatus : ST.DASH }),
      h('td', { testid: 'audit-detail', text: it.detail || ST.DASH }));
  }

  function load() {
    var my = ++seq, q = query();
    ST.clearMsg();
    csv.setAttribute('href', '/api/audit/export.csv' + (q ? '?' + q : ''));
    EG.api('GET', '/api/audit' + (q ? '?' + q : '')).then(function (r) {
      if (my !== seq) return;
      out.textContent = '';
      if (!r.ok) { count.textContent = ''; ST.showError(ST.errText(r)); return; }
      count.textContent = r.body.count;
      if (!r.body.items.length) { out.appendChild(h('p', { text: 'ไม่พบรายการ Audit ตามเงื่อนไข' })); return; }
      out.appendChild(h('div', { class: 'table-wrap', role: 'region', 'aria-label': 'ตาราง Audit Trail', tabindex: '0' },
        h('table', { class: 'data' },
          h('thead', null, h('tr', null, ['เวลา', 'ผู้ทำ', 'บทบาท', 'เหตุการณ์', 'เลขคำขอ', 'สถานะก่อน → หลัง', 'รายละเอียด'].map(function (t) { return h('th', { scope: 'col', text: t }); }))),
          h('tbody', null, r.body.items.map(row)))));
    }).catch(function () { if (my === seq) ST.netError(); });
  }
  load();
})();
