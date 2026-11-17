// B11 · /officer/queue (officer รับเรื่องได้ · head อ่านอย่างเดียว) · ข้อมูลจาก GET /api/officer/queue
(function () {
  var EG = window.EG, ST = window.ST, h = EG.h;
  var isOfficer = ST.boot.user && ST.boot.user.role === 'officer';
  var filter = 'all', seq = 0, busy = false;

  var filterSel = h('select', { id: 'queue-filter', testid: 'queue-filter', onchange: function () { filter = filterSel.value; load(); } },
    h('option', { value: 'all', text: 'ทั้งหมด' }),
    h('option', { value: 'unclaimed', text: 'ยังไม่มีผู้รับ' }),
    h('option', { value: 'mine', text: 'ของฉัน' }));
  filterSel.value = 'all';
  var workloadBox = h('p', { id: 'workload' });
  var list = h('div', { id: 'queue-list' });
  document.getElementById('msg').after(h('div', { class: 'filters' }, ST.field('queue-filter', 'แสดงรายการ', filterSel)), workloadBox);
  ST.setView(list);

  function claim(caseNo) {
    if (busy) return;
    busy = true; ST.clearMsg();
    list.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    EG.api('POST', '/api/officer/cases/' + encodeURIComponent(caseNo) + '/claim').then(function (r) {
      // โหลดคิวใหม่ก่อนแล้วค่อยแสดงข้อความ (ข้อความต้องไม่ถูกล้างตอนวาดใหม่)
      return load().then(function () {
        busy = false;
        if (r.ok) ST.showOk('รับเรื่อง ' + caseNo + ' แล้ว'); else ST.showError(ST.errText(r));
      });
    }).catch(function () { busy = false; ST.netError(); });
  }

  function row(it) {
    var owner = it.owner || '';
    return h('tr', { testid: 'queue-row', 'data-case-no': it.caseNo, 'data-owner': owner, 'data-status': it.status, 'data-sla-level': it.slaLevel || '' },
      h('td', null, h('a', { testid: 'row-case-no', href: '/officer/cases/' + encodeURIComponent(it.caseNo), text: it.caseNo })),
      h('td', { testid: 'row-service', text: ST.svcLabel(it.serviceId) }),
      h('td', { testid: 'row-applicant', text: it.applicantName }),
      h('td', { testid: 'row-id-masked', text: it.idMasked }),
      h('td', null, ST.statusBadge(it.status, 'row-status')),
      h('td', null, ST.timeEl(it.dueAt, 'row-due')),
      h('td', null, ST.levelBadge(it.slaLevel, 'row-sla-level')),
      h('td', { testid: 'row-owner', text: owner || '' }),
      h('td', null, it.can && it.can.claim ? h('button', { type: 'button', class: 'btn', testid: 'claim-btn', 'aria-label': 'รับเรื่อง ' + it.caseNo, onclick: function () { claim(it.caseNo); }, text: 'รับเรื่อง' }) : null));
  }

  function draw(d) {
    workloadBox.textContent = '';
    if (isOfficer && d.workload !== null && d.workload !== undefined) {
      workloadBox.appendChild(document.createTextNode('งานในมือของฉัน (กำลังตรวจสอบ): '));
      workloadBox.appendChild(h('strong', { testid: 'workload-count', text: d.workload }));
      workloadBox.appendChild(document.createTextNode(' จากสูงสุด 10 เรื่อง'));
    }
    list.textContent = '';
    if (!d.items.length) { list.appendChild(h('p', { testid: 'queue-empty', text: 'ไม่มีงานในคิว' })); return; }
    list.appendChild(h('div', { class: 'table-wrap', role: 'region', 'aria-label': 'ตารางคิวงาน', tabindex: '0' },
      h('table', { class: 'data', testid: 'queue-table' },
        h('thead', null, h('tr', null, ['เลขคำขอ', 'บริการ', 'ผู้ยื่น', 'เลขบัตร', 'สถานะ', 'กำหนดเสร็จ', 'ระดับเตือน', 'ผู้ถือเรื่อง', 'ดำเนินการ'].map(function (t) { return h('th', { scope: 'col', text: t }); }))),
        h('tbody', null, d.items.map(row)))));
  }

  function load() {
    var my = ++seq;
    return EG.api('GET', '/api/officer/queue?filter=' + encodeURIComponent(filter)).then(function (r) {
      if (my !== seq) return; // มีคำขอที่ใหม่กว่าแล้ว
      if (!r.ok) { ST.showError(ST.errText(r)); return; }
      draw(r.body);
    }).catch(function () { if (my === seq) ST.netError(); });
  }
  load();
})();
