"""
Frame catalogue, rendering, interpolation engine and evaluation for the API.

Frames on disk:
    data/sample/<source>/*.nc|*.h5      native observations (one folder per satellite)
    data/processed/interp/<id>.nc       generated frames (+ <id>.json sidecar with metadata)

Interpolation engine:
    checkpoints/interpolation_best.pth (or _latest) present -> SatelliteRIFE
    otherwise -> classical Farneback optical flow, clearly labelled as such
"""

from __future__ import annotations

import datetime as dt
import io
import json
import os
import re
import threading
import uuid
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import cv2
import numpy as np
from PIL import Image

from src.interpolation.utils import (
    NormalizationConfig,
    compute_metrics,
    load_satellite_frame,
    normalize_frame,
    write_interpolated_frame_nc,
)

BACKEND_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.environ.get("SITAR_DATA_DIR", BACKEND_DIR / "data" / "sample"))
OUT_DIR = Path(os.environ.get("SITAR_OUT_DIR", BACKEND_DIR / "data" / "processed" / "interp"))
CKPT_DIR = Path(os.environ.get("SITAR_CHECKPOINT_DIR", BACKEND_DIR / "checkpoints"))
# Frames larger than this (e.g. 5424x5424 GOES full disk) are area-downsampled
# for display, inference and metrics so the dashboard stays responsive on CPU.
MAX_SIDE = int(os.environ.get("SITAR_MAX_SIDE", "1024"))

# Must match frontend/js/field.js: grey PNG is a fixed linear scale, 180 K -> 255, 320 K -> 0.
BT_MIN, BT_MAX = 180.0, 320.0
BT_RANGE = BT_MAX - BT_MIN

KNOWN_SOURCES = {
    "goes19": {"name": "GOES-19 ABI · C13 (10.3 µm)", "short": "GOES-19", "band": "C13"},
    "himawari": {"name": "Himawari-9 AHI · B13 (10.4 µm)", "short": "Himawari-9", "band": "B13"},
    "insat3ds": {"name": "INSAT-3DS Imager · TIR1 (10.8 µm)", "short": "INSAT-3DS", "band": "TIR1"},
    "insat3dr": {"name": "INSAT-3DR Imager · TIR1 (10.8 µm)", "short": "INSAT-3DR", "band": "TIR1"},
}
STAGES = [
    "Reading NetCDF inputs",
    "Normalising brightness temperature",
    "Estimating optical flow",
    "Synthesising intermediate frames",
    "Writing output .nc + metadata",
]
MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]


def iso(t: dt.datetime) -> str:
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def stamp(t: dt.datetime) -> str:
    s = t.strftime("%Y%m%d_%H%M")
    return s + (t.strftime("%S") if t.second else "")


def rel(p: Path) -> str:
    try:
        return p.resolve().relative_to(BACKEND_DIR).as_posix()
    except ValueError:
        return p.as_posix()


# ---------------------------------------------------------------- timestamps

_TS_PATTERNS: List[Tuple[re.Pattern, Callable[[re.Match], dt.datetime]]] = [
    # GOES ABI: ..._s20262571800000_...  (year, day-of-year, HHMMSS, tenths)
    (re.compile(r"_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})\d?"),
     lambda m: dt.datetime(int(m[1]), 1, 1, int(m[3]), int(m[4]), int(m[5])) + dt.timedelta(days=int(m[2]) - 1)),
    # INSAT: 3SIMG_14SEP2026_0000_L1B...
    (re.compile(r"(\d{2})(" + "|".join(MON) + r")(\d{4})_(\d{2})(\d{2})", re.I),
     lambda m: dt.datetime(int(m[3]), MON.index(m[2].upper()) + 1, int(m[1]), int(m[4]), int(m[5]))),
    # generic: 20260914_1800, 20260914-180000, 202609141800
    (re.compile(r"(\d{4})(\d{2})(\d{2})[_\-T]?(\d{2})(\d{2})(\d{2})?"),
     lambda m: dt.datetime(int(m[1]), int(m[2]), int(m[3]), int(m[4]), int(m[5]), int(m[6] or 0))),
]


