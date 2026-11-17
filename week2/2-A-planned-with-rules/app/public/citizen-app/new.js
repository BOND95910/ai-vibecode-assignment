// B10 · /citizen/new/:service ขั้นตอนยื่นคำขอ 3 ขั้น: 1 กรอกข้อมูล · 2 แนบเอกสาร · 3 ชำระเงิน
// ค่าธรรมเนียมคิดทันทีในหน้าด้วยสูตรเดียวกับ server (อัตราจาก SSR boot = ตาราง services ตอนโหลดหน้า) · server คิดซ้ำตอนบันทึกร่าง/สร้าง QR
// ข้อความ error ของไฟล์/ร่าง/ชำระ ใช้ message จาก response ของ API ตรง ๆ
(function () {
  var EG = window.EG, h = EG.h, baht = EG.baht;
  var boot = JSON.parse(document.getElementById('boot').textContent);
  var svc = boot.service, id = svc.id;
  var state = { step: 1, draft: boot.draft, files: [], missing: [], pay: null, dirty: false, saved: null };
  var STEP_TEXT = { 1: '1/3 กรอกข้อมูล', 2: '2/3 แนบเอกสาร', 3: '3/3 ชำระเงิน' };
  var el = {}; // อ้าง element ที่ต้องแก้ภายหลัง
  var pollTimer = null;

  var errBox = function (testid, text, extra) { return h('p', { class: 'msg-error', role: 'alert', testid: testid, id: extra, text: text }); };
  function flash(kind, text) {
    el.flash.textContent = '';
    if (!text) return;
    el.flash.appendChild(kind === 'ok'
      ? h('p', { class: 'msg-ok', role: 'status', testid: 'action-success', text: text })
      : errBox('action-error', text));
  }
  function apiError(r, fallback) { return (r.body && r.body.message) || fallback || 'เกิดข้อผิดพลาด'; }

  // ---------------------------------------------------------------- ขั้น 1: กรอกข้อมูล + ค่าธรรมเนียม
  var parseInt10 = function (s) { return /^\s*-?\d+\s*$/.test(s) ? Number(s) : null; };
  function calc() {
    if (id === 'SV-01') {
      var q = parseInt10(el.qty.value);
      if (q === null || q < 1 || q > 5) return { ok: false, code: 'INVALID_QTY' };
      return { ok: true, value: q, fee: svc.fee * q };
    }
    if (id === 'SV-03') {
      var a = parseInt10(el.area.value);
      if (a === null || a < 1) return { ok: false, code: 'INVALID_AREA' };
      if (a > 500) return { ok: false, code: 'AREA_TOO_LARGE' };
      return { ok: true, value: a, fee: a >= 101 ? svc.feeBase + svc.feePerSqm * (a - 100) : svc.feeBase };
    }
    return { ok: true, value: null, fee: svc.fee };
  }
  function showFeeError(text) {
    el.feeMsg.textContent = '';
    var input = el.qty || el.area;
    if (!text) { if (input) { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); } return; }
    el.feeMsg.appendChild(errBox('fee-error', text, 'fee-error'));
    if (input) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', 'fee-error'); }
  }
  function update() {
    var r = calc();
    el.fee.textContent = r.ok ? baht(r.fee) : '–'; // en dash
    showFeeError(!r.ok && state.dirty ? boot.msgs[r.code] : '');
    el.toUpload.disabled = el.save.disabled = !r.ok;
    return r;
  }

  // บันทึกร่าง (สร้าง/แก้) · คืน true เมื่อสำเร็จ
  async function saveDraft() {
    var r = calc();
    if (!r.ok) { state.dirty = true; update(); return false; }
    var body = id === 'SV-01' ? { qty: r.value } : id === 'SV-03' ? { areaSqm: r.value } : {};
    var res;
    if (!state.draft) {
      res = await EG.api('POST', '/api/drafts', Object.assign({ serviceId: id }, body));
      if (res.ok) {
        state.draft = { draftId: res.body.draftId, status: 'DRAFT', fee: res.body.fee };
        history.replaceState(null, '', location.pathname + '?draft=' + encodeURIComponent(res.body.draftId));
      }
    } else if (state.draft.status === 'DRAFT' && JSON.stringify(body) !== state.saved) {
      res = await EG.api('PUT', '/api/drafts/' + state.draft.draftId, body);
    } else {
      return true; // ไม่มีอะไรเปลี่ยน
    }
    if (!res.ok) {
      if (res.status === 400 && res.body && boot.msgs[res.body.code]) { state.dirty = true; showFeeError(res.body.message); }
      else flash('err', apiError(res));
      return false;
    }
    state.saved = JSON.stringify(body);
    renderDraftId();
    return true;
  }
  function renderDraftId() {
    el.draftLine.textContent = '';
    if (state.draft) el.draftLine.appendChild(h('p', null, 'รหัสร่าง: ', h('strong', { testid: 'draft-id', text: state.draft.draftId })));
  }

  // ---------------------------------------------------------------- ขั้น 2: แนบเอกสาร
  async function refreshDraft() {
    var r = await EG.api('GET', '/api/drafts/' + state.draft.draftId);
    if (!r.ok) { flash('err', apiError(r)); return false; }
    state.draft.status = r.body.status;
    state.draft.fee = r.body.fee;
    state.files = r.body.files || [];
    state.missing = r.body.missing || [];
    renderFiles();
    return true;
  }
  var docName = function (key) {
    for (var i = 0; i < svc.docs.length; i++) if (svc.docs[i].key === key) return svc.docs[i].name;
    return key === 'extra' ? 'เอกสารเพิ่มเติม' : key;
  };
  function renderFiles() {
    el.fileList.textContent = '';
    state.files.forEach(function (f) {
      el.fileList.appendChild(h('li', { testid: 'file-item', 'data-name': f.name, 'data-doc-key': f.docKey, 'data-file-id': f.fileId },
        h('span', { class: 'lbl', text: docName(f.docKey) }),
        h('span', { text: f.name + ' (' + Math.max(1, Math.round(f.size / 1024)) + ' KB)' }),
        h('button', { type: 'button', class: 'btn secondary', testid: 'file-remove-btn', 'aria-label': 'ลบไฟล์ ' + f.name, text: 'ลบ',
          onclick: function () { removeFile(f); } })));
    });
    el.missingBox.textContent = '';
    if (state.missing.length) el.missingBox.appendChild(h('p', { class: 'msg-warn', testid: 'missing-docs', text: 'ยังขาดเอกสาร: ' + state.missing.join(', ') }));
    el.toPay.disabled = state.missing.length > 0;
  }
  async function removeFile(f) {
    flash();
    var r = await EG.api('DELETE', '/api/drafts/' + state.draft.draftId + '/files/' + encodeURIComponent(f.fileId));
    if (!r.ok && r.status !== 404) flash('err', apiError(r));
    await refreshDraft();
  }
  async function uploadFiles(docKey, input) {
    var list = Array.prototype.slice.call(input.files || []);
    input.value = ''; // เลือกไฟล์เดิมซ้ำได้
    el.uploadMsg.textContent = '';
    flash();
    var lastError = '';
    for (var i = 0; i < list.length; i++) { // ทีละไฟล์ตามลำดับ (ไฟล์ที่ถูกปฏิเสธไม่เพิ่มรายการ)
      var fd = new FormData();
      fd.append('docKey', docKey);
      fd.append('file', list[i]);
      var r = await EG.api('POST', '/api/drafts/' + state.draft.draftId + '/files', fd);
      if (!r.ok) lastError = apiError(r);
    }
    await refreshDraft();
    if (lastError) el.uploadMsg.appendChild(errBox('upload-error', lastError));
  }

  // ---------------------------------------------------------------- ขั้น 3: ชำระเงิน
  var payKey = null; // null = ยังไม่เคยวาด
  function renderPay() {
    var p = state.pay;
    var key = p ? p.ref + '|' + p.status : '';
    el.payAmount.textContent = baht(p && p.amount != null ? p.amount : state.draft ? state.draft.fee : 0);
    if (key === payKey) return;
    payKey = key;
    el.payArea.textContent = '';
    el.refresh.hidden = !p;
    if (!p) {
      el.payArea.appendChild(h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn secondary', 'data-role': 'back', text: 'ย้อนกลับ', onclick: function () { go(2); } }),
        h('button', { type: 'button', class: 'btn', testid: 'create-qr-btn', text: 'สร้าง QR', onclick: createQr })));
      return;
    }
    var statusTh = { PENDING: 'รอชำระ', PAID: 'ชำระแล้ว', EXPIRED: 'QR หมดอายุ' }[p.status] || p.status;
    var nodes = [h('p', null, 'สถานะ: ', h('span', { class: 'badge', testid: 'payment-status', 'data-status': p.status, text: statusTh }))];
    if (p.status === 'PAID') {
      nodes.push(
        h('div', { class: 'card' },
          h('h3', { text: 'ใบเสร็จรับเงิน' }),
          h('dl', { class: 'kv' },
            h('dt', { text: 'เลขคำขอ' }), h('dd', { testid: 'submitted-case-no', text: p.caseNo }),
            h('dt', { text: 'เลขใบเสร็จ' }), h('dd', { testid: 'receipt-no', text: p.receiptNo }),
            h('dt', { text: 'ยอดชำระ' }), h('dd', { testid: 'receipt-amount', text: baht(p.amount) }),
            h('dt', { text: 'เวลาชำระ' }), h('dd', null, h('time', { testid: 'receipt-paid-at', 'data-iso': p.paidAt, datetime: p.paidAt, text: EG.thaiDateTime(p.paidAt) })))),
        h('div', { class: 'actions' }, h('a', { class: 'btn', testid: 'go-case-btn', href: '/citizen/cases/' + encodeURIComponent(p.caseNo), text: 'ดูคำขอ' })));
    } else {
      nodes.push(h('p', null, 'เลขอ้างอิง: ', h('strong', { testid: 'qr-ref', text: p.ref })));
      nodes.push(h('p', null, h('time', { testid: 'qr-expires', 'data-iso': p.qrExpiresAt, datetime: p.qrExpiresAt, text: 'หมดอายุ ' + EG.thaiDateTime(p.qrExpiresAt) })));
      if (p.status === 'EXPIRED') {
        nodes.push(errBox('qr-expired-msg', 'QR หมดอายุ กรุณาสร้าง QR ใหม่'),
          h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', testid: 'regenerate-qr-btn', text: 'สร้าง QR ใหม่', onclick: createQr })));
      } else {
        nodes.unshift(EG.fakeQr(p.ref, 'QR พร้อมเพย์จำลอง เลขอ้างอิง ' + p.ref, 'qr-image'));
        nodes.push(h('p', { class: 'hint', text: 'ระบบจำลอง: ธนาคารจำลองจะแจ้งผลชำระเงินเข้ามา แล้วกด "ตรวจสอบการชำระเงิน"' }));
      }
    }
    el.payArea.appendChild(h('div', null, nodes));
  }
  async function createQr() {
    flash();
    var r = await EG.api('POST', '/api/drafts/' + state.draft.draftId + '/payment');
    if (!r.ok) {
      if (r.body && r.body.code === 'MISSING_DOCS') { await refreshDraft(); go(2); }
      flash('err', apiError(r));
      return;
    }
    state.draft.status = 'PENDING_PAYMENT';
    state.pay = { ref: r.body.ref, amount: r.body.amount, qrCreatedAt: r.body.qrCreatedAt, qrExpiresAt: r.body.qrExpiresAt, status: 'PENDING' };
    renderPay();
    startPoll();
  }
  async function checkPay() {
    if (!state.pay) return;
    var r = await EG.api('GET', '/api/payments/' + encodeURIComponent(state.pay.ref));
    if (r.ok) {
      state.pay = r.body;
      renderPay();
      if (r.body.status === 'PAID') state.draft.status = 'SUBMITTED';
      if (r.body.status !== 'PENDING') stopPoll();
    } else if (r.status === 404) { state.pay = null; stopPoll(); renderPay(); }
  }
  function startPoll() { stopPoll(); pollTimer = setInterval(checkPay, 3000); }
  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  // ---------------------------------------------------------------- สลับขั้น
  function go(n, noFocus) {
    state.step = n;
    el.s1.hidden = n !== 1; el.s2.hidden = n !== 2; el.s3.hidden = n !== 3;
    document.querySelector('[data-testid="wizard-step"]').textContent = STEP_TEXT[n];
    var head = [el.s1, el.s2, el.s3][n - 1].querySelector('h2');
    head.tabIndex = -1;
    if (!noFocus) head.focus(); // ย้ายโฟกัสไปหัวข้อขั้นใหม่ (ผู้ใช้คีย์บอร์ด/โปรแกรมอ่านจอ)
    if (n === 3) renderPay();
  }
  async function toUpload() {
    flash();
    if (!(await saveDraft())) return;
    if (!(await refreshDraft())) return;
    go(2);
  }

  // ---------------------------------------------------------------- สร้างหน้า (ครั้งเดียว)
  function build() {
    var wiz = document.getElementById('wizard');
    el.flash = h('div', { id: 'flash' });
    el.draftLine = h('div');

    // ขั้น 1
    var d = state.draft;
    el.feeMsg = h('div');
    el.fee = h('strong', { testid: 'fee-total', text: '–' });
    var fields = [];
    if (id === 'SV-01') {
      el.qty = h('input', { type: 'text', id: 'qty-input', testid: 'qty-input', inputmode: 'numeric', autocomplete: 'off', value: d && d.qty != null ? String(d.qty) : '1' });
      fields.push(h('div', { class: 'field' }, h('label', { for: 'qty-input', text: 'จำนวนฉบับ (1–5 ฉบับ)' }), el.qty));
    } else if (id === 'SV-03') {
      el.area = h('input', { type: 'text', id: 'area-input', testid: 'area-input', inputmode: 'numeric', autocomplete: 'off', value: d && d.areaSqm != null ? String(d.areaSqm) : '' });
      fields.push(h('div', { class: 'field' }, h('label', { for: 'area-input', text: 'พื้นที่อาคาร (ตร.ม. 1–500)' }), el.area));
    } else {
      fields.push(h('p', { text: 'บริการนี้ไม่ต้องกรอกข้อมูลเพิ่ม' }));
    }
    var onInput = function () { state.dirty = true; update(); };
    if (el.qty) el.qty.addEventListener('input', onInput);
    if (el.area) el.area.addEventListener('input', onInput);
    el.save = h('button', { type: 'button', class: 'btn secondary', testid: 'save-draft-btn', text: 'บันทึกร่าง',
      onclick: async function () { flash(); if (await saveDraft()) flash('ok', 'บันทึกร่างแล้ว'); } });
    el.toUpload = h('button', { type: 'button', class: 'btn', testid: 'to-upload-btn', text: 'ไปขั้นแนบเอกสาร', onclick: toUpload });
    el.s1 = h('section', { 'aria-labelledby': 'h-s1' },
      h('h2', { id: 'h-s1', text: 'กรอกข้อมูลคำขอ' }), fields,
      h('p', { 'aria-live': 'polite' }, 'ค่าธรรมเนียม: ', el.fee), el.feeMsg,
      h('div', { class: 'actions' }, el.save, el.toUpload));

    // ขั้น 2
    el.uploadMsg = h('div');
    el.fileList = h('ul', { class: 'rows', 'aria-label': 'ไฟล์ที่แนบแล้ว' });
    el.missingBox = h('div');
    var docs = svc.docs.concat([{ key: 'extra', name: 'เอกสารเพิ่มเติม', required: false }]);
    var inputs = docs.map(function (x) {
      var inpId = 'upload-input-' + x.key;
      var label = x.name + (x.required ? ' ✱' : '') + (x.pdfOnly ? ' (PDF เท่านั้น)' : '');
      var input = h('input', { type: 'file', id: inpId, testid: inpId, accept: x.pdfOnly ? '.pdf,application/pdf' : '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png', multiple: x.key === 'extra' });
      input.addEventListener('change', function () { uploadFiles(x.key, input); });
      return h('div', { class: 'field' },
        h('label', { for: inpId }, label, ' ', h('span', { class: 'req', text: x.key === 'extra' ? '(ไม่บังคับ เลือกได้หลายไฟล์)' : x.required ? '(จำเป็น)' : '(ไม่บังคับ)' })), input);
    });
    el.toPay = h('button', { type: 'button', class: 'btn', testid: 'to-payment-btn', text: 'ไปชำระเงิน', disabled: true, onclick: function () { go(3); } });
    el.s2 = h('section', { 'aria-labelledby': 'h-s2', hidden: true },
      h('h2', { id: 'h-s2', text: 'แนบเอกสาร' }),
      h('p', { class: 'hint', text: 'รับไฟล์ PDF, JPG, PNG ไม่เกิน 5 MB ต่อไฟล์ รวมไม่เกิน 5 ไฟล์ · ✱ = เอกสารบังคับ' }),
      inputs, el.uploadMsg, el.fileList, el.missingBox,
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn secondary', text: 'ย้อนกลับ', onclick: function () { go(1); } }), el.toPay));

    // ขั้น 3
    el.payAmount = h('strong', { testid: 'payment-amount', text: baht(d ? d.fee : 0) });
    el.payArea = h('div');
    el.refresh = h('button', { type: 'button', class: 'btn secondary', testid: 'refresh-payment-btn', text: 'ตรวจสอบการชำระเงิน', hidden: true, onclick: checkPay });
    el.s3 = h('section', { 'aria-labelledby': 'h-s3', hidden: true },
      h('h2', { id: 'h-s3', text: 'ชำระเงินด้วย QR' }),
      h('p', null, 'ยอดที่ต้องชำระ: ', el.payAmount), el.payArea,
      h('div', { class: 'actions' }, el.refresh));

    wiz.appendChild(el.flash); wiz.appendChild(el.draftLine);
    wiz.appendChild(el.s1); wiz.appendChild(el.s2); wiz.appendChild(el.s3);
    if (d) { state.saved = JSON.stringify(id === 'SV-01' ? { qty: d.qty } : id === 'SV-03' ? { areaSqm: d.areaSqm } : {}); renderDraftId(); }
    update();
    state.dirty = false;
  }

  async function init() {
    build();
    go(1, true);
    if (!state.draft) return;
    if (!(await refreshDraft())) return;
    if (state.draft.status === 'DRAFT') return;
    // PENDING_PAYMENT / SUBMITTED: ไปขั้นชำระ พร้อมสถานะ QR ล่าสุดของร่างนี้
    if (boot.latestRef) { state.pay = { ref: boot.latestRef, status: 'PENDING' }; await checkPay(); if (state.pay && state.pay.status === 'PENDING') startPoll(); }
    go(3, true);
  }
  init();
})();
