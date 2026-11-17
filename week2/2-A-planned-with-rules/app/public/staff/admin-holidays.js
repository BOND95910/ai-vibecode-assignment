// B11 · /admin/holidays · GET/POST/DELETE /api/admin/holidays
(function () {
  var EG = window.EG, ST = window.ST, h = EG.h;
  var date = h('input', { type: 'date', id: 'holiday-date', testid: 'holiday-date-input' });
  var name = h('input', { type: 'text', id: 'holiday-name', testid: 'holiday-name-input', autocomplete: 'off' });
  var list = h('div');

  function add() {
    ST.clearMsg();
    EG.api('POST', '/api/admin/holidays', { date: date.value, name: name.value }).then(function (r) {
      if (!r.ok) { ST.showError(ST.errText(r)); return; }
      date.value = ''; name.value = '';
      return load().then(function () { ST.showOk('เพิ่มวันหยุด ' + r.body.date + ' แล้ว'); });
    }).catch(ST.netError);
  }
  function del(d) {
    ST.clearMsg();
    EG.api('DELETE', '/api/admin/holidays/' + encodeURIComponent(d)).then(function (r) {
      if (!r.ok) { ST.showError(ST.errText(r)); return load(); }
      return load().then(function () { ST.showOk('ลบวันหยุด ' + d + ' แล้ว'); });
    }).catch(ST.netError);
  }

  function row(it) {
    return h('tr', { testid: 'holiday-row', 'data-date': it.date },
      h('td', null, h('time', { datetime: it.date, 'data-iso': it.date, text: ST.thaiDay(it.date) })),
      h('td', { text: it.name || ST.DASH }),
      h('td', null, h('button', { type: 'button', class: 'btn secondary', testid: 'holiday-delete-btn', 'aria-label': 'ลบ ' + it.date, text: 'ลบ', onclick: function () { del(it.date); } })));
  }

  function load() {
    return EG.api('GET', '/api/admin/holidays').then(function (r) {
      if (!r.ok) { ST.showError(ST.errText(r)); return; }
      list.textContent = '';
      list.appendChild(h('div', { class: 'table-wrap', role: 'region', 'aria-label': 'ตารางวันหยุด', tabindex: '0' },
        h('table', { class: 'data' },
          h('thead', null, h('tr', null, ['วันที่', 'ชื่อวันหยุด', 'ดำเนินการ'].map(function (t) { return h('th', { scope: 'col', text: t }); }))),
          h('tbody', null, r.body.items.map(row)))));
    });
  }

  ST.setView([
    h('form', { class: 'filters', novalidate: '', onsubmit: function (e) { e.preventDefault(); add(); } },
      ST.field('holiday-date', 'วันที่ (ค.ศ.)', date), ST.field('holiday-name', 'ชื่อวันหยุด', name),
      h('button', { type: 'submit', class: 'btn', testid: 'holiday-add-btn', text: 'เพิ่มวันหยุด' })),
    list,
  ]);
  load().catch(ST.netError);
})();
