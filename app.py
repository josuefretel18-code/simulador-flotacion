"""
Servidor web del simulador de control de nivel FB / FB+FF.

Ejecutar en local:
    python app.py                 -> http://127.0.0.1:5000

Producción (Render / Railway):
    gunicorn app:app --workers 1 --threads 8 --bind 0.0.0.0:$PORT
    (1 worker: las sesiones de simulación viven en memoria del proceso)
"""

from __future__ import annotations

import os
import threading
import time
import uuid

from flask import Flask, jsonify, render_template, request

from simulator import config as C
from simulator.model import TwinSimulation, run_batch

app = Flask(__name__)

SESSION_TTL_S = 30 * 60
MAX_SESSIONS = 300
MAX_STEPS_PER_CALL = 200

_sessions: dict[str, dict] = {}
_lock = threading.Lock()


# --------------------------------------------------------------------------- utilidades
def _merge_params(user: dict | None) -> dict:
    """Combina los parámetros enviados por el cliente con los valores por defecto."""
    p = C.default_parameters()
    if not user:
        return p
    for k, v in user.items():
        if isinstance(v, dict) and isinstance(p.get(k), dict):
            p[k].update(v)
        else:
            p[k] = v
    return _sanitize(p)


def _sanitize(p: dict) -> dict:
    def three(x, default):
        try:
            vals = [float(v) for v in x][:3]
            return vals if len(vals) == 3 else list(default)
        except Exception:  # noqa: BLE001
            return list(default)

    ctrl = p["controller"]
    ctrl["Kc"] = three(ctrl.get("Kc"), C.KC_FINAL)
    ctrl["tauI"] = [max(1.0, v) for v in three(ctrl.get("tauI"), C.TAU_I_FINAL)]
    ctrl["Kff"] = three(ctrl.get("Kff"), C.KFF)
    ctrl["form"] = "positional" if ctrl.get("form") == "positional" else "velocity"
    pl = p["plant"]
    pl["k_prime"] = three(pl.get("k_prime"), C.K_PRIME)
    pl["theta"] = [int(max(0, min(60, round(v)))) for v in three(pl.get("theta"), C.THETA_S)]
    pl["conc_flow"] = [max(0.0, v) for v in three(pl.get("conc_flow"), [0, 0, 0])]
    p["setpoints"] = [min(C.CELL_HEIGHT_CM, max(0.0, v))
                      for v in three(p.get("setpoints"), C.SP_INITIAL)]
    p["feed_flow"] = max(0.0, float(p.get("feed_flow", C.FEED_FLOW_DEFAULT)))
    p["air_flow"] = max(0.0, min(100.0, float(p.get("air_flow", C.AIR_FLOW_DEFAULT_LPM))))
    p["noise_std"] = max(0.0, float(p.get("noise_std", C.LEVEL_NOISE_STD_CM)))
    p["noise_on"] = bool(p.get("noise_on", True))
    p["median_window"] = int(max(1, min(60, int(p.get("median_window", C.MEDIAN_WINDOW)))))
    p["pump_bits_max"] = int(max(1000, min(C.INT16_MAX, int(p.get("pump_bits_max",
                                                                   C.PUMP_BITS_MAX_CALIBRATED)))))
    rd = p.get("random_dist") or {}
    p["random_dist"] = {
        "on": bool(rd.get("on", False)),
        "amplitude": max(0.0, float(rd.get("amplitude", 10.0))),
        "period": int(max(1, int(rd.get("period", 20)))),
    }
    return p


def _cleanup():
    now = time.time()
    dead = [sid for sid, s in _sessions.items() if now - s["last"] > SESSION_TTL_S]
    for sid in dead:
        _sessions.pop(sid, None)
    if len(_sessions) > MAX_SESSIONS:
        for sid, _ in sorted(_sessions.items(), key=lambda kv: kv[1]["last"])[
                : len(_sessions) - MAX_SESSIONS]:
            _sessions.pop(sid, None)


def _get(sid: str):
    s = _sessions.get(sid)
    if s is None:
        return None
    s["last"] = time.time()
    return s


# --------------------------------------------------------------------------- rutas
@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/health")
def health():
    return jsonify(status="ok", sessions=len(_sessions))


@app.get("/api/defaults")
def defaults():
    return jsonify(params=C.default_parameters(), article=C.article_info())


@app.post("/api/session")
def create_session():
    body = request.get_json(silent=True) or {}
    params = _merge_params(body.get("params"))
    scenario = body.get("scenario", "free")
    sim = TwinSimulation(params, scenario=scenario)
    sid = uuid.uuid4().hex
    with _lock:
        _cleanup()
        _sessions[sid] = {"sim": sim, "lock": threading.Lock(), "last": time.time()}
    snap = {"fb": [sim.fb.snapshot()], "ff": [sim.ff.snapshot()], "t": 0.0,
            "setpoints": sim.params["setpoints"]}
    return jsonify(session_id=sid, params=sim.params, initial=snap)


@app.post("/api/session/<sid>/step")
def step_session(sid):
    with _lock:
        s = _get(sid)
    if s is None:
        return jsonify(error="session_not_found"), 404
    body = request.get_json(silent=True) or {}
    n = int(max(1, min(MAX_STEPS_PER_CALL, int(body.get("steps", 1)))))
    with s["lock"]:
        sim: TwinSimulation = s["sim"]
        if body.get("params"):
            merged = _merge_params({**sim.params, **body["params"]})
            # el escenario del artículo controla los setpoints; no se pisan desde la UI
            if sim.scenario == "article" and not body.get("override_setpoints"):
                merged["setpoints"] = sim.params["setpoints"]
            sim.update_params(merged)
        out = sim.step(n)
    return jsonify(out)


@app.post("/api/session/<sid>/reset")
def reset_session(sid):
    with _lock:
        s = _get(sid)
    if s is None:
        return jsonify(error="session_not_found"), 404
    body = request.get_json(silent=True) or {}
    params = _merge_params(body.get("params"))
    with s["lock"]:
        sim: TwinSimulation = s["sim"]
        sim.reset(params, body.get("scenario", "free"))
        snap = {"fb": [sim.fb.snapshot()], "ff": [sim.ff.snapshot()], "t": 0.0,
                "setpoints": sim.params["setpoints"]}
    return jsonify(params=sim.params, initial=snap)


@app.post("/api/run")
def run():
    """Ejecución instantánea de un experimento completo (por defecto, el de la Fig. 14)."""
    body = request.get_json(silent=True) or {}
    params = _merge_params(body.get("params"))
    duration = int(max(10, min(7200, int(body.get("duration", C.EXPERIMENT_DURATION_S)))))
    scenario = body.get("scenario", "article")
    res = run_batch(params, duration=duration, scenario=scenario)
    return jsonify(res)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
