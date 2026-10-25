"""
FastAPI app implementing the API contract in frontend/README.md.

Run from the backend/ folder:
    python -m uvicorn src.api.app:app --port 8000
then open http://localhost:8000 (the dashboard is served from the same origin).
"""

from __future__ import annotations

from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .service import BACKEND_DIR, DATA_DIR, Service

app = FastAPI(title="SITAR frame interpolation API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

svc = Service()
SUPPORTED_MODELS = {"SatelliteRIFE"}


def frame_or_404(frame_id: str):
    try:
        return svc.catalog.get(frame_id)
    except KeyError:
        raise HTTPException(404, f"unknown frame '{frame_id}'")


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "mode": "live",
        "model": svc.engine.description,
        "checkpoint": str(svc.engine.checkpoint) if svc.engine.checkpoint else None,
        "data_dir": str(DATA_DIR),
        "sources": len(svc.catalog.by_source),
    }


@app.get("/api/sources")
def sources():
    return svc.catalog.sources()


@app.get("/api/frames")
def frames(source: str):
    if source not in svc.catalog.by_source:
        raise HTTPException(404, f"unknown source '{source}'")
    return [f.to_json() for f in svc.catalog.by_source[source]]


@app.get("/api/frames/{frame_id}/image")
def frame_image(frame_id: str, cmap: Literal["gray", "enhanced"] = "gray"):
    f = frame_or_404(frame_id)
    try:
        png = svc.catalog.png(f, cmap)
    except Exception as e:
        raise HTTPException(500, f"could not render {frame_id}: {e}")
    return Response(png, media_type="image/png", headers={"Cache-Control": "max-age=3600"})


@app.get("/api/frames/{frame_id}/nc")
def frame_nc(frame_id: str):
    f = frame_or_404(frame_id)
    if f.path is None or not f.path.is_file():
        raise HTTPException(404, f"no file on disk for '{frame_id}'")
    return FileResponse(f.path, filename=f.path.name, media_type="application/x-netcdf")


class InterpolateRequest(BaseModel):
    source: str
    frame0: str
    frame1: str
    factor: int = 2
    model: str = "SatelliteRIFE"


@app.post("/api/interpolate")
def interpolate(req: InterpolateRequest):
    if req.model not in SUPPORTED_MODELS:
        raise HTTPException(400, f"model '{req.model}' is not available on this server (available: {', '.join(sorted(SUPPORTED_MODELS))})")
    frame_or_404(req.frame0), frame_or_404(req.frame1)
    try:
        return {"job_id": svc.submit(req.source, req.frame0, req.frame1, req.factor)}
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/jobs/{job_id}")
def job(job_id: str):
    j = svc.jobs.get(job_id)
    if j is None:
        raise HTTPException(404, f"unknown job '{job_id}'")
    return j


@app.get("/api/runs")
def runs():
    return svc.runs()


@app.get("/api/metrics/{run_id}")
def metrics(run_id: str):
    try:
        return svc.metrics(run_id)
    except KeyError:
        raise HTTPException(404, f"unknown run '{run_id}'")


@app.get("/api/sequences")
def sequences():
    return svc.sequences()


@app.get("/api/sequences/{seq_id}")
def sequence(seq_id: str):
    try:
        return svc.sequence(seq_id)
    except KeyError:
        raise HTTPException(404, f"unknown sequence '{seq_id}'")


@app.post("/api/rescan")
def rescan():
    """Pick up frames added to data/sample/ without restarting the server."""
    svc.catalog.scan()
    svc.run_cache.clear()
    svc.seq_cache.clear()
    return {"sources": svc.catalog.sources()}


FRONTEND_DIR = BACKEND_DIR.parent / "frontend"
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
