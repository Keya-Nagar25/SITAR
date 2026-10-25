/*
 * Data layer. One interface, two implementations:
 *   live - talks to the Python backend (see README.md for the API contract)
 *   demo - fabricates everything in the browser so the dashboard works stand-alone
 *
 * Frame object used everywhere in the UI:
 *   { id, source, timestamp (ISO, UTC), file, is_synthetic, metadata?, ground_truth_id? }
 */
window.TI = window.TI || {};
(function (TI) {
  "use strict";
  const F = TI.field;

  /* ------------------------------------------------------------ helpers */
  const pad = (n) => String(n).padStart(2, "0");
  const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const fmt = {
    hhmm: (iso) => { const d = new Date(iso); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; },
    hhmmss: (iso) => { const d = new Date(iso); const s = d.getUTCSeconds(); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${s ? ":" + pad(s) : ""}`; },
    date: (iso) => { const d = new Date(iso); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; },
    full: (iso) => `${fmt.date(iso)} ${fmt.hhmmss(iso)} UTC`,
    gapMin: (a, b) => (new Date(b) - new Date(a)) / 60000,
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // The backend's grey PNG must use this fixed linear scale so the UI can
  // recover brightness temperature from pixels: 180 K -> 255 (white), 320 K -> 0.
  const lumToBt = (l) => F.BT_MAX - (l / 255) * (F.BT_MAX - F.BT_MIN);

  /* ------------------------------------------------------------ demo */
  const DEMO_SOURCES = [
    { id: "goes19", name: "GOES-19 ABI · C13 (10.3 µm)", short: "GOES-19", band: "C13", cadence_min: 10, start: "2026-09-14T18:00:00Z", count: 19, seed: 11 },
    { id: "himawari", name: "Himawari-9 AHI · B13 (10.4 µm)", short: "Himawari-9", band: "B13", cadence_min: 10, start: "2026-09-14T03:00:00Z", count: 19, seed: 29 },
    { id: "insat3ds", name: "INSAT-3DS Imager · TIR1 (10.8 µm)", short: "INSAT-3DS", band: "TIR1", cadence_min: 30, start: "2026-09-14T00:00:00Z", count: 13, seed: 47 },
  ];

  function demoFileName(src, iso) {
    const d = new Date(iso);
    const Y = d.getUTCFullYear(), M = pad(d.getUTCMonth() + 1), D = pad(d.getUTCDate());
    const hm = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
    if (src === "goes19") {
      const doy = String(Math.floor((d - Date.UTC(Y, 0, 0)) / 864e5)).padStart(3, "0");
      return `data/sample/goes19/OR_ABI-L2-CMIPF-M6C13_G19_s${Y}${doy}${hm}000.nc`;
    }
    if (src === "himawari") return `data/sample/himawari/NC_H09_${Y}${M}${D}_${hm}_B13_FLDK_06001_06001.nc`;
    return `data/sample/insat3ds/3SIMG_${D}${MON[d.getUTCMonth()]}${Y}_${hm}_L1B_STD_V01R00.h5`;
  }

  const demo = (function () {
    const scenes = {};
    const frameCache = {};
    const scene = (src) => scenes[src.id] || (scenes[src.id] = F.makeScene(src.seed));
    const srcById = (id) => DEMO_SOURCES.find((s) => s.id === id);
    const minutesOf = (src, iso) => (new Date(iso) - new Date(src.start)) / 60000;
    const isoAt = (src, min) => new Date(new Date(src.start).getTime() + min * 60000).toISOString().replace(".000", "");
    const stamp = (iso) => fmt.date(iso).replace(/-/g, "") + "_" + fmt.hhmm(iso).replace(":", "");

    function nativeFrames(srcId) {
      if (frameCache[srcId]) return frameCache[srcId];
      const src = srcById(srcId);
      const list = [];
      for (let i = 0; i < src.count; i++) {
        const iso = isoAt(src, i * src.cadence_min);
        const t = i * src.cadence_min;
        list.push({ id: `${srcId}_${stamp(iso)}`, source: srcId, timestamp: iso, file: demoFileName(srcId, iso), is_synthetic: false, _gen: () => F.generate(scene(src), t) });
      }
      return (frameCache[srcId] = list);
    }

    function synthFrame(src, f0, f1, w, model, factor) {
      const t0 = minutesOf(src, f0.timestamp), t1 = minutesOf(src, f1.timestamp);
      const t = t0 + w * (t1 - t0);
      const iso = isoAt(src, t);
      const gt = nativeFrames(src.id).find((f) => Math.abs(minutesOf(src, f.timestamp) - t) < 0.01) || null;
      const seed = (t * 7.3) % 50;
      const fr = {
        id: `${src.id}_${stamp(iso)}_${model}_synthetic`,
        source: src.id,
        timestamp: iso,
        file: `data/processed/interp/${src.id}_${stamp(iso)}_${model}_interp.nc`,
        is_synthetic: true,
        ground_truth_id: gt ? gt.id : null,
        _truthAt: () => F.generate(scene(src), t),
        _gen: () => F.fakeModel(fr._truthAt(), values(f0), values(f1), w, t1 - t0, model, seed),
        _baseline: () => F.blend(values(f0), values(f1), w),
        metadata: {
          source_frame_0: f0.file.split("/").pop(),
          source_frame_1: f1.file.split("/").pop(),
          interpolation_factor: factor,
          time_fraction: +w.toFixed(4),
          model_name: model,
          creation_time: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
          is_synthetic: true,
          variable: "brightness_temperature (K)",
          satellite: src.short,
          band: src.band,
        },
      };
      return fr;
    }

    function values(frame) {
      if (!frame._bt) frame._bt = frame._gen();
      return frame._bt;
    }

    async function interpolate({ source, frame0, frame1, factor, model }, onProgress) {
      const src = srcById(source);
      const frames = nativeFrames(source);
      const f0 = frames.find((f) => f.id === frame0), f1 = frames.find((f) => f.id === frame1);
      const stages = ["Reading NetCDF inputs", "Normalising brightness temperature", "Estimating optical flow", "Synthesising intermediate frames", "Writing output .nc + metadata"];
      const emit = (i, p) => onProgress && onProgress({ stage: stages[i], stageIndex: i, stages, progress: p });

      emit(0, 0.05); await sleep(350);
      values(f0); values(f1);
      emit(1, 0.18); await sleep(300);
      emit(2, 0.3); await sleep(250);
      const flow = F.blockFlow(values(f0), values(f1));
      await sleep(350);
      const out = [];
      for (let k = 1; k < factor; k++) {
        emit(3, 0.45 + 0.4 * (k - 1) / (factor - 1));
        await sleep(260);
        const fr = synthFrame(src, f0, f1, k / factor, model, factor);
        values(fr);
        const gt = fr.ground_truth_id ? frames.find((f) => f.id === fr.ground_truth_id) : null;
        if (gt) {
          fr.metrics = TI.metrics.compute(values(gt), values(fr));
          fr.baseline_metrics = TI.metrics.compute(values(gt), fr._baseline());
        }
        out.push(fr);
        await tick();
      }
      emit(4, 0.92); await sleep(300);
      onProgress && onProgress({ stage: "done", stageIndex: stages.length, stages, progress: 1 });
      return { frames: out, flow, frame0: f0, frame1: f1 };
    }

    const RUNS = [
      { id: "goes19_eval", name: "GOES-19 C13 · 20→10 min", source: "goes19", kind: "eval" },
      { id: "himawari_eval", name: "Himawari-9 B13 · 20→10 min", source: "himawari", kind: "eval" },
      { id: "insat3ds_holdout", name: "INSAT-3DS TIR1 · 60→30 min hold-out", source: "insat3ds", kind: "holdout" },
    ];
    const runCache = {};

    // Predict every odd native frame from its neighbours two steps apart.
    async function metrics(runId, model = "SatelliteRIFE") {
      const key = runId + model;
      if (runCache[key]) return runCache[key];
      const run = RUNS.find((r) => r.id === runId);
      const src = srcById(run.source);
      const frames = nativeFrames(src.id);
      const rows = [];
      for (let i = 1; i + 1 < frames.length; i += 2) {
        const f0 = frames[i - 1], f1 = frames[i + 1], gt = frames[i];
        const fr = synthFrame(src, f0, f1, 0.5, model, 2);
        rows.push({
          timestamp: gt.timestamp,
          frame0: f0.timestamp, frame1: f1.timestamp,
          model: TI.metrics.compute(values(gt), values(fr)),
          baseline: TI.metrics.compute(values(gt), fr._baseline()),
          _truth: gt, _pred: fr,
        });
        await tick();
      }
      const res = { run: run.id, name: run.name, source: src.id, satellite: src.short, model_name: model, baseline_name: "Linear blend", gap_min: 2 * src.cadence_min, frames: rows };
      return (runCache[key] = res);
    }

    const SEQS = [
      { id: "goes19_eval", name: "GOES-19 C13 · every other frame generated", source: "goes19" },
      { id: "himawari_eval", name: "Himawari-9 B13 · every other frame generated", source: "himawari" },
      { id: "insat3ds_15min", name: "INSAT-3DS TIR1 · 30 → 15 min", source: "insat3ds" },
      { id: "insat3ds_7p5min", name: "INSAT-3DS TIR1 · 30 → 7.5 min", source: "insat3ds" },
    ];
    const seqCache = {};
    async function sequence(seqId) {
      if (seqCache[seqId]) return seqCache[seqId];
      const meta = SEQS.find((s) => s.id === seqId);
      const src = srcById(meta.source);
      const frames = nativeFrames(src.id);
      let interpolated = [];
      if (seqId.endsWith("_eval")) {
        interpolated = frames.map((f, i) => (i % 2 === 0 || i === frames.length - 1 ? f : synthFrame(src, frames[i - 1], frames[i + 1], 0.5, "SatelliteRIFE", 2)));
      } else {
        const factor = seqId.endsWith("7p5min") ? 4 : 2;
        for (let i = 0; i < frames.length - 1; i++) {
          interpolated.push(frames[i]);
          for (let k = 1; k < factor; k++) interpolated.push(synthFrame(src, frames[i], frames[i + 1], k / factor, "SatelliteRIFE", factor));
        }
        interpolated.push(frames[frames.length - 1]);
      }
      return (seqCache[seqId] = { id: seqId, name: meta.name, source: src.id, ground_truth: frames, interpolated });
    }

    return {
      async health() { return { status: "ok", mode: "demo", model: "SatelliteRIFE (simulated)" }; },
      async sources() { return DEMO_SOURCES.map(({ id, name, short, band, cadence_min }) => ({ id, name, short, band, cadence_min })); },
      async frames(source) { return nativeFrames(source); },
      async values(frame) { if (!frame._bt) { await tick(); } return { data: values(frame), w: F.N, h: F.N, kind: "bt" }; },
      async draw(canvas, frame, cmap) { F.paintBT(canvas, values(frame), cmap); },
      async baselineValues(frame) { return frame._baseline ? frame._baseline() : null; },
      interpolate, metrics, sequence,
      async runs() { return RUNS; },
      async sequences() { return SEQS; },
      ncUrl() { return null; },
    };
  })();

  /* ------------------------------------------------------------ live */
  const live = (function () {
    let base = "";
    const url = (p) => base.replace(/\/$/, "") + p;
    async function j(path, opts) {
      const r = await fetch(url(path), opts);
      if (!r.ok) {
        // FastAPI puts the reason in {"detail": "..."}; show that instead of a bare status.
        let detail = "";
        try { detail = (await r.json()).detail || ""; } catch (e) { /* not JSON */ }
        throw new Error(detail ? `${detail} (${r.status})` : `${r.status} ${r.statusText} — ${path}`);
      }
      return r.json();
    }
    const imgCache = new Map();
    function loadImage(src) {
      if (imgCache.has(src)) return imgCache.get(src);
      const p = new Promise((res, rej) => {
        const im = new Image();
        im.crossOrigin = "anonymous";
        im.onload = () => res(im);
        im.onerror = () => rej(new Error("image failed: " + src));
        im.src = src;
      });
      imgCache.set(src, p);
      return p;
    }
    const imageUrl = (frame, cmap) => url(`/api/frames/${encodeURIComponent(frame.id)}/image?cmap=${cmap}`);
    const valCache = new Map();

    const frameIndex = new Map();
    const remember = (list) => { list.forEach((f) => frameIndex.set(f.id, f)); return list; };

    return {
      setBase(b) { base = b; },
      health: () => j("/api/health"),
      sources: () => j("/api/sources"),
      frames: async (source) => remember(await j(`/api/frames?source=${encodeURIComponent(source)}`)),
      // Metric rows only carry ids; image routes need nothing else, so a stub works.
      frameById: (id) => frameIndex.get(id) || (id ? { id } : null),
      async draw(canvas, frame, cmap) {
        const im = await loadImage(imageUrl(frame, cmap));
        canvas.width = im.naturalWidth; canvas.height = im.naturalHeight;
        canvas.getContext("2d").drawImage(im, 0, 0);
      },
      async values(frame) {
        if (valCache.has(frame.id)) return valCache.get(frame.id);
        const im = await loadImage(imageUrl(frame, "gray"));
        const c = document.createElement("canvas");
        c.width = im.naturalWidth; c.height = im.naturalHeight;
        const ctx = c.getContext("2d");
        ctx.drawImage(im, 0, 0);
        const px = ctx.getImageData(0, 0, c.width, c.height).data;
        const data = new Float32Array(c.width * c.height);
        for (let i = 0; i < data.length; i++) data[i] = lumToBt(0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]);
        const v = { data, w: c.width, h: c.height, kind: "bt" };
        valCache.set(frame.id, v);
        return v;
      },
      // The backend serves the linear blend of a generated frame's inputs as "<id>~blend".
      async baselineValues(frame) {
        if (!frame || frame.is_synthetic === false) return null;
        try { return (await this.values({ id: frame.baseline_id || frame.id + "~blend" })).data; } catch (e) { return null; }
      },
      async interpolate(params, onProgress) {
        const { job_id } = await j("/api/interpolate", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params),
        });
        for (;;) {
          const s = await j(`/api/jobs/${encodeURIComponent(job_id)}`);
          onProgress && onProgress({ stage: s.stage || s.status, stageIndex: s.stage_index ?? -1, stages: s.stages || [], progress: s.progress ?? 0 });
          if (s.status === "done") {
            const res = s.result;
            remember(res.frames);
            res.frame0 = frameIndex.get(params.frame0);
            res.frame1 = frameIndex.get(params.frame1);
            return res;
          }
          if (s.status === "error") throw new Error(s.error || "inference failed");
          await sleep(700);
        }
      },
      runs: () => j("/api/runs"),
      metrics: (run) => j(`/api/metrics/${encodeURIComponent(run)}`),
      sequences: () => j("/api/sequences"),
      async sequence(id) { const s = await j(`/api/sequences/${encodeURIComponent(id)}`); remember(s.ground_truth); remember(s.interpolated); return s; },
      ncUrl: (frame) => url(`/api/frames/${encodeURIComponent(frame.id)}/nc`),
    };
  })();

  /* ------------------------------------------------------------ switch */
  const api = {
    mode: "demo",
    base: "",
    impl: demo,
    async connect(base) {
      this.base = base || "";
      if (!base) { this.useDemo(); return false; }
      live.setBase(base);
      try {
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), 2500);
        const r = await fetch(base.replace(/\/$/, "") + "/api/health", { signal: ctl.signal });
        clearTimeout(to);
        if (!r.ok) throw new Error(r.statusText);
        this.mode = "live"; this.impl = live;
        return true;
      } catch (e) {
        this.useDemo();
        return false;
      }
    },
    useDemo() { this.mode = "demo"; this.impl = demo; },
    frameById(id, list) { return (list || []).find((f) => f.id === id) || (this.impl.frameById ? this.impl.frameById(id) : null); },
  };
  ["health", "sources", "frames", "draw", "values", "baselineValues", "interpolate", "runs", "metrics", "sequences", "sequence", "ncUrl"].forEach((k) => {
    api[k] = function (...a) { return this.impl[k](...a); };
  });

  TI.api = api;
  TI.fmt = fmt;
})(window.TI);
