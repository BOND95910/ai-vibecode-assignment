// B11 · /officer/cases/:caseNo · รายละเอียดคำขอ + ปุ่มดำเนินการ (render ตาม can{} จาก GET /api/cases/:caseNo เท่านั้น)
(function () {
  var EG = window.EG, ST = window.ST, h = EG.h;
  var caseNo = ST.boot.caseNo;
  var base = '/api/officer/cases/' + encodeURIComponent(caseNo);
  var cur = null;
  // สถานะของหน้า (ไม่เก็บเลขเต็มไว้ที่อื่น: โหลดหน้าใหม่ = ปิดบังตามเดิม)
  var ui = { ret: false, rej: false, unmask: false, fullId: null, busy: false, focus: null };

  function setDisabled(flag) {
    var v = ST.view();
    if (v) v.querySelectorAll('button').forEach(function (b) { b.disabled = flag; });
  }

  // ยิง POST แล้วโหลดคำขอใหม่ · inline(r) คืน true = แสดงข้อผิดพลาดในฟอร์มแล้ว (ไม่โหลดใหม่ ฟอร์มและข้อความที่พิมพ์ค้างไว้)
  function run(path, body, inline) {
    if (ui.busy) return;
    ui.busy = true; ST.clearMsg(); setDisabled(true);
    EG.api('POST', path, body).then(function (r) {
      ui.busy = false;
      if (!r.ok && inline && inline(r)) { setDisabled(false); return; }
      ui.ret = ui.rej = ui.unmask = false;
      return load().then(function () { if (r.ok) ST.showOk('ดำเนินการสำเร็จ'); else ST.showError(ST.errText(r)); });
    }).catch(function () { ui.busy = false; setDisabled(false); ST.netError(); });
  }

  function load() {
    return EG.api('GET', '/api/cases/' + encodeURIComponent(caseNo)).then(function (r) {
      if (!r.ok) { ST.setView(null); ST.showError(ST.errText(r)); return; }
      cur = r.body; draw();
    });
  }

  function open(which) {
    ui.ret = which === 'ret'; ui.rej = which === 'rej'; ui.unmask = which === 'unmask';
    ui.focus = { ret: 'return-reason', rej: 'reject-reason', unmask: 'unmask-reason' }[which];
    draw();
  }

  // กล่องเหตุผล (ตีกลับ / ไม่อนุมัติ / แสดงเลขเต็ม): ข้อผิดพลาดแสดงใต้ช่อง ข้อความมาจาก API
  function reasonCard(o) {
    var ta = o.input ? h('input', { type: 'text', id: o.id, testid: o.ta, autocomplete: 'off' }) : h('textarea', { id: o.id, testid: o.ta, rows: '3' });
    var errBox = h('div');
    function showInline(msg) { errBox.textContent = ''; errBox.appendChild(h('p', { class: 'msg-error', testid: o.err, role: 'alert', text: msg })); }
    return h('div', { class: 'card reason-box' },
      ST.field(o.id, o.label, ta), errBox,
      h('button', { type: 'button', class: 'btn ' + (o.cls || ''), testid: o.submit, text: o.btnText, onclick: function () { errBox.textContent = ''; o.send(ta.value, showInline); } }));
  }

  function btn(testid, text, cls, fn) { return h('button', { type: 'button', class: 'btn ' + cls, testid: testid, onclick: fn, text: text }); }
  function card(title, id) {
    var nodes = [].slice.call(arguments, 2);
    return h('section', { class: 'card', 'aria-labelledby': id }, h('h2', { id: id, text: title }), nodes);
  }

  function draw() {
    var c = cur, can = c.can || {};
    var kv = h('dl', { class: 'kv' });
    function add(label, node) { kv.appendChild(h('dt', { text: label })); kv.appendChild(h('dd', null, node)); }
    add('บริการ', h('span', { testid: 'case-service', text: c.serviceId + ' ' + c.serviceName }));
    if (c.stepLabel) add('ขั้นตอน', h('span', { testid: 'case-step', text: c.stepLabel }));
    add('สถานะ', ST.statusBadge(c.status, 'case-status'));
    add('ค่าธรรมเนียม', h('span', { testid: 'case-fee', text: EG.baht(c.fee) }));
    if (c.qty !== null && c.qty !== undefined) add('จำนวนฉบับ', String(c.qty));
    if (c.areaSqm !== null && c.areaSqm !== undefined) add('พื้นที่ (ตร.ม.)', String(c.areaSqm));
    add('ผู้ยื่น', h('span', { testid: 'applicant-name', text: c.applicantName }));
    add('เลขบัตรประชาชน', [
      h('span', { testid: 'applicant-id', text: c.idMasked }), ' ',
      can.unmask && !ui.fullId ? h('button', { type: 'button', class: 'btn secondary', testid: 'show-full-id-btn', text: 'แสดงเลขเต็ม', onclick: function () { open('unmask'); } }) : null,
      ui.fullId ? h('span', { testid: 'full-id', text: ui.fullId }) : null,
    ]);
    add('กำหนดเสร็จ', ST.timeEl(c.dueAt, 'sla-due'));
    add('ระดับเตือน', ST.levelBadge(c.slaLevel, 'sla-level'));
    add('ผู้ถือเรื่อง', h('span', { testid: 'case-owner', text: c.owner || 'ยังไม่มีผู้รับ' }));
    add('ตีกลับแล้ว (ครั้ง)', h('span', { testid: 'return-count', text: c.returnCount }));
    if (c.returnReason) add('เหตุผลตีกลับล่าสุด', c.returnReason);
    if (c.status === 'NEED_FIX' && c.fixDeadline) add('เส้นตายแก้ไข', ST.timeEl(c.fixDeadline, null));
    if (c.rejectReason) add('เหตุผลไม่อนุมัติ', c.rejectReason);
    if ((c.status === 'COMPLETED' || c.status === 'REJECTED') && c.closedAt) add('ปิดงานเมื่อ', ST.timeEl(c.closedAt, 'closed-at'));

    var files = c.files || [];
    var docs = files.length
      ? h('ul', { class: 'files' }, files.map(function (f) {
        return h('li', { testid: 'doc-item', 'data-name': f.name, 'data-file-id': f.fileId },
          h('a', { testid: 'doc-download-link', href: '/api/files/' + encodeURIComponent(f.fileId), target: '_blank', rel: 'noopener', text: f.name }));
      }))
      : h('p', { text: 'ไม่มีไฟล์แนบที่เปิดดูได้' });

    var issued = null;
    var d = c.document;
    if (d) {
      var qr = EG.fakeQr(d.verifyCode, 'QR ตรวจสอบเอกสาร ' + d.docNo, 'doc-qr');
      qr.setAttribute('data-url', d.verifyUrl);
      issued = card('เอกสารที่ออก', 'h-doc', h('dl', { class: 'kv' },
        h('dt', { text: 'เลขเอกสาร' }), h('dd', { testid: 'doc-no', text: d.docNo }),
        h('dt', { text: 'รหัสตรวจสอบ' }), h('dd', { testid: 'verify-code', text: d.verifyCode })),
      h('div', { class: 'qr-box' }, qr, h('a', { href: '/verify/' + encodeURIComponent(d.verifyCode), text: 'เปิดหน้าตรวจสอบเอกสาร' })));
    }

    // ปุ่มดำเนินการ: ไม่มีสิทธิ์ = ไม่ render เลย
    var acts = [];
    if (can.claim) acts.push(btn('claim-btn', 'รับเรื่อง', '', function () { run(base + '/claim'); }));
    if (can.return) acts.push(btn('return-btn', 'ตีกลับ', 'secondary', function () { open('ret'); }));
    if (can.forward) acts.push(btn('forward-btn', 'ผ่าน/ส่งต่อ', '', function () { run(base + '/forward', { note: document.getElementById('forward-note').value }); }));
    if (can.approve) acts.push(btn('approve-btn', 'อนุมัติ', '', function () { run('/api/cases/' + encodeURIComponent(caseNo) + '/approve'); }));
    if (can.reject) acts.push(btn('reject-btn', 'ไม่อนุมัติ', 'danger', function () { open('rej'); }));
    if (can.issue) acts.push(btn('issue-btn', 'ออกเอกสาร', '', function () { run(base + '/issue'); }));

    var forms = [];
    if (ui.ret && can.return) {
      forms.push(reasonCard({
        id: 'return-reason', ta: 'return-reason', err: 'return-reason-error', submit: 'return-submit', btnText: 'ยืนยันตีกลับ',
        label: 'เหตุผลที่ตีกลับ (อย่างน้อย 10 ตัวอักษร)',
        send: function (reason, showInline) {
          run(base + '/return', { reason: reason }, function (r) { if (r.body && r.body.code === 'REASON_TOO_SHORT') { showInline(ST.errText(r)); return true; } });
        },
      }));
    }
    if (ui.rej && can.reject) {
      forms.push(reasonCard({
        id: 'reject-reason', ta: 'reject-reason', err: 'reject-reason-error', submit: 'reject-submit', btnText: 'ยืนยันไม่อนุมัติ', cls: 'danger',
        label: 'เหตุผลที่ไม่อนุมัติ (อย่างน้อย 10 ตัวอักษร)',
        send: function (reason, showInline) {
          run('/api/cases/' + encodeURIComponent(caseNo) + '/reject', { reason: reason }, function (r) { if (r.body && r.body.code === 'REASON_TOO_SHORT') { showInline(ST.errText(r)); return true; } });
        },
      }));
    }
    if (ui.unmask && can.unmask && !ui.fullId) {
      forms.push(reasonCard({
        id: 'unmask-reason', ta: 'unmask-reason', err: 'unmask-error', submit: 'unmask-submit', btnText: 'ยืนยันแสดงเลขเต็ม', input: true,
        label: 'เหตุผลในการแสดงเลขบัตรเต็ม (บันทึกใน Audit)',
        send: function (reason, showInline) {
          if (ui.busy) return;
          ui.busy = true; setDisabled(true);
          EG.api('POST', base + '/unmask', { reason: reason }).then(function (r) {
            ui.busy = false;
            if (r.ok) { ui.fullId = EG.formatId(r.body.idNo); ui.unmask = false; ST.clearMsg(); draw(); return; }
            if (r.body && r.body.code === 'REASON_REQUIRED') { setDisabled(false); showInline(ST.errText(r)); return; }
            ui.unmask = false;
            return load().then(function () { ST.showError(ST.errText(r)); });
          }).catch(function () { ui.busy = false; setDisabled(false); ST.netError(); });
        },
      }));
    }

    var actions = null;
    if (acts.length || forms.length) {
      actions = card('ดำเนินการ', 'h-act',
        can.forward ? ST.field('forward-note', 'หมายเหตุส่งต่อ (ไม่บังคับ)', h('input', { type: 'text', id: 'forward-note', testid: 'forward-note', autocomplete: 'off', maxlength: '500' })) : null,
        h('div', { class: 'actions' }, acts), forms);
    }

    var timeline = card('ไทม์ไลน์', 'h-tl', h('ol', { class: 'timeline', testid: 'case-timeline' }, (c.timeline || []).map(function (t) {
      return h('li', { testid: 'timeline-item', 'data-iso': t.time }, EG.thaiDateTime(t.time) + ' · ' + t.text + (t.actor ? ' (โดย ' + t.actor + ')' : ''));
    })));

    ST.setView([card('ข้อมูลคำขอ', 'h-info', kv), card('เอกสารแนบ', 'h-files', docs), issued, actions, timeline]);
    if (ui.focus) { var f = document.getElementById(ui.focus); ui.focus = null; if (f) f.focus(); }
  }

  load().catch(function () { ST.setView(null); ST.netError(); });
})();
