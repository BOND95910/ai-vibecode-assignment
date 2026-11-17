// B11 · /dashboard (executive) · ข้อมูลจาก GET /api/dashboard · ส่งออกผ่าน GET /api/dashboard/export (ไฟล์จริง)
// หน้านี้ไม่แสดงชื่อผู้ยื่น เลขบัตร เบอร์โทร (API ก็ไม่ส่งมา)
(function () {
  var EG = window.EG, ST = window.ST, h = EG.h;
  var P = ST.boot.period;
  var seq = 0;

  var periodSel = h('select', { id: 'period-select', testid: 'period-select', onchange: change }, P.options.map(function (o) { return h('option', { value: o.value, text: o.label }); }));
  var serviceSel = h('select', { id: 'service-select', testid: 'service-select', onchange: change },
    h('option', { value: 'ALL', text: 'ทุกบริการ' }),
    Object.keys(ST.boot.services).map(function (id) { return h('option', { value: id, text: ST.svcLabel(id) }); }));
  periodSel.value = P.def; serviceSel.value = 'ALL';

  var xlsx = h('a', { class: 'btn secondary', testid: 'export-xlsx-btn', download: '', text: 'ส่งออก Excel' });
  var pdf = h('a', { class: 'btn secondary', testid: 'export-pdf-btn', download: '', text: 'ส่งออก PDF' });
  function qs() { return 'period=' + encodeURIComponent(periodSel.value) + '&service=' + encodeURIComponent(serviceSel.value); }
  function links() {
    xlsx.setAttribute('href', '/api/dashboard/export?format=xlsx&' + qs());
    pdf.setAttribute('href', '/api/dashboard/export?format=pdf&' + qs());
  }

  var vals = {};
  function kpi(key, label) {
    var v = h('strong', { class: 'kpi-value', testid: 'kpi-' + key });
    vals[key] = v;
    return h('div', { class: 'kpi' }, h('span', { class: 'kpi-label', text: label }), v);
  }
  var workload = h('ul', { class: 'plain-list', 'aria-labelledby': 'h-workload' });

  ST.setView([
    h('div', { class: 'filters' }, ST.field('period-select', 'ช่วงเวลา', periodSel), ST.field('service-select', 'บริการ', serviceSel)),
    h('div', { class: 'kpis' }, kpi('received', 'รับเรื่อง'), kpi('closed', 'ปิดงาน'), kpi('ontime-pct', 'ทันกำหนด (%)'), kpi('backlog', 'งานคงค้าง (ณ ปัจจุบัน)'), kpi('overdue', 'เกินกำหนดคงค้าง (ณ ปัจจุบัน)')),
    h('div', { class: 'actions' }, xlsx, pdf),
    h('h2', { id: 'h-workload', text: 'งานในมือรายเจ้าหน้าที่' }), workload,
  ]);
  links();

  function change() { links(); load(); }

  function load() {
    var my = ++seq;
    ST.clearMsg();
    EG.api('GET', '/api/dashboard?' + qs()).then(function (r) {
      if (my !== seq) return; // ผลของตัวกรองเก่าที่มาช้ากว่า
      if (!r.ok) { ST.showError(ST.errText(r)); return; }
      var d = r.body;
      vals.received.textContent = d.received;
      vals.closed.textContent = d.closed;
      vals['ontime-pct'].textContent = d.ontimePct === null ? ST.DASH : d.ontimePct.toFixed(1) + '%';
      vals.backlog.textContent = d.backlog;
      vals.overdue.textContent = d.overdue;
      workload.textContent = '';
      d.workload.forEach(function (w) {
        workload.appendChild(h('li', { testid: 'workload-row', 'data-username': w.username },
          h('span', { text: w.username }), h('strong', { testid: 'workload-value', text: w.count })));
      });
    }).catch(function () { if (my === seq) ST.netError(); });
  }
  load();
})();
