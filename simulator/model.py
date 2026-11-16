"""
Modelo dinámico y lógica de control del banco de 3 celdas de flotación en serie.

Implementa, siguiendo el artículo (MethodsX 10 (2023) 102081):

  * Planta integradora por celda (Tabla 2):  G_p(s) = k' e^{-θ s} / s
        dh_i/dt = k'_i · ( Q_out,i(t-θ_i) + Q_conc,i - Q_in,i(t) )
    con k' < 0: más caudal de relaves => el nivel baja.
    Celdas acopladas en serie: Q_in,1 = Q_feed ;  Q_in,i = Q_out,i-1  (Figs. 4 y 15).
  * Conversión a registros INT de 16 bits (0..32767) con las curvas de calibración
    de las Figs. 9 (bombas) y 11 (sensores de nivel).
  * Ruido del sensor de nivel dependiente de jg (aire) y filtro de mediana móvil
    (medfilt1, ventana de 10 muestras).
  * PI (Ec. 1 con τ_d = 0) + Feedforward (Ecs. 7 y 8):
        u_i = Kc_i ( e_i + (1/τI_i) ∫ e_i dτ ) + Kff_i · ΔQ_d,i
        ΔQ_d,i = Q_d,i(t) - Q_d,i(t-1)
    en dos implementaciones seleccionables:
        - "positional": Ec. 7 literal (con sesgo de operación y anti-windup).
        - "velocity":   forma incremental equivalente, en la que el término ΔQ_d de la
                        Ec. 8 se suma en cada muestreo (feedforward estático acumulado).
  * Saturación de actuadores (0 .. bits máximos calibrados) sin límite de velocidad
    de cambio (como indica el artículo).
  * IAE (Ec. 9): IAE_i = ∫ |e_i| dt.
"""

from __future__ import annotations

import copy
import random
from collections import deque
from statistics import median

from . import config as C


# ======================================================================================
# Instrumentación: conversión unidades de ingeniería <-> registros de 16 bits
# ======================================================================================
def clip(x, lo, hi):
    return lo if x < lo else hi if x > hi else x


def flow_to_bits(q: float, slope: float, bits_max: int) -> int:
    """Escritura PLC (ddepoke): caudal -> entero de 16 bits (Fig. 9, Q = m·bits)."""
    return int(clip(round(q / slope), C.INT16_MIN, min(bits_max, C.INT16_MAX)))


def bits_to_flow(bits: int, slope: float) -> float:
    return bits * slope


def bits_to_rpm(bits: int) -> float:
    return clip(bits / C.PUMP_BITS_FULL_SCALE * C.PUMP_RPM_MAX, 0.0, C.PUMP_RPM_MAX)


def level_to_bits(h_cm: float, cal: dict) -> int:
    """Sensor -> PLC: nivel físico -> entero de 16 bits (inversa de la Fig. 11)."""
    return int(clip(round((h_cm - cal["b"]) / cal["a"]), C.INT16_MIN, C.INT16_MAX))


def bits_to_level(bits: int, cal: dict) -> float:
    """Lectura PLC (ddereq): entero de 16 bits -> nivel [cm] (Fig. 11, h = a·bits + b)."""
    return cal["a"] * bits + cal["b"]


def air_flow_to_bits(q_air: float) -> int:
    return int(clip(round(q_air / C.AIR_SLOPE_WRITE), C.INT16_MIN, C.INT16_MAX))


# ======================================================================================
# Controlador PI + FF de una celda
# ======================================================================================
class PIFFController:
    def __init__(self, u0: float, d0: float, e0: float = 0.0):
        self.u0 = u0              # sesgo de operación (forma posicional)
        self.u_prev = u0          # última salida saturada (forma velocidad)
        self.e_prev = e0
        self.integral = 0.0
        self.d_prev = d0

    def compute(self, e: float, d: float, Kc: float, tauI: float, Kff: float,
                ff_on: bool, form: str, u_min: float, u_max: float, Ts: float) -> float:
        dQ = d - self.d_prev                         # Ec. 8
        ff = Kff * dQ if ff_on else 0.0
        tauI = max(tauI, 1e-6)

        if form == "positional":
            # Ec. 7 literal: u = u0 + Kc(e + I/τI) + Kff·ΔQ
            new_int = self.integral + e * Ts
            u_unsat = self.u0 + Kc * (e + new_int / tauI) + ff
            u = clip(u_unsat, u_min, u_max)
            # anti-windup por integración condicional: no se integra si el
            # actuador está saturado y la acción integral empuja más hacia el límite
            push = Kc * e   # signo de la contribución integral de este muestreo
            windup = (u_unsat > u_max and push > 0) or (u_unsat < u_min and push < 0)
            if not windup:
                self.integral = new_int
        else:
            # Forma velocidad: Δu = Kc[(e_k - e_{k-1}) + Ts/τI·e_k] + Kff·ΔQ_d
            du = Kc * ((e - self.e_prev) + Ts / tauI * e) + ff
            u = clip(self.u_prev + du, u_min, u_max)

        self.u_prev = u
        self.e_prev = e
        self.d_prev = d
        return u


