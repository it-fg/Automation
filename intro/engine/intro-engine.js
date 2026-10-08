/* =====================================================================
 * FG Intro Engine — report.fitgroup.com.vn
 * Dựng intro hoạt hình 30s bằng HTML/CSS/Canvas, điều khiển theo thời gian
 * (deterministic): render(t) vẽ đúng khung hình tại giây t.
 *  - Phát trực tiếp trên web (requestAnimationFrame)
 *  - Render ra MP4 xem trước (Playwright chụp từng khung)
 * API: FGIntro.mount(hostEl, scene, baseUrl) -> Promise<{duration, render(t), destroy()}>
 * ===================================================================== */
(function () {
  'use strict';
  var W = 1920, H = 1080;
  var C = { bg: '#16130f', red: '#e2231a', gold: '#ebc100', text: '#f5f4f1', muted: '#c3c2b7' };

  /* ---------- tiện ích thời gian & easing ---------- */
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function seg(t, a, b) { return clamp((t - a) / (b - a), 0, 1); }
  function lerp(a, b, p) { return a + (b - a) * p; }
  var E = {
    out: function (p) { return 1 - Math.pow(1 - p, 3); },
    inOut: function (p) { return p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; },
    back: function (p) { var c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); },
    expo: function (p) { return p === 1 ? 1 : 1 - Math.pow(2, -10 * p); }
  };
  /* hiện dần [a,b], ẩn dần [c,d] */
  function fio(t, a, b, c, d) { return Math.min(E.out(seg(t, a, b)), 1 - E.inOut(seg(t, c, d))); }
  function rng(seed) { return function () { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; }

  function el(tag, css, parent, html) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (html != null) e.innerHTML = html;
    if (parent) parent.appendChild(e);
    return e;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function set(e, o, tf) { e.style.opacity = o; if (tf != null) e.style.transform = tf; }

  /* ---------- tải tài nguyên ---------- */
  function loadImg(src) {
    return new Promise(function (res, rej) {
      var i = new Image(); i.decoding = 'async';
      i.onload = function () { (i.decode ? i.decode() : Promise.resolve()).then(function () { res(i); }, function () { res(i); }); };
      i.onerror = function () { rej(new Error('Không tải được ảnh ' + src)); };
      i.src = src;
    });
  }
  function ensureFonts(base) {
    if (!document.getElementById('fgi-fonts')) {
      var l = document.createElement('link'); l.id = 'fgi-fonts'; l.rel = 'stylesheet'; l.href = base + 'engine/fonts.css';
      document.head.appendChild(l);
      return new Promise(function (r) { l.onload = r; l.onerror = r; }).then(loadFaces);
    }
    return loadFaces();
  }
  function loadFaces() {
    var specs = ['300 20px Roboto', '400 20px Roboto', '700 20px Roboto', '900 20px Roboto',
      'italic 700 20px "Playfair Display"', '700 20px "Playfair Display"', '700 20px "Dancing Script"'];
    var sample = 'ÀÁẠẢÃỆỘỮĐđươ Ngọc Mai';
    return Promise.all(specs.map(function (s) { return document.fonts.load(s, sample).catch(function () {}); }))
      .then(function () { return document.fonts.ready; });
  }
  /* Logo: nhúng SVG, đổi chữ GROUP xám (#666666) sang màu sáng cho nền tối */
  function loadLogo(base, light) {
    return fetch(base + 'engine/LogoFG.svg').then(function (r) { return r.text(); }).then(function (svg) {
      if (light) svg = svg.replace(/#666666/gi, light);
      return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    }).then(loadImg);
  }

  /* ---------- khung sân khấu 1920x1080 tự co giãn ---------- */
  function makeStage(host, bg) {
    host.innerHTML = '';
    var root = el('div', 'position:absolute;inset:0;overflow:hidden;background:' + bg + ';', host);
    var stage = el('div', 'position:absolute;left:50%;top:50%;width:' + W + 'px;height:' + H + 'px;transform-origin:0 0;overflow:hidden;' +
      'font-family:Roboto,"Segoe UI",sans-serif;color:' + C.text + ';-webkit-font-smoothing:antialiased;', root);
    function fit() {
      var s = Math.min(host.clientWidth / W, host.clientHeight / H) || 1;
      stage.style.transform = 'scale(' + s + ') translate(-50%,-50%)';
    }
    fit();
    window.addEventListener('resize', fit);
    return { root: root, stage: stage, destroy: function () { window.removeEventListener('resize', fit); host.innerHTML = ''; } };
  }
  function layer(stage, css) { return el('div', 'position:absolute;inset:0;' + (css || ''), stage); }
  function canvasLayer(stage) {
    var c = el('canvas', 'position:absolute;inset:0;width:' + W + 'px;height:' + H + 'px;', stage);
    c.width = W; c.height = H; return c;
  }
  /* tách tiêu đề thành 2 dòng cân đối */
  function twoLines(s) {
    var w = String(s).trim().split(/\s+/); if (w.length < 3) return [w.join(' ')];
    var best = 1, diff = 1e9;
    for (var i = 1; i < w.length; i++) { var d = Math.abs(w.slice(0, i).join(' ').length - w.slice(i).join(' ').length); if (d < diff) { diff = d; best = i; } }
    return [w.slice(0, best).join(' '), w.slice(best).join(' ')];
  }
  /* thu nhỏ cỡ chữ để vừa 1 dòng trong bề rộng maxW */
  function fitOne(e, maxW, minPx) {
    e.style.whiteSpace = 'nowrap'; e.style.display = 'inline-block';
    var fs = parseFloat(getComputedStyle(e).fontSize);
    while (e.scrollWidth > maxW && fs > (minPx || 30)) { fs -= 2; e.style.fontSize = fs + 'px'; }
    e.style.display = 'block';
  }
  function maskLine(parent, text, css) {
    var m = el('div', 'overflow:hidden;padding:.28em .08em .08em;margin:-.28em 0 -.08em;', parent);
    var i = el('div', 'will-change:transform;' + (css || ''), m, esc(text));
    return i;
  }

  /* =================================================================
   * TEMPLATE: onboarding
   * ================================================================= */
  function tplOnboarding(host, sc, base) {
    var d = sc.data || {}, T = sc.duration || 30;
    var assets = {};
    var jobs = [loadLogo(base, '#f5f4f1').then(function (i) { assets.logo = i; })];
    if (d.poster) jobs.push(loadImg(base + sc.id + '/' + d.poster).then(function (i) { assets.poster = i; }));
    return Promise.all(jobs).then(function () {
      var S = makeStage(host, C.bg), st = S.stage;
      /* nền */
      var bgGlow = layer(st, 'background:radial-gradient(1200px 700px at 50% 60%, rgba(226,35,26,.22), transparent 70%),radial-gradient(900px 600px at 15% 10%, rgba(235,193,0,.10), transparent 70%);');
      var dust = canvasLayer(st), dctx = dust.getContext('2d');
      var R = rng(7), P = [];
      for (var i = 0; i < 90; i++) P.push({ x: R() * W, y: R() * H, r: .6 + R() * 2.4, s: 8 + R() * 26, ph: R() * 6.28, a: .15 + R() * .5 });

      /* poster */
      var pWrap = layer(st, 'opacity:0;');
      var pImg = assets.poster ? el('img', 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform-origin:50% 50%;', pWrap) : null;
      if (pImg) pImg.src = assets.poster.src;
      var pDim = layer(pWrap, 'background:rgba(22,19,15,1);opacity:0;');
      var spark = canvasLayer(st), sctx = spark.getContext('2d');
      var SP = []; var R2 = rng(42);
      for (var k = 0; k < 26; k++) SP.push({ x: 80 + R2() * (W - 160), y: 60 + R2() * (H - 120), s: 10 + R2() * 34, ph: R2() * 6.28, sp: 1.4 + R2() * 2.2 });

      /* logo mở đầu */
      var logo = el('img', 'position:absolute;left:50%;top:50%;width:620px;margin-left:-310px;margin-top:-69px;', st); logo.src = assets.logo.src;
      var sweep = el('div', 'position:absolute;left:50%;top:640px;height:3px;width:620px;margin-left:-310px;background:linear-gradient(90deg,transparent,' + C.gold + ',transparent);transform-origin:50% 50%;', st);
      var mini = el('img', 'position:absolute;left:72px;top:56px;width:190px;opacity:0;', st); mini.src = assets.logo.src;

      /* tiêu đề */
      var tWrap = el('div', 'position:absolute;left:0;right:0;top:330px;text-align:center;', st);
      var kick = el('div', 'font:700 26px Roboto;letter-spacing:.42em;color:' + C.gold + ';margin-bottom:26px;opacity:0;', tWrap, 'F.I.T GROUP · CHÀO ĐÓN');
      var lines = twoLines(String(d.tieuDe || 'Chào mừng thành viên mới').replace(/\s+!/g, '!')).map(function (s, idx) {
        return maskLine(tWrap, s.toUpperCase(), 'font:900 ' + (idx ? 128 : 112) + 'px/1.08 Roboto;letter-spacing:.01em;color:' + (idx ? C.text : C.text) + ';');
      });
      var bar = el('div', 'margin:34px auto 0;height:8px;width:260px;background:' + C.red + ';border-radius:4px;transform-origin:50% 50%;', tWrap);

      /* thẻ nhân sự */
      var card = el('div', 'position:absolute;left:250px;top:300px;width:1420px;height:480px;', st);
      var ringBox = el('div', 'position:absolute;left:0;top:20px;width:440px;height:440px;', card);
      var ring = el('div', 'position:absolute;inset:0;', ringBox,
        '<svg width="440" height="440" viewBox="0 0 440 440"><circle cx="220" cy="220" r="200" fill="none" stroke="rgba(235,193,0,.18)" stroke-width="3"/>' +
        '<circle class="arc" cx="220" cy="220" r="200" fill="none" stroke="' + C.gold + '" stroke-width="6" stroke-linecap="round" stroke-dasharray="1257" stroke-dashoffset="1257" transform="rotate(-90 220 220)"/>' +
        '<circle cx="220" cy="220" r="170" fill="' + C.red + '"/></svg>');
      var arc = ring.querySelector('.arc');
      var nameWords = String(d.hoTen || '').trim().split(/\s+/);
      var initials = nameWords.slice(-2).map(function (w) { return w.charAt(0); }).join('').toUpperCase();
      var ini = el('div', 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:900 150px Roboto;color:#fff;letter-spacing:.02em;', ringBox, esc(initials));
      var info = el('div', 'position:absolute;left:540px;top:40px;right:0;', card);
      var lab = el('div', 'font:700 26px Roboto;letter-spacing:.32em;color:' + C.gold + ';margin-bottom:22px;', info, 'THÀNH VIÊN MỚI');
      var nm = maskLine(info, String(d.hoTen || '').toUpperCase(), 'font:900 104px/1.1 Roboto;color:#fff;');
      fitOne(nm, 860, 60);
      var role = el('div', 'margin-top:26px;font:700 50px Roboto;color:' + C.text + ';', info, esc(d.chucDanh || ''));
      var showDept = d.phongBan && String(d.chucDanh || '').toLowerCase().indexOf(String(d.phongBan).toLowerCase()) < 0;
      var dept = el('div', 'margin-top:12px;font:400 40px Roboto;color:' + C.muted + ';', info, showDept ? esc(d.phongBan) : '');
      var line = el('div', 'margin-top:34px;height:4px;width:520px;background:linear-gradient(90deg,' + C.red + ',' + C.gold + ');transform-origin:0 50%;', info);
      var date = el('div', 'margin-top:26px;font:400 36px Roboto;color:' + C.muted + ';', info, d.ngayGiaNhap ? 'Ngày gia nhập&nbsp;&nbsp;<b style="color:#fff;font-weight:700">' + esc(d.ngayGiaNhap) + '</b>' : '');

      /* lời chúc */
      var wish = el('div', 'position:absolute;left:100px;right:100px;top:380px;text-align:center;', st);
      var wl = (d.loiChuc || []).map(function (s, idx) {
        var e = el('div', 'font:' + (idx ? '400 54px/1.3' : '900 72px/1.2') + ' Roboto;color:' + (idx ? C.text : '#fff') + ';margin-top:' + (idx ? 28 : 0) + 'px;opacity:0;', wish, esc(s));
        fitOne(e, 1700, 40); return e;
      });
      var sign = el('div', 'margin-top:54px;font:700 34px Roboto;letter-spacing:.12em;color:' + C.gold + ';opacity:0;', wish, d.kyTen ? '— ' + esc(d.kyTen) + ' —' : '');

      var fade = layer(st, 'background:' + C.bg + ';opacity:0;');

      function drawDust(t, alpha) {
        dctx.clearRect(0, 0, W, H); if (alpha <= 0) return;
        for (var i = 0; i < P.length; i++) {
          var p = P[i], y = (p.y - t * p.s) % H; if (y < 0) y += H;
          var x = p.x + Math.sin(t * .6 + p.ph) * 18;
          var a = p.a * (.55 + .45 * Math.sin(t * 1.7 + p.ph)) * alpha;
          dctx.fillStyle = 'rgba(235,193,0,' + a.toFixed(3) + ')';
          dctx.beginPath(); dctx.arc(x, y, p.r, 0, 6.2832); dctx.fill();
        }
      }
      function star(ctx, x, y, s, a) {
        ctx.save(); ctx.translate(x, y); ctx.globalAlpha = a;
        ctx.fillStyle = '#fff'; ctx.shadowColor = 'rgba(255,255,255,.9)'; ctx.shadowBlur = s * .6;
        ctx.beginPath();
        ctx.moveTo(0, -s); ctx.quadraticCurveTo(s * .12, -s * .12, s, 0); ctx.quadraticCurveTo(s * .12, s * .12, 0, s);
        ctx.quadraticCurveTo(-s * .12, s * .12, -s, 0); ctx.quadraticCurveTo(-s * .12, -s * .12, 0, -s); ctx.fill();
        ctx.restore();
      }
      function drawSpark(t, alpha) {
        sctx.clearRect(0, 0, W, H); if (alpha <= 0) return;
        for (var i = 0; i < SP.length; i++) {
          var q = SP[i], tw = Math.max(0, Math.sin(t * q.sp + q.ph));
          if (tw > .05) star(sctx, q.x, q.y, q.s * (.4 + .6 * tw), tw * alpha);
        }
      }

      function render(t) {
        /* nền & bụi vàng */
        bgGlow.style.opacity = 1 - seg(t, 16.8, 18);
        drawDust(t, 1 - .6 * seg(t, 16.8, 18) + .6 * seg(t, 24, 25));
        /* 0–4.2s logo */
        var lp = E.out(seg(t, .3, 1.8));
        set(logo, Math.min(lp, 1 - E.inOut(seg(t, 3.5, 4.2))), 'scale(' + (lerp(.86, 1, lp) + .05 * E.inOut(seg(t, 3.5, 4.2))) + ')');
        set(sweep, fio(t, 1.2, 2.2, 3.3, 3.9), 'scaleX(' + E.expo(seg(t, 1.2, 2.4)) + ')');
        mini.style.opacity = .85 * fio(t, 4.2, 5, 16.6, 17.2);
        /* 4.2–9s tiêu đề */
        var tOut = E.inOut(seg(t, 8.3, 9));
        tWrap.style.opacity = 1 - tOut; tWrap.style.transform = 'translateY(' + (-40 * tOut) + 'px)';
        kick.style.opacity = E.out(seg(t, 4.3, 5));
        lines.forEach(function (ln, idx) { var p = E.out(seg(t, 4.5 + idx * .25, 5.3 + idx * .25)); ln.style.transform = 'translateY(' + (110 * (1 - p)) + '%)'; });
        bar.style.transform = 'scaleX(' + E.expo(seg(t, 5.4, 6.4)) + ')';
        /* 9–16.8s thẻ nhân sự */
        var cOut = E.inOut(seg(t, 16.2, 16.9));
        card.style.opacity = t < 8.9 ? 0 : 1 - cOut; card.style.transform = 'translateX(' + (-60 * cOut) + 'px)';
        var rp = E.out(seg(t, 9, 9.8));
        ringBox.style.opacity = rp; ringBox.style.transform = 'scale(' + lerp(.6, 1, E.back(seg(t, 9, 9.9))) + ') rotate(' + (t * 4) + 'deg)';
        ini.style.transform = 'rotate(' + (-t * 4) + 'deg)';
        arc.setAttribute('stroke-dashoffset', String(1257 * (1 - E.inOut(seg(t, 9.3, 11)))));
        lab.style.opacity = E.out(seg(t, 9.5, 10.1));
        nm.style.transform = 'translateY(' + (110 * (1 - E.out(seg(t, 9.7, 10.5)))) + '%)';
        set(role, E.out(seg(t, 10.3, 11)), 'translateY(' + (24 * (1 - E.out(seg(t, 10.3, 11)))) + 'px)');
        set(dept, E.out(seg(t, 10.6, 11.3)));
        line.style.transform = 'scaleX(' + E.expo(seg(t, 10.9, 12)) + ')';
        set(date, E.out(seg(t, 11.3, 12)), 'translateY(' + (20 * (1 - E.out(seg(t, 11.3, 12)))) + 'px)');
        /* 17–24s poster */
        var pin = E.inOut(seg(t, 16.9, 18));
        pWrap.style.opacity = t < 16.9 ? 0 : 1;
        pWrap.style.clipPath = 'circle(' + (pin * 75).toFixed(2) + '% at 50% 50%)';
        if (pImg) pImg.style.transform = 'scale(' + lerp(1.14, 1.0, E.out(seg(t, 16.9, 24.5))) + ')';
        var dp = E.inOut(seg(t, 24, 24.9));
        pDim.style.opacity = .9 * dp;
        if (pImg) pImg.style.filter = dp > 0 ? 'blur(' + (8 * dp).toFixed(2) + 'px)' : 'none';
        drawSpark(t, fio(t, 17.6, 18.6, 23.8, 24.6));
        /* 24.6–28s lời chúc */
        wl.forEach(function (w, idx) { var a = seg(t, 24.7 + idx * .7, 25.5 + idx * .7); set(w, E.out(a), 'translateY(' + (30 * (1 - E.out(a))) + 'px)'); });
        sign.style.opacity = E.out(seg(t, 26.2, 26.9));
        /* 28–30s mờ về nền trang đăng nhập */
        fade.style.opacity = E.inOut(seg(t, T - 2, T - .15));
      }
      render(0);
      return { duration: T, render: render, destroy: S.destroy };
    });
  }

  /* =================================================================
   * TEMPLATE: phunu2010 (Ngày Phụ nữ Việt Nam)
   * ================================================================= */
  var WOMAN_SVG = null; /* nạp từ engine/art/phunu-aodai.svg */
  function tplPhuNu(host, sc, base) {
    var d = sc.data || {}, T = sc.duration || 30, assets = {};
    return Promise.all([
      loadLogo(base, '#f5f4f1').then(function (i) { assets.logo = i; }),
      loadImg(base + 'engine/art/phunu-aodai.svg').then(function (i) { assets.woman = i; }),
      loadImg(base + 'engine/art/hoa-hong.svg').then(function (i) { assets.rose = i; })
    ]).then(function () {
      var S = makeStage(host, C.bg), st = S.stage;
      var bg = layer(st, 'background:radial-gradient(1100px 800px at 30% 55%, rgba(214,51,98,.30), transparent 70%),radial-gradient(900px 700px at 85% 30%, rgba(235,193,0,.12), transparent 70%),linear-gradient(160deg,#2a0f17 0%,#1d1112 55%,#16130f 100%);');
      var petals = canvasLayer(st), pctx = petals.getContext('2d');
      var R = rng(2010), PT = [];
      var cols = ['#f06292', '#e2231a', '#f8bbd0', '#ec407a', '#ffd1dc'];
      for (var i = 0; i < 70; i++) PT.push({ x: R() * W * 1.2 - W * .1, y0: -R() * H * 1.2, sp: 60 + R() * 90, sw: 30 + R() * 70, ph: R() * 6.28, rs: (R() - .5) * 3, sz: 10 + R() * 18, c: cols[Math.floor(R() * cols.length)], a: .55 + R() * .45, z: R() });

      var woman = el('img', 'position:absolute;left:170px;bottom:-10px;height:1020px;transform-origin:50% 100%;opacity:0;', st); woman.src = assets.woman.src;
      var roseL = el('img', 'position:absolute;left:-120px;bottom:-90px;width:440px;transform-origin:30% 80%;opacity:0;', st); roseL.src = assets.rose.src;
      var roseR = el('img', 'position:absolute;right:-70px;bottom:-80px;width:460px;transform-origin:70% 80%;opacity:0;transform:scaleX(-1);', st); roseR.src = assets.rose.src;

      var logo = el('img', 'position:absolute;left:50%;top:50%;width:620px;margin-left:-310px;margin-top:-69px;', st); logo.src = assets.logo.src;
      var mini = el('img', 'position:absolute;right:72px;top:56px;width:190px;opacity:0;', st); mini.src = assets.logo.src;

      /* khối chữ bên phải */
      var R0 = 830;
      var head = el('div', 'position:absolute;left:' + R0 + 'px;right:120px;top:250px;', st);
      var h1 = el('div', 'font:700 34px Roboto;letter-spacing:.38em;color:' + C.gold + ';', head, 'CHÚC MỪNG');
      var h2 = maskLine(head, 'NGÀY PHỤ NỮ VIỆT NAM', 'font:900 78px/1.15 Roboto;color:#fff;margin-top:14px;');
      var big = el('div', 'font:italic 700 260px/1 "Playfair Display",serif;margin-top:6px;background:linear-gradient(100deg,#c99700 0%,#ffe27a 35%,#fff6c9 45%,#ebc100 60%,#b98a00 100%);background-size:260% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;', head, '20/10');

      var quote = el('div', 'position:absolute;left:' + R0 + 'px;right:120px;top:300px;', st);
      var qMark = el('div', 'font:italic 700 200px/0.6 "Playfair Display",serif;color:' + C.gold + ';opacity:.85;height:90px;', quote, '“');
      var q = (d.loiChuc || []).map(function (s) {
        return el('div', 'position:absolute;left:0;right:0;top:130px;font:italic 700 60px/1.32 "Playfair Display",serif;color:#fff;opacity:0;', quote, esc(s));
      });

      var qLen = (d.loiChuc || []).map(function (x) { return Math.max(String(x).length, 30); });
      var qSum = qLen.reduce(function (a, b) { return a + b; }, 0) || 1;
      var qDur = qLen.map(function (l) { return 9.6 * l / qSum; });
      var signBox = el('div', 'position:absolute;left:' + R0 + 'px;right:120px;top:420px;text-align:left;opacity:0;', st);
      el('div', 'height:3px;width:420px;background:linear-gradient(90deg,' + C.gold + ',transparent);margin-bottom:34px;', signBox);
      el('div', 'font:700 30px Roboto;letter-spacing:.3em;color:' + C.gold + ';', signBox, 'TRÂN TRỌNG');
      el('div', 'font:900 64px/1.2 Roboto;color:#fff;margin-top:14px;', signBox, esc(d.kyTen || ''));

      var fade = layer(st, 'background:' + C.bg + ';opacity:0;');

      function petal(ctx, p, t) {
        var y = p.y0 + t * p.sp; var span = H + 200; y = ((y + 100) % span + span) % span - 100;
        var x = p.x + Math.sin(t * .9 + p.ph) * p.sw;
        var rot = p.ph + t * p.rs, flip = Math.cos(t * 1.6 + p.ph);
        ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(1, .35 + .65 * Math.abs(flip));
        ctx.globalAlpha = p.a; ctx.fillStyle = p.c;
        var s = p.sz * (.6 + p.z * .8);
        ctx.beginPath(); ctx.moveTo(0, -s); ctx.bezierCurveTo(s * .9, -s * .7, s * .8, s * .6, 0, s); ctx.bezierCurveTo(-s * .8, s * .6, -s * .9, -s * .7, 0, -s); ctx.fill();
        ctx.restore();
      }

      function render(t) {
        /* cánh hoa */
        pctx.clearRect(0, 0, W, H);
        var pa = E.out(seg(t, .2, 2)) * (1 - .7 * seg(t, T - 2.5, T - .3));
        if (pa > 0) { pctx.globalAlpha = 1; for (var i = 0; i < PT.length; i++) { pctx.save(); pctx.globalAlpha = pa; petal(pctx, PT[i], t + 6); pctx.restore(); } }
        /* 0–5s logo */
        var lp = E.out(seg(t, .3, 1.8)), lo = E.inOut(seg(t, 4.2, 5));
        set(logo, Math.min(lp, 1 - lo), 'scale(' + (lerp(.86, 1, lp) + .06 * lo) + ')');
        mini.style.opacity = .85 * fio(t, 5.4, 6.2, T - 3, T - 2);
        /* hình minh hoạ + hoa */
        var wp = E.out(seg(t, 5, 6.8));
        set(woman, wp, 'translateX(' + (-120 * (1 - wp)) + 'px) rotate(' + (Math.sin(t * .8) * .6) + 'deg)');
        var rl = E.back(seg(t, 5.6, 7.2)), rr = E.back(seg(t, 6, 7.6));
        set(roseL, Math.min(1, rl * 1.2), 'scale(' + (rl * (1 + .015 * Math.sin(t * 1.3))) + ') rotate(' + (Math.sin(t * .7) * 1.2) + 'deg)');
        set(roseR, Math.min(1, rr * 1.2), 'scaleX(-1) scale(' + (rr * (1 + .015 * Math.sin(t * 1.1 + 1))) + ') rotate(' + (Math.sin(t * .6 + 2) * 1.2) + 'deg)');
        /* 5.6–13s tiêu đề */
        var ho = 1 - E.inOut(seg(t, 12.4, 13.1));
        head.style.opacity = ho; head.style.transform = 'translateY(' + (-30 * (1 - ho)) + 'px)';
        h1.style.opacity = E.out(seg(t, 5.8, 6.5));
        h2.style.transform = 'translateY(' + (110 * (1 - E.out(seg(t, 6.2, 7.1)))) + '%)';
        var bp = E.out(seg(t, 7, 8.4));
        set(big, bp, 'scale(' + lerp(.8, 1, E.back(seg(t, 7, 8.4))) + ')');
        big.style.transformOrigin = '0% 60%';
        big.style.backgroundPosition = (100 - ((t * 22) % 160)) + '% 0';
        /* 13–23s lời chúc (mỗi câu 1 nửa) */
        /* chia 10s cho các câu theo độ dài chữ (tối thiểu 3.5s/câu) */
        quote.style.opacity = fio(t, 13.1, 13.8, 22.5, 23.1);
        var acc = 13.4;
        q.forEach(function (e, idx) {
          var a = acc, b = a + qDur[idx] - .4; acc += qDur[idx];
          var o = fio(t, a, a + .8, b - .3, b + .3);
          set(e, o, 'translateY(' + (26 * (1 - E.out(seg(t, a, a + .8)))) + 'px)');
        });
        /* 23–27s ký tên */
        var so = fio(t, 23.2, 24, T - 2.4, T - 1.6);
        set(signBox, so, 'translateY(' + (24 * (1 - E.out(seg(t, 23.2, 24)))) + 'px)');
        /* 28–30s mờ về nền */
        fade.style.opacity = E.inOut(seg(t, T - 2, T - .15));
      }
      render(0);
      return { duration: T, render: render, destroy: S.destroy };
    });
  }

  var TEMPLATES = { onboarding: tplOnboarding, phunu2010: tplPhuNu };

  window.FGIntro = {
    version: '2026.10.001',
    mount: function (host, scene, baseUrl) {
      var base = baseUrl || 'intro/';
      var tpl = TEMPLATES[scene.template];
      if (!tpl) return Promise.reject(new Error('Không có template: ' + scene.template));
      return ensureFonts(base).then(function () { return tpl(host, scene, base); });
    }
  };
})();
