"""
Write small synthetic thermal-IR sequences to data/sample/<source>/ so the API
and dashboard can run before real GOES-19 / Himawari / INSAT data is downloaded.

Each frame is a brightness-temperature field (K) with a drifting cloud deck,
a rotating cyclone and a convective cell that grows quickly (the non-linear
case a plain blend gets wrong). Files are named like the real products, so
dropping real files into the same folders works the same way.

Usage (from backend/):
    python scripts/make_sample_data.py            # skips sources that already have files
    python scripts/make_sample_data.py --force    # regenerate
"""

from __future__ import annotations

import argparse
import datetime as dt
from pathlib import Path

import numpy as np
import xarray as xr
from scipy import ndimage

OUT = Path(__file__).resolve().parents[1] / "data" / "sample"
N = 256
MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]

SOURCES = [
    # id, variable name, cadence (min), frame count, start time, seed
    ("goes19", "CMI", 10, 19, dt.datetime(2026, 9, 14, 18, 0), 11),
    ("himawari", "tbb_13", 10, 19, dt.datetime(2026, 9, 14, 3, 0), 29),
    ("insat3ds", "TIR1", 30, 13, dt.datetime(2026, 9, 14, 0, 0), 47),
]


def filename(src: str, t: dt.datetime) -> str:
    if src == "goes19":
        return f"OR_ABI-L2-CMIPF-M6C13_G19_s{t:%Y}{t.timetuple().tm_yday:03d}{t:%H%M}000.nc"
    if src == "himawari":
        return f"NC_H09_{t:%Y%m%d}_{t:%H%M}_B13_FLDK_06001_06001.nc"
    return f"3SIMG_{t:%d}{MON[t.month - 1]}{t:%Y}_{t:%H%M}_L1B_STD_V01R00.nc"


def noise(rng: np.random.Generator, size: int) -> np.ndarray:
    """Periodic multi-scale noise in [0, 1]."""
    out = np.zeros((size, size), np.float32)
    for sigma, amp in ((24, 1.0), (10, 0.5), (4, 0.25), (1.5, 0.12)):
        out += amp * ndimage.gaussian_filter(rng.standard_normal((size, size)), sigma, mode="wrap")
    out -= out.min()
    return out / out.max()


def make_sequence(seed: int, minutes: np.ndarray) -> list[np.ndarray]:
    rng = np.random.default_rng(seed)
    big = 2 * N
    clouds, depth, surface = noise(rng, big), noise(rng, big), noise(rng, N)
    wind = np.array([0.22 + rng.random() * 0.2, 0.04 + rng.random() * 0.08])  # px / min
    cyc = np.array([70 + rng.random() * 40, 150 + rng.random() * 30])
    cell = np.array([150 + rng.random() * 40, 170 + rng.random() * 30])
    cell_t0 = 55 + rng.random() * 50

    yy, xx = np.mgrid[0:N, 0:N].astype(np.float32)
    sfc = 288 + 12 * surface - 0.04 * yy  # warm ground, a bit cooler to the "north"
    frames = []
    for m in minutes:
        # advect the deck with the mean wind
        x, y = xx - wind[0] * m, yy - wind[1] * m
        # spin it around the moving cyclone centre, faster near the core
        c = cyc + np.array([0.16, -0.07]) * m
        dx, dy = x - c[0], y - c[1]
        r = np.hypot(dx, dy)
        ang = -0.009 * m * np.exp(-r / 42) * 2.6
        x = c[0] + dx * np.cos(ang) - dy * np.sin(ang)
        y = c[1] + dx * np.sin(ang) + dy * np.cos(ang)
        cov = ndimage.map_coordinates(clouds, [y, x], order=1, mode="grid-wrap")
        dep = ndimage.map_coordinates(depth, [y, x], order=1, mode="grid-wrap")
        cov = cov + 0.45 * np.exp(-(r / 42) ** 2)                      # cyclone core
        cc = cell + np.array([0.12, 0.02]) * m
        grow = 1 / (1 + np.exp(-(m - cell_t0) / 14))                   # fast convective growth
        cov = cov + 0.7 * grow * np.exp(-(np.hypot(xx - cc[0], yy - cc[1]) / (6 + 16 * grow)) ** 2)
        a = np.clip((cov - 0.45) / 0.35, 0, 1)
        a = a * a * (3 - 2 * a)
        top = 252 - 58 * np.clip(dep + 0.5 * a, 0, 1)
        frames.append((sfc * (1 - a) + top * a).astype(np.float32))
    return frames


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--force", action="store_true", help="overwrite existing sample files")
    args = ap.parse_args()

    for src, var, cadence, count, start, seed in SOURCES:
        d = OUT / src
        if d.is_dir() and any(d.iterdir()) and not args.force:
            print(f"{src}: {d} already has files, skipping (use --force)")
            continue
        d.mkdir(parents=True, exist_ok=True)
        for old in d.glob("*.nc"):
            old.unlink()
        minutes = np.arange(count) * cadence
        lat = np.linspace(30, 0, N, dtype=np.float32)
        lon = np.linspace(60, 100, N, dtype=np.float32)
        for m, bt in zip(minutes, make_sequence(seed, minutes)):
            t = start + dt.timedelta(minutes=int(m))
            da = xr.DataArray(bt[None], dims=("time", "y", "x"), name=var,
                              coords={"time": [np.datetime64(t, "s")], "lat": ("y", lat), "lon": ("x", lon)})
            da.attrs.update(units="K", long_name="brightness temperature", sensor=src, synthetic_sample="true")
            da.to_dataset().to_netcdf(d / filename(src, t))
        print(f"{src}: wrote {count} frames to {d}")


if __name__ == "__main__":
    main()
