// B11 · /admin/services · GET/PUT /api/admin/services (ข้อผิดพลาดตรงตัวจาก API)
(function () {
  var EG = window.EG, ST = window.ST, h = EG.h;

  function num(id, label, testid, value) {
    // ช่อง number ไม่มี min/max: ให้ API เป็นผู้ตัดสินช่วงค่าและข้อความ
    return ST.field(id, label, h('input', { type: 'number', id: id, testid: testid, value: value, step: '1', inputmode: 'numeric' }));
  }

  function section(it) {
    var is3 = it.id === 'SV-03';
    var fee = num('fee-' + it.id, is3 ? 'ค่าธรรมเนียมฐาน (บาท · พื้นที่ 1-100 ตร.ม.)' : it.id === 'SV-01' ? 'ค่าธรรมเนียมต่อฉบับ (บาท)' : 'ค่าธรรมเนียมคงที่ (บาท)', 'svc-fee-' + it.id, it.fee);
    var perSqm = is3 ? num('sqm-' + it.id, 'ค่าธรรมเนียมต่อ ตร.ม. ส่วนที่เกิน 100 (บาท)', 'svc-fee-per-sqm-' + it.id, it.feePerSqm) : null;
    var sla = num('sla-' + it.id, 'SLA (วันทำการ)', 'svc-sla-' + it.id, it.sla);
    var inputs = [fee, perSqm, sla];

    function save() {
      var v = function (f) { return f ? f.querySelector('input').value : undefined; };
      var body = { sla: v(sla) };
      if (is3) { body.feeBase = v(fee); body.feePerSqm = v(perSqm); } else body.fee = v(fee);
      ST.clearMsg();
      EG.api('PUT', '/api/admin/services/' + encodeURIComponent(it.id), body).then(function (r) {
        if (!r.ok) { ST.showError(ST.errText(r)); return; }
        fee.querySelector('input').value = r.body.fee;
        if (is3) perSqm.querySelector('input').value = r.body.feePerSqm;
        sla.querySelector('input').value = r.body.sla;
        ST.showOk('บันทึก ' + it.id + ' แล้ว');
      }).catch(ST.netError);
    }

    return h('section', { class: 'card', testid: 'service-row', 'data-service-id': it.id, 'aria-labelledby': 'h-' + it.id },
      h('h2', { id: 'h-' + it.id, text: ST.svcLabel(it.id) }),
      h('form', { novalidate: '', onsubmit: function (e) { e.preventDefault(); save(); } },
        h('div', { class: 'svc-grid' }, inputs),
        h('button', { type: 'submit', class: 'btn', testid: 'svc-save-' + it.id, text: 'บันทึก' })));
  }

  EG.api('GET', '/api/admin/services').then(function (r) {
    if (!r.ok) { ST.setView(null); ST.showError(ST.errText(r)); return; }
    ST.setView(r.body.items.map(section));
  }).catch(function () { ST.setView(null); ST.netError(); });
})();