# ======================================================================================
# Banco de 3 celdas (planta + instrumentación + control)
# ======================================================================================
class FlotationBank:
    TAIL_KEYS = ["tail1", "tail2", "tail3"]

    def __init__(self, params: dict, ff_on: bool, seed: int = 12345):
        self.ff_on = ff_on
        self.rng = random.Random(seed)
        self.t = 0.0
        self.p = copy.deepcopy(params)
        self._build()

    # ------------------------------------------------------------------ inicialización
    def _build(self):
        p = self.p
        n = C.N_CELLS
        sp = p["setpoints"]
        qc = p["plant"]["conc_flow"]
        feed = p["feed_flow"]

        # estado estacionario inicial: niveles en setpoint, Q_out,i = Q_in,i - Q_conc,i
        self.h = list(sp)
        q_in = feed
        u_ss = []
        for i in range(n):
            q_out = max(q_in - qc[i], 0.0)
            u_ss.append(q_out)
            q_in = q_out

        # bomba de alimentación cuantizada
        self.feed_bits = flow_to_bits(feed, C.PUMP_SLOPE["feed"], C.INT16_MAX)
        self.q_feed = bits_to_flow(self.feed_bits, C.PUMP_SLOPE["feed"])

        # comandos cuantizados y búferes de tiempo muerto
        self.bits_cmd = []
        self.u_cmd = []
        self.delay = []
        for i in range(n):
            s = C.PUMP_SLOPE[self.TAIL_KEYS[i]]
            b = flow_to_bits(u_ss[i], s, p["pump_bits_max"])
            self.bits_cmd.append(b)
            self.u_cmd.append(bits_to_flow(b, s))
            theta = int(round(p["plant"]["theta"][i]))
            self.delay.append(deque([self.u_cmd[i]] * max(theta, 0)))
        self.q_out = list(self.u_cmd)      # caudal de relaves efectivamente entregado

        # filtro de mediana
        w = max(1, int(p["median_window"]))
        self.med_buf = [deque([self.h[i]] * w, maxlen=w) for i in range(n)]
        self.y_filt = list(self.h)
        self.y_meas = list(self.h)
        self.level_bits = [level_to_bits(self.h[i], C.LEVEL_CAL[i]) for i in range(n)]

        # perturbaciones medidas iniciales
        d0 = [self.q_feed] + self.q_out[:-1]
        self.d = list(d0)
        self.ctrl = [PIFFController(self.u_cmd[i], d0[i], 0.0) for i in range(n)]
        self.iae = [0.0] * n
        self.overflow = [False] * n

    # ------------------------------------------------------------------ parámetros vivos
    def update_params(self, new: dict):
        """Aplica en caliente los parámetros editables desde la interfaz."""
        p = self.p
        for key in ("setpoints", "feed_flow", "air_flow", "noise_std", "noise_on",
                    "pump_bits_max"):
            if key in new:
                p[key] = copy.deepcopy(new[key])
        if "controller" in new:
            p["controller"].update(copy.deepcopy(new["controller"]))
        if "plant" in new:
            pl = new["plant"]
            if "k_prime" in pl:
                p["plant"]["k_prime"] = list(pl["k_prime"])
            if "conc_flow" in pl:
                p["plant"]["conc_flow"] = list(pl["conc_flow"])
            if "theta" in pl:
                for i, th in enumerate(pl["theta"]):
                    th = max(0, int(round(th)))
                    if th != len(self.delay[i]):
                        last = self.delay[i][-1] if self.delay[i] else self.u_cmd[i]
                        self.delay[i] = deque([last] * th)
                p["plant"]["theta"] = [max(0, int(round(x))) for x in pl["theta"]]
        if "median_window" in new:
            w = max(1, int(new["median_window"]))
            if w != p["median_window"]:
                p["median_window"] = w
                for i in range(C.N_CELLS):
                    last = list(self.med_buf[i])[-w:]
                    pad = [last[0]] * (w - len(last)) if last else [self.h[i]] * w
                    self.med_buf[i] = deque(pad + last, maxlen=w)

    # ------------------------------------------------------------------ un muestreo
    def step(self, feed_flow_cmd: float) -> dict:
        """Avanza un período de muestreo Ts. `feed_flow_cmd` incluye perturbaciones."""
        p = self.p
        Ts = C.TS
        n = C.N_CELLS
        ctrl = p["controller"]
        jg = C.superficial_gas_velocity(p["air_flow"])
        noise_std = p["noise_std"] * (jg / 0.87) if p["noise_on"] else 0.0

        # 1) Lectura de sensores (ddereq) + filtro de mediana (medfilt1)
        for i in range(n):
            h_noisy = self.h[i] + (self.rng.gauss(0.0, noise_std) if noise_std > 0 else 0.0)
            self.level_bits[i] = level_to_bits(h_noisy, C.LEVEL_CAL[i])
            self.y_meas[i] = bits_to_level(self.level_bits[i], C.LEVEL_CAL[i])
            self.med_buf[i].append(self.y_meas[i])
            self.y_filt[i] = median(self.med_buf[i])

        # 2) Bomba de alimentación (P-4)
        self.feed_bits = flow_to_bits(max(feed_flow_cmd, 0.0), C.PUMP_SLOPE["feed"], C.INT16_MAX)
        self.q_feed = bits_to_flow(self.feed_bits, C.PUMP_SLOPE["feed"])

        # 3) Caudales de relaves entregados ahora (comandos emitidos hace θ_i s)
        for i in range(n):
            if self.delay[i]:
                self.q_out[i] = self.delay[i][0]
            else:
                self.q_out[i] = self.u_cmd[i]

        # 4) Perturbaciones medidas: caudal de entrada de cada celda (Fig. 15)
        self.d = [self.q_feed] + self.q_out[:-1]

        # 5) Controladores PI (+FF) -> ddepoke (bits) con saturación
        for i in range(n):
            s = C.PUMP_SLOPE[self.TAIL_KEYS[i]]
            u_max = bits_to_flow(min(p["pump_bits_max"], C.INT16_MAX), s)
            e = p["setpoints"][i] - self.y_filt[i]
            u = self.ctrl[i].compute(
                e=e, d=self.d[i],
                Kc=float(ctrl["Kc"][i]), tauI=float(ctrl["tauI"][i]),
                Kff=float(ctrl["Kff"][i]), ff_on=self.ff_on,
                form=ctrl.get("form", "velocity"),
                u_min=0.0, u_max=u_max, Ts=Ts,
            )
            self.bits_cmd[i] = flow_to_bits(u, s, p["pump_bits_max"])
            self.u_cmd[i] = bits_to_flow(self.bits_cmd[i], s)
            if self.delay[i]:
                self.delay[i].append(self.u_cmd[i])
                self.delay[i].popleft()
            else:
                self.q_out[i] = self.u_cmd[i]
            self.iae[i] += abs(e) * Ts                       # Ec. 9

        # 6) Integración de la planta (ZOH en Ts: exacto para el integrador)
        q_in = self.q_feed
        for i in range(n):
            kp = float(p["plant"]["k_prime"][i])
            qc = float(p["plant"]["conc_flow"][i])
            dh = kp * (self.q_out[i] + qc - q_in) * Ts
            h_new = self.h[i] + dh
            self.overflow[i] = h_new > C.CELL_HEIGHT_CM
            self.h[i] = clip(h_new, 0.0, C.CELL_HEIGHT_CM)
            q_in = self.q_out[i]

        self.t += Ts
        return self.snapshot()

    # ------------------------------------------------------------------ salida
    def snapshot(self) -> dict:
        r = lambda x, k=4: round(x, k)
        return {
            "t": r(self.t, 1),
            "sp": [r(x, 3) for x in self.p["setpoints"]],
            "h": [r(x) for x in self.h],
            "y_meas": [r(x) for x in self.y_meas],
            "y_filt": [r(x) for x in self.y_filt],
            "level_bits": list(self.level_bits),
            "u": [r(x, 3) for x in self.q_out],        # relaves entregados
            "u_cmd": [r(x, 3) for x in self.u_cmd],    # comando actual
            "bits": list(self.bits_cmd),
            "rpm": [r(bits_to_rpm(b), 1) for b in self.bits_cmd],
            "d": [r(x, 3) for x in self.d],
            "feed": r(self.q_feed, 3),
            "feed_bits": self.feed_bits,
            "iae": [r(x, 2) for x in self.iae],
            "overflow": list(self.overflow),
        }


