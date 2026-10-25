# Frontend: Fill the Frames dashboard

A dashboard for the optical-flow frame interpolation project. It's plain HTML, CSS and JS: nothing to build and no `npm install`.

## Run it

```bash
cd frontend
python -m http.server 5500
# open http://localhost:5500
```

(Opening `index.html` by double-click also works, but a local server is closer to how it'll run with the backend.)

At startup the dashboard looks for a backend at `http://localhost:8000`. To change the URL, click the status pill in the top-right corner. If no backend answers, the dashboard switches to **demo data**: it generates brightness-temperature fields in the browser (a moving cloud deck, a rotating cyclone and a fast-growing convective cell), so every screen can be used before the model server exists. Reports built from demo data carry a warning banner.

## Screens

| Tab | What it covers |
|---|---|
| **Workbench** | Choose a satellite, frame 0 and frame 1, the factor (×2 / ×4 / ×8) and the model, then run inference. A progress bar shows each stage. Compare the generated frame with the real one side by side, with a swipe slider, blinking, or as a signed error map, with optional optical-flow vectors. Shows metrics against ground truth and the linear-blend baseline, the NetCDF metadata panel (`is_synthetic` highlighted), and a `.nc` download. |
| **Animation** | Two synced time-lapse tracks: ground truth and interpolated. Controls: play/pause, step, scrub, speed (0.5–12 fps) and loop. Keyboard: space, ← and →. Generated frames get orange ticks on the timeline. |
| **Metrics** | Mean SSIM, PSNR, MSE, MAE, cold-cloud IoU and edge SSIM compared with the baseline, a trend chart per metric, a per-frame PSNR-gain bar chart and a per-frame table. Export to CSV or JSON, or load a metrics JSON from `train.py`. |
| **INSAT-3DS** | The deliverable: native 30-minute frames next to 15-minute (or 7.5-minute) output. The sparse track holds its last frame so the gaps show. Also shows the 60→30 min hold-out scores and the list of output files. |
| **Report** | Builds a single HTML report with example comparisons (truth / model / blend / error), metric tables, charts and definitions. **Save as PDF** uses the browser's print dialog. |

## Backend API contract (for `inference.py` / `train.py`)

The backend should be a small FastAPI or Flask app that wraps `SatelliteRIFE` / `run_inference()`. It must allow CORS from the dashboard origin. Timestamps are ISO-8601 UTC strings with a `Z`, e.g. `2026-09-14T18:10:00Z`.

### Frames

```
GET /api/health                → {"status": "ok"}
GET /api/sources               → [{"id": "goes19", "name": "GOES-19 ABI · C13", "band": "C13", "cadence_min": 10}, ...]
GET /api/frames?source=goes19  → [{"id": "...", "source": "goes19", "timestamp": "...", "file": "data/sample/...nc", "is_synthetic": false}, ...]
GET /api/frames/{id}/image?cmap=gray|enhanced → image/png
GET /api/frames/{id}/nc        → the .nc file (download)
```

**Important:** the `cmap=gray` PNG must use a fixed linear scale: **180 K → 255 (white), 320 K → 0 (black)**. The dashboard reads brightness temperature back from those pixels to draw the difference maps. `enhanced` can look however you like.

Generated frames are frames too. Serve them through the same `/api/frames/{id}/...` routes.

### Inference

```
POST /api/interpolate
  {"source": "goes19", "frame0": "<id>", "frame1": "<id>", "factor": 2, "model": "SatelliteRIFE"}
  → {"job_id": "abc123"}

GET /api/jobs/abc123
  → {"status": "running", "progress": 0.4, "stage": "Estimating optical flow",
     "stages": ["Reading NetCDF inputs", "..."], "stage_index": 2}
  → {"status": "done", "result": {
        "frames": [{
          "id": "goes19_20260914_1810_SatelliteRIFE",
          "timestamp": "2026-09-14T18:10:00Z",
          "file": "data/processed/interp/....nc",
          "is_synthetic": true,
          "ground_truth_id": "goes19_20260914_1810",      // null if no real frame at that time
          "metadata": { /* the attrs write_interpolated_frame_nc() writes:
                           source_frame_0, source_frame_1, interpolation_factor,
                           model_name, creation_time, is_synthetic, ... */ },
          "metrics":          {"ssim": 0.98, "psnr": 38.1, "mse": 3.1, "mae": 0.94},   // optional
          "baseline_metrics": {"ssim": 0.91, "psnr": 31.8, "mse": 12.8, "mae": 1.72}   // optional
        }],
        "flow": {"grid_w": 16, "grid_h": 16, "block": 16, "u": [...], "v": [...]}     // optional, pixels t0→t1
     }}
  → {"status": "error", "error": "message"}
```

If `metrics` is missing, the dashboard computes SSIM, PSNR, MSE and MAE itself from the grey PNGs.

### Evaluation runs (output of `validate()` / `compute_metrics()`)

```
GET /api/runs          → [{"id": "goes19_eval", "name": "GOES-19 C13 · 20→10 min"}, {"id": "insat3ds_holdout", ...}]
GET /api/metrics/{run} → {
  "run": "goes19_eval", "name": "...", "model_name": "SatelliteRIFE", "gap_min": 20,
  "frames": [
    {"timestamp": "2026-09-14T18:10:00Z",
     "model":    {"ssim": 0.98, "psnr": 38.0, "mse": 3.1, "mae": 0.94, "fsim": 0.97},
     "baseline": {"ssim": 0.91, "psnr": 31.6, "mse": 13.6, "mae": 1.76},
     "truth_id": "<frame id>", "pred_id": "<frame id>"}   // ids are optional; used for report images
  ]}
```

The INSAT-3DS tab expects a run with id `insat3ds_holdout`.

Recognised metric keys: `ssim`, `psnr`, `mse`, `mae`, `fsim`, `cloud_iou`, `grad_ssim`. `baseline` is optional. **Load metrics JSON** on the Metrics tab reads the same shape, or a flat list such as `[{"timestamp": "...", "ssim": ..., "psnr": ...}]`. That means `train.py` can dump a file and you can look at it without running the server.

### Sequences (animations)

```
GET /api/sequences      → [{"id": "goes19_eval", "name": "..."}, {"id": "insat3ds_15min", ...}, {"id": "insat3ds_7p5min", ...}]
GET /api/sequences/{id} → {"ground_truth": [frame, ...], "interpolated": [frame, ...]}
```

`interpolated` is the full output timeline, with native and generated frames mixed and each generated one flagged `is_synthetic: true`. The INSAT-3DS tab expects sequence ids `insat3ds_15min` and `insat3ds_7p5min`.

## Files

```
index.html        page structure
css/styles.css    theme (light + dark follow the OS setting)
js/api.js         live backend client + demo data source
js/field.js       colour maps, demo cloud generator, flow vectors
js/metrics.js     SSIM / PSNR / MSE / MAE / cold-cloud IoU / edge SSIM
js/charts.js      SVG line & bar charts with hover tooltips
js/viewer.js      ground truth vs generated comparison modes
js/player.js      two-track synced time-lapse player
js/report.js      standalone HTML/PDF report builder
js/app.js         tab wiring and screen logic
```
