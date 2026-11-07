"""
Tests for the real-data path: calibration, downsampling, and how the server
treats pixels with no observation (space around the Earth disk). Uses small
generated arrays, so no real satellite files are required.
"""

import io

import numpy as np
import pytest
import xarray as xr
from PIL import Image
from scipy import ndimage

from scripts.prepare_goes19 import downsample
from src.api.service import BT_MAX, Engine, Frame, Catalog, score, to_working
from src.data_pipeline.calibration import radiance_to_brightness_temperature


def disk_mask(size=128, radius=0.45):
    yy, xx = np.mgrid[0:size, 0:size]
    return np.hypot(xx - size / 2, yy - size / 2) < radius * size


def cloudy_frame(shift=0, size=128):
    """A smooth warm scene with one cold cloud, drifting right by `shift` pixels."""
    rng = np.random.default_rng(3)
    scene = 285 + 8 * ndimage.gaussian_filter(rng.standard_normal((size, size)), 5, mode="wrap")
    yy, xx = np.mgrid[0:size, 0:size]
    cloud = np.exp(-(((xx - 50 - shift) / 12) ** 2 + ((yy - 64) / 12) ** 2))
    return (scene - 70 * cloud).astype(np.float32)


def test_planck_inversion_matches_abi_equation():
    fk1, fk2, bc1, bc2 = 10803.3, 1392.74, 0.07550, 0.99975
    rad = xr.DataArray(np.array([[50.0, -1.0]]), dims=("y", "x"), name="Rad",
                       attrs=dict(planck_fk1=fk1, planck_fk2=fk2, planck_bc1=bc1, planck_bc2=bc2))
    bt = radiance_to_brightness_temperature(rad).values
    assert bt[0, 0] == pytest.approx((fk2 / np.log(fk1 / 50.0 + 1) - bc1) / bc2)
    assert np.isnan(bt[0, 1])  # non-positive radiance is not an observation


def test_downsample_ignores_no_data_pixels():
    bt = np.full((100, 100), 250.0, np.float32)
    bt[:, 50:] = np.nan
    small = downsample(bt, 10)
    assert np.isnan(small[:, 6:]).all()
    assert np.nanmin(small) == pytest.approx(250.0)
    assert np.nanmax(small) == pytest.approx(250.0)


def test_to_working_keeps_no_data_when_shrinking(monkeypatch):
    monkeypatch.setattr("src.api.service.MAX_SIDE", 10)
    bt = np.full((100, 100), 250.0, np.float32)
    bt[:, 50:] = np.nan
    small = to_working(bt)
    assert small.shape == (10, 10)
    assert np.isnan(small[:, 6:]).all()
    assert np.nanmax(small) == pytest.approx(250.0)


def test_to_working_rejects_empty_frame():
    with pytest.raises(ValueError):
        to_working(np.full((8, 8), np.nan, np.float32))


def test_score_counts_only_observed_pixels():
    disk = disk_mask()
    truth = np.where(disk, cloudy_frame(), np.nan).astype(np.float32)
    pred = truth.copy()
    pred[disk] += 2.0
    m = score(truth, pred)
    assert m["mae"] == pytest.approx(2.0, abs=1e-3)
    assert m["mse"] == pytest.approx(4.0, abs=1e-2)
    assert np.isfinite(list(m.values())).all()


def test_farneback_keeps_no_data_and_tracks_motion():
    disk = disk_mask()
    a = np.where(disk, cloudy_frame(0), np.nan).astype(np.float32)
    b = np.where(disk, cloudy_frame(8), np.nan).astype(np.float32)
    pred, flow = Engine()._run_farneback(a, b, 0.5)

    assert (np.isnan(pred) == ~disk).all()
    assert np.isfinite(flow).all()  # the dashboard sends this to the browser as JSON
    # the cold cloud should sit halfway along its path, not as a double image
    truth = cloudy_frame(4)
    assert np.mean(np.abs(pred - truth)[disk]) < 0.5 * np.mean(np.abs((a + b) / 2 - truth)[disk])


def test_farneback_fills_image_edges_when_nothing_is_missing():
    pred, _ = Engine()._run_farneback(cloudy_frame(0), cloudy_frame(8), 0.5)
    assert np.isfinite(pred).all()


def test_no_data_pixels_render_black(tmp_path, monkeypatch):
    monkeypatch.setattr("src.api.service.DATA_DIR", tmp_path / "none")
    monkeypatch.setattr("src.api.service.OUT_DIR", tmp_path / "none")
    bt = np.full((4, 4), 250.0, np.float32)
    bt[0, 0] = np.nan
    cat = Catalog()
    frame = Frame(id="f", source="s", time=None, kind="native")
    cat.values_cache["f"] = bt
    grey = np.array(Image.open(io.BytesIO(cat.png(frame, "gray"))))
    assert grey[0, 0].tolist() == [0, 0, 0]
    assert grey[1, 1, 0] > 0
    assert BT_MAX == 320.0  # no data shares the coldest display value of the grey scale
