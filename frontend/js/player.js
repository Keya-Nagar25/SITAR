/*
 * Two-track time-lapse player, synced on real timestamps. When one track is
 * sparser than the other it holds its last frame, so the gaps stay visible.
 */
window.TI = window.TI || {};
(function (TI) {
  "use strict";
  const { api, fmt } = TI;

  class Player {
    constructor(root, opts) {
      this.root = root;
      this.opts = opts;
      this.cmap = opts.cmap || "gray";
      this.fps = opts.fps || 2;
      this.loop = true;
      this.idx = 0;
      this.playing = false;
      this.cache = new Map();
      this.build();
      this.load();
    }

    build() {
      const { left, right } = this.opts;
      const times = new Set();
      [left, right].forEach((t) => t.frames.forEach((f) => times.add(f.timestamp)));
      this.times = [...times].sort();
      const synthTimes = new Set(right.frames.filter((f) => f.is_synthetic).map((f) => f.timestamp));
      const t0 = new Date(this.times[0]).getTime(), t1 = new Date(this.times[this.times.length - 1]).getTime();
      const pos = (iso) => ((new Date(iso).getTime() - t0) / (t1 - t0 || 1)) * 100;

      const trackHtml = (t, k) => `
        <div class="track" data-k="${k}">
          <div class="track-head"><b>${t.label}</b><span class="mono">${t.sub || ""}</span></div>
          <div class="track-canvas"><canvas width="256" height="256"></canvas><span class="stamp"></span><span class="held" hidden></span></div>
        </div>`;
      this.root.innerHTML = `
        <div class="player-tracks">${trackHtml(left, "left")}${trackHtml(right, "right")}</div>
        <div class="transport" tabindex="0" aria-label="Playback controls (space: play/pause, arrows: step)">
          <button class="btn" data-a="first" title="First frame">⏮</button>
          <button class="btn" data-a="prev" title="Previous frame">◀︎</button>
          <button class="btn primary" data-a="play" title="Play / pause" style="min-width:74px">Play</button>
          <button class="btn" data-a="next" title="Next frame">▶︎</button>
          <button class="btn" data-a="last" title="Last frame">⏭</button>
          <span class="clock"></span>
          <div class="timeline">
            <div class="ticks">${this.times.map((iso) => `<i class="${synthTimes.has(iso) ? "syn" : ""}" style="left:${pos(iso)}%"></i>`).join("")}</div>
            <input type="range" min="0" max="${this.times.length - 1}" value="0" step="1" aria-label="Timeline">
          </div>
          <label class="speed">Speed
            <select>
              <option value="0.5">0.5 fps</option><option value="1">1 fps</option><option value="2" selected>2 fps</option>
              <option value="4">4 fps</option><option value="8">8 fps</option><option value="12">12 fps</option>
            </select>
          </label>
          <label class="speed"><input type="checkbox" checked> Loop</label>
          <span class="hint mono" data-load></span>
        </div>
        <div class="legend" style="margin-top:8px">
          <span><i style="background:var(--ink-2);width:1px;height:10px"></i>observed frame</span>
          <span><i style="background:var(--accent);width:2px;height:14px"></i>AI-generated frame</span>
        </div>`;

      const q = (s) => this.root.querySelector(s);
      this.canvases = { left: q('[data-k="left"] canvas'), right: q('[data-k="right"] canvas') };
      this.stamps = { left: q('[data-k="left"] .stamp'), right: q('[data-k="right"] .stamp') };
      this.helds = { left: q('[data-k="left"] .held'), right: q('[data-k="right"] .held') };
      this.range = q('input[type="range"]');
      this.clock = q(".clock");
      this.playBtn = q('[data-a="play"]');
      this.loadEl = q("[data-load]");

      this.root.querySelectorAll("[data-a]").forEach((b) => b.addEventListener("click", () => this.action(b.dataset.a)));
      this.range.addEventListener("input", () => { this.pause(); this.go(+this.range.value); });
      const [speedSel] = this.root.querySelectorAll(".speed select");
      speedSel.value = String(this.fps);
      speedSel.addEventListener("change", () => { this.fps = +speedSel.value; if (this.playing) { this.pause(); this.play(); } });
      q('.speed input[type="checkbox"]').addEventListener("change", (e) => { this.loop = e.target.checked; });
      q(".transport").addEventListener("keydown", (e) => {
        if (e.key === " ") { e.preventDefault(); this.action("play"); }
        if (e.key === "ArrowRight") { e.preventDefault(); this.action("next"); }
        if (e.key === "ArrowLeft") { e.preventDefault(); this.action("prev"); }
      });
    }

    frameAt(track, iso) {
      let best = null;
      for (const f of track.frames) if (f.timestamp <= iso) best = f;
      return best || track.frames[0];
    }

    async bitmap(frame) {
      const key = frame.id + "|" + this.cmap;
      if (!this.cache.has(key)) {
        this.cache.set(key, (async () => {
          const c = document.createElement("canvas");
          await api.draw(c, frame, this.cmap);
          return c;
        })());
      }
      return this.cache.get(key);
    }

    async load() {
      const all = [...this.opts.left.frames, ...this.opts.right.frames];
      const uniq = [...new Map(all.map((f) => [f.id, f])).values()];
      const myCmap = this.cmap;
      this.go(0);
      for (let i = 0; i < uniq.length; i++) {
        if (this.destroyed || myCmap !== this.cmap) return;
        this.loadEl.textContent = `loading ${i + 1}/${uniq.length}`;
        await this.bitmap(uniq[i]);
        await new Promise((r) => setTimeout(r, 0));
      }
      this.loadEl.textContent = "";
    }

    async go(i) {
      this.idx = i;
      const iso = this.times[i];
      this.range.value = i;
      this.clock.textContent = `${fmt.date(iso)}  ${fmt.hhmmss(iso)} UTC`;
      const tok = (this.tok = (this.tok || 0) + 1);
      for (const k of ["left", "right"]) {
        const tr = this.opts[k];
        const f = this.frameAt(tr, iso);
        const bm = await this.bitmap(f);
        if (tok !== this.tok) return;
        const c = this.canvases[k];
        if (c.width !== bm.width) { c.width = bm.width; c.height = bm.height; }
        c.getContext("2d").drawImage(bm, 0, 0);
        this.stamps[k].textContent = `${fmt.hhmmss(f.timestamp)}${f.is_synthetic ? " · SYNTHETIC" : ""}`;
        this.stamps[k].classList.toggle("syn", !!f.is_synthetic);
        const held = f.timestamp !== iso;
        this.helds[k].hidden = !held;
        if (held) this.helds[k].textContent = `no frame · holding ${fmt.hhmm(f.timestamp)}`;
      }
    }

    action(a) {
      const n = this.times.length;
      if (a === "play") return this.playing ? this.pause() : this.play();
      this.pause();
      if (a === "first") this.go(0);
      if (a === "last") this.go(n - 1);
      if (a === "prev") this.go((this.idx - 1 + n) % n);
      if (a === "next") this.go((this.idx + 1) % n);
    }
    play() {
      this.playing = true;
      this.playBtn.textContent = "Pause";
      if (this.idx >= this.times.length - 1) this.idx = -1;
      this.timer = setInterval(() => {
        let n = this.idx + 1;
        if (n >= this.times.length) {
          if (!this.loop) return this.pause();
          n = 0;
        }
        this.go(n);
      }, 1000 / this.fps);
    }
    pause() {
      this.playing = false;
      clearInterval(this.timer);
      if (this.playBtn) this.playBtn.textContent = "Play";
    }
    setCmap(c) { this.cmap = c; this.go(this.idx); this.load(); }
    destroy() { this.destroyed = true; this.pause(); }
  }

  TI.Player = Player;
})(window.TI);
