"""
Turn raw GOES-19 ABI L1b Channel 13 files into frames the API and dashboard can
read: calibrated brightness temperature (K) at a manageable size, written to
data/sample/goes19_real/. Pixels with no observation (space around the Earth
disk) stay NaN.

Usage (from the project root):
    python scripts/prepare_goes19.py                        # reads data/raw
    python scripts/prepare_goes19.py --input path/to/raw    # reads another folder
    python scripts/prepare_goes19.py --force                # regenerate
"""

from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np
import xarray as xr

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.data_pipeline.calibration import find_input_files, process_file  # noqa: E402

RAW = ROOT / "data" / "raw"
OUT = ROOT / "data" / "sample" / "goes19_real"


def downsample(bt: np.ndarray, size: int) -> np.ndarray:
    """Area-average valid pixels only, so space never bleeds into the disk edge."""
    valid = np.isfinite(bt)
    total = cv2.resize(np.where(valid, bt, 0).astype(np.float32), (size, size), interpolation=cv2.INTER_AREA)
    coverage = cv2.resize(valid.astype(np.float32), (size, size), interpolation=cv2.INTER_AREA)
    keep = cv2.resize(valid.astype(np.uint8), (size, size), interpolation=cv2.INTER_NEAREST).astype(bool)
    keep &= coverage > 0
    out = np.full((size, size), np.nan, np.float32)
    out[keep] = total[keep] / coverage[keep]
    return out


def prepare(path: Path, out_path: Path, size: int) -> tuple[float, float, float]:
    with tempfile.TemporaryDirectory() as tmp:
        full = Path(tmp) / f"{path.stem}_BT.nc"
        process_file(path, full)
        with xr.open_dataset(full) as ds:
            attrs = dict(ds.attrs)
            bt_attrs = dict(ds["brightness_temperature"].attrs)
            small = downsample(ds["brightness_temperature"].values, size)
    da = xr.DataArray(small, dims=("y", "x"), name="brightness_temperature", attrs=bt_attrs)
    ds = da.to_dataset()
    ds.attrs = attrs
    ds.to_netcdf(out_path, encoding={"brightness_temperature": {"zlib": True, "complevel": 4}})
    return float(np.nanmin(small)), float(np.nanmax(small)), float(np.isfinite(small).mean())


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", type=Path, default=RAW, help="folder of raw ABI L1b .nc files")
    ap.add_argument("--size", type=int, default=1024, help="output side length in pixels")
    ap.add_argument("--force", action="store_true", help="overwrite existing frames")
    args = ap.parse_args()

    files = find_input_files(args.input)
    if not files:
        raise SystemExit(f"No .nc files found in {args.input}")
    OUT.mkdir(parents=True, exist_ok=True)
    for path in files:
        out_path = OUT / path.name
        if out_path.exists() and not args.force:
            print(f"{path.name}: already prepared, skipping (use --force)")
            continue
        low, high, disk = prepare(path, out_path, args.size)
        print(f"{path.name}: {low:.1f}-{high:.1f} K, {disk:.0%} of pixels valid")
    print(f"Frames are in {OUT}. Use POST /api/rescan or restart the server to load them.")


if __name__ == "__main__":
    main()
