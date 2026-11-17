// B11 · /head/approvals · ข้อมูลจาก GET /api/head/approvals
(function () {
  var EG = window.EG, ST = window.ST, h = EG.h;

  function row(it) {
    return h('tr', { testid: 'approval-row', 'data-case-no': it.caseNo },
      h('td', { testid: 'row-case-no', text: it.caseNo }),
      h('td', { testid: 'row-service', text: ST.svcLabel(it.serviceId) }),
      h('td', { testid: 'row-applicant', text: it.applicantName }),
      h('td', null, ST.timeEl(it.dueAt, 'row-due')),
      h('td', null, h('a', { class: 'btn secondary', testid: 'approval-open', href: '/officer/cases/' + encodeURIComponent(it.caseNo), 'aria-label': 'เปิดคำขอ ' + it.caseNo, text: 'เปิดคำขอ' })));
  }

  EG.api('GET', '/api/head/approvals').then(function (r) {
    if (!r.ok) { ST.setView(null); ST.showError(ST.errText(r)); return; }
    if (!r.body.items.length) { ST.setView(h('p', { testid: 'approval-empty', text: 'ไม่มีรายการรออนุมัติ' })); return; }
    ST.setView(h('div', { class: 'table-wrap', role: 'region', 'aria-label': 'ตารางรออนุมัติ', tabindex: '0' },
      h('table', { class: 'data' },
        h('thead', null, h('tr', null, ['เลขคำขอ', 'บริการ', 'ผู้ยื่น', 'กำหนดเสร็จ', 'ดำเนินการ'].map(function (t) { return h('th', { scope: 'col', text: t }); }))),
        h('tbody', null, r.body.items.map(row)))));
  }).catch(function () { ST.setView(null); ST.netError(); });
})();
