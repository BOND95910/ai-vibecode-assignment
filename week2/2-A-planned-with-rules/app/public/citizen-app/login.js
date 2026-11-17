// B10 · /login: ประชาชน (ThaiD จำลอง: เลขบัตร → OTP) และเจ้าหน้าที่ (SSO จำลอง) · ข้อความ error มาจาก response ของ API ตรง ๆ
(function () {
  var EG = window.EG, h = EG.h;
  var $ = function (id) { return document.getElementById(id); };
  var pendingId = '';

  // แสดงข้อความ error ใน container (แทนของเดิม) · ไม่มีข้อความ = ล้าง (element จึงไม่อยู่ใน DOM เมื่อไม่มี error)
  function show(box, nodes) { box.textContent = ''; [].concat(nodes || []).forEach(function (n) { box.appendChild(n); }); }
  var err = function (testid, text) { return h('p', { class: 'msg-error', role: 'alert', testid: testid, text: text }); };

  // ---- แท็บ ----
  var tabs = { citizen: $('tab-citizen'), staff: $('tab-staff') };
  var panels = { citizen: $('panel-citizen'), staff: $('panel-staff') };
  function pick(name, focus) {
    Object.keys(tabs).forEach(function (k) {
      var on = k === name;
      tabs[k].setAttribute('aria-selected', on ? 'true' : 'false');
      tabs[k].tabIndex = on ? 0 : -1;
      tabs[k].classList.toggle('secondary', !on);
      panels[k].hidden = !on;
    });
    if (focus) tabs[name].focus();
  }
  tabs.citizen.addEventListener('click', function () { pick('citizen'); });
  tabs.staff.addEventListener('click', function () { pick('staff'); });
  [tabs.citizen, tabs.staff].forEach(function (t) {
    t.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') pick(t === tabs.citizen ? 'staff' : 'citizen', true);
    });
  });

  // ---- ประชาชน: ขั้น 1 เลขบัตร ----
  var idInput = $('thaid-id-input'), otpForm = $('otp-form'), otpInput = $('otp-input');
  idInput.addEventListener('input', function () { otpForm.hidden = true; }); // แก้เลขบัตรแล้วต้องขอ OTP ใหม่

  function showLock(until) {
    show($('lock-box'), h('div', { class: 'msg-error', role: 'alert' },
      h('p', { testid: 'lock-message', text: 'ผิดเกินกำหนด เลขบัตรนี้ถูกล็อก 15 นาที' }),
      until ? h('p', null, 'ปลดล็อกเมื่อ ', h('time', { testid: 'lock-until', 'data-iso': until, datetime: until, text: EG.thaiDateTime(until) })) : null));
  }

  $('thaid-form').addEventListener('submit', function (e) {
    e.preventDefault();
    show($('thaid-msg')); show($('lock-box')); show($('otp-msg'));
    var idNo = idInput.value.trim();
    EG.api('POST', '/api/auth/thaid/start', { idNo: idNo }).then(function (r) {
      if (r.ok) {
        pendingId = idNo;
        otpForm.hidden = false;
        otpInput.value = '';
        otpInput.focus();
      } else if (r.body && r.body.code === 'LOCKED') {
        otpForm.hidden = true;
        showLock(r.body.lockedUntil);
      } else {
        otpForm.hidden = true;
        show($('thaid-msg'), err('thaid-error', (r.body && r.body.message) || 'เกิดข้อผิดพลาด'));
      }
    });
  });

  // ---- ประชาชน: ขั้น 2 OTP ----
  otpForm.addEventListener('submit', function (e) {
    e.preventDefault();
    show($('otp-msg')); show($('lock-box'));
    EG.api('POST', '/api/auth/thaid/verify', { idNo: pendingId, otp: otpInput.value.trim() }).then(function (r) {
      var b = r.body || {};
      if (r.ok) { location.href = b.registered === false ? '/register' : '/citizen'; return; }
      if (b.code === 'LOCKED') { showLock(b.lockedUntil); return; }
      var nodes = [err('otp-error', b.message || 'เกิดข้อผิดพลาด')];
      if (b.code === 'OTP_INVALID' && typeof b.attemptsLeft === 'number') {
        nodes.push(h('p', { class: 'msg-warn', testid: 'otp-attempts-left', text: 'เหลือ ' + b.attemptsLeft + ' ครั้ง' }));
      }
      show($('otp-msg'), nodes);
    });
  });

  // ---- เจ้าหน้าที่ ----
  $('staff-form').addEventListener('submit', function (e) {
    e.preventDefault();
    show($('staff-msg'));
    EG.api('POST', '/api/auth/staff/login', { username: $('staff-username').value.trim(), password: $('staff-password').value }).then(function (r) {
      if (r.ok && r.body && r.body.landing) { location.href = r.body.landing; return; }
      show($('staff-msg'), err('staff-error', (r.body && r.body.message) || 'เกิดข้อผิดพลาด'));
    });
  });
})();
