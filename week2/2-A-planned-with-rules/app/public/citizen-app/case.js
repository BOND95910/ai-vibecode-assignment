// B10 · /citizen/cases/:caseNo รายละเอียดคำขอ (ข้อมูลจาก GET /api/cases/:caseNo · CONTRACT 6.7 + 2.6)
// ฟิลด์จาก B08 (เกินจาก 6.7): can{cancel,resubmit} timeline[]{time,text,kind} files[] returnReason serviceName stepLabel document{verifyUrl}
// ค่าสำรองถ้า API ไม่ส่ง: can จากสถานะ · ชื่อบริการจาก boot · ไฟล์จาก GET /api/cases/:caseNo/files
(function () {
  var EG = window.EG, h = EG.h, baht = EG.baht;
  var boot = JSON.parse(document.getElementById('boot').textContent);
  var no = boot.caseNo, base = '/api/cases/' + encodeURIComponent(no);
  var body = document.getElementById('case-body'), flashBox = document.getElementById('flash');

  var KIND_TH = { PAID: 'ชำระค่าธรรมเนียม', SUBMITTED: 'ส่งคำขอแล้ว', CLAIM: 'เจ้าหน้าที่รับเรื่อง', RETURN: 'ตีกลับให้แก้ไขเอกสาร', RESUBMIT: 'ส่งแก้ไขเอกสาร', FORWARD: 'ส่งต่อขั้นถัดไป', APPROVE: 'อนุมัติ', REJECT: 'ไม่อนุมัติ', ISSUE: 'ออกเอกสาร', CANCEL: 'ยกเลิกคำขอ', AUTO_CANCEL: 'ระบบยกเลิกเนื่องจากเลยเวลาแก้ไข' };

  function flash(kind, text) {
    flashBox.textContent = '';
    if (!text) return;
    flashBox.appendChild(kind === 'ok'
      ? h('p', { class: 'msg-ok', role: 'status', testid: 'action-success', text: text })
      : h('p', { class: 'msg-error', role: 'alert', testid: 'action-error', text: text }));
  }
  var apiError = function (r) { return (r.body && r.body.message) || 'เกิดข้อผิดพลาด'; };
  var row = function (dt, dd) { return [h('dt', { text: dt }), dd]; };

  async function load() {
    var r = await EG.api('GET', base);
    if (r.status === 404) {
      body.textContent = '';
      body.appendChild(h('p', { testid: 'not-found-msg', text: 'ไม่พบคำขอ' }));
      return;
    }
    if (!r.ok) { body.textContent = ''; body.appendChild(h('p', { class: 'msg-error', role: 'alert', text: apiError(r) })); return; }
    var c = r.body;
    var files = c.files;
    if (!Array.isArray(files)) {
      var fr = await EG.api('GET', base + '/files');
      files = fr.ok && fr.body ? fr.body.items || [] : [];
    }
    render(c, files);
  }

  function render(c, files) {
    var status = c.status;
    var can = c.can || {};
    var canCancel = can.cancel !== undefined ? !!can.cancel : status === 'SUBMITTED' && !c.owner;
    var canFix = can.resubmit !== undefined ? !!can.resubmit : status === 'NEED_FIX';
    var svcName = c.serviceName || boot.services[c.serviceId] || '';
    var kv = [];
    kv.push(row('สถานะ', h('dd', null, h('span', { class: 'badge', testid: 'case-status', 'data-status': status, text: EG.STATUS_TH[status] || status }))));
    kv.push(row('บริการ', h('dd', { testid: 'case-service', text: c.serviceId + ' ' + svcName })));
    if (c.serviceId === 'SV-03' && c.step) kv.push(row('ขั้นตอน', h('dd', { testid: 'case-step', text: c.stepLabel || 'ขั้นตอน ' + c.step + '/3 · ' + (EG.STEP_TH[c.step] || '') })));
    kv.push(row('ค่าธรรมเนียม', h('dd', { testid: 'case-fee', text: baht(c.fee) })));
    kv.push(row('กำหนดเสร็จ', h('dd', null, h('time', { testid: 'sla-due', 'data-iso': c.dueAt, datetime: c.dueAt, text: EG.thaiDateTime(c.dueAt) }))));
    kv.push(row('ระดับเตือน', h('dd', null, h('span', { class: 'badge', testid: 'sla-level', 'data-level': c.slaLevel, text: EG.LEVEL_TH[c.slaLevel] || c.slaLevel }))));
    if ((status === 'COMPLETED' || status === 'REJECTED') && c.closedAt) {
      kv.push(row('ปิดงานเมื่อ', h('dd', null, h('time', { testid: 'closed-at', 'data-iso': c.closedAt, datetime: c.closedAt, text: EG.thaiDateTime(c.closedAt) }))));
    }
    if (c.idNo) kv.push(row('เลขบัตรประชาชน', h('dd', { testid: 'case-id-full', text: c.idFormatted || EG.formatId(c.idNo) })));

    var out = [h('h2', { id: 'h-sum', text: 'สรุปคำขอ' }), h('dl', { class: 'kv', 'aria-labelledby': 'h-sum' }, kv)];

    // รอแก้ไข: เหตุผล + เส้นตาย + ส่งแก้ไข
    if (status === 'NEED_FIX') {
      var fixInput = h('input', { type: 'file', id: 'fix-upload-input', testid: 'fix-upload-input', multiple: true, accept: '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png' });
      out.push(h('h2', { id: 'h-fix', text: 'ต้องแก้ไขเอกสาร' }),
        h('div', { class: 'card', 'aria-labelledby': 'h-fix' },
          c.returnReason ? h('p', null, 'เหตุผลที่ตีกลับ: ', h('strong', { testid: 'return-reason-display', text: c.returnReason })) : null,
          c.fixDeadline ? h('p', null, 'ส่งแก้ไขภายใน: ', h('time', { testid: 'fix-deadline', 'data-iso': c.fixDeadline, datetime: c.fixDeadline, text: EG.thaiDateTime(c.fixDeadline) })) : null,
          canFix ? h('div', { class: 'field' }, h('label', { for: 'fix-upload-input', text: 'แนบไฟล์ใหม่ (ไม่บังคับ)' }), fixInput) : null,
          canFix ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', testid: 'submit-fix-btn', text: 'ส่งแก้ไข', onclick: function () { submitFix(fixInput); } })) : null));
    }

    if (status === 'REJECTED' || status === 'CANCELLED') {
      out.push(h('p', { class: 'msg-warn', testid: 'no-refund-note', text: 'ค่าธรรมเนียมที่ชำระแล้วไม่คืน' }));
    }

    // ยกเลิก (เฉพาะ SUBMITTED ที่ยังไม่มีผู้รับ) + กล่องยืนยัน
    if (canCancel) {
      var confirmBox = h('div', { class: 'card', role: 'group', 'aria-label': 'ยืนยันการยกเลิก', hidden: true },
        h('p', { class: 'msg-warn', testid: 'cancel-confirm-text', text: 'ค่าธรรมเนียมที่ชำระแล้วไม่คืน' }),
        h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'btn danger', testid: 'confirm-cancel-btn', text: 'ยืนยันยกเลิกคำขอ', onclick: doCancel }),
          h('button', { type: 'button', class: 'btn secondary', text: 'ไม่ยกเลิก', onclick: function () { confirmBox.hidden = true; cancelBtn.focus(); } })));
      var cancelBtn = h('button', { type: 'button', class: 'btn danger', testid: 'cancel-case-btn', text: 'ยกเลิกคำขอ',
        onclick: function () { flash(); confirmBox.hidden = false; confirmBox.querySelector('[data-testid="confirm-cancel-btn"]').focus(); } });
      out.push(h('div', { class: 'actions' }, cancelBtn), confirmBox);
    }

    // เอกสารดิจิทัลที่ออกแล้ว
    if (c.docNo) {
      var vUrl = (c.document && c.document.verifyUrl) || boot.baseUrl + '/verify/' + c.verifyCode;
      out.push(h('h2', { id: 'h-doc', text: 'เอกสารที่ออกให้' }),
        h('div', { class: 'card', 'aria-labelledby': 'h-doc' },
          h('dl', { class: 'kv' },
            h('dt', { text: 'เลขเอกสาร' }), h('dd', { testid: 'doc-no', text: c.docNo }),
            h('dt', { text: 'รหัสตรวจสอบ' }), h('dd', { testid: 'verify-code', text: c.verifyCode })),
          h('div', { testid: 'doc-qr', 'data-url': vUrl },
            EG.fakeQr(vUrl, 'QR ตรวจสอบเอกสาร ' + c.verifyCode),
            h('p', { class: 'hint' }, 'สแกนหรือเปิด ', h('a', { href: '/verify/' + c.verifyCode, text: vUrl }), ' เพื่อตรวจสอบเอกสาร')),
          h('div', { class: 'actions' }, h('a', { class: 'btn', testid: 'download-doc-btn', href: '/api/documents/' + encodeURIComponent(c.docNo) + '/pdf', download: c.docNo + '.pdf', text: 'ดาวน์โหลดเอกสาร' }))));
    }

    // ไฟล์แนบ
    out.push(h('h2', { id: 'h-files', text: 'เอกสารแนบ' }));
    out.push(files.length
      ? h('ul', { class: 'rows', 'aria-labelledby': 'h-files' }, files.map(function (f) {
        return h('li', { testid: 'doc-item', 'data-name': f.name, 'data-file-id': f.fileId },
          h('span', { text: f.name }),
          h('a', { testid: 'doc-download-link', href: '/api/files/' + encodeURIComponent(f.fileId), download: f.name, 'aria-label': 'ดาวน์โหลด ' + f.name, text: 'ดาวน์โหลด' }));
      }))
      : h('p', { text: 'ไม่มีเอกสารแนบ' }));

    // ไทม์ไลน์
    var tl = c.timeline || [];
    out.push(h('h2', { id: 'h-tl', text: 'ความคืบหน้า' }),
      h('ol', { class: 'timeline', testid: 'case-timeline', 'aria-labelledby': 'h-tl' }, tl.map(function (e) {
        var t = e.time || e.at || e.createdAt;
        return h('li', { testid: 'timeline-item', 'data-iso': t },
          h('time', { datetime: t, text: EG.thaiDateTime(t) }), ' · ', e.text || KIND_TH[e.kind] || e.kind || '');
      })));

    body.textContent = '';
    body.appendChild(h('div', null, out));
  }

  async function doCancel() {
    flash();
    var r = await EG.api('POST', base + '/cancel');
    if (!r.ok) flash('err', apiError(r));
    await load(); // สถานะล่าสุด (สำเร็จ = ยกเลิก · ล้มเหลว = ปุ่มยกเลิกหาย)
  }
  async function submitFix(input) {
    flash();
    var list = Array.prototype.slice.call(input.files || []);
    var opts;
    if (list.length) {
      var fd = new FormData();
      fd.append('docKey', 'extra');
      list.forEach(function (f) { fd.append('file', f); });
      opts = fd;
    }
    var r = await EG.api('POST', base + '/resubmit', opts);
    if (r.ok) flash('ok', 'ส่งแก้ไขเรียบร้อยแล้ว');
    else flash('err', apiError(r));
    await load();
  }

  load();
})();
