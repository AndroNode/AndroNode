/*
 * AndroNode first-visit intro: the canvas scene (phones fly in, lock into a globe, tasks pulse,
 * a shockwave checks every device, then the camera flies through as the overlay dissolves).
 * Runs in a Worker on an OffscreenCanvas when the browser supports it, so work on the page's main
 * thread (such as building the hero 3D scene) cannot freeze the intro. Otherwise it runs on the page.
 * The page talks to it with messages: init, resize, pointer, leave, stop. Times are absolute
 * (performance.timeOrigin + performance.now()), so the page and the worker share one clock.
 */
(function (root) {
  var now = function () { return performance.timeOrigin + performance.now(); };
  var raf = root.requestAnimationFrame ? root.requestAnimationFrame.bind(root) : function (f) { return setTimeout(function () { f(); }, 16); };
  var canvas = null, ctx = null, started = 0, leaveAt = 0, checked = false, running = false;
  var W = 0, H = 0, CX = 0, CY = 0, R = 0, dpr = 1;
  var devs = [], order = [], links = [], pulses = [];
  var mx = 0, my = 0, smx = 0, smy = 0;

  function size(m) {
    W = m.W; H = m.H; dpr = m.dpr; CX = W / 2; CY = m.CY; R = Math.min(W * 0.42, H * 0.34, 380);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function seed() {
    var n = W < 700 ? 60 : 90;
    devs = [];
    for (var i = 0; i < n; i++) {
      // Home position on a Fibonacci sphere; start far outside the screen.
      var y = 1 - ((i + 0.5) / n) * 2, r = Math.sqrt(1 - y * y), th = i * 2.39996;
      var ang = Math.random() * Math.PI * 2, far = Math.max(W, H) * (0.75 + Math.random() * 0.5);
      devs.push({
        sx: Math.cos(th) * r, sy: y, sz: Math.sin(th) * r,
        ox: Math.cos(ang) * far, oy: Math.sin(ang) * far,
        bend: (Math.random() - 0.5) * 0.9,
        t0: 0.35 + Math.random() * 1.15,
        flash: 0, ph: Math.random() * 6.28, locked: false, wave: 0,
        px: 0, py: 0, ps: 1, z: 0, arrived: 0,
      });
    }
    order = devs.slice();
    // Links: each device to its two nearest neighbours on the sphere.
    links = [];
    for (var a = 0; a < n; a++) {
      var b0 = -1, b1 = -1, d0 = 9, d1 = 9;
      for (var b = 0; b < n; b++) {
        if (a === b) continue;
        var dx = devs[a].sx - devs[b].sx, dy = devs[a].sy - devs[b].sy, dz = devs[a].sz - devs[b].sz, d = dx * dx + dy * dy + dz * dz;
        if (d < d0) { d1 = d0; b1 = b0; d0 = d; b0 = b; } else if (d < d1) { d1 = d; b1 = b; }
      }
      if (b0 > a) links.push([a, b0]);
      if (b1 > a) links.push([a, b1]);
    }
  }
  function easeOut(x) { return 1 - Math.pow(1 - x, 3); }
  function easeIn(x) { return x * x * x; }
  function clamp(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function bez(a, m, b, e) { var u = 1 - e; return u * u * a + 2 * u * e * m + e * e * b; }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }
  // Glows are drawn from small pre-rendered sprites: far cheaper than a new gradient per dot per frame.
  var sprites = {};
  function sprite(col) {
    if (sprites[col]) return sprites[col];
    var c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(64, 64) : document.createElement("canvas"); c.width = c.height = 64;
    var g = c.getContext("2d"), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, "rgba(" + col + ",1)"); gr.addColorStop(0.35, "rgba(" + col + ",0.45)"); gr.addColorStop(1, "rgba(" + col + ",0)");
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    return (sprites[col] = c);
  }
  function glow(x, y, rad, col, a) {
    if (rad <= 0.5 || a <= 0.01) return;
    ctx.globalAlpha = a > 1 ? 1 : a;
    ctx.drawImage(sprite(col), x - rad, y - rad, rad * 2, rad * 2);
    ctx.globalAlpha = 1;
  }

  function draw(now) {
    var t = (now - started) / 1000;
    var ex = leaveAt ? clamp((now - leaveAt) / 1150) : 0; // exit progress
    ctx.clearRect(0, 0, W, H);
    smx += (mx - smx) * 0.06; smy += (my - smy) * 0.06;

    // Boot: a scan line opens across the screen and the core lights.
    var boot = clamp(t / 0.7);
    if (boot < 1) {
      var w = easeOut(boot) * W;
      ctx.fillStyle = "rgba(255,148,102," + (0.7 * (1 - boot)).toFixed(3) + ")";
      ctx.fillRect(CX - w / 2, CY - 0.5, w, 1);
    }
    var core = easeOut(clamp(t / 0.6));
    var beat = 1 + Math.sin(t * 6) * 0.08;
    glow(CX, CY, R * 0.55 * core * beat * (1 + ex * 3), "255,122,69", 0.22 * (1 - ex));

    // Globe rotation, tilted toward the pointer; the exit flies the camera through it.
    var rotY = t * 0.42 + smx * 0.6, rotX = 0.38 + smy * 0.4;
    var cy = Math.cos(rotY), sy = Math.sin(rotY), cx = Math.cos(rotX), sx = Math.sin(rotX);
    var zoom = 1 + easeIn(ex) * 6;
    var i, d;

    for (i = 0; i < devs.length; i++) {
      d = devs[i];
      var x = d.sx * cy + d.sz * sy, z = -d.sx * sy + d.sz * cy;
      var y = d.sy * cx - z * sx; z = d.sy * sx + z * cx;
      var persp = 2.6 / (2.6 - z * 0.9);
      var hx = CX + x * R * persp * zoom, hy = CY + y * R * persp * zoom;
      var k = clamp((t - d.t0) / 0.95), e = easeOut(k);
      d.arrived = k;
      // Fly in along a curve from far outside the screen, leaving a short streak.
      var sxp = CX + d.ox, syp = CY + d.oy;
      var mxp = (sxp + hx) / 2 + (hy - syp) * d.bend, myp = (syp + hy) / 2 - (hx - sxp) * d.bend;
      var px = bez(sxp, mxp, hx, e), py = bez(syp, myp, hy, e);
      if (k > 0 && k < 1) {
        var e2 = easeOut(clamp((t - 0.06 - d.t0) / 0.95));
        var qx = bez(sxp, mxp, hx, e2), qy = bez(syp, myp, hy, e2);
        ctx.strokeStyle = "rgba(255,190,150," + (0.6 * (1 - k)).toFixed(3) + ")";
        ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(qx, qy); ctx.lineTo(px, py); ctx.stroke();
      }
      d.px = px; d.py = py; d.z = z; d.ps = persp * (1 + easeIn(ex) * 2);
      if (k === 1 && !d.locked) { d.locked = true; d.flash = Math.max(d.flash, 0.7); }
      d.flash *= 0.94;
    }

    // Links between settled neighbours, brighter at the front.
    // Drawn in three depth bands, one path each, instead of one stroke per link.
    ctx.lineWidth = 1;
    for (var band = 0; band < 3; band++) {
      ctx.beginPath();
      for (var l = 0; l < links.length; l++) {
        var A = devs[links[l][0]], B = devs[links[l][1]];
        if (A.arrived < 1 || B.arrived < 1) continue;
        var depth = ((A.z + B.z) / 2 + 1) / 2, bnd = depth < 0.33 ? 0 : depth < 0.66 ? 1 : 2;
        if (bnd !== band) continue;
        ctx.moveTo(A.px, A.py); ctx.lineTo(B.px, B.py);
      }
      ctx.strokeStyle = "rgba(252,224,207," + ((0.06 + 0.06 * band) * (1 - ex)).toFixed(3) + ")";
      ctx.stroke();
    }

    // Beat two: tasks pulse out from the core and results travel back.
    if (t > 1.7 && t < 3.7 && !leaveAt && Math.random() < 0.55) {
      var tgt = devs[(Math.random() * devs.length) | 0];
      if (tgt.arrived === 1 && tgt.z > -0.2) pulses.push({ d: tgt, t: t, back: false });
    }
    for (var p = pulses.length - 1; p >= 0; p--) {
      var P = pulses[p], f = (t - P.t) / 0.55;
      if (f >= 1) {
        if (!P.back) { P.d.flash = 1; P.back = true; P.t = t; continue; }
        pulses.splice(p, 1); continue;
      }
      var ff = P.back ? 1 - f : f;
      ctx.strokeStyle = "rgba(255,122,69," + (0.16 * (1 - ex)).toFixed(3) + ")";
      ctx.beginPath(); ctx.moveTo(CX, CY); ctx.lineTo(P.d.px, P.d.py); ctx.stroke();
      glow(CX + (P.d.px - CX) * ff, CY + (P.d.py - CY) * ff, 7, P.back ? "255,236,224" : "255,148,102", 0.95 * (1 - ex));
    }

    // Beat three: the checked shockwave lights every device as it passes.
    if (t > 2.75 && !checked) {
      checked = true;
      for (i = 0; i < devs.length; i++) devs[i].wave = 2.75 + Math.hypot(devs[i].px - CX, devs[i].py - CY) / (R * 2.4) * 0.9;
    }
    if (checked) {
      var sw = t - 2.75;
      if (sw < 1.4) {
        var fade = 1 - sw / 1.4;
        ctx.strokeStyle = "rgba(255,148,102," + (0.75 * fade).toFixed(3) + ")";
        ctx.lineWidth = 2.5 * fade + 0.5;
        ctx.beginPath(); ctx.arc(CX, CY, easeOut(clamp(sw / 1.4)) * R * 2.4, 0, 6.283); ctx.stroke();
      }
      for (i = 0; i < devs.length; i++) if (devs[i].wave && t > devs[i].wave) { devs[i].flash = 1; devs[i].wave = 0; }
    }

    // Devices: tiny phones, back ones dimmer; flashing ones glow orange.
    order.sort(function (a, b) { return a.z - b.z; });
    var small = W < 700 ? 0.8 : 1;
    for (i = 0; i < order.length; i++) {
      d = order[i];
      if (d.arrived <= 0) continue;
      var front = (d.z + 1) / 2, s = d.ps * small;
      var dw = 5 * s, dh = 9 * s;
      var alpha = (0.25 + 0.75 * front) * (1 - ex * 0.6);
      var fl = d.flash;
      if (fl > 0.05) glow(d.px, d.py, 16 * s * (0.6 + fl), "255,122,69", 0.55 * fl * alpha);
      var tw = 0.75 + Math.sin(t * 2 + d.ph) * 0.25;
      ctx.fillStyle = "rgba(" + Math.round(236 + 19 * fl) + "," + Math.round(238 - 116 * fl) + "," + Math.round(243 - 174 * fl) + "," + (alpha * tw).toFixed(3) + ")";
      roundRect(d.px - dw / 2, d.py - dh / 2, dw, dh, 1.4 * s); ctx.fill();
    }

    // The exit: a ring of light spreads from the core as the overlay dissolves.
    if (leaveAt) {
      var ring = easeOut(ex) * Math.hypot(W, H) * 0.75, ra = 1 - ex;
      ctx.lineWidth = 18; ctx.strokeStyle = "rgba(255,122,69," + (0.12 * ra).toFixed(3) + ")";
      ctx.beginPath(); ctx.arc(CX, CY, ring, 0, 6.283); ctx.stroke();
      ctx.lineWidth = 2; ctx.strokeStyle = "rgba(255,190,150," + (0.85 * ra).toFixed(3) + ")";
      ctx.beginPath(); ctx.arc(CX, CY, ring, 0, 6.283); ctx.stroke();
    }

  }


  function loop() {
    if (!running) return;
    draw(now());
    raf(loop);
  }
  function handle(m) {
    if (m.type === "init") {
      canvas = m.canvas; ctx = canvas.getContext("2d"); started = m.start;
      size(m); seed(); running = true; raf(loop);
    } else if (m.type === "resize") { size(m); seed(); }
    else if (m.type === "pointer") { mx = m.mx; my = m.my; }
    else if (m.type === "leave") { leaveAt = m.at; }
    else if (m.type === "stop") { running = false; }
  }
  if (typeof WorkerGlobalScope !== "undefined" && root instanceof WorkerGlobalScope) root.onmessage = function (e) { handle(e.data); };
  else root.__anIntroScene = handle;
})(self);
