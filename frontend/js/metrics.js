/*
 * Image-similarity metrics, computed in the browser. Used for demo data and as
 * a fallback when the backend sends frames without a metrics block. The
 * backend's utils.compute_metrics() values take priority whenever present.
 */
window.TI = window.TI || {};
(function (TI) {
  "use strict";

  // kind: "bt" -> values are Kelvin; "lum" -> 0..255 display luminance
  function compute(truth, pred, opts = {}) {
    const kind = opts.kind || "bt";
    const range = kind === "bt" ? 140 : 255;
    const lo = kind === "bt" ? 180 : 0;
    const w = opts.w || 256, h = opts.h || 256;
    const n = truth.length;

    let se = 0, ae = 0;
    for (let i = 0; i < n; i++) { const d = pred[i] - truth[i]; se += d * d; ae += Math.abs(d); }
    const mse = se / n, mae = ae / n;
    const psnr = mse === 0 ? 99 : 10 * Math.log10((range * range) / mse);

    const out = { ssim: ssim(truth, pred, w, h, lo, range), mse, mae, psnr };
    if (kind === "bt") {
      out.cloud_iou = coldIoU(truth, pred, 235);
      out.grad_ssim = gradSsim(truth, pred, w, h);
    }
    return out;
  }

  // Windowed SSIM on [0,1]-normalised data, 8x8 windows, stride 4.
  function ssim(a, b, w, h, lo, range) {
    const C1 = 0.01 * 0.01, C2 = 0.03 * 0.03;
    const win = 8, step = 4;
    let total = 0, count = 0;
    for (let y = 0; y + win <= h; y += step) {
      for (let x = 0; x + win <= w; x += step) {
        let ma = 0, mb = 0;
        for (let j = 0; j < win; j++) for (let i = 0; i < win; i++) {
          const k = (y + j) * w + x + i;
          ma += (a[k] - lo) / range; mb += (b[k] - lo) / range;
        }
        const nn = win * win;
        ma /= nn; mb /= nn;
        let va = 0, vb = 0, cov = 0;
        for (let j = 0; j < win; j++) for (let i = 0; i < win; i++) {
          const k = (y + j) * w + x + i;
          const da = (a[k] - lo) / range - ma, db = (b[k] - lo) / range - mb;
          va += da * da; vb += db * db; cov += da * db;
        }
        va /= nn - 1; vb /= nn - 1; cov /= nn - 1;
        total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
        count++;
      }
    }
    return total / count;
  }

  // Overlap of cold cloud tops (BT < thr): does the model put the deep cloud
  // in the right place? Sensitive to motion errors that SSIM averages away.
  function coldIoU(a, b, thr) {
    let inter = 0, uni = 0;
    for (let i = 0; i < a.length; i++) {
      const pa = a[i] < thr, pb = b[i] < thr;
      if (pa && pb) inter++;
      if (pa || pb) uni++;
    }
    return uni === 0 ? 1 : inter / uni;
  }

  // SSIM of gradient magnitude: scores sharpness of cloud edges.
  function gradSsim(a, b, w, h) {
    const ga = grad(a, w, h), gb = grad(b, w, h);
    return ssim(ga, gb, w, h, 0, 40);
  }
  function grad(f, w, h) {
    const g = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      g[i] = Math.hypot(f[i + 1] - f[i - 1], f[i + w] - f[i - w]) / 2;
    }
    return g;
  }

  const DEFS = {
    ssim: { label: "SSIM", unit: "", higher: true, fmt: (v) => v.toFixed(4), desc: "Structural similarity" },
    psnr: { label: "PSNR", unit: "dB", higher: true, fmt: (v) => v.toFixed(2), desc: "Peak signal-to-noise ratio" },
    mse: { label: "MSE", unit: "K²", higher: false, fmt: (v) => v.toFixed(3), desc: "Mean squared error" },
    mae: { label: "MAE", unit: "K", higher: false, fmt: (v) => v.toFixed(3), desc: "Mean absolute error" },
    fsim: { label: "FSIM", unit: "", higher: true, fmt: (v) => v.toFixed(4), desc: "Feature similarity" },
    cloud_iou: { label: "Cold-cloud IoU", unit: "", higher: true, fmt: (v) => v.toFixed(3), desc: "Overlap of cloud tops colder than 235 K" },
    grad_ssim: { label: "Edge SSIM", unit: "", higher: true, fmt: (v) => v.toFixed(4), desc: "SSIM of gradient magnitude (cloud-edge sharpness)" },
  };
  const ORDER = ["ssim", "psnr", "mse", "mae", "fsim", "cloud_iou", "grad_ssim"];

  function mean(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : NaN; }

  TI.metrics = { compute, DEFS, ORDER, mean };
})(window.TI);
