/*
 * Brightness-temperature fields: rendering (colour maps) for any frame, plus a
 * synthetic cloud generator used only in demo mode so the UI can run without
 * the Python backend.
 */
window.TI = window.TI || {};
(function (TI) {
  "use strict";

  const N = 256;          // demo grid is N x N
  const BT_MIN = 180;     // K, colour-map range
  const BT_MAX = 320;

  /* ------------------------------------------------------------ noise */
  function hash(x, y, s) {
    let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(s, 982451653);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
  }
  function vnoise(x, y, s) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y, s, oct) {
    let sum = 0, amp = 0.5, f = 1, norm = 0;
    for (let i = 0; i < oct; i++) {
      sum += amp * vnoise(x * f, y * f, s + i * 17);
      norm += amp; f *= 2.03; amp *= 0.5;
    }
    return sum / norm;
  }
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const smoothstep = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };

  /* ------------------------------------------------------------ scenes */
  // Each demo "satellite" gets its own weather: a drifting cloud deck, a
  // rotating cyclone-like system and one convective cell that grows fast
  // (the non-linear case plain blending gets wrong).
  function makeScene(seed) {
    const r = (k) => hash(seed, k, 7);
    return {
      seed,
      wind: { u: 0.22 + r(1) * 0.2, v: 0.04 + r(2) * 0.08 },
      systems: [
        { kind: "cyclone", x: 70 + r(3) * 40, y: 150 + r(4) * 30, vx: 0.16, vy: -0.07, R: 42, omega: 0.009, twist: 2.6, grow: null },
        { kind: "band", x: 190, y: 60 + r(5) * 30, vx: 0.28, vy: 0.05, R: 36, omega: 0.002, twist: 0.8, grow: null },
        { kind: "cell", x: 150 + r(6) * 40, y: 170 + r(7) * 30, vx: 0.12, vy: 0.02, R: 20, omega: 0.004, twist: 0.5, grow: { t0: 55 + r(8) * 50, rate: 14 } },
      ],
    };
  }

  const surfaceCache = new Map();
  function surface(scene) {
    if (surfaceCache.has(scene.seed)) return surfaceCache.get(scene.seed);
    const s = new Float32Array(N * N);
    for (let y = 0; y < N; y++) {
      const lat = Math.abs(y / N - 0.52);
      for (let x = 0; x < N; x++) {
        const land = smoothstep(0.52, 0.6, fbm(x / 70, y / 70, scene.seed + 99, 4));
        s[y * N + x] = 301 - 34 * Math.pow(lat, 1.6) + land * (5 + 3 * fbm(x / 12, y / 12, scene.seed + 5, 2));
      }
    }
    surfaceCache.set(scene.seed, s);
    return s;
  }

  // Brightness temperature (K) at minute t.
  function generate(scene, t) {
    const out = new Float32Array(N * N);
    const surf = surface(scene);
    const cloud = new Float32Array(N * N);
    const depth = new Float32Array(N * N);
    const { u, v } = scene.wind;

    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const n = fbm((x - u * t) / 38, (y - v * t) / 38, scene.seed, 5);
        cloud[y * N + x] = smoothstep(0.55, 0.78, n) * 0.75;
        depth[y * N + x] = smoothstep(0.62, 0.9, n) * 0.35;
      }
    }

    for (let si = 0; si < scene.systems.length; si++) {
      const sy = scene.systems[si];
      const cx = sy.x + sy.vx * t, cy = sy.y + sy.vy * t;
      let amp = 1, R = sy.R;
      if (sy.grow) {
        const g = 1 / (1 + Math.exp(-(t - sy.grow.t0) / sy.grow.rate));
        amp = 0.08 + 0.92 * g;
        R = sy.R * (0.45 + 0.9 * g);
      }
      const ext = Math.ceil(R * 2.2);
      const x0 = Math.max(0, Math.floor(cx - ext)), x1 = Math.min(N - 1, Math.ceil(cx + ext));
      const y0 = Math.max(0, Math.floor(cy - ext)), y1 = Math.min(N - 1, Math.ceil(cy + ext));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x - cx, dy = y - cy;
          const r = Math.sqrt(dx * dx + dy * dy);
          const rn = r / R;
          if (rn > 2.2) continue;
          const ang = Math.atan2(dy, dx) + sy.twist * Math.exp(-rn) + sy.omega * t;
          const px = r * Math.cos(ang), py = r * Math.sin(ang);
          const tex = fbm(px / 16 + 50, py / 16 + 50, scene.seed + 31 * (si + 1), 4);
          let d = Math.exp(-rn * rn) * (0.55 + 0.9 * tex);
          if (sy.kind === "cyclone") {
            // spiral arms + clear eye
            const arm = 0.5 + 0.5 * Math.sin(2 * Math.atan2(dy, dx) - 3.2 * Math.log(1 + rn * 2) + sy.omega * t * 3);
            d = Math.max(d, Math.exp(-Math.pow(rn / 1.6, 2)) * arm * 0.9 * (0.6 + 0.6 * tex));
            d *= 1 - Math.exp(-Math.pow(r / 5, 2));
          }
          d *= amp;
          const i = y * N + x;
          cloud[i] = Math.max(cloud[i], clamp01(d));
          depth[i] = Math.max(depth[i], clamp01(d * 1.15 - 0.15));
        }
      }
    }

    for (let i = 0; i < N * N; i++) {
      const a = smoothstep(0.05, 0.65, cloud[i]);
      const top = 252 - 58 * depth[i];
      out[i] = surf[i] * (1 - a) + top * a;
    }
    return out;
  }

  /* ------------------------------------------------------------ colour maps */
  function hexToRgb(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
  function buildLut(stops) {
    // stops: [[K, "#hex"], ...] in ascending K
    const lut = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const k = BT_MIN + (i / 255) * (BT_MAX - BT_MIN);
      let j = 0;
      while (j < stops.length - 2 && k > stops[j + 1][0]) j++;
      const [k0, c0] = stops[j], [k1, c1] = stops[j + 1];
      const t = clamp01((k - k0) / (k1 - k0));
      const a = hexToRgb(c0), b = hexToRgb(c1);
      for (let c = 0; c < 3; c++) lut[i * 3 + c] = a[c] + (b[c] - a[c]) * t;
    }
    return lut;
  }
  const LUTS = {
    // cold = bright, the usual IR convention
    gray: buildLut([[180, "#ffffff"], [320, "#000000"]]),
    // classic enhancement: grey above ~240 K, colours for deep convection
    enhanced: buildLut([
      [180, "#f4f4f4"], [190, "#8a1616"], [198, "#d8401a"], [206, "#eec33a"],
      [214, "#3fa650"], [224, "#1d4fb8"], [236, "#62c3ec"], [240, "#b4b4b4"],
      [320, "#0c0c0c"],
    ]),
  };
  const CMAP_CSS = {
    gray: "linear-gradient(90deg,#fff,#000)",
    enhanced: "linear-gradient(90deg,#f4f4f4 0%,#8a1616 7%,#d8401a 13%,#eec33a 19%,#3fa650 24%,#1d4fb8 31%,#62c3ec 40%,#b4b4b4 43%,#0c0c0c 100%)",
  };

  function paintBT(canvas, bt, cmap, w = N, h = N) {
    const lut = LUTS[cmap] || LUTS.gray;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(w, h);
    const d = img.data;
    for (let i = 0; i < w * h; i++) {
      let k = Math.round(((bt[i] - BT_MIN) / (BT_MAX - BT_MIN)) * 255);
      k = k < 0 ? 0 : k > 255 ? 255 : k;
      d[i * 4] = lut[k * 3]; d[i * 4 + 1] = lut[k * 3 + 1]; d[i * 4 + 2] = lut[k * 3 + 2]; d[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  // Signed error map: model colder than truth -> cyan, warmer -> orange, 0 -> black.
  function paintDiff(canvas, a, b, w, h, range = 12) {
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(w, h);
    const d = img.data;
    for (let i = 0; i < w * h; i++) {
      const e = Math.max(-1, Math.min(1, (b[i] - a[i]) / range));
      const m = Math.pow(Math.abs(e), 0.7);
      if (e >= 0) { d[i * 4] = 20 + 235 * m; d[i * 4 + 1] = 20 + 110 * m; d[i * 4 + 2] = 20 + 20 * m; }
      else { d[i * 4] = 20 + 20 * m; d[i * 4 + 1] = 20 + 180 * m; d[i * 4 + 2] = 20 + 225 * m; }
      d[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  /* ------------------------------------------------------------ demo model */
  function sample(f, x, y) {
    x = Math.max(0, Math.min(N - 1.001, x)); y = Math.max(0, Math.min(N - 1.001, y));
    const xi = x | 0, yi = y | 0, xf = x - xi, yf = y - yi;
    const i = yi * N + xi;
    return f[i] * (1 - xf) * (1 - yf) + f[i + 1] * xf * (1 - yf) + f[i + N] * (1 - xf) * yf + f[i + N + 1] * xf * yf;
  }

  const MODEL_ERR = {
    SatelliteRIFE: { disp: 0.7, blur: 0.25, ghost: 0.1, noise: 0.5 },
    "RIFE-pretrained": { disp: 1.1, blur: 0.35, ghost: 0.18, noise: 0.6 },
    SuperSloMo: { disp: 1.6, blur: 0.5, ghost: 0.26, noise: 0.8 },
  };

  // Stand-in for the network: the true field with the kind of error a flow
  // model makes (small misplacement, some smoothing, residual ghosting).
  function fakeModel(truth, f0, f1, w, gapMin, model, seed) {
    const p = MODEL_ERR[model] || MODEL_ERR.SatelliteRIFE;
    const scale = 4 * w * (1 - w) * Math.max(0.6, gapMin / 20);
    const a = p.disp * scale;
    const out = new Float32Array(N * N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const ex = a * Math.sin(y / 21 + seed) + 0.5 * a * Math.sin(x / 9 + y / 13);
        const ey = a * Math.cos(x / 27 + seed * 0.7);
        out[y * N + x] = sample(truth, x + ex, y + ey);
      }
    }
    const blurred = new Float32Array(N * N);
    for (let y = 1; y < N - 1; y++) {
      for (let x = 1; x < N - 1; x++) {
        const i = y * N + x;
        blurred[i] = (out[i] * 4 + out[i - 1] + out[i + 1] + out[i - N] + out[i + N]) / 8;
      }
    }
    const g = p.ghost * scale;
    for (let i = 0; i < N * N; i++) {
      const b = blurred[i] || out[i];
      let v = out[i] * (1 - p.blur) + b * p.blur;
      v = v * (1 - g) + ((1 - w) * f0[i] + w * f1[i]) * g;
      v += (hash(i, seed | 0, 3) - 0.5) * 2 * p.noise;
      out[i] = v;
    }
    return out;
  }

  function blend(f0, f1, w) {
    const out = new Float32Array(f0.length);
    for (let i = 0; i < f0.length; i++) out[i] = (1 - w) * f0[i] + w * f1[i];
    return out;
  }

  /* ------------------------------------------------------------ flow */
  // Coarse block-matching flow between two frames. Used in demo mode for the
  // vector overlay; a live backend can send its own flow grid instead.
  function blockFlow(a, b, w = N, h = N, block = 16, search = 8) {
    const gw = Math.floor(w / block), gh = Math.floor(h / block);
    const u = new Float32Array(gw * gh), v = new Float32Array(gw * gh), mag = new Float32Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        const bx = gx * block, by = gy * block;
        let best = Infinity, bu = 0, bv = 0, zero = 0;
        let varSum = 0, mean = 0;
        for (let yy = 0; yy < block; yy++) for (let xx = 0; xx < block; xx++) mean += a[(by + yy) * w + bx + xx];
        mean /= block * block;
        for (let yy = 0; yy < block; yy++) for (let xx = 0; xx < block; xx++) { const d = a[(by + yy) * w + bx + xx] - mean; varSum += d * d; }
        for (let dy = -search; dy <= search; dy += 1) {
          for (let dx = -search; dx <= search; dx += 1) {
            const sx = bx + dx, sy = by + dy;
            if (sx < 0 || sy < 0 || sx + block > w || sy + block > h) continue;
            let sad = 0;
            for (let yy = 0; yy < block; yy += 2) {
              const ra = (by + yy) * w + bx, rb = (sy + yy) * w + sx;
              for (let xx = 0; xx < block; xx += 2) sad += Math.abs(a[ra + xx] - b[rb + xx]);
              if (sad >= best) break;
            }
            if (dx === 0 && dy === 0) zero = sad;
            if (sad < best || (sad === best && dx * dx + dy * dy < bu * bu + bv * bv)) { best = sad; bu = dx; bv = dy; }
          }
        }
        // flat blocks (clear sky) have no trackable texture
        const textured = varSum / (block * block) > 4 && best < zero * 0.9;
        const k = gy * gw + gx;
        u[k] = textured ? bu : 0; v[k] = textured ? bv : 0;
        mag[k] = textured ? Math.hypot(bu, bv) : 0;
      }
    }
    return { grid_w: gw, grid_h: gh, block, u: Array.from(u), v: Array.from(v) };
  }

  function drawFlow(canvas, flow, displayScale = 1) {
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const sx = W / flow.grid_w, sy = H / flow.grid_h;
    ctx.lineWidth = Math.max(1.5, W / 300);
    ctx.lineCap = "round";
    for (let gy = 0; gy < flow.grid_h; gy++) {
      for (let gx = 0; gx < flow.grid_w; gx++) {
        const k = gy * flow.grid_w + gx;
        const u = flow.u[k] * (W / (flow.grid_w * flow.block)) * displayScale;
        const v = flow.v[k] * (H / (flow.grid_h * flow.block)) * displayScale;
        const m = Math.hypot(u, v);
        if (m < 0.5) continue;
        const x0 = (gx + 0.5) * sx, y0 = (gy + 0.5) * sy;
        const x1 = x0 + u, y1 = y0 + v;
        ctx.strokeStyle = "rgba(0,0,0,0.55)";
        ctx.lineWidth = Math.max(3, W / 170);
        line(ctx, x0, y0, x1, y1, m);
        ctx.strokeStyle = "#ff8a3d";
        ctx.lineWidth = Math.max(1.5, W / 340);
        line(ctx, x0, y0, x1, y1, m);
      }
    }
    function line(c, x0, y0, x1, y1, m) {
      const ang = Math.atan2(y1 - y0, x1 - x0), hl = Math.min(8, 3 + m * 0.3) * (W / 512);
      c.beginPath();
      c.moveTo(x0, y0); c.lineTo(x1, y1);
      c.moveTo(x1, y1); c.lineTo(x1 - hl * Math.cos(ang - 0.5), y1 - hl * Math.sin(ang - 0.5));
      c.moveTo(x1, y1); c.lineTo(x1 - hl * Math.cos(ang + 0.5), y1 - hl * Math.sin(ang + 0.5));
      c.stroke();
    }
  }

  TI.field = {
    N, BT_MIN, BT_MAX, CMAP_CSS,
    makeScene, generate, fakeModel, blend, blockFlow,
    paintBT, paintDiff, drawFlow,
  };
})(window.TI);
