// B10 · /register: ส่งเบอร์/อีเมล/ยินยอม ให้ API ตรวจ · แสดงข้อความ error จาก response ตรง ๆ
(function () {
  var EG = window.EG, h = EG.h;
  var $ = function (id) { return document.getElementById(id); };
  var show = function (box, node) { box.textContent = ''; if (node) box.appendChild(node); };
  var err = function (testid, text) { return h('p', { class: 'msg-error', role: 'alert', testid: testid, text: text }); };

  $('reg-form').addEventListener('submit', function (e) {
    e.preventDefault();
    ['reg-mobile-msg', 'reg-consent-msg', 'reg-msg'].forEach(function (id) { show($(id)); });
    EG.api('POST', '/api/auth/register', {
      mobile: $('reg-mobile').value.trim(),
      email: $('reg-email').value.trim(),
      consent: $('reg-consent').checked, // ต้องเป็น boolean จริง (API ตรวจ === true)
    }).then(function (r) {
      var b = r.body || {};
      if (r.ok || b.code === 'ALREADY_REGISTERED') { location.href = '/citizen'; return; }
      if (b.code === 'INVALID_MOBILE') show($('reg-mobile-msg'), err('reg-error-mobile', b.message));
      else if (b.code === 'CONSENT_REQUIRED') show($('reg-consent-msg'), err('reg-error-consent', b.message));
      else show($('reg-msg'), err('action-error', b.message || 'เกิดข้อผิดพลาด'));
    });
  });
})();
