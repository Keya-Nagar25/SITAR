/*
 * Ground truth vs generated frame: side by side, swipe, blink, difference.
 */
window.TI = window.TI || {};
(function (TI) {
  "use strict";
  const { api, fmt, field: F } = TI;

  class Compare {
    constructor(root) {
      this.root = root;
      this.state = { mode: "side", cmap: "gray", showFlow: false };
      this.blinkTimer = null;
      this.token = 0;
    }

    set(patch) {
      Object.assign(this.state, patch);
      this.render();
    }

    cell(label, sub, tagHtml) {
      const d = document.createElement("div");
      d.className = "cmp-cell";
      d.innerHTML = `<div class="cmp-label"><b>${label}</b><span class="mono">${sub}</span></div><div class="cmp-img" style="position:relative"></div>`;
      if (tagHtml) d.querySelector(".cmp-label").insertAdjacentHTML("beforeend", tagHtml);
      return d;
    }

    async render() {
      const tok = ++this.token;
      clearInterval(this.blinkTimer);
      const { truth, pred, mode, cmap, showFlow, flow } = this.state;
      const root = this.root;
      root.innerHTML = "";
      if (!pred) return;

      const effMode = !truth && mode !== "side" ? "side" : mode;
      const predTime = fmt.full(pred.timestamp);

      if (effMode === "side") {
        const wrap = document.createElement("div");
        wrap.className = "cmp-side";
        const a = this.cell("Observed", truth ? fmt.full(truth.timestamp) : "—");
        const b = this.cell("Generated", predTime);
        wrap.append(a, b);
        root.append(wrap);
        if (truth) {
          const c = document.createElement("canvas");
          a.querySelector(".cmp-img").append(c, stamp("OBSERVED"));
          await api.draw(c, truth, cmap);
        } else {
          a.querySelector(".cmp-img").innerHTML = `<div class="empty" style="aspect-ratio:1;display:flex;align-items:center;justify-content:center"><p>No real observation exists at ${fmt.hhmmss(pred.timestamp)} UTC, so this frame can't be scored against ground truth.</p></div>`;
        }
        if (tok !== this.token) return;
        const cb = document.createElement("canvas");
        const holder = b.querySelector(".cmp-img");
        holder.append(cb, stamp("SYNTHETIC", true));
        await api.draw(cb, pred, cmap);
        if (showFlow && flow) holder.append(flowLayer(flow));
        root.append(colorbar(cmap));
        return;
      }

      if (effMode === "swipe") {
        const st = document.createElement("div");
        st.className = "cmp-stack";
        const bottom = document.createElement("canvas");
        const top = document.createElement("canvas");
        top.className = "top";
        const handle = document.createElement("div");
        handle.className = "swipe-handle";
        st.append(bottom, top, handle, stamp("OBSERVED"), stamp("SYNTHETIC", true, true));
        root.append(st);
        await Promise.all([api.draw(bottom, truth, cmap), api.draw(top, pred, cmap)]);
        if (tok !== this.token) return;
        let pos = this.state.swipePos ?? 0.5;
        const apply = () => {
          top.style.clipPath = `inset(0 0 0 ${pos * 100}%)`;
          handle.style.left = pos * 100 + "%";
        };
        apply();
        const drag = (ev) => {
          const r = st.getBoundingClientRect();
          pos = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
          this.state.swipePos = pos;
          apply();
        };
        st.addEventListener("pointerdown", (ev) => { st.setPointerCapture(ev.pointerId); drag(ev); st.onpointermove = drag; });
        st.addEventListener("pointerup", () => { st.onpointermove = null; });
        if (showFlow && flow) st.append(flowLayer(flow));
        root.append(note(`Drag across the image. Left = observed ${fmt.hhmmss(truth.timestamp)}, right = generated.`), colorbar(cmap));
        return;
      }

      if (effMode === "blink") {
        const st = document.createElement("div");
        st.className = "cmp-stack";
        const a = document.createElement("canvas");
        const b = document.createElement("canvas");
        b.className = "top";
        const lab = stamp("OBSERVED");
        st.append(a, b, lab);
        root.append(st);
        await Promise.all([api.draw(a, truth, cmap), api.draw(b, pred, cmap)]);
        if (tok !== this.token) return;
        let on = false;
        const flip = () => {
          on = !on;
          b.style.visibility = on ? "visible" : "hidden";
          lab.textContent = on ? "SYNTHETIC" : "OBSERVED";
          lab.classList.toggle("syn", on);
        };
        flip(); flip();
        this.blinkTimer = setInterval(flip, 650);
        root.append(note("Flicks between the two frames. Anything that jumps is a mismatch in position or shape."), colorbar(cmap));
        return;
      }

      if (effMode === "diff") {
        const st = document.createElement("div");
        st.className = "cmp-stack";
        const c = document.createElement("canvas");
        st.append(c, stamp("GENERATED − OBSERVED"));
        root.append(st);
        const [va, vb] = await Promise.all([api.values(truth), api.values(pred)]);
        if (tok !== this.token) return;
        F.paintDiff(c, va.data, vb.data, va.w, va.h, 12);
        const bar = document.createElement("div");
        bar.className = "colorbar mono";
        bar.innerHTML = `<span>−12 K (too cold)</span><i style="background:linear-gradient(90deg,#28c8ff,#141414 50%,#ff8228)"></i><span>+12 K (too warm)</span>`;
        root.append(bar, note("Black means the generated frame matches. Colour marks where cloud is misplaced or its temperature is wrong."));
      }
    }
  }

  function stamp(text, syn, right) {
    const s = document.createElement("span");
    s.className = "stamp" + (syn ? " syn" : "") + (right ? " right" : "");
    s.textContent = text;
    return s;
  }
  function note(t) { const p = document.createElement("p"); p.className = "hint"; p.textContent = t; return p; }
  function colorbar(cmap) {
    const d = document.createElement("div");
    d.className = "colorbar mono";
    d.innerHTML = `<span>180 K</span><i style="background:${F.CMAP_CSS[cmap]}"></i><span>320 K</span>`;
    return d;
  }
  function flowLayer(flow) {
    const c = document.createElement("canvas");
    c.className = "flowlayer";
    c.width = 512; c.height = 512;
    c.style.top = "0";
    F.drawFlow(c, flow, 1.6);
    return c;
  }

  TI.Compare = Compare;
})(window.TI);
