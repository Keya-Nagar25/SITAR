/*
 * Small SVG charts. Each builder returns an SVG string (so the report can embed
 * it) and mount() adds the hover layer when it's shown in the dashboard.
 */
window.TI = window.TI || {};
(function (TI) {
  "use strict";

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function niceTicks(min, max, count = 4) {
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    const step0 = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const err = step0 / mag;
    const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag;
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step * 0.5; v += step) ticks.push(+v.toFixed(10));
    return { lo, hi, ticks, step };
  }
  const tickFmt = (step) => (v) => (step >= 1 ? v.toFixed(0) : v.toFixed(Math.min(4, Math.ceil(-Math.log10(step)))));

  // theme: { ink, ink2, ink3, grid, surface } as CSS colours
  const APP_THEME = { ink: "var(--ink)", ink2: "var(--ink-2)", ink3: "var(--ink-3)", grid: "var(--grid)", surface: "var(--paper)" };

  function lineSvg(o) {
    const W = o.width || 560, H = o.height || 210;
    const th = o.theme || APP_THEME;
    const m = { l: 48, r: 86, t: 10, b: 26 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const all = o.series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
    const pad = (Math.max(...all) - Math.min(...all)) * 0.08 || 0.01;
    const { lo, hi, ticks, step } = niceTicks(Math.min(...all) - pad, Math.max(...all) + pad);
    const n = o.labels.length;
    const x = (i) => m.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
    const y = (v) => m.t + ih - ((v - lo) / (hi - lo)) * ih;
    const tf = tickFmt(step);

    let s = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(o.title || "")}" font-family="Martian Mono, Consolas, monospace" font-size="10">`;
    ticks.forEach((t) => {
      s += `<line x1="${m.l}" x2="${m.l + iw}" y1="${y(t)}" y2="${y(t)}" stroke="${th.grid}" stroke-width="1"/>`;
      s += `<text x="${m.l - 8}" y="${y(t) + 3.5}" text-anchor="end" fill="${th.ink3}">${tf(t)}</text>`;
    });
    const every = Math.max(1, Math.ceil(n / 9));
    o.labels.forEach((lb, i) => {
      if (i % every !== 0 && i !== n - 1) return;
      s += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" fill="${th.ink3}">${esc(lb)}</text>`;
    });
    s += `<line x1="${m.l}" x2="${m.l + iw}" y1="${m.t + ih}" y2="${m.t + ih}" stroke="${th.ink3}" stroke-width="1"/>`;

    // lines, then markers with a surface ring
    const ends = [];
    o.series.forEach((se) => {
      const pts = se.values.map((v, i) => (Number.isFinite(v) ? [x(i), y(v)] : null)).filter(Boolean);
      if (!pts.length) return;
      s += `<path d="M${pts.map((p) => p.join(",")).join("L")}" fill="none" stroke="${se.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${se.dash ? ' stroke-dasharray="5 4"' : ""}/>`;
      ends.push({ y: pts[pts.length - 1][1], x: pts[pts.length - 1][0], name: se.name, color: se.color });
    });
    o.series.forEach((se, si) => {
      se.values.forEach((v, i) => {
        if (!Number.isFinite(v)) return;
        s += `<circle class="pt" data-s="${si}" data-i="${i}" cx="${x(i)}" cy="${y(v)}" r="4" fill="${se.color}" stroke="${th.surface}" stroke-width="2"/>`;
      });
    });
    // direct labels at line ends, nudged apart
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
    ends.forEach((e) => {
      s += `<line x1="${e.x + 6}" x2="${e.x + 14}" y1="${e.y}" y2="${e.y}" stroke="${e.color}" stroke-width="2"/>`;
      s += `<text x="${e.x + 18}" y="${e.y + 3.5}" fill="${th.ink2}" font-family="Archivo, Arial, sans-serif" font-size="11">${esc(e.name)}</text>`;
    });
    s += `<line class="xh" x1="0" x2="0" y1="${m.t}" y2="${m.t + ih}" stroke="${th.ink3}" stroke-width="1" visibility="hidden"/>`;
    s += `<rect class="hit" x="${m.l - 10}" y="${m.t}" width="${iw + 20}" height="${ih}" fill="transparent"/>`;
    s += `</svg>`;
    return { svg: s, geom: { W, H, m, iw, ih, n, x } };
  }

  function barSvg(o) {
    const W = o.width || 1100, H = o.height || 190;
    const th = o.theme || APP_THEME;
    const m = { l: 48, r: 12, t: 12, b: 26 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const vals = o.values;
    const { lo, hi, ticks, step } = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals), 4);
    const y = (v) => m.t + ih - ((v - lo) / (hi - lo)) * ih;
    const n = vals.length, slot = iw / n, bw = Math.max(4, Math.min(38, slot - 2));
    const tf = tickFmt(step);
    let s = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(o.title || "")}" font-family="Martian Mono, Consolas, monospace" font-size="10">`;
    ticks.forEach((t) => {
      s += `<line x1="${m.l}" x2="${m.l + iw}" y1="${y(t)}" y2="${y(t)}" stroke="${th.grid}"/>`;
      s += `<text x="${m.l - 8}" y="${y(t) + 3.5}" text-anchor="end" fill="${th.ink3}">${tf(t)}</text>`;
    });
    const every = Math.max(1, Math.ceil(n / 14));
    vals.forEach((v, i) => {
      const cx = m.l + slot * (i + 0.5);
      const y0 = y(0), y1 = y(v);
      const top = Math.min(y0, y1), h = Math.max(1, Math.abs(y1 - y0));
      const r = Math.min(4, h / 2, bw / 2);
      const up = v >= 0;
      // rounded only on the data end
      const d = up
        ? `M${cx - bw / 2},${y0}V${top + r}Q${cx - bw / 2},${top} ${cx - bw / 2 + r},${top}H${cx + bw / 2 - r}Q${cx + bw / 2},${top} ${cx + bw / 2},${top + r}V${y0}Z`
        : `M${cx - bw / 2},${y0}V${top + h - r}Q${cx - bw / 2},${top + h} ${cx - bw / 2 + r},${top + h}H${cx + bw / 2 - r}Q${cx + bw / 2},${top + h} ${cx + bw / 2},${top + h - r}V${y0}Z`;
      s += `<path class="bar" data-i="${i}" d="${d}" fill="${o.color}"/>`;
      if (i % every === 0 || i === n - 1) s += `<text x="${cx}" y="${H - 6}" text-anchor="middle" fill="${th.ink3}">${esc(o.labels[i])}</text>`;
    });
    s += `<line x1="${m.l}" x2="${m.l + iw}" y1="${y(0)}" y2="${y(0)}" stroke="${th.ink2}"/>`;
    vals.forEach((v, i) => { s += `<rect class="hitb" data-i="${i}" x="${m.l + slot * i}" y="${m.t}" width="${slot}" height="${ih}" fill="transparent"/>`; });
    s += `</svg>`;
    return { svg: s };
  }

  function tip(el) {
    let t = el.querySelector(".tip");
    if (!t) { t = document.createElement("div"); t.className = "tip"; t.hidden = true; el.appendChild(t); }
    return t;
  }
  function localPoint(svg, ev) {
    const r = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    return { x: ((ev.clientX - r.left) / r.width) * vb.width, sx: r.width / vb.width, sy: r.height / vb.height, r };
  }

  function mountLine(el, o) {
    const { svg, geom } = lineSvg(o);
    el.innerHTML = `<div class="chart-title">${esc(o.title)}</div>${o.sub ? `<div class="chart-sub">${esc(o.sub)}</div>` : ""}${svg}`;
    const svgEl = el.querySelector("svg");
    const xh = svgEl.querySelector(".xh");
    const t = tip(el);
    const move = (ev) => {
      const p = localPoint(svgEl, ev);
      let i = Math.round(((p.x - geom.m.l) / geom.iw) * (geom.n - 1));
      i = Math.max(0, Math.min(geom.n - 1, i));
      const cx = geom.x(i);
      xh.setAttribute("x1", cx); xh.setAttribute("x2", cx); xh.setAttribute("visibility", "visible");
      svgEl.querySelectorAll(".pt").forEach((c) => c.setAttribute("r", +c.dataset.i === i ? 6 : 4));
      t.innerHTML = `<b>${esc(o.labels[i])} UTC</b><br>` + o.series.map((se) => `<span class="sw" style="background:${se.color}"></span>${esc(se.name)} ${Number.isFinite(se.values[i]) ? o.fmt(se.values[i]) : "–"}`).join("<br>");
      const elR = el.getBoundingClientRect();
      const top = Math.min(...o.series.map((se) => { const pt = svgEl.querySelector(`.pt[data-i="${i}"]`); return pt ? pt.getBoundingClientRect().top : p.r.top; }));
      t.style.left = Math.max(70, Math.min(elR.width - 70, p.r.left - elR.left + cx * p.sx)) + "px";
      t.style.top = top - elR.top + "px";
      t.hidden = false;
    };
    const leave = () => { xh.setAttribute("visibility", "hidden"); t.hidden = true; svgEl.querySelectorAll(".pt").forEach((c) => c.setAttribute("r", 4)); };
    const hit = svgEl.querySelector(".hit");
    hit.addEventListener("pointermove", move);
    hit.addEventListener("pointerleave", leave);
  }

  function mountBars(el, o) {
    const { svg } = barSvg(o);
    el.innerHTML = `<div class="chart-title">${esc(o.title)}</div>${o.sub ? `<div class="chart-sub">${esc(o.sub)}</div>` : ""}<div class="chart">${svg}</div>`;
    const box = el.querySelector(".chart");
    const svgEl = box.querySelector("svg");
    const t = tip(box);
    svgEl.querySelectorAll(".hitb").forEach((h) => {
      h.addEventListener("pointerenter", () => {
        const i = +h.dataset.i;
        svgEl.querySelectorAll(".bar").forEach((b) => b.setAttribute("opacity", +b.dataset.i === i ? 1 : 0.45));
        const bar = svgEl.querySelector(`.bar[data-i="${i}"]`).getBoundingClientRect();
        const br = box.getBoundingClientRect();
        t.innerHTML = `<b>${esc(o.labels[i])} UTC</b><br>${esc(o.valueLabel)} ${o.fmt(o.values[i])}`;
        t.style.left = Math.max(70, Math.min(br.width - 70, bar.left - br.left + bar.width / 2)) + "px";
        t.style.top = bar.top - br.top + "px";
        t.hidden = false;
      });
      h.addEventListener("pointerleave", () => { t.hidden = true; svgEl.querySelectorAll(".bar").forEach((b) => b.setAttribute("opacity", 1)); });
    });
  }

  TI.charts = { lineSvg, barSvg, mountLine, mountBars, esc };
})(window.TI);
