// B11 · /admin/users · GET /api/admin/users · PUT /api/admin/users/:username
(function () {
  var EG = window.EG, ST = window.ST, h = EG.h;
  var ROLES = [['citizen', 'ประชาชน'], ['officer', 'เจ้าหน้าที่'], ['head', 'หัวหน้าฝ่าย'], ['executive', 'ผู้บริหาร'], ['auditor', 'ผู้ตรวจสอบภายใน'], ['admin', 'ผู้ดูแลระบบ']];
  var DEPTS = [['', 'ไม่ระบุ'], ['registry', 'ฝ่ายทะเบียน'], ['works', 'ฝ่ายโยธา']];

  function select(testid, label, opts, value) {
    var s = h('select', { testid: testid, 'aria-label': label }, opts.map(function (o) { return h('option', { value: o[0], text: o[1] }); }));
    s.value = value;
    return s;
  }

  function row(u) {
    var role = select('user-role-select', 'บทบาทของ ' + u.username, ROLES, u.role);
    var dept = select('user-dept-select', 'แผนกของ ' + u.username, DEPTS, u.dept || '');
    return h('tr', { testid: 'user-row', 'data-username': u.username },
      h('td', { text: u.username }), h('td', { text: u.name }), h('td', null, role), h('td', null, dept),
      h('td', null, h('button', { type: 'button', class: 'btn', testid: 'user-save-btn', 'aria-label': 'บันทึก ' + u.username, text: 'บันทึก', onclick: function () {
        ST.clearMsg();
        EG.api('PUT', '/api/admin/users/' + encodeURIComponent(u.username), { role: role.value, dept: dept.value }).then(function (r) {
          if (!r.ok) { ST.showError(ST.errText(r)); return; }
          role.value = r.body.role; dept.value = r.body.dept || '';
          ST.showOk('บันทึก ' + u.username + ' แล้ว');
        }).catch(ST.netError);
      } })));
  }

  EG.api('GET', '/api/admin/users').then(function (r) {
    if (!r.ok) { ST.setView(null); ST.showError(ST.errText(r)); return; }
    ST.setView(h('div', { class: 'table-wrap', role: 'region', 'aria-label': 'ตารางผู้ใช้', tabindex: '0' },
      h('table', { class: 'data' },
        h('thead', null, h('tr', null, ['username', 'ชื่อ', 'บทบาท', 'แผนก', 'ดำเนินการ'].map(function (t) { return h('th', { scope: 'col', text: t }); }))),
        h('tbody', null, r.body.items.map(row)))));
  }).catch(function () { ST.setView(null); ST.netError(); });
})();