def timestamp_of(path: Path) -> Optional[dt.datetime]:
    for pat, build in _TS_PATTERNS:
        m = pat.search(path.name)
        if m:
            try:
                return build(m).replace(tzinfo=dt.timezone.utc)
            except ValueError:
                continue
    if path.suffix.lower() in (".nc", ".nc4"):
        try:
            import xarray as xr
            with xr.open_dataset(path) as ds:
                if "time" in ds.coords:
                    v = np.atleast_1d(ds["time"].values)[0]
                    return dt.datetime.fromtimestamp(v.astype("datetime64[s]").astype(int), dt.timezone.utc)
        except Exception:
            pass
    return None


# ---------------------------------------------------------------- frames

@dataclass
class Frame:
    id: str
    source: str
    time: dt.datetime
    kind: str                      # "native" | "synthetic" | "baseline"
    path: Optional[Path] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    ground_truth_id: Optional[str] = None
    frame0_id: Optional[str] = None
    frame1_id: Optional[str] = None
    t: Optional[float] = None
    metrics: Optional[Dict[str, float]] = None
    baseline_metrics: Optional[Dict[str, float]] = None

    def to_json(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {
            "id": self.id,
            "source": self.source,
            "timestamp": iso(self.time),
            "file": rel(self.path) if self.path else None,
            "is_synthetic": self.kind != "native",
        }
        if self.kind == "synthetic":
            d.update(
                ground_truth_id=self.ground_truth_id,
                baseline_id=self.id + "~blend",
                metadata=self.metadata,
            )
            if self.metrics:
                d["metrics"] = self.metrics
            if self.baseline_metrics:
                d["baseline_metrics"] = self.baseline_metrics
        return d


class LRU(OrderedDict):
    def __init__(self, size: int):
        super().__init__()
        self.size = size
        self.lock = threading.Lock()

    def get_or(self, key, make):
        with self.lock:
            if key in self:
                self.move_to_end(key)
                return self[key]
        val = make()
        with self.lock:
            self[key] = val
            while len(self) > self.size:
                self.popitem(last=False)
        return val


class Catalog:
    def __init__(self):
        self.lock = threading.RLock()
        self.frames: Dict[str, Frame] = {}
        self.by_source: Dict[str, List[Frame]] = {}
        self.values_cache = LRU(256)
        self.png_cache = LRU(512)
        self.scan()

    # ---- discovery
    def scan(self) -> None:
        with self.lock:
            self.frames.clear()
            self.by_source.clear()
            if DATA_DIR.is_dir():
                for d in sorted(p for p in DATA_DIR.iterdir() if p.is_dir()):
                    files = [p for p in d.iterdir() if p.suffix.lower() in (".nc", ".nc4", ".h5", ".hdf5")]
                    lst = []
                    for p in files:
                        t = timestamp_of(p)
                        if t is None:
                            print(f"[catalog] skipping {p.name}: no timestamp in name or time coord")
                            continue
                        lst.append(Frame(id=f"{d.name}_{stamp(t)}", source=d.name, time=t, kind="native", path=p))
                    lst.sort(key=lambda f: f.time)
                    if lst:
                        self.by_source[d.name] = lst
                        for f in lst:
                            self.frames[f.id] = f
            if OUT_DIR.is_dir():
                for side in OUT_DIR.glob("*.json"):
                    try:
                        self._register_synthetic(json.loads(side.read_text()))
                    except Exception as e:  # stale / partial output: ignore
                        print(f"[catalog] skipping {side.name}: {e}")

    def _register_synthetic(self, meta: Dict[str, Any]) -> Frame:
        nc = OUT_DIR / f"{meta['id']}.nc"
        if not nc.is_file():
            raise FileNotFoundError(nc)
        f = Frame(
            id=meta["id"], source=meta["source"], kind="synthetic", path=nc,
            time=dt.datetime.fromisoformat(meta["timestamp"].replace("Z", "+00:00")),
            metadata=meta["metadata"], frame0_id=meta["frame0_id"], frame1_id=meta["frame1_id"], t=meta["t"],
        )
        native = {x.time: x for x in self.by_source.get(f.source, [])}
        gt = native.get(f.time)
        f.ground_truth_id = gt.id if gt else None
        with self.lock:
            self.frames[f.id] = f
        return f

    def sources(self) -> List[Dict[str, Any]]:
        out = []
        for sid, lst in self.by_source.items():
            info = KNOWN_SOURCES.get(sid, {"name": sid, "short": sid, "band": ""})
            gaps = np.diff([f.time.timestamp() for f in lst]) / 60 if len(lst) > 1 else [0]
            out.append({"id": sid, **info, "cadence_min": float(np.median(gaps)), "count": len(lst)})
        return out

    def get(self, frame_id: str) -> Frame:
        f = self.frames.get(frame_id)
        if f is None and frame_id.endswith("~blend"):
            pred = self.frames.get(frame_id[:-len("~blend")])
            if pred is not None and pred.kind == "synthetic":
                f = Frame(id=frame_id, source=pred.source, time=pred.time, kind="baseline",
                          frame0_id=pred.frame0_id, frame1_id=pred.frame1_id, t=pred.t)
        if f is None:
            raise KeyError(frame_id)
        return f

    # ---- pixels
    def values(self, frame: Frame) -> np.ndarray:
        """Brightness temperature (K) at working resolution, NaNs filled."""
        def make():
            if frame.kind == "baseline":
                a, b = self.values(self.get(frame.frame0_id)), self.values(self.get(frame.frame1_id))
                return ((1 - frame.t) * a + frame.t * b).astype(np.float32)
            var = "TIR1_interpolated" if frame.kind == "synthetic" else None
            data, _, _ = load_satellite_frame(str(frame.path), var_name=var)
            return to_working(data)
        return self.values_cache.get_or(frame.id, make)

    def png(self, frame: Frame, cmap: str) -> bytes:
        def make():
            bt = self.values(frame)
            idx = np.clip(np.rint((bt - BT_MIN) / BT_RANGE * 255), 0, 255).astype(np.uint8)
            rgb = LUTS.get(cmap, LUTS["gray"])[idx]
            buf = io.BytesIO()
            Image.fromarray(rgb, "RGB").save(buf, "PNG", optimize=False)
            return buf.getvalue()
        return self.png_cache.get_or((frame.id, cmap), make)


def to_working(data: np.ndarray) -> np.ndarray:
    data = data.astype(np.float32)
    if np.isnan(data).all():
        raise ValueError("frame is entirely missing")
    if np.isnan(data).any():
        data = np.where(np.isnan(data), np.nanmean(data), data)
    h, w = data.shape
    s = MAX_SIDE / max(h, w)
    if s < 1:
        data = cv2.resize(data, (max(1, round(w * s)), max(1, round(h * s))), interpolation=cv2.INTER_AREA)
    return data


def _lut(stops: List[Tuple[float, str]]) -> np.ndarray:
    """Port of buildLut() in frontend/js/field.js."""
    k = BT_MIN + np.arange(256) / 255 * BT_RANGE
    xs = [s[0] for s in stops]
    cols = np.array([[int(h[i:i + 2], 16) for i in (1, 3, 5)] for _, h in stops], dtype=np.float32)
    return np.stack([np.interp(k, xs, cols[:, c]) for c in range(3)], axis=1).astype(np.uint8)


LUTS = {
    "gray": _lut([(180, "#ffffff"), (320, "#000000")]),
    "enhanced": _lut([
        (180, "#f4f4f4"), (190, "#8a1616"), (198, "#d8401a"), (206, "#eec33a"),
        (214, "#3fa650"), (224, "#1d4fb8"), (236, "#62c3ec"), (240, "#b4b4b4"),
        (320, "#0c0c0c"),
    ]),
}


# ---------------------------------------------------------------- metrics

def score(truth: np.ndarray, pred: np.ndarray) -> Dict[str, float]:
    """Same keys/units as frontend/js/metrics.js: MSE in K², MAE in K, PSNR over the 140 K range."""
    tn = np.clip((truth - BT_MIN) / BT_RANGE, 0, 1)
    pn = np.clip((pred - BT_MIN) / BT_RANGE, 0, 1)
    m = compute_metrics(pn, tn, data_range=1.0)
    out = {"ssim": m["ssim"], "psnr": m["psnr"], "mse": m["mse"] * BT_RANGE ** 2, "mae": m["mae"] * BT_RANGE}
    ct, cp = truth < 235, pred < 235
    union = np.logical_or(ct, cp).sum()
    out["cloud_iou"] = float(np.logical_and(ct, cp).sum() / union) if union else 1.0

    def grad(f):
        gy, gx = np.gradient(f)
        return np.clip(np.hypot(gx, gy) / 40, 0, 1)

    out["grad_ssim"] = compute_metrics(grad(pred), grad(truth), data_range=1.0)["ssim"]
    return {k: float(v) if np.isfinite(v) else 99.0 for k, v in out.items()}


# ---------------------------------------------------------------- engine

class Engine:
    def __init__(self):
        self.lock = threading.Lock()
        self.model = None
        self.cfg = None
        self.checkpoint = next((p for p in (CKPT_DIR / "interpolation_best.pth", CKPT_DIR / "interpolation_latest.pth") if p.is_file()), None)

    @property
    def name(self) -> str:
        return "SatelliteRIFE" if self.checkpoint else "FarnebackFlow"

    @property
    def description(self) -> str:
        if self.checkpoint:
            return f"SatelliteRIFE ({self.checkpoint.name})"
        return "Farneback optical flow (no SatelliteRIFE checkpoint found in backend/checkpoints)"

    def _load(self):
        if self.model is None:
            import torch
            from src.interpolation.inference import load_model_from_checkpoint
            self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
            self.model, self.cfg = load_model_from_checkpoint(str(self.checkpoint), self.device)

    def run(self, a: np.ndarray, b: np.ndarray, t: float) -> Tuple[np.ndarray, np.ndarray]:
        """Returns (predicted BT in K, flow 0->1 in pixels, shape (H, W, 2))."""
        if self.checkpoint:
            return self._run_model(a, b, t)
        return self._run_farneback(a, b, t)

    def _run_model(self, a, b, t):
        import torch
        with self.lock:
            self._load()
            # One shared range for both inputs, so a percentile config can't
            # stretch the two frames differently.
            norm_cfg = NormalizationConfig.from_dict(self.cfg["data"]["normalization"])
            _, meta = normalize_frame(np.concatenate([a, b], axis=0), norm_cfg)
            fixed = NormalizationConfig(method="minmax", vmin=meta["vmin"], vmax=meta["vmax"])
            na, _ = normalize_frame(a, fixed)
            nb, _ = normalize_frame(b, fixed)
            ta = torch.from_numpy(na)[None, None].to(self.device)
            tb = torch.from_numpy(nb)[None, None].to(self.device)
            with torch.no_grad():
                out = self.model(ta, tb, t=t)
            pred = out["pred"][0, 0].cpu().numpy() * (meta["vmax"] - meta["vmin"]) + meta["vmin"]
            flow = (out["flow_t1"] - out["flow_t0"])[0].permute(1, 2, 0).cpu().numpy()
        return pred.astype(np.float32), flow

    @staticmethod
    def _flow(a8, b8):
        return cv2.calcOpticalFlowFarneback(a8, b8, None, 0.5, 4, 21, 5, 7, 1.5, 0)

    def _run_farneback(self, a, b, t):
        to8 = lambda x: np.clip((BT_MAX - x) / BT_RANGE * 255, 0, 255).astype(np.uint8)
        a8, b8 = to8(a), to8(b)
        f01, f10 = self._flow(a8, b8), self._flow(b8, a8)
        h, w = a.shape
        gx, gy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
        # backward-warp each input to time t (linear-motion assumption)
        w0 = cv2.remap(a, gx - t * f01[..., 0], gy - t * f01[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        w1 = cv2.remap(b, gx - (1 - t) * f10[..., 0], gy - (1 - t) * f10[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        return ((1 - t) * w0 + t * w1).astype(np.float32), f01


def flow_grid(flow: np.ndarray, grid: int = 16) -> Dict[str, Any]:
    h, w = flow.shape[:2]
    g = cv2.resize(flow, (grid, grid), interpolation=cv2.INTER_AREA)
    r = lambda x: [round(float(v), 2) for v in x.ravel()]
    return {"grid_w": grid, "grid_h": grid, "block": w / grid, "u": r(g[..., 0]), "v": r(g[..., 1] * (w / h))}


# ---------------------------------------------------------------- service

class Service:
    def __init__(self):
        self.catalog = Catalog()
        self.engine = Engine()
        self.jobs: Dict[str, Dict[str, Any]] = {}
        self.pool = ThreadPoolExecutor(max_workers=1)
        self.gen_lock = threading.Lock()
        self.run_cache: Dict[str, Dict[str, Any]] = {}
        self.seq_cache: Dict[str, Dict[str, Any]] = {}

    # ---- generation
    def generate(self, f0: Frame, f1: Frame, t: float, factor: int, flow_out: Optional[list] = None) -> Frame:
        """Generate (or reuse from disk) the frame at fraction t between f0 and f1."""
        cat = self.catalog
        when = f0.time + (f1.time - f0.time) * t
        fid = f"{f0.source}_{stamp(when)}_{self.engine.name}_{f0.time:%H%M}-{f1.time:%H%M}"
        with self.gen_lock:
            fr = cat.frames.get(fid)
            if fr is None or flow_out is not None:
                a, b = cat.values(f0), cat.values(f1)
                pred, flow = self.engine.run(a, b, t)
                if flow_out is not None:
                    flow_out.append(flow)
            if fr is None:
                OUT_DIR.mkdir(parents=True, exist_ok=True)
                nc = OUT_DIR / f"{fid}.nc"
                if nc.exists():
                    nc.unlink()  # orphan without sidecar
                raw, coords, attrs = load_satellite_frame(str(f0.path))
                same_grid = raw.shape == pred.shape  # lat/lon only fit if we didn't downsample
                write_interpolated_frame_nc(
                    output_path=str(nc), data=pred, source_coords=coords if same_grid else {},
                    source_attrs=attrs, interpolation_factor=t, model_name=self.engine.name,
                    model_checkpoint=str(self.engine.checkpoint or "none"),
                    source_frame_0=str(f0.path), source_frame_1=str(f1.path),
                )
                meta = {
                    "source_frame_0": f0.path.name,
                    "source_frame_1": f1.path.name,
                    "interpolation_factor": factor,
                    "time_fraction": round(t, 4),
                    "model_name": self.engine.name,
                    "engine": self.engine.description,
                    "creation_time": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "is_synthetic": True,
                    "variable": "TIR1_interpolated · brightness_temperature (K)",
                    "satellite": KNOWN_SOURCES.get(f0.source, {}).get("short", f0.source),
                    "grid": f"{pred.shape[1]} x {pred.shape[0]}",
                }
                side = {"id": fid, "source": f0.source, "timestamp": iso(when), "frame0_id": f0.id,
                        "frame1_id": f1.id, "t": t, "metadata": meta}
                (OUT_DIR / f"{fid}.json").write_text(json.dumps(side, indent=2))
                fr = cat._register_synthetic(side)
                cat.values_cache[fr.id] = pred.astype(np.float32)
        if fr.ground_truth_id and fr.metrics is None:
            truth = cat.values(cat.get(fr.ground_truth_id))
            fr.metrics = score(truth, cat.values(fr))
            fr.baseline_metrics = score(truth, cat.values(cat.get(fr.id + "~blend")))
        return fr

    # ---- jobs
    def submit(self, source: str, frame0: str, frame1: str, factor: int) -> str:
        f0, f1 = self.catalog.get(frame0), self.catalog.get(frame1)
        if f0.source != source or f1.source != source:
            raise ValueError("frame0/frame1 must belong to the selected source")
        if f1.time <= f0.time:
            raise ValueError("frame1 must be later than frame0")
        if factor not in (2, 4, 8):
            raise ValueError("factor must be 2, 4 or 8")
        jid = uuid.uuid4().hex[:12]
        self.jobs[jid] = {"status": "queued", "progress": 0.0, "stage": "Queued", "stages": STAGES, "stage_index": -1}
        self.pool.submit(self._job, jid, f0, f1, factor)
        return jid

    def _job(self, jid, f0, f1, factor):
        job = self.jobs[jid]

        def step(i, p):
            job.update(status="running", stage=STAGES[i], stage_index=i, progress=p)

        try:
            step(0, 0.05)
            self.catalog.values(f0), self.catalog.values(f1)
            step(1, 0.15)
            step(2, 0.3)
            frames, flows = [], []
            for k in range(1, factor):
                step(3, 0.35 + 0.55 * (k - 1) / max(1, factor - 1))
                frames.append(self.generate(f0, f1, k / factor, factor, flows if k == 1 else None))
            step(4, 0.95)
            result = {"frames": [f.to_json() for f in frames]}
            if flows:
                result["flow"] = flow_grid(flows[0])
            job.update(status="done", progress=1.0, stage="done", stage_index=len(STAGES), result=result)
        except Exception as e:
            job.update(status="error", error=f"{type(e).__name__}: {e}")

    # ---- evaluation runs
    def runs(self) -> List[Dict[str, Any]]:
        out = []
        for s in self.catalog.sources():
            if s["count"] < 3:
                continue
            c = s["cadence_min"]
            if s["id"].startswith("insat"):
                out.append({"id": f"{s['id']}_holdout", "name": f"{s['short']} {s['band']} · {2*c:g}→{c:g} min hold-out"})
            else:
                out.append({"id": f"{s['id']}_eval", "name": f"{s['short']} {s['band']} · {2*c:g}→{c:g} min"})
        return out

    def metrics(self, run_id: str) -> Dict[str, Any]:
        if run_id in self.run_cache:
            return self.run_cache[run_id]
        name = next((r["name"] for r in self.runs() if r["id"] == run_id), None)
        if name is None:
            raise KeyError(run_id)
        src = run_id.rsplit("_", 1)[0]
        native = self.catalog.by_source[src]
        rows = []
        # hold out every odd frame and predict it from its neighbours
        for i in range(1, len(native) - 1, 2):
            f0, gt, f1 = native[i - 1], native[i], native[i + 1]
            fr = self.generate(f0, f1, 0.5, 2)
            rows.append({"timestamp": iso(gt.time), "frame0": iso(f0.time), "frame1": iso(f1.time),
                         "model": fr.metrics, "baseline": fr.baseline_metrics,
                         "truth_id": gt.id, "pred_id": fr.id})
        gap = (native[2].time - native[0].time).total_seconds() / 60
        res = {"run": run_id, "name": name, "source": src, "model_name": self.engine.name,
               "engine": self.engine.description, "baseline_name": "Linear blend", "gap_min": gap, "frames": rows}
        self.run_cache[run_id] = res
        return res

    # ---- sequences
    def sequences(self) -> List[Dict[str, Any]]:
        out = []
        for s in self.catalog.sources():
            if s["count"] < 3:
                continue
            out.append({"id": f"{s['id']}_eval", "name": f"{s['short']} {s['band']} · every other frame generated"})
            if s["id"].startswith("insat"):
                c = s["cadence_min"]
                out.append({"id": f"{s['id']}_15min", "name": f"{s['short']} {s['band']} · {c:g} → {c/2:g} min"})
                out.append({"id": f"{s['id']}_7p5min", "name": f"{s['short']} {s['band']} · {c:g} → {c/4:g} min"})
        return out

    def sequence(self, seq_id: str) -> Dict[str, Any]:
        if seq_id in self.seq_cache:
            return self.seq_cache[seq_id]
        name = next((s["name"] for s in self.sequences() if s["id"] == seq_id), None)
        if name is None:
            raise KeyError(seq_id)
        src, kind = seq_id.rsplit("_", 1)
        native = self.catalog.by_source[src]
        interp: List[Frame] = []
        if kind == "eval":
            for i, f in enumerate(native):
                keep = i % 2 == 0 or i == len(native) - 1
                interp.append(f if keep else self.generate(native[i - 1], native[i + 1], 0.5, 2))
        else:
            factor = 4 if kind == "7p5min" else 2
            for i in range(len(native) - 1):
                interp.append(native[i])
                interp += [self.generate(native[i], native[i + 1], k / factor, factor) for k in range(1, factor)]
            interp.append(native[-1])
        res = {"id": seq_id, "name": name, "source": src,
               "ground_truth": [f.to_json() for f in native], "interpolated": [f.to_json() for f in interp]}
        self.seq_cache[seq_id] = res
        return res
