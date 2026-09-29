"""Local HTTP bridge for the browser-specialized Laya checkpoint.

Loads cklxx/laya-browser with its Hugging Face remote code and exposes the tiny API
used by the Node app:
  GET  /health
  POST /v1/decide   {"page": ..., "goal": "...", "history": [...]}
"""
import os
import time
from typing import Any

import torch
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from transformers import AutoModel

MODEL_ID = os.environ.get("LAYA_MODEL", "cklxx/laya-browser")
HOST = os.environ.get("LAYA_HOST", "127.0.0.1")
PORT = int(os.environ.get("LAYA_PORT", "8001"))

requested = os.environ.get("LAYA_DEVICE", "").strip().lower()
if requested:
    DEVICE = requested
else:
    DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

print(f"[laya-browser] loading {MODEL_ID} on {DEVICE} ...", flush=True)
_t0 = time.perf_counter()
model = AutoModel.from_pretrained(MODEL_ID, trust_remote_code=True)
model = model.to(DEVICE)
model.eval()

if os.environ.get("LAYA_WARMUP", "1") != "0":
    # The first CUDA decision can pay a multi-second kernel compilation cost. Compile a
    # representative near-max action observation before advertising readiness so the first
    # spoken page-local command sees warm latency instead of the compile spike.
    warm_page = {
        "url": "https://warmup.invalid/",
        "title": "Warmup",
        "text": ("warmup visible page text " * 50)[:1200],
        "actions": [
            {"id": f"e{i:02d}", "node": f"e{i:02d}", "kind": "click", "label": f"Warmup link {i}", "role": "link"}
            for i in range(1, 41)
        ],
    }
    tw = time.perf_counter()
    with torch.inference_mode():
        model.decide(warm_page, goal="click warmup link 20", history=[])
    if DEVICE.startswith("cuda") and torch.cuda.is_available():
        torch.cuda.synchronize()
    print(f"[laya-browser] warmup {(time.perf_counter() - tw):.1f}s", flush=True)

print(f"[laya-browser] ready in {(time.perf_counter() - _t0):.1f}s", flush=True)

app = FastAPI()


def plain(value: Any):
    if isinstance(value, torch.Tensor):
        if value.numel() == 1:
            return value.detach().cpu().item()
        return value.detach().cpu().tolist()
    if isinstance(value, dict):
        return {str(k): plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(v) for v in value]
    if hasattr(value, "item") and callable(value.item):
        try:
            return value.item()
        except Exception:
            pass
    return value


@app.get("/health")
def health():
    gpu = None
    if DEVICE.startswith("cuda") and torch.cuda.is_available():
        gpu = torch.cuda.get_device_name(0)
    return {
        "status": "ok",
        "loaded": [MODEL_ID],
        "device": DEVICE,
        "gpu": gpu,
        "backend": "laya-browser",
    }


@app.post("/v1/decide")
async def decide(request: Request):
    body = await request.json()
    page = body.get("page")
    goal = str(body.get("goal") or "").strip()
    history = body.get("history") or []
    if not isinstance(page, dict) or not goal:
        raise HTTPException(400, "page and goal are required")

    t0 = time.perf_counter()
    try:
        with torch.inference_mode():
            result = model.decide(page, goal=goal, history=history)
    except Exception as exc:
        raise HTTPException(500, f"{type(exc).__name__}: {exc}") from exc

    out = plain(result)
    out["model"] = MODEL_ID
    out["device"] = DEVICE
    out["latency_ms"] = round((time.perf_counter() - t0) * 1000, 1)
    return out


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level=os.environ.get("LAYA_LOG_LEVEL", "warning"))