# ======================================================================================
# Generador de perturbaciones en la alimentación (común a ambas plantas)
# ======================================================================================
class FeedDisturbance:
    def __init__(self, seed: int = 777):
        self.rng = random.Random(seed)
        self.value = 0.0
        self.counter = 0

    def next(self, cfg: dict) -> float:
        if not cfg.get("on"):
            self.value = 0.0
            self.counter = 0
            return 0.0
        period = max(1, int(cfg.get("period", 20)))
        amp = float(cfg.get("amplitude", 10.0))
        if self.counter % period == 0:
            self.value = self.rng.uniform(-amp, amp)
        self.counter += 1
        return self.value


# ======================================================================================
# Sesión: dos plantas gemelas (Solo FB vs FB+FF) con las mismas entradas exógenas
# ======================================================================================
class TwinSimulation:
    def __init__(self, params: dict, scenario: str = "free", seed: int = 12345):
        self.params = copy.deepcopy(params)
        self.scenario = scenario
        self.seed = seed
        self.reset(params, scenario)

    def reset(self, params: dict | None = None, scenario: str | None = None):
        if params is not None:
            self.params = copy.deepcopy(params)
        if scenario is not None:
            self.scenario = scenario
        if self.scenario == "article":
            self.params["setpoints"] = list(C.SP_INITIAL)
            self.params["feed_flow"] = C.FEED_FLOW_DEFAULT
        self.fb = FlotationBank(self.params, ff_on=False, seed=self.seed)
        self.ff = FlotationBank(self.params, ff_on=True, seed=self.seed)
        self.dist = FeedDisturbance(seed=self.seed + 1)
        self.t = 0.0

    def update_params(self, new: dict):
        for k, v in new.items():
            if isinstance(v, dict) and isinstance(self.params.get(k), dict):
                self.params[k].update(copy.deepcopy(v))
            else:
                self.params[k] = copy.deepcopy(v)
        self.fb.update_params(new)
        self.ff.update_params(new)

    def _scenario_events(self):
        """Escenario del artículo: escalón de setpoint en t ≈ 180 s (Fig. 14)."""
        if self.scenario == "article" and abs(self.t - C.SETPOINT_STEP_TIME_S) < 1e-6:
            sp = list(C.SP_AFTER_STEP)
            self.params["setpoints"] = sp
            self.fb.update_params({"setpoints": sp})
            self.ff.update_params({"setpoints": sp})
            return True
        return False

    def step(self, n_steps: int = 1) -> dict:
        out = {"fb": [], "ff": [], "events": []}
        for _ in range(max(1, int(n_steps))):
            if self._scenario_events():
                out["events"].append({"t": self.t, "type": "sp_step",
                                      "setpoints": list(self.params["setpoints"])})
            feed_cmd = self.params["feed_flow"] + self.dist.next(self.params.get("random_dist", {}))
            out["fb"].append(self.fb.step(feed_cmd))
            out["ff"].append(self.ff.step(feed_cmd))
            self.t += C.TS
        out["t"] = self.t
        out["setpoints"] = list(self.params["setpoints"])
        return out


def run_batch(params: dict, duration: int = C.EXPERIMENT_DURATION_S,
              scenario: str = "article", seed: int = 12345) -> dict:
    """Corre un experimento completo (por defecto el de la Fig. 14) y devuelve las series."""
    sim = TwinSimulation(params, scenario=scenario, seed=seed)
    res = sim.step(int(duration / C.TS))
    return res
