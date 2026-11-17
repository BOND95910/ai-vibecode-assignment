// B11 · /notifications · ข้อมูลจาก GET /api/notifications (ข้อความมาจาก API ตรง ๆ)
(function () {
  var EG = window.EG, ST = window.ST, h = EG.h;

  EG.api('GET', '/api/notifications').then(function (r) {
    if (!r.ok) { ST.setView(null); ST.showError(ST.errText(r)); return; }
    if (!r.body.items.length) { ST.setView(h('p', { testid: 'noti-empty', text: 'ไม่มีแจ้งเตือน' })); return; }
    ST.setView(h('ul', { class: 'noti' }, r.body.items.map(function (n) {
      return h('li', { testid: 'noti-item', 'data-case-no': n.caseNo, 'data-level': n.level },
        h('a', { href: '/officer/cases/' + encodeURIComponent(n.caseNo), text: n.text }),
        ST.timeEl(n.createdAt, null));
    })));
  }).catch(function () { ST.setView(null); ST.netError(); });
})();
