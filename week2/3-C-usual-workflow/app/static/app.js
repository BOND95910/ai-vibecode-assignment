(() => {
  'use strict';
  const $ = id => document.querySelector(`[data-testid="${id}"]`);
  const byId = id => document.getElementById(id);
  const data = JSON.parse(byId('page-data')?.textContent || '{}');
  const TH_M = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  const thDate = iso => { const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return `${d} ${TH_M[m - 1]} ${y + 543} ${iso.slice(11, 16)}`; };
  const money = n => '฿' + Number(n).toLocaleString('en-US');
  const fmtId = s => `${s[0]}-${s.slice(1, 5)}-${s.slice(5, 10)}-${s.slice(10, 12)}-${s[12]}`;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  async function api(method, url, body) {
    const opt = { method, headers: {} };
    if (body instanceof FormData) opt.body = body;
    else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const r = await fetch(url, opt);
    let j = {};
    try { j = await r.json(); } catch { /* empty body */ }
    return { ok: r.ok, status: r.status, data: j || {} };
  }
  // put (or remove) a single message element with a testid inside a container; kind: 'err' (role=alert) | 'ok' (role=status) | 'info'
  const KIND = { err: ['msg err', 'alert'], ok: ['msg ok', 'status'], info: ['msg', null] };
  function msg(container, testid, text, kind = 'err') {
    let el = $(testid);
    if (text == null) { el?.remove(); return null; }
    if (!el) {
      el = document.createElement('p');
      el.dataset.testid = testid;
      const [cls, role] = KIND[kind];
      el.className = cls;
      if (role) el.setAttribute('role', role);
      (container || byId('flash')).appendChild(el);
    }
    el.textContent = text;
    return el;
  }
  // remove stale messages before a new request, so a repeated message can only come from the new response
  const clearMsgs = (...ids) => ['action-error', 'action-success', ...ids].forEach(id => $(id)?.remove());
  const showError = text => { msg(null, 'action-success', null); msg(byId('flash'), 'action-error', text); };
  const showOk = text => { msg(null, 'action-error', null); msg(byId('flash'), 'action-success', text, 'ok'); };
  const reloadWith = text => { sessionStorage.setItem('flash', text); location.reload(); };
  const flash = sessionStorage.getItem('flash');
  if (flash) { sessionStorage.removeItem('flash'); showOk(flash); }

  $('logout-btn')?.addEventListener('click', async () => { await api('POST', '/api/auth/logout'); location.href = '/login'; });
  document.querySelectorAll('[data-autosubmit]').forEach(el => el.addEventListener('change', () => el.form.submit()));

  // ------------------------------------------------------------ login
  if (data.page === 'login') {
    const tabs = [[$('login-tab-citizen'), 'panel-c'], [$('login-tab-staff'), 'panel-s']];
    tabs.forEach(([tab]) => tab.addEventListener('click', () => tabs.forEach(([t, p]) => {
      t.setAttribute('aria-selected', String(t === tab)); byId(p).hidden = t !== tab;
    })));
    const box = byId('citizen-msg');
    const clear = () => ['thaid-error', 'otp-error', 'otp-attempts-left', 'lock-message', 'lock-until'].forEach(t => $(t)?.remove());
    const showLock = until => {
      msg(box, 'lock-message', 'ผิดเกินกำหนด เลขบัตรนี้ถูกล็อก 15 นาที');
      msg(box, 'lock-until', `ปลดล็อกได้เมื่อ ${thDate(until)}`, 'info').dataset.iso = until;
    };
    const idNo = () => $('thaid-id-input').value.trim();
    byId('thaid-form').addEventListener('submit', async e => {
      e.preventDefault(); clear();
      const r = await api('POST', '/api/auth/thaid/start', { idNo: idNo() });
      if (r.ok) { $('otp-step').hidden = false; $('otp-input').focus(); return; }
      $('otp-step').hidden = true;
      if (r.status === 423) showLock(r.data.lockedUntil); else msg(box, 'thaid-error', r.data.message);
    });
    $('otp-step').addEventListener('submit', async e => {
      e.preventDefault(); clear();
      const r = await api('POST', '/api/auth/thaid/verify', { idNo: idNo(), otp: $('otp-input').value.trim() });
      if (r.ok) { location.href = r.data.registered ? '/citizen' : '/register'; return; }
      if (r.status === 423) showLock(r.data.lockedUntil);
      else if (r.status === 401) { msg(box, 'otp-error', r.data.message); msg(box, 'otp-attempts-left', `เหลือ ${r.data.attemptsLeft} ครั้ง`, 'info'); }
      else msg(box, 'thaid-error', r.data.message);
    });
    byId('staff-form').addEventListener('submit', async e => {
      e.preventDefault(); $('staff-error')?.remove();
      const r = await api('POST', '/api/auth/staff/login', { username: $('staff-username').value.trim(), password: $('staff-password').value });
      if (r.ok) location.href = r.data.landing; else msg(byId('staff-msg'), 'staff-error', r.data.message);
    });
  }

  // ------------------------------------------------------------ register
  if (data.page === 'register') {
    byId('reg-form').addEventListener('submit', async e => {
      e.preventDefault();
      $('reg-error-mobile')?.remove(); $('reg-error-consent')?.remove();
      const r = await api('POST', '/api/auth/register', { mobile: $('reg-mobile').value.trim(), email: $('reg-email').value.trim(), consent: $('reg-consent').checked });
      if (r.ok) { location.href = '/citizen'; return; }
      if (r.data.code === 'INVALID_MOBILE') msg(byId('err-mobile'), 'reg-error-mobile', r.data.message);
      else if (r.data.code === 'CONSENT_REQUIRED') msg(byId('err-consent'), 'reg-error-consent', r.data.message);
      else showError(r.data.message);
    });
  }

  // ------------------------------------------------------------ wizard (/citizen/new/:service)
  if (data.page === 'wizard') {
    const svc = data.serviceId;
    let draft = data.draft;
    const STEPS = { 1: '1/3 กรอกข้อมูล', 2: '2/3 แนบเอกสาร', 3: '3/3 ชำระเงิน' };
    const setStep = n => { $('wizard-step').textContent = STEPS[n]; [1, 2, 3].forEach(i => { byId('step' + i).hidden = i !== n; }); };
    const input = $('qty-input') || $('area-input');
    const values = () => (svc === 'SV-01' ? { qty: input.value } : svc === 'SV-03' ? { areaSqm: input.value } : {});
    let seq = 0;
    async function refreshFee() {
      const mine = ++seq;
      const r = await api('GET', '/api/fee?' + new URLSearchParams({ serviceId: svc, ...values() }));
      if (mine !== seq) return; // a newer value is being checked
      $('fee-total').textContent = r.ok ? money(r.data.fee) : '–';
      msg(byId('fee-msg'), 'fee-error', r.ok || (input.value === '' && svc === 'SV-03') ? null : r.data.message);
      $('to-upload-btn').disabled = !r.ok;
    }
    input?.addEventListener('input', refreshFee);
    const reloadDraft = async () => { draft = (await api('GET', `/api/drafts/${draft.draftId}`)).data; };
    async function saveDraft() {
      const body = { serviceId: svc, ...values() };
      const r = draft ? await api('PATCH', `/api/drafts/${draft.draftId}`, body) : await api('POST', '/api/drafts', body);
      if (!r.ok) { msg(byId('fee-msg'), 'fee-error', r.data.message); return false; }
      draft = { draftId: r.data.draftId };
      await reloadDraft();
      byId('draft-line').innerHTML = `รหัสร่าง: <span data-testid="draft-id">${draft.draftId}</span>`;
      history.replaceState(null, '', `/citizen/new/${svc}?draft=${draft.draftId}`);
      return true;
    }
    $('save-draft-btn').addEventListener('click', async () => { if (await saveDraft()) showOk(`บันทึกร่าง ${draft.draftId} แล้ว`); });
    byId('f1').addEventListener('submit', async e => {
      e.preventDefault();
      if ($('to-upload-btn').disabled) return;
      if (await saveDraft()) { setStep(2); renderFiles(); }
    });

    function renderFiles() {
      byId('file-list').innerHTML = draft.files.map(f => `<li data-testid="file-item" data-name="${esc(f.name)}" data-doc-key="${f.docKey}" data-file-id="${f.fileId}">
        ${esc(f.name)} <span class="hint">(${f.size.toLocaleString('en-US')} ไบต์)</span>
        <button type="button" class="small secondary" data-testid="file-remove-btn" aria-label="ลบไฟล์ ${esc(f.name)}">ลบ</button></li>`).join('');
      msg(byId('missing'), 'missing-docs', draft.missing.length ? `ยังขาดเอกสาร: ${draft.missing.join(', ')}` : null, 'info');
      $('to-payment-btn').disabled = draft.missing.length > 0;
    }
    byId('file-list').addEventListener('click', async e => {
      const li = e.target.closest('[data-testid="file-remove-btn"]')?.closest('li');
      if (!li) return;
      await api('DELETE', `/api/drafts/${draft.draftId}/files/${li.dataset.fileId}`);
      await reloadDraft(); renderFiles();
    });
    document.querySelectorAll('#step2 input[type=file]').forEach(inp => inp.addEventListener('change', async () => {
      for (const f of [...inp.files]) {
        clearMsgs('upload-error');
        const fd = new FormData();
        fd.append('docKey', inp.dataset.docKey);
        fd.append('file', f, f.name);
        const r = await api('POST', `/api/drafts/${draft.draftId}/files`, fd);
        if (!r.ok) { msg(byId('upload-msg'), 'upload-error', r.data.message); break; }
        msg(null, 'upload-error', null);
        await reloadDraft(); renderFiles();
      }
      inp.value = '';
    }));
    $('to-payment-btn').addEventListener('click', () => { setStep(3); renderPay(); });

    function renderPay() {
      const p = draft.payment;
      let h = `<p>ยอดที่ต้องชำระ <strong data-testid="payment-amount">${money(p ? p.amount : draft.fee)}</strong></p>`;
      if (!p) h += '<button type="button" data-testid="create-qr-btn">สร้าง QR</button>';
      else if (p.status === 'PAID') {
        h += `<p>สถานะ: <span class="badge lv-normal" data-testid="payment-status" data-status="PAID">ชำระแล้ว</span></p>
          <dl class="kv"><dt>เลขคำขอ</dt><dd data-testid="submitted-case-no">${p.caseNo}</dd><dt>เลขใบเสร็จ</dt><dd data-testid="receipt-no">${p.receiptNo}</dd>
          <dt>ยอดชำระ</dt><dd data-testid="receipt-amount">${money(p.amount)}</dd>
          <dt>ชำระเมื่อ</dt><dd><time data-testid="receipt-paid-at" data-iso="${p.paidAt}" datetime="${p.paidAt}">${thDate(p.paidAt)}</time></dd></dl>
          <a class="btn" data-testid="go-case-btn" href="/citizen/cases/${p.caseNo}">ดูคำขอ</a>`;
      } else {
        h += `<figure class="qr"><img data-testid="qr-image" width="160" height="160" alt="QR PromptPay จำลอง เลขอ้างอิง ${p.ref}" src="data:image/svg+xml,${encodeURIComponent(qrSvg(p.ref))}"></figure>
          <p>เลขอ้างอิง <strong data-testid="qr-ref">${p.ref}</strong></p>
          <p><time data-testid="qr-expires" data-iso="${p.qrExpiresAt}" datetime="${p.qrExpiresAt}">หมดอายุ ${thDate(p.qrExpiresAt)}</time></p>`;
        if (p.status === 'EXPIRED') {
          h += `<p class="msg err" role="alert" data-testid="qr-expired-msg">QR หมดอายุ กรุณาสร้าง QR ใหม่</p>
            <p>สถานะ: <span class="badge lv-overdue" data-testid="payment-status" data-status="EXPIRED">QR หมดอายุ</span></p>
            <button type="button" data-testid="regenerate-qr-btn">สร้าง QR ใหม่</button>`;
        } else {
          h += `<p>สถานะ: <span class="badge lv-near" data-testid="payment-status" data-status="PENDING">รอชำระ</span></p>`;
        }
        h += ' <button type="button" class="secondary" data-testid="refresh-payment-btn">ตรวจสอบการชำระเงิน</button>';
      }
      byId('pay').innerHTML = h;
    }
    function qrSvg(seed) {
      let s = 7; for (const ch of seed) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
      let r = '';
      for (let y = 0; y < 21; y++) for (let x = 0; x < 21; x++) { s = (s * 1103515245 + 12345) >>> 0; if (s & 0x100 || (x < 7 && y < 7) || (x > 13 && y < 7) || (x < 7 && y > 13)) r += `<rect x="${x}" y="${y}" width="1" height="1"/>`; }
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 23 23"><rect x="-1" y="-1" width="23" height="23" fill="#fff"/><g fill="#000">${r}</g></svg>`;
    }
    byId('pay').addEventListener('click', async e => {
      const id = e.target.dataset.testid;
      if (id === 'create-qr-btn' || id === 'regenerate-qr-btn') {
        const r = await api('POST', `/api/drafts/${draft.draftId}/payment`);
        if (!r.ok) return showError(r.data.message);
        await reloadDraft(); renderPay();
      } else if (id === 'refresh-payment-btn') {
        const r = await api('GET', `/api/payments/${draft.payment.ref}`);
        if (r.ok) { draft.payment = r.data; renderPay(); } else showError(r.data.message);
      }
    });
    if (draft && draft.status !== 'DRAFT') { setStep(3); renderPay(); }
    else if (input && input.value !== '') refreshFee();
  }

  // ------------------------------------------------------------ case pages (citizen + officer)
  if (data.page === 'case') {
    const no = data.caseNo;
    const reveal = (btn, form) => $(btn)?.addEventListener('click', () => { byId(form).hidden = false; $(btn).setAttribute('aria-expanded', 'true'); byId(form).querySelector('textarea,input')?.focus(); });
    async function act(url, body, okText, fieldErr) {
      clearMsgs(fieldErr?.testid);
      const r = await api('POST', url, body);
      if (r.ok) return reloadWith(okText);
      if (fieldErr && fieldErr.codes.includes(r.data.code)) msg(byId(fieldErr.box), fieldErr.testid, r.data.message);
      else showError(r.data.message);
    }
    $('claim-btn')?.addEventListener('click', () => act(`/api/officer/cases/${no}/claim`, {}, 'รับเรื่องแล้ว'));
    $('approve-btn')?.addEventListener('click', () => act(`/api/cases/${no}/approve`, {}, 'อนุมัติแล้ว'));
    $('issue-btn')?.addEventListener('click', () => act(`/api/officer/cases/${no}/issue`, {}, 'ออกเอกสารแล้ว'));
    $('forward-btn')?.addEventListener('click', () => act(`/api/officer/cases/${no}/forward`, { note: $('forward-note').value }, 'ส่งต่อแล้ว'));
    reveal('return-btn', 'return-form');
    reveal('reject-btn', 'reject-form');
    reveal('show-full-id-btn', 'unmask-form');
    $('return-submit')?.addEventListener('click', () => act(`/api/officer/cases/${no}/return`, { reason: $('return-reason').value }, 'ตีกลับแล้ว',
      { codes: ['REASON_TOO_SHORT'], box: 'return-msg', testid: 'return-reason-error' }));
    $('reject-submit')?.addEventListener('click', () => act(`/api/cases/${no}/reject`, { reason: $('reject-reason').value }, 'บันทึกไม่อนุมัติแล้ว',
      { codes: ['REASON_TOO_SHORT'], box: 'reject-msg', testid: 'reject-reason-error' }));
    $('unmask-submit')?.addEventListener('click', async () => {
      clearMsgs('unmask-error');
      const r = await api('POST', `/api/officer/cases/${no}/unmask`, { reason: $('unmask-reason').value });
      if (!r.ok) return r.data.code === 'REASON_REQUIRED' ? msg(byId('unmask-msg'), 'unmask-error', r.data.message) : showError(r.data.message);
      byId('full-id-slot').innerHTML = `เลขเต็ม: <strong data-testid="full-id">${fmtId(r.data.idNo)}</strong>`;
    });
    $('cancel-case-btn')?.addEventListener('click', () => { byId('cancel-dialog').hidden = false; $('confirm-cancel-btn').focus(); });
    byId('cancel-no')?.addEventListener('click', () => { byId('cancel-dialog').hidden = true; $('cancel-case-btn').focus(); });
    $('confirm-cancel-btn')?.addEventListener('click', () => act(`/api/cases/${no}/cancel`, {}, 'ยกเลิกคำขอแล้ว'));
    $('submit-fix-btn')?.addEventListener('click', async () => {
      clearMsgs();
      const fd = new FormData();
      for (const f of $('fix-upload-input').files) fd.append('file', f, f.name);
      const r = await api('POST', `/api/cases/${no}/resubmit`, fd);
      if (r.ok) reloadWith('ส่งแก้ไขแล้ว'); else showError(r.data.message);
    });
  }

  // ------------------------------------------------------------ queue claim buttons
  document.querySelectorAll('[data-testid="queue-row"] [data-testid="claim-btn"]').forEach(b => b.addEventListener('click', async () => {
    clearMsgs();
    const r = await api('POST', `/api/officer/cases/${b.dataset.case}/claim`);
    if (r.ok) reloadWith(`รับเรื่อง ${b.dataset.case} แล้ว`); else showError(r.data.message);
  }));

  // ------------------------------------------------------------ admin
  if (data.page === 'admin-services') {
    document.querySelectorAll('[data-svc]').forEach(b => b.addEventListener('click', async () => {
      clearMsgs();
      const id = b.dataset.svc;
      const body = { fee: $(`svc-fee-${id}`).value, sla: $(`svc-sla-${id}`).value };
      if ($(`svc-fee-per-sqm-${id}`)) body.feePerSqm = $(`svc-fee-per-sqm-${id}`).value;
      const r = await api('PUT', `/api/admin/services/${id}`, body);
      if (r.ok) showOk(`บันทึก ${id} แล้ว`); else showError(r.data.message);
    }));
  }
  if (data.page === 'admin-holidays') {
    byId('holiday-form').addEventListener('submit', async e => {
      e.preventDefault(); clearMsgs();
      const r = await api('POST', '/api/admin/holidays', { date: $('holiday-date-input').value, name: $('holiday-name-input').value });
      if (r.ok) reloadWith('เพิ่มวันหยุดแล้ว'); else showError(r.data.message);
    });
    document.querySelectorAll('[data-testid="holiday-delete-btn"]').forEach(b => b.addEventListener('click', async () => {
      const r = await api('DELETE', `/api/admin/holidays/${b.dataset.date}`);
      if (r.ok) reloadWith('ลบวันหยุดแล้ว'); else showError(r.data.message);
    }));
  }
  if (data.page === 'admin-users') {
    document.querySelectorAll('[data-user]').forEach(b => b.addEventListener('click', async () => {
      clearMsgs();
      const row = b.closest('tr');
      const r = await api('PUT', `/api/admin/users/${b.dataset.user}`, {
        role: row.querySelector('[data-testid="user-role-select"]').value, dept: row.querySelector('[data-testid="user-dept-select"]').value });
      if (r.ok) showOk(`บันทึก ${b.dataset.user} แล้ว`); else showError(r.data.message);
    }));
  }
})();
