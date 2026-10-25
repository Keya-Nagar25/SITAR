/* Wiring: tabs, connection, and the five screens. */
(function (TI) {
  "use strict";
  const { api, fmt, metrics: M, charts } = TI;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = charts.esc;
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  function toast(msg, ms = 3200) {
    const t = $("#toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (t.hidden = true), ms);
  }
  function seg(el, onChange) {
    el.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b || b.disabled) return;
      $$("button", el).forEach((x) => x.setAttribute("aria-pressed", x === b ? "true" : "false"));
      onChange(b.dataset.v);
    });
  }
  const segValue = (el) => $('button[aria-pressed="true"]', el).dataset.v;
  const cadenceOf = (frames) => {
    if (frames.length < 2) return "";
    const g = fmt.gapMin(frames[0].timestamp, frames[1].timestamp);
    return `${+g.toFixed(2)} min`;
  };
  const download = (name, text, type) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  /* ================================================================ tabs */
  const inited = {};
  function showTab(name) {
    $$(".tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === name ? "true" : "false"));
    $$(".tab-panel").forEach((p) => (p.hidden = p.id !== "tab-" + name));
    store.set("ti.tab", name);
    history.replaceState(null, "", "#" + name);
    if (!inited[name]) { inited[name] = true; INIT[name](); }
  }
  $$(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

  /* ================================================================ connection */
  const pill = $("#connPill"), pop = $("#connPop");
  pill.addEventListener("click", () => (pop.hidden = !pop.hidden));
  document.addEventListener("click", (e) => { if (!e.target.closest(".conn")) pop.hidden = true; });
  $("#connRetry").addEventListener("click", async () => {
    store.set("ti.apiBase", $("#apiBase").value.trim());
    await connect();
    pop.hidden = true;
  });
  $("#connDemo").addEventListener("click", () => {
    store.set("ti.apiBase", "");
    api.useDemo(); setPill(); reset(); pop.hidden = true;
  });

  function setPill() {
    pill.dataset.state = api.mode;
    $("#connLabel").textContent = api.mode === "live" ? "live · " + api.base.replace(/^https?:\/\//, "") : "demo data";
  }
  async function connect() {
    const base = store.get("ti.apiBase", "http://localhost:8000");
    $("#apiBase").value = base;
    $("#connLabel").textContent = "connecting…";
    const ok = await api.connect(base);
    if (base && !ok) toast(`No backend at ${base}. Showing demo data instead.`);
    setPill();
    reset();
  }
  function reset() {
    Object.keys(inited).forEach((k) => delete inited[k]);
    if (anState.player) anState.player.destroy();
    if (inState.player) inState.player.destroy();
    metricsCache.clear();
    const h = location.hash.slice(1);
    showTab(INIT[h] ? h : store.get("ti.tab", "workbench"));
  }

  /* ================================================================ metrics normalisation */
  const metricsCache = new Map();
  const imported = [];
  function normRun(res) {
    const known = new Set(M.ORDER);
    const pick = (o) => { const r = {}; if (!o) return null; Object.keys(o).forEach((k) => { if (known.has(k) && Number.isFinite(+o[k])) r[k] = +o[k]; }); return Object.keys(r).length ? r : null; };
    const frames = (res.frames || []).map((f) => ({
      ...f,
      timestamp: f.timestamp || f.time,
      model: pick(f.model || f.metrics || f),
      baseline: pick(f.baseline || f.baseline_metrics),
    })).filter((f) => f.model && f.timestamp);
    return { ...res, name: res.name || res.run || "Imported run", frames };
  }
  async function getRun(id) {
    const imp = imported.find((r) => r.run === id);
    if (imp) return imp;
    if (!metricsCache.has(id)) metricsCache.set(id, api.metrics(id).then(normRun));
    return metricsCache.get(id);
  }
  const runKeys = (run) => M.ORDER.filter((k) => run.frames.some((r) => Number.isFinite(r.model[k])));
  const hasBaseline = (run, k) => run.frames.some((r) => r.baseline && Number.isFinite(r.baseline[k]));

  function tilesHtml(run, keys) {
    return keys.map((k) => {
      const d = M.DEFS[k];
      const mv = M.mean(run.frames.map((r) => r.model[k]));
      let delta = "";
      if (hasBaseline(run, k)) {
        const bv = M.mean(run.frames.map((r) => r.baseline[k]));
        const diff = mv - bv;
        const better = d.higher ? diff > 0 : diff < 0;
        delta = `<span class="${better ? "up" : "down"}">${better ? "▲ better" : "▼ worse"}</span> than blend (${d.fmt(bv)})`;
      }
      return `<div class="tile"><div class="k">${d.label}</div><div class="v">${d.fmt(mv)}${d.unit ? `<small>${d.unit}</small>` : ""}</div><div class="d">${delta || "mean over " + run.frames.length + " frames"}</div></div>`;
    }).join("");
  }

  /* ================================================================ WORKBENCH */
  const wb = { frames: [], sources: [], result: null, selected: null };
  const compare = new TI.Compare($("#compare"));

  async function initWorkbench() {
    $("#wbResult").hidden = true; $("#wbEmpty").hidden = false; $("#wbMetaPanel").hidden = true; $("#wbOutStrip").innerHTML = "";
    try {
      wb.sources = await api.sources();
    } catch (e) { toast("Could not load sources: " + e.message); return; }
    $("#wbSource").innerHTML = wb.sources.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
    await loadSourceFrames();
  }

  async function loadSourceFrames() {
    const src = $("#wbSource").value;
    wb.frames = await api.frames(src);
    const opts = wb.frames.map((f, i) => `<option value="${i}">${fmt.hhmm(f.timestamp)} · ${fmt.date(f.timestamp).slice(5)}</option>`).join("");
    $("#wbF0").innerHTML = opts;
    $("#wbF1").innerHTML = opts;
    const s = wb.sources.find((x) => x.id === src);
    $("#wbF0").value = "0";
    $("#wbF1").value = String(Math.min(wb.frames.length - 1, s && s.cadence_min <= 10 ? 2 : 1));
    updatePair();
  }

  function updatePair() {
    const i0 = +$("#wbF0").value, i1 = +$("#wbF1").value;
    $$("#wbF1 option").forEach((o) => (o.disabled = +o.value <= i0));
    if (i1 <= i0) $("#wbF1").value = String(Math.min(wb.frames.length - 1, i0 + 1));
    const f0 = wb.frames[+$("#wbF0").value], f1 = wb.frames[+$("#wbF1").value];
    const gap = fmt.gapMin(f0.timestamp, f1.timestamp);
    const factor = +segValue($("#wbFactor"));
    const between = wb.frames.filter((f) => f.timestamp > f0.timestamp && f.timestamp < f1.timestamp).length;
    $("#wbGap").textContent = `Δt = ${gap} min · ${between ? between + " real frame(s) in between to score against" : "no real frames in between"}`;
    $("#wbFactorNote").textContent = `${factor - 1} new frame(s), one every ${+(gap / factor).toFixed(2)} min`;
    $("#wbThumb0Cap").textContent = `t₀ ${fmt.hhmm(f0.timestamp)} · ${f0.file.split("/").pop()}`;
    $("#wbThumb1Cap").textContent = `t₁ ${fmt.hhmm(f1.timestamp)} · ${f1.file.split("/").pop()}`;
    const cm = $("#cmpCmap").value;
    api.draw($("#wbThumb0"), f0, cm).catch(() => {});
    api.draw($("#wbThumb1"), f1, cm).catch(() => {});
  }

  $("#wbSource").addEventListener("change", loadSourceFrames);
  $("#wbF0").addEventListener("change", updatePair);
  $("#wbF1").addEventListener("change", updatePair);
  seg($("#wbFactor"), updatePair);
  seg($("#cmpMode"), (v) => compare.set({ mode: v }));
  $("#cmpCmap").addEventListener("change", () => { compare.set({ cmap: $("#cmpCmap").value }); updatePair(); drawStrip(); });
  $("#cmpFlow").addEventListener("change", (e) => compare.set({ showFlow: e.target.checked }));

  $("#wbRun").addEventListener("click", async () => {
    const f0 = wb.frames[+$("#wbF0").value], f1 = wb.frames[+$("#wbF1").value];
    const params = { source: $("#wbSource").value, frame0: f0.id, frame1: f1.id, factor: +segValue($("#wbFactor")), model: $("#wbModel").value };
    const btn = $("#wbRun");
    btn.disabled = true; btn.textContent = "Running…";
    $("#wbProgress").hidden = false;
    const t0 = performance.now();
    try {
      const res = await api.interpolate(params, (p) => {
        $("#wbProgressFill").style.width = Math.round(p.progress * 100) + "%";
        if (p.stages && p.stages.length) {
          $("#wbStages").innerHTML = p.stages.map((s, i) => `<li class="${i < p.stageIndex ? "done" : i === p.stageIndex ? "active" : ""}">${esc(s)}</li>`).join("");
        } else {
          $("#wbStages").innerHTML = `<li class="active">${esc(p.stage || "running")}</li>`;
        }
      });
      wb.result = res;
      toast(`${res.frames.length} frame(s) generated in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
      showResult();
    } catch (e) {
      toast("Inference failed: " + e.message, 5000);
    } finally {
      btn.disabled = false; btn.textContent = "Run interpolation";
    }
  });

  function drawStrip() {
    if (!wb.result) return;
    const cm = $("#cmpCmap").value;
    $$("#wbOutStrip canvas").forEach((c) => {
      const f = wb.result.frames.find((x) => x.id === c.dataset.id);
      if (f) api.draw(c, f, cm);
    });
  }

  function showResult() {
    const res = wb.result;
    $("#wbEmpty").hidden = true;
    $("#wbResult").hidden = false;
    const strip = $("#wbOutStrip");
    strip.innerHTML = res.frames.map((f) => `<button data-id="${esc(f.id)}" aria-pressed="false" title="${esc(fmt.full(f.timestamp))}"><canvas data-id="${esc(f.id)}"></canvas><span>${fmt.hhmmss(f.timestamp)}</span></button>`).join("");
    drawStrip();
    $$("button", strip).forEach((b) => b.addEventListener("click", () => selectOutput(b.dataset.id)));
    const first = res.frames.find((f) => f.ground_truth_id) || res.frames[0];
    selectOutput(first.id);
  }

  async function selectOutput(id) {
    const res = wb.result;
    const fr = res.frames.find((f) => f.id === id);
    wb.selected = fr;
    $$("#wbOutStrip button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.id === id ? "true" : "false"));
    const truth = fr.ground_truth_id ? api.frameById(fr.ground_truth_id, wb.frames) : null;
    ["swipe", "blink", "diff"].forEach((m) => ($(`#cmpMode button[data-v="${m}"]`).disabled = !truth));
    if (!truth && segValue($("#cmpMode")) !== "side") $('#cmpMode button[data-v="side"]').click();
    compare.set({ truth, pred: fr, flow: res.flow, cmap: $("#cmpCmap").value });
    $("#cmpFlow").disabled = !res.flow;

    // metrics
    const box = $("#wbMetrics");
    let m = fr.metrics, b = fr.baseline_metrics;
    if (truth && !m) {
      box.innerHTML = `<div class="hint">Scoring…</div>`;
      const [vt, vp] = await Promise.all([api.values(truth), api.values(fr)]);
      m = fr.metrics = M.compute(vt.data, vp.data, { w: vt.w, h: vt.h });
    }
    if (!truth) {
      box.innerHTML = `<div class="hint" style="grid-column:1/-1">Nothing to score: no real observation at ${fmt.hhmmss(fr.timestamp)} UTC. Pick a pair with a real frame between them (for example, frames 20 min apart on GOES-19) to validate.</div>`;
    } else {
      box.innerHTML = ["ssim", "psnr", "mse", "mae", "cloud_iou"].filter((k) => Number.isFinite(m[k])).map((k) => {
        const d = M.DEFS[k];
        const bl = b && Number.isFinite(b[k]) ? `linear blend ${d.fmt(b[k])}` : "";
        return `<div><div class="k">${d.label}${d.unit ? " · " + d.unit : ""}</div><div class="v">${d.fmt(m[k])}</div><div class="b">${bl}</div></div>`;
      }).join("");
    }

    // metadata
    $("#wbMetaPanel").hidden = false;
    const md = fr.metadata || {};
    const order = ["source_frame_0", "source_frame_1", "interpolation_factor", "model_name", "creation_time", "is_synthetic"];
    const keys = [...order.filter((k) => k in md), ...Object.keys(md).filter((k) => !order.includes(k))];
    $("#wbMeta").innerHTML =
      `<dt>valid_time</dt><dd>${esc(fmt.full(fr.timestamp))}</dd><dt>output_file</dt><dd>${esc(fr.file || "—")}</dd>` +
      keys.map((k) => `<dt>${esc(k)}</dt><dd class="${k === "is_synthetic" && md[k] ? "flag" : ""}">${esc(typeof md[k] === "object" ? JSON.stringify(md[k]) : String(md[k]))}</dd>`).join("");
    const nc = api.ncUrl(fr);
    const dl = $("#wbDownloadNc");
    if (nc) { dl.href = nc; dl.removeAttribute("aria-disabled"); $("#wbNcHint").textContent = ""; }
    else { dl.removeAttribute("href"); dl.setAttribute("aria-disabled", "true"); $("#wbNcHint").textContent = "Download works once the backend is connected."; }
  }

  /* ================================================================ ANIMATION */
  const anState = { player: null, seqs: [] };
  async function initAnimation() {
    try { anState.seqs = await api.sequences(); } catch (e) { toast("Could not load sequences: " + e.message); return; }
    const sel = $("#anSeq");
    sel.innerHTML = anState.seqs.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
    await loadSequence();
  }
  async function loadSequence() {
    if (anState.player) anState.player.destroy();
    const id = $("#anSeq").value;
    $("#anPlayer").innerHTML = `<div class="empty"><p>Loading sequence…</p></div>`;
    let seq;
    try { seq = await api.sequence(id); } catch (e) { $("#anPlayer").innerHTML = `<div class="empty"><p>${esc(e.message)}</p></div>`; return; }
    const nSyn = seq.interpolated.filter((f) => f.is_synthetic).length;
    $("#anLede").textContent = id.includes("insat")
      ? `Native INSAT-3DS frames (left) next to the same period with ${nSyn} generated frames added (right).`
      : `Left: every real frame. Right: every second frame replaced by a model prediction from the frames either side, so each generated frame can be checked against the real one. ${nSyn} generated frames.`;
    anState.player = new TI.Player($("#anPlayer"), {
      cmap: $("#anCmap").value,
      left: { label: "Ground truth · observed", sub: cadenceOf(seq.ground_truth) + " cadence", frames: seq.ground_truth },
      right: { label: "Interpolated", sub: cadenceOf(seq.interpolated) + " cadence", frames: seq.interpolated },
    });
  }
  $("#anSeq").addEventListener("change", loadSequence);
  $("#anCmap").addEventListener("change", () => anState.player && anState.player.setCmap($("#anCmap").value));

  /* ================================================================ METRICS */
  let mtCurrent = null;
  async function initMetrics() {
    let runs = [];
    try { runs = await api.runs(); } catch (e) { toast("Could not load runs: " + e.message); }
    const all = [...runs.map((r) => ({ id: r.id, name: r.name })), ...imported.map((r) => ({ id: r.run, name: "Imported · " + r.name }))];
    $("#mtRun").innerHTML = all.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("");
    if (all.length) await showRun($("#mtRun").value);
  }
  async function showRun(id) {
    $("#mtLede").textContent = "Scoring frames…";
    $("#mtTiles").innerHTML = ""; $("#mtCharts").innerHTML = ""; $("#mtBars").innerHTML = ""; $("#mtTable").innerHTML = ""; $("#mtLegend").innerHTML = "";
    let run;
    try { run = await getRun(id); } catch (e) { $("#mtLede").textContent = "Could not load metrics: " + e.message; return; }
    mtCurrent = run;
    const keys = runKeys(run);
    $("#mtLede").textContent = `${run.frames.length} generated frames, each scored against the real observation at the same time${run.gap_min ? `. Inputs were ${run.gap_min} min apart` : ""}. The baseline is a plain pixel blend of the two inputs, with no motion.`;
    $("#mtTiles").innerHTML = tilesHtml(run, keys.filter((k) => k !== "grad_ssim").slice(0, 6));

    const anyB = keys.some((k) => hasBaseline(run, k));
    $("#mtLegend").innerHTML = `<span><i style="background:var(--accent)"></i>${esc(run.model_name || "Model")}</span>` + (anyB ? `<span><i class="dash" style="color:var(--teal)"></i>${esc(run.baseline_name || "Linear blend")}</span>` : "");

    const labels = run.frames.map((r) => fmt.hhmm(r.timestamp));
    const box = $("#mtCharts");
    keys.forEach((k) => {
      const d = M.DEFS[k];
      const el = document.createElement("div");
      el.className = "chart";
      box.appendChild(el);
      const series = [{ name: run.model_name || "Model", color: "var(--accent)", values: run.frames.map((r) => r.model[k]) }];
      if (hasBaseline(run, k)) series.push({ name: run.baseline_name || "Blend", color: "var(--teal)", values: run.frames.map((r) => r.baseline && r.baseline[k]), dash: true });
      charts.mountLine(el, { title: `${d.label}${d.unit ? ` (${d.unit})` : ""}`, sub: `${d.desc}; ${d.higher ? "higher" : "lower"} is better`, labels, series, fmt: d.fmt });
    });

    if (hasBaseline(run, "psnr")) {
      charts.mountBars($("#mtBars"), {
        title: "PSNR gain over linear blend, per frame (dB)",
        sub: "Above zero means the model beat the blend on that frame. Frames with fast-growing or fast-moving cloud usually gain the most.",
        labels, values: run.frames.map((r) => r.model.psnr - r.baseline.psnr), color: "var(--accent)", valueLabel: "gain", fmt: (v) => (v >= 0 ? "+" : "") + v.toFixed(2) + " dB",
      });
    }

    const head = keys.map((k) => `<th>${M.DEFS[k].label}</th>`).join("");
    const rows = run.frames.map((r) => `<tr><td>${fmt.date(r.timestamp)} ${fmt.hhmm(r.timestamp)}</td>${keys.map((k) => {
      const d = M.DEFS[k], v = r.model[k], b = r.baseline && r.baseline[k];
      const better = Number.isFinite(b) && (d.higher ? v > b : v < b);
      return `<td class="${better ? "better" : ""}" title="${Number.isFinite(b) ? "blend " + d.fmt(b) : ""}">${d.fmt(v)}</td>`;
    }).join("")}</tr>`).join("");
    const foot = `<tr><td>Mean</td>${keys.map((k) => `<td>${M.DEFS[k].fmt(M.mean(run.frames.map((r) => r.model[k])))}</td>`).join("")}</tr>`;
    $("#mtTable").innerHTML = `<div class="tbl-scroll"><table class="data"><thead><tr><th>Frame (UTC)</th>${head}</tr></thead><tbody>${rows}</tbody><tfoot>${foot}</tfoot></table></div><p class="hint">Green = beat the linear blend on that frame (hover a cell for the blend value).</p>`;
  }
  $("#mtRun").addEventListener("change", () => showRun($("#mtRun").value));

  function exportRows(run) {
    const keys = runKeys(run);
    return run.frames.map((r) => {
      const o = { timestamp: r.timestamp };
      keys.forEach((k) => { o[k] = r.model[k]; if (r.baseline && k in r.baseline) o["baseline_" + k] = r.baseline[k]; });
      return o;
    });
  }
  $("#mtCsv").addEventListener("click", () => {
    if (!mtCurrent) return;
    const rows = exportRows(mtCurrent);
    const cols = Object.keys(rows[0]);
    download(`${mtCurrent.run || "metrics"}.csv`, [cols.join(","), ...rows.map((r) => cols.map((c) => r[c] ?? "").join(","))].join("\n"), "text/csv");
  });
  $("#mtJson").addEventListener("click", () => {
    if (!mtCurrent) return;
    const out = { run: mtCurrent.run, name: mtCurrent.name, model_name: mtCurrent.model_name, frames: mtCurrent.frames.map((r) => ({ timestamp: r.timestamp, model: r.model, baseline: r.baseline })) };
    download(`${mtCurrent.run || "metrics"}.json`, JSON.stringify(out, null, 2), "application/json");
  });
  $("#mtImport").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const raw = JSON.parse(await file.text());
      const run = normRun(Array.isArray(raw) ? { frames: raw } : raw);
      if (!run.frames.length) throw new Error("no frames with metrics found");
      run.run = "import_" + Date.now();
      run.name = run.name === "Imported run" ? file.name : run.name;
      imported.push(run);
      $("#mtRun").insertAdjacentHTML("beforeend", `<option value="${run.run}">Imported · ${esc(run.name)}</option>`);
      $("#mtRun").value = run.run;
      showRun(run.run);
      inited.report = false;
      toast(`Loaded ${run.frames.length} frames from ${file.name}`);
    } catch (err) {
      toast("Couldn't read that file: " + err.message, 5000);
    }
    e.target.value = "";
  });

  /* ================================================================ INSAT */
  const inState = { player: null };
  async function initInsat() {
    await loadInsat();
    try {
      const run = await getRun("insat3ds_holdout");
      const keys = runKeys(run).filter((k) => ["ssim", "psnr", "mae", "cloud_iou"].includes(k));
      $("#inTiles").innerHTML = tilesHtml(run, keys);
      const el = $("#inChart");
      el.className = "chart";
      const series = [{ name: run.model_name || "Model", color: "var(--accent)", values: run.frames.map((r) => r.model.ssim) }];
      if (hasBaseline(run, "ssim")) series.push({ name: "Linear blend", color: "var(--teal)", values: run.frames.map((r) => r.baseline.ssim), dash: true });
      charts.mountLine(el, { title: "SSIM per held-out frame", labels: run.frames.map((r) => fmt.hhmm(r.timestamp)), series, fmt: M.DEFS.ssim.fmt, height: 190 });
    } catch (e) {
      $("#inTiles").innerHTML = `<p class="hint">Hold-out metrics not available: ${esc(e.message)}</p>`;
    }
  }
  async function loadInsat() {
    if (inState.player) inState.player.destroy();
    const cad = segValue($("#inCadence"));
    const id = cad === "15" ? "insat3ds_15min" : "insat3ds_7p5min";
    $("#inPlayer").innerHTML = `<div class="empty"><p>Loading INSAT-3DS sequence…</p></div>`;
    let seq;
    try { seq = await api.sequence(id); } catch (e) { $("#inPlayer").innerHTML = `<div class="empty"><p>${esc(e.message)}</p></div>`; return; }
    inState.player = new TI.Player($("#inPlayer"), {
      cmap: $("#inCmap").value,
      fps: 4,
      left: { label: "INSAT-3DS native", sub: cadenceOf(seq.ground_truth) + " · " + seq.ground_truth.length + " frames", frames: seq.ground_truth },
      right: { label: "With generated frames", sub: `${cad} min · ${seq.interpolated.length} frames`, frames: seq.interpolated },
    });
    $("#inFiles").innerHTML = seq.interpolated.map((f) => {
      const u = api.ncUrl(f);
      const name = (f.file || f.id).split("/").pop();
      return `<div><span class="${f.is_synthetic ? "syn" : ""}">${fmt.hhmmss(f.timestamp)} ${f.is_synthetic ? "gen" : "obs"}</span><span>${u ? `<a href="${esc(u)}" download>${esc(name)}</a>` : esc(name)}</span></div>`;
    }).join("");
  }
  seg($("#inCadence"), loadInsat);
  $("#inCmap").addEventListener("change", () => inState.player && inState.player.setCmap($("#inCmap").value));

  /* ================================================================ REPORT */
  let reportHtml = "";
  async function initReport() {
    let runs = [];
    try { runs = await api.runs(); } catch (e) { /* shown below */ }
    const all = [...runs.map((r) => ({ id: r.id, name: r.name })), ...imported.map((r) => ({ id: r.run, name: "Imported · " + r.name }))];
    $("#rpRuns").innerHTML = all.length
      ? all.map((r, i) => `<label><input type="checkbox" value="${esc(r.id)}" ${i < 3 ? "checked" : ""}> ${esc(r.name)}</label>`).join("")
      : `<p class="hint">No runs available.</p>`;
  }
  $("#rpBuild").addEventListener("click", async () => {
    const ids = $$("#rpRuns input:checked").map((i) => i.value);
    if (!ids.length) return toast("Pick at least one run.");
    const btn = $("#rpBuild");
    btn.disabled = true;
    try {
      $("#rpStatus").textContent = "Scoring runs…";
      const runs = [];
      for (const id of ids) runs.push(await getRun(id));
      reportHtml = await TI.report.build({
        runs, examples: +$("#rpExamples").value, author: $("#rpAuthor").value.trim(), demo: api.mode === "demo",
        onStatus: (s) => ($("#rpStatus").textContent = s),
      });
      $("#rpFrame").srcdoc = reportHtml;
      $("#rpEmpty").hidden = true;
      $("#rpPrint").disabled = false; $("#rpHtml").disabled = false;
      $("#rpStatus").textContent = `Report ready · ${runs.length} run(s).`;
    } catch (e) {
      $("#rpStatus").textContent = "Failed: " + e.message;
    } finally { btn.disabled = false; }
  });
  $("#rpPrint").addEventListener("click", () => {
    const w = $("#rpFrame").contentWindow;
    w.focus(); w.print();
  });
  $("#rpHtml").addEventListener("click", () => download(`interpolation-report-${fmt.date(new Date().toISOString())}.html`, reportHtml, "text/html"));

  /* ================================================================ boot */
  const INIT = { workbench: initWorkbench, animation: initAnimation, metrics: initMetrics, insat: initInsat, report: initReport };
  connect();
})(window.TI);
