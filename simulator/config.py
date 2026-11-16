"""
Parámetros tomados del artículo:

  Quintanilla, P., Navia, D., Moreno, F., Neethling, S.J., Brito-Parada, P.R. (2023).
  "A methodology to implement a closed-loop feedback-feedforward level control in a
  laboratory-scale flotation bank using peristaltic pumps". MethodsX 10, 102081.
  doi:10.1016/j.mex.2023.102081

Todas las constantes llevan la referencia a la tabla / figura / ecuación de origen.

NOTA SOBRE UNIDADES DE CAUDAL
El artículo rotula los caudales de las bombas como "lpm". Se conservan aquí los mismos
valores numéricos (calibraciones de la Fig. 9, k' de la Tabla 2, Kc de la Tabla 2) porque
son coherentes entre sí. Físicamente, la coherencia con el área de celda (900 cm²) y con
la pendiente medida en la Fig. 12 indica que la unidad real es mL/s; el simulador es
dimensionalmente consistente en cualquiera de los dos casos porque toda la dinámica se
expresa con k' [cm s^-1 por unidad de caudal].
"""

# --------------------------------------------------------------------------------------
# Geometría (sección "Experimental rig", Fig. 2)
# --------------------------------------------------------------------------------------
CELL_WIDTH_CM = 30.0            # 300 mm
CELL_AREA_CM2 = 30.0 * 30.0     # 300 x 300 mm
CELL_HEIGHT_CM = 45.0           # 450 mm
N_CELLS = 3

# --------------------------------------------------------------------------------------
# Registro de 16 bits (sección "Calibration of instruments")
# INT válido 0 .. 32 767. Rango calibrado de las bombas: 0 .. 28 000 bits (paso 3).
# --------------------------------------------------------------------------------------
INT16_MIN = 0
INT16_MAX = 32767
PUMP_BITS_MAX_CALIBRATED = 28000
PUMP_RPM_MAX = 600.0            # Tabla 1: Masterflex L/S, 0-600 rpm
PUMP_BITS_FULL_SCALE = 32000    # 4-20 mA -> 0..32000 cuentas (módulo GE IC693ALG392)

# --------------------------------------------------------------------------------------
# Calibraciones (ajustes con intercepto fijo en 0 o recta, Figs. 8, 9 y 11)
# --------------------------------------------------------------------------------------
# Fig. 9 – bombas peristálticas: Q = m * bits
PUMP_SLOPE = {
    "feed": 0.0035,     # bomba de alimentación P-4
    "tail1": 0.0029,    # relaves celda 1 (P-1)
    "tail2": 0.0033,    # relaves celda 2 (P-2)
    "tail3": 0.0033,    # relaves celda 3 (P-3)
}

# Fig. 11 – sensores de nivel: h [cm] = a * bits + b
LEVEL_CAL = [
    {"a": -0.0018, "b": 40.1363},   # celda 1
    {"a": -0.0019, "b": 43.8823},   # celda 2
    {"a": -0.0020, "b": 41.2930},   # celda 3
]

# Fig. 8 – controlador másico de aire: Q_air [lpm] = m * bits
AIR_SLOPE_WRITE = 0.0031    # "Controller" (escritura PLC -> válvula)
AIR_SLOPE_READ = 0.0032     # "Sensor" (lectura)
AIR_FLOW_DEFAULT_LPM = 47.0  # "Method validation": 47 lpm -> jg = 0.87 cm/s

# --------------------------------------------------------------------------------------
# Modelo de proceso (Tabla 2): G_p(s) = k' e^{-θ s} / s
# --------------------------------------------------------------------------------------
K_PRIME = [-0.001018, -0.001018, -0.001018]     # cm s^-1 (unidad de caudal)^-1
THETA_S = [7, 6, 3]                               # s

