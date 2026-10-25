# Fill in the Frames Seamlessly

**Enhancing the temporal resolution of satellite imagery using AI/ML-based optical flow frame interpolation.**

[![Python](https://img.shields.io/badge/Python-3.10+-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![PyTorch](https://img.shields.io/badge/PyTorch-2.x-EE4C2C?logo=pytorch&logoColor=white)](https://pytorch.org/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-in%20development-yellow.svg)]()

---

## Overview

Geostationary satellites capture imagery at fixed intervals — every 30 minutes for INSAT, every 10 minutes for Himawari and GOES, and every few days for polar-orbiting platforms. This fixed cadence limits near real-time monitoring of fast-evolving phenomena such as cyclones, thunderstorms, wildfires, floods, and rapid land-surface change.

Classical optical-flow interpolation struggles here: it produces blurring and artefacts, and it cannot model the fast, non-linear motion typical of cloud systems.

This project develops a deep learning frame interpolation pipeline that synthesises intermediate frames between two consecutive satellite images — effectively increasing temporal resolution **without additional satellite resources**.

> **30 min → 15 min → 7.5 min**, from the same input data.

---

## Objectives

1. **Motion estimation** — build an optical flow model that estimates motion vectors between consecutive satellite frames.
2. **Frame synthesis** — generate synthetic intermediate frames using deep learning interpolation networks.
3. **Temporal upscaling** — improve effective temporal resolution from 30 minutes to 15 minutes, and further to 7.5 minutes or equivalent.
4. **Validation** — evaluate against real high-temporal-resolution datasets (Himawari / GOES-19) using SSIM, MSE, PSNR, FSIM and other suitable metrics.

---

## How It Works

```
   Frame @ 00:00              Frame @ 00:20
        │                          │
        └────────────┬─────────────┘
                     ▼
        ┌────────────────────────┐
        │  Optical Flow Estimator│   motion vectors
        └────────────────────────┘
                     ▼
        ┌────────────────────────┐
        │ Interpolation Network  │   warping + synthesis
        └────────────────────────┘
                     ▼
            Synthetic Frame @ 00:10
                     ▼
        ┌────────────────────────┐
        │  Validation + Metrics  │   SSIM · PSNR · MSE · FSIM
        └────────────────────────┘
                     ▼
              Web Dashboard
         (ground truth vs interpolated)
```

Input and output files are handled in **NetCDF (`.nc`)** format throughout the pipeline.

---

## Datasets

Thermal infrared band data (~10 µm) from geostationary satellites. Accepted input formats: `.nc` and `.h5`.

| Satellite | Channel / Band | Source | Role |
|---|---|---|---|
| **GOES-19** | ABI Channel 13 | NOAA GOES-19 AWS bucket | Training & validation |
| **INSAT-3DS / 3DR** | TIR1 | MOSDAC | Target application |
| **Himawari-8** | Band 13 (IR) | JMA / AWS | Training & validation |

GOES-19 (or any other high-frequency geostationary source) is used for development and benchmarking. The best-performing model is then applied to INSAT-3DR/3DS data.

---

## Deliverables

### 1. Frame Interpolation

Takes two consecutive satellite images and generates the intermediate frame.

- Optical flow estimation using AI/ML models, preferably trained on satellite data
- Frame synthesis via interpolation networks
- `.nc` in, `.nc` out

### 2. Visualisation Dashboard

A web interface comparing original and interpolated imagery.

- Time-lapse animations of interpolated output
- Side-by-side animations of ground truth and generated frames

### 3. Comparison Report

- Quantitative comparison against ground truth using SSIM, MSE, PSNR, FSIM
- Plots of metric distributions across the test set
- Additional metrics explored where they better capture cloud motion

### 4. INSAT-3DS Application

- The trained model applied to INSAT-3DR/3DS imagery
- Interpolated animations prepared at **15-minute** temporal resolution

---

## Tech Stack

| Layer | Tools |
|---|---|
| **Interpolation models** | RIFE, Super SloMo, and similar video interpolation architectures |
| **Deep learning** | PyTorch |
| **Geospatial I/O** | xarray, netCDF4, h5py |
| **Metrics** | scikit-image, piq |
| **Visualisation** | Web-based dashboard (animations + metric plots) |

---

## Getting Started

### Prerequisites

- Python 3.10 or later
- CUDA-capable GPU recommended for training
- Sufficient disk space for satellite archives

### Installation

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate          # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
```

### Run the dashboard

All commands below run from `backend/`.

```bash
# 1. Sample data: synthetic GOES-19 / Himawari / INSAT-3DS sequences in data/sample/
#    (skip if you already put real .nc/.h5 files in data/sample/<satellite>/)
python scripts/make_sample_data.py

# 2. Start the API server; it also serves the dashboard
python -m uvicorn src.api.app:app --port 8000
```

Open http://localhost:8000. The status pill in the top-right should read `live · localhost:8000`.

- **Data:** each folder in `data/sample/` is one satellite (`goes19`, `himawari`, `insat3ds`, ...). Timestamps come from the file name or the file's `time` coordinate. Use `POST /api/rescan` to pick up new files without restarting.
- **Model:** if `checkpoints/interpolation_best.pth` (or `interpolation_latest.pth`) exists, frames are generated by SatelliteRIFE. Otherwise the server falls back to classical Farneback optical flow and labels every output with that engine name.
- **Output:** generated frames are written to `data/processed/interp/` as `.nc` with a `.json` metadata sidecar.
- The API contract is documented in `frontend/README.md`.

### Train, infer, test

```bash
python -m src.interpolation.train --config src/interpolation/configs/interpolation.yaml
python -m src.interpolation.inference --frame0 a.nc --frame1 b.nc --checkpoint checkpoints/interpolation_best.pth --output out.nc
python -m pytest
```

Set `data.train_dir` in the config to a folder of chronologically named frames first.

---

## Project Structure

```
.
├── configs/          # Training and model configuration
├── data/             # Raw and processed satellite imagery
├── models/           # Optical flow and interpolation architectures
├── scripts/          # Data download and preprocessing
├── dashboard/        # Web visualisation
├── notebooks/        # Exploration and analysis
├── train.py
├── interpolate.py
└── evaluate.py
```

---

## Evaluation Criteria

| Area | What is assessed |
|---|---|
| **Frame interpolation** | MSE, PSNR and other image quality metrics against ground truth |
| **Visualisation** | Web GUI design and usability |
| **INSAT-3DS output** | Visual quality of the interpolated imagery |

---

## Roadmap

- [ ] Data acquisition pipeline for GOES-19, Himawari-8, INSAT-3DS/3DR
- [ ] Preprocessing and NetCDF normalisation
- [ ] Baseline optical flow estimation
- [ ] Deep learning interpolation model training
- [ ] Metric evaluation suite (SSIM, MSE, PSNR, FSIM)
- [ ] Web dashboard with comparative animations
- [ ] INSAT-3DS interpolation at 15-minute resolution

---

## Acknowledgements

Satellite data courtesy of **NOAA** (GOES-19), **JMA** (Himawari-8), and **ISRO / MOSDAC** (INSAT-3DR / 3DS).

---

## License

Released under the MIT License. See [LICENSE](LICENSE) for details.
