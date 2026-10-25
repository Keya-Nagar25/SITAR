/*
 * Builds a standalone HTML report (prints cleanly to PDF) from metric runs
 * plus a few rendered example comparisons.
 */
window.TI = window.TI || {};
(function (TI) {
  "use strict";
  const { api, fmt, charts, metrics: M, field: F } = TI;
  const esc = charts.esc;

  const THEME = { ink: "#1B1A17", ink2: "#4A463E", ink3: "#7A7468", grid: "#E2DDD0", surface: "#FFFFFF" };
  const C_MODEL = "#C4461A", C_BASE = "#00809A";

  async function canvasUrl(fn) {
    const c = document.createElement("canvas");
    await fn(c);
    return c.toDataURL("image/png");
  }

  async function exampleImages(row) {
    const truth = row._truth || (row.truth_id && api.frameById(row.truth_id));
    const pred = row._pred || (row.pred_id && api.frameById(row.pred_id));
    if (!truth || !pred) return null;
    const [vt, vp] = await Promise.all([api.values(truth), api.values(pred)]);
    const base = await api.baselineValues(pred);
    const out = {
      time: row.timestamp,
      truth: await canvasUrl((c) => api.draw(c, truth, "enhanced")),
      pred: await canvasUrl((c) => api.draw(c, pred, "enhanced")),
      diff: await canvasUrl((c) => F.paintDiff(c, vt.data, vp.data, vt.w, vt.h, 12)),
      base: base ? await canvasUrl((c) => F.paintBT(c, base, "enhanced", vt.w, vt.h)) : null,
      m: row.model,
      b: row.baseline,
    };
    return out;
  }

  function pickExamples(rows, n) {
    if (rows.length <= n) return rows;
    const idx = new Set();
    for (let k = 0; k < n; k++) idx.add(Math.round((k / (n - 1)) * (rows.length - 1)));
    return [...idx].map((i) => rows[i]);
  }

  function keysOf(run) {
    const present = new Set();
    run.frames.forEach((r) => Object.keys(r.model || {}).forEach((k) => present.add(k)));
    return M.ORDER.filter((k) => present.has(k));
  }

  function summaryRows(run) {
    return keysOf(run).map((k) => {
      const d = M.DEFS[k];
      const mv = M.mean(run.frames.map((r) => r.model[k]));
      const hasB = run.frames.some((r) => r.baseline && Number.isFinite(r.baseline[k]));
      const bv = hasB ? M.mean(run.frames.map((r) => r.baseline[k])) : NaN;
      const better = hasB && (d.higher ? mv > bv : mv < bv);
      return `<tr><td>${d.label}${d.unit ? ` <span class="u">(${d.unit})</span>` : ""}</td><td class="${better ? "good" : ""}">${d.fmt(mv)}</td><td>${hasB ? d.fmt(bv) : "–"}</td><td>${d.higher ? "higher" : "lower"} is better</td></tr>`;
    }).join("");
  }

  function chartBlock(run, key) {
    const d = M.DEFS[key];
    const labels = run.frames.map((r) => fmt.hhmm(r.timestamp));
    const series = [{ name: run.model_name || "Model", color: C_MODEL, values: run.frames.map((r) => r.model[key]) }];
    if (run.frames.some((r) => r.baseline && Number.isFinite(r.baseline[key]))) {
      series.push({ name: run.baseline_name || "Linear blend", color: C_BASE, values: run.frames.map((r) => r.baseline && r.baseline[key]), dash: true });
    }
    const { svg } = charts.lineSvg({ labels, series, width: 520, height: 190, theme: THEME });
    return `<div class="ch"><div class="cht">${d.label}${d.unit ? ` (${d.unit})` : ""} <span>${d.higher ? "higher" : "lower"} is better</span></div>${svg}</div>`;
  }

  function frameTable(run) {
    const keys = keysOf(run);
    const hasB = run.frames.some((r) => r.baseline);
    const head = keys.map((k) => `<th>${M.DEFS[k].label}</th>${hasB ? `<th class="b">blend</th>` : ""}`).join("");
    const body = run.frames.map((r) => `<tr><td>${fmt.hhmm(r.timestamp)}</td>${keys.map((k) => `<td>${M.DEFS[k].fmt(r.model[k])}</td>${hasB ? `<td class="b">${r.baseline ? M.DEFS[k].fmt(r.baseline[k]) : "–"}</td>` : ""}`).join("")}</tr>`).join("");
    return `<table class="t small"><thead><tr><th>Frame (UTC)</th>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  async function build({ runs, examples = 3, author = "", demo = false, onStatus }) {
    const now = new Date();
    const sections = [];
    let exHtml = "";
    const exRun = runs.find((r) => r.frames.some((f) => f._truth || f.truth_id));
    if (exRun) {
      const picks = pickExamples(exRun.frames, examples);
      const items = [];
      for (let i = 0; i < picks.length; i++) {
        onStatus && onStatus(`Rendering example ${i + 1} of ${picks.length}…`);
        const ex = await exampleImages(picks[i]);
        if (ex) items.push(ex);
      }
      exHtml = items.map((ex) => `
        <div class="ex">
          <div class="exh">${esc(exRun.satellite || exRun.name)} · ${fmt.full(ex.time)} <span>SSIM ${ex.m.ssim.toFixed(3)} · PSNR ${ex.m.psnr.toFixed(1)} dB${ex.b ? ` &nbsp;|&nbsp; blend SSIM ${ex.b.ssim.toFixed(3)}` : ""}</span></div>
          <div class="exg">
            <figure><img src="${ex.truth}"><figcaption>Observed (ground truth)</figcaption></figure>
            <figure><img src="${ex.pred}"><figcaption class="syn">Generated · ${esc(exRun.model_name || "model")}</figcaption></figure>
            ${ex.base ? `<figure><img src="${ex.base}"><figcaption>Linear blend (baseline)</figcaption></figure>` : ""}
            <figure><img src="${ex.diff}"><figcaption>Generated − observed, ±12 K</figcaption></figure>
          </div>
        </div>`).join("");
    }

    runs.forEach((run) => {
      const keys = keysOf(run).filter((k) => ["ssim", "psnr", "mse", "mae", "fsim", "cloud_iou"].includes(k)).slice(0, 6);
      sections.push(`
        <section class="run">
          <h2>${esc(run.name || run.run)}</h2>
          <p class="sub">${run.frames.length} generated frames scored against real observations${run.gap_min ? ` · inputs ${run.gap_min} min apart, target at the midpoint` : ""}.</p>
          <table class="t"><thead><tr><th>Metric</th><th>${esc(run.model_name || "Model")}</th><th>${esc(run.baseline_name || "Linear blend")}</th><th></th></tr></thead><tbody>${summaryRows(run)}</tbody></table>
          <div class="lg"><span><i style="background:${C_MODEL}"></i>${esc(run.model_name || "Model")}</span><span><i class="dash" style="color:${C_BASE}"></i>${esc(run.baseline_name || "Linear blend")}</span></div>
          <div class="chs">${keys.map((k) => chartBlock(run, k)).join("")}</div>
          <h3>Per-frame values</h3>
          ${frameTable(run)}
        </section>`);
    });

    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Interpolation comparison report</title>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,300..800&family=Martian+Mono:wdth,wght@75..112,300..600&display=swap" rel="stylesheet">
<style>
  @page { size: A4; margin: 14mm; }
  body { font-family: Archivo, Arial, sans-serif; color: #1B1A17; background: #fff; margin: 0 auto; max-width: 1060px; padding: 28px; font-size: 12.5px; line-height: 1.45; }
  header { border-bottom: 3px solid #1B1A17; padding-bottom: 12px; margin-bottom: 18px; }
  header + section h2 { border-top: 0; padding-top: 0; }
  .k { font-family: "Martian Mono", monospace; font-size: 10px; color: #C4461A; text-transform: uppercase; letter-spacing: .08em; }
  h1 { font-size: 30px; line-height: 1; margin: 6px 0 8px; font-weight: 800; font-variation-settings: "wdth" 66; text-transform: uppercase; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .06em; font-variation-settings: "wdth" 75; margin: 0 0 4px; border-top: 1px solid #1B1A17; padding-top: 10px; }
  h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #4A463E; margin: 18px 0 6px; }
  .meta { font-family: "Martian Mono", monospace; font-size: 10px; color: #4A463E; display: flex; gap: 22px; flex-wrap: wrap; }
  .warn { border: 1px solid #C4461A; color: #8f2f0f; padding: 8px 10px; margin: 12px 0 0; font-size: 11.5px; }
  .sub { color: #4A463E; margin: 0 0 10px; }
  section { margin: 0 0 26px; }
  .run { break-before: page; }
  .run:first-of-type { break-before: auto; }
  .t { border-collapse: collapse; width: 100%; font-family: "Martian Mono", monospace; font-size: 10.5px; margin-bottom: 10px; }
  .t th, .t td { text-align: right; padding: 5px 8px; border-bottom: 1px solid #E2DDD0; }
  .t th { font-family: Archivo, sans-serif; text-transform: uppercase; font-size: 9.5px; letter-spacing: .06em; color: #4A463E; border-bottom: 1px solid #1B1A17; }
  .t th:first-child, .t td:first-child { text-align: left; }
  .t td.good { color: #3D7A34; font-weight: 600; }
  .t .u { color: #7A7468; }
  .t.small { font-size: 9.5px; }
  .t .b { color: #7A7468; }
  .lg { display: flex; gap: 18px; font-size: 11px; color: #4A463E; margin: 6px 0; }
  .lg i { display: inline-block; width: 16px; height: 2px; vertical-align: middle; margin-right: 6px; }
  .lg i.dash { background: repeating-linear-gradient(90deg, currentColor 0 4px, transparent 4px 7px); }
  .chs { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 22px; }
  .ch { break-inside: avoid; }
  .cht { font-weight: 700; font-size: 11.5px; } .cht span { font-weight: 400; color: #7A7468; font-size: 10.5px; margin-left: 6px; }
  svg { width: 100%; height: auto; display: block; }
  .ex { break-inside: avoid; margin-bottom: 18px; }
  .exh { font-family: "Martian Mono", monospace; font-size: 10.5px; padding: 5px 0; border-bottom: 1px solid #1B1A17; margin-bottom: 6px; display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
  .exh span { color: #4A463E; }
  .exg { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  figure { margin: 0; } figure img { width: 100%; display: block; image-rendering: pixelated; background: #0e0e0d; }
  figcaption { font-size: 10px; color: #4A463E; margin-top: 3px; } figcaption.syn { color: #C4461A; font-weight: 600; }
  .notes dt { font-weight: 700; margin-top: 6px; } .notes dd { margin: 0 0 0 0; color: #4A463E; }
  @media print { body { padding: 0; } }
</style></head><body>
<header>
  <div class="k">Comparison report · generated frames vs ground truth</div>
  <h1>Temporal interpolation of geostationary thermal-IR imagery</h1>
  <div class="meta"><span>Created ${esc(fmt.full(now.toISOString()))}</span>${author ? `<span>Prepared by ${esc(author)}</span>` : ""}<span>Runs: ${runs.length}</span></div>
  ${demo ? `<div class="warn"><b>Demo data.</b> These figures come from the dashboard's built-in simulator, not a trained model. Connect the backend and rebuild before using this report.</div>` : ""}
</header>
${exHtml ? `<section><h2>Example comparisons</h2><p class="sub">Brightness temperature with the IR enhancement palette (cold cloud tops in colour). The error panel shows where the generated frame is too warm (orange) or too cold (cyan).</p>${exHtml}</section>` : ""}
${sections.join("")}
<section>
  <h2>Metric definitions</h2>
  <dl class="notes">
    ${M.ORDER.map((k) => `<dt>${M.DEFS[k].label}</dt><dd>${M.DEFS[k].desc}${M.DEFS[k].unit ? ` (${M.DEFS[k].unit})` : ""}. ${M.DEFS[k].higher ? "Higher" : "Lower"} is better.</dd>`).join("")}
    <dt>Linear blend baseline</dt><dd>Pixel-wise weighted average of the two input frames. It has no motion model, so moving cloud shows up as double edges ("ghosting"). The model has to beat this to be worth using.</dd>
  </dl>
</section>
</body></html>`;
  }

  TI.report = { build };
})(window.TI);