# --------------------------------------------------------------------------------------
# Sintonía SIMC y valores finales (Tabla 2) + Kff (texto tras Ec. 8)
# --------------------------------------------------------------------------------------
TAU_C = [7, 6, 8]
KC_INITIAL = [-70.2, -81.8, -78.1]
KC_FINAL = [-62.0, -76.0, -85.0]
TAU_I_INITIAL = [56, 48, 52]
TAU_I_FINAL = [56, 30, 44]
KFF = [0.8, 0.8, 1.0]

# --------------------------------------------------------------------------------------
# Condiciones experimentales ("Method validation")
# --------------------------------------------------------------------------------------
TS = 1.0                      # tiempo de muestreo [s]
MEDIAN_WINDOW = 10            # medfilt1, ventana 10 muestras (10 s)
FEED_FLOW_DEFAULT = 45.0      # alimentación constante de la celda 1
EXPERIMENT_DURATION_S = 600   # duración mostrada en la Fig. 14
SETPOINT_STEP_TIME_S = 180    # instante aproximado del cambio de setpoint (Fig. 14)

# Setpoints leídos de la Fig. 14 (antes -> después del escalón)
SP_INITIAL = [30.0, 34.0, 33.0]
SP_AFTER_STEP = [29.0, 33.0, 32.0]

# Ruido del sensor de nivel (desviación estándar, cm) a jg = 0.87 cm/s.
# El artículo indica que la señal es más ruidosa por la turbulencia del aire;
# se escala linealmente con jg.
LEVEL_NOISE_STD_CM = 0.35


def superficial_gas_velocity(q_air_lpm: float) -> float:
    """jg = Q_air / A_cell  [cm/s]   (sección 'Air mass flowrate controllers')."""
    return q_air_lpm * 1000.0 / 60.0 / CELL_AREA_CM2


def default_parameters() -> dict:
    """Parámetros por defecto que el frontend puede editar."""
    return {
        "controller": {
            "Kc": list(KC_FINAL),
            "tauI": list(TAU_I_FINAL),
            "Kff": list(KFF),
            "form": "velocity",          # "velocity" | "positional"
        },
        "plant": {
            "k_prime": list(K_PRIME),
            "theta": list(THETA_S),
            "conc_flow": [0.0, 0.0, 0.0],  # caudal de concentrado (rebalse de espuma)
        },
        "setpoints": list(SP_INITIAL),
        "feed_flow": FEED_FLOW_DEFAULT,
        "air_flow": AIR_FLOW_DEFAULT_LPM,
        "noise_std": LEVEL_NOISE_STD_CM,
        "noise_on": True,
        "median_window": MEDIAN_WINDOW,
        "pump_bits_max": PUMP_BITS_MAX_CALIBRATED,
        "random_dist": {"on": False, "amplitude": 10.0, "period": 20},
    }


def article_info() -> dict:
    """Tabla 2 + calibraciones, para mostrarlas en la interfaz."""
    return {
        "table2": {
            "k_prime": K_PRIME, "theta": THETA_S, "tau_c": TAU_C,
            "Kc_initial": KC_INITIAL, "Kc_final": KC_FINAL,
            "tauI_initial": TAU_I_INITIAL, "tauI_final": TAU_I_FINAL,
            "Kff": KFF,
        },
        "pump_slope": PUMP_SLOPE,
        "level_cal": LEVEL_CAL,
        "air_slope": {"write": AIR_SLOPE_WRITE, "read": AIR_SLOPE_READ},
        "cell": {"area_cm2": CELL_AREA_CM2, "height_cm": CELL_HEIGHT_CM},
        "Ts": TS,
        "median_window": MEDIAN_WINDOW,
        "experiment": {
            "duration": EXPERIMENT_DURATION_S,
            "sp_step_time": SETPOINT_STEP_TIME_S,
            "sp_initial": SP_INITIAL,
            "sp_after": SP_AFTER_STEP,
            "feed": FEED_FLOW_DEFAULT,
        },
    }
