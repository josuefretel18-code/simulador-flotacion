# Simulador web · Control de nivel FB vs FB+FF en un banco de flotación de 3 celdas

Simulación interactiva del artículo:

> Quintanilla, P., Navia, D., Moreno, F., Neethling, S.J., Brito-Parada, P.R. (2023).
> *A methodology to implement a closed-loop feedback-feedforward level control in a
> laboratory-scale flotation bank using peristaltic pumps.* MethodsX 10, 102081.

El backend (Flask) corre **dos bancos gemelos** con las mismas entradas exógenas y la misma semilla de ruido:
uno con **Solo Feedback (PI)** y otro con **Feedback + Feedforward (PI + Kff·ΔQ)**. El frontend los muestra
en paralelo o por separado.

## Contenido (requisitos del docente)

| Requisito | Dónde está |
|---|---|
| **HTML** (interfaz web) | `templates/index.html` + `static/` · versión de un solo archivo: `standalone/simulador_flotacion.html` |
| **Python** (backend y toda la programación del artículo) | `app.py`, `simulator/` (modelo y control), `scripts/` (calibración, SIMC, control FB/FF, derivación) |
| **Ejecución local** | `iniciar_windows.bat` / `iniciar_linux_mac.sh`, o los comandos de la sección 1 |
| **URL pública en la nube** | Sección 2: Render / Railway (con Python) o GitHub Pages (`docs/index.html`) |
| **Archivo .rar** | `flotacion-sim.rar` (mismo contenido que el .zip) |

---

## 1. Ejecutar en local

Lo más rápido en Windows es hacer doble clic en **`iniciar_windows.bat`**: crea el entorno, instala Flask y abre el simulador.
Para ejecutar los scripts del artículo, haz doble clic en **`ejecutar_scripts_windows.bat`**.
Sin instalar nada: abre **`standalone/simulador_flotacion.html`** con doble clic en el navegador.

Requisitos: **Python 3.10 o superior**. No hace falta internet, porque Chart.js va incluido en `static/vendor`.

### Windows (PowerShell / CMD)
```bat
cd flotacion-sim
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

### Linux / macOS
```bash
cd flotacion-sim
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Abre **http://127.0.0.1:5000** en el navegador.

### Scripts de Python del artículo (toda la programación)
```bash
pip install -r requirements-scripts.txt
python scripts/ejecutar_todo.py          # corre todo y deja figuras, CSV y JSON en outputs/
```
| Script | Sección del artículo | Salidas |
|---|---|---|
| `scripts/plc_interface.py` | Comunicación PC↔PLC: `ddeinit`, `ddereq`, `ddepoke`, `ddeterm` (direcciones AI00X/AQ00X). Incluye un PLC simulado y un cliente DDE real para GEHCS (pywin32) | — |
| `scripts/s01_calibracion_instrumentos.py` | Calibración de aire, bombas (Q = V/t, 10 s, triplicados) y niveles (ΔX = 2 cm). Rectas con intervalo de predicción al 95 % | Figs. 8, 9 y 11, `cal_*.csv`, `calibracion.json` |
| `scripts/s02_sintonia_simc.py` | Escalones en lazo abierto, k′ = Δy/(Δt·Δu), θ, reglas SIMC (Ecs. 2, 3, 5 y 6) y comparación con la Tabla 2 | Fig. 12, `sintonia_simc.json` |
| `scripts/s03_control_fb_ff.py` | Lazo `while` del artículo: lectura → `medfilt1` (10) → PI / PI+FF (Ecs. 1, 7 y 8) → `ddepoke` → IAE (Ec. 9) | Fig. 14, `control_fb.csv`, `control_ff.csv`, `iae_*.json` |
| `scripts/s04_derivacion_funcion_transferencia.py` | Derivación simbólica de las Ecs. 10–15 → Ec. 4, límite integrador y SIMC (SymPy) | Consola (incluye LaTeX) |

Opciones de `s03_control_fb_ff.py`: `--random-dist 15`, `--feed-step 10 --feed-step-time 300`,
`--form positional`, `--tuning simc`, `--strategy fb|ff|both` y `--plc gehcs --topic PLC1` (PLC real en Windows).

Pruebas del núcleo de simulación:
```bash
python -m unittest -v
```

Modo producción en local (Linux/macOS):
```bash
gunicorn app:app --workers 1 --threads 8 --bind 0.0.0.0:8000
```

---

## 2. Desplegar con URL pública

### Opción A · URL ya publicada (versión autónoma)
La versión de un solo archivo está publicada en:
**https://claude.ai/artifact/Jnoot8tJ2DtUsRsNwfYQMx**
Es privada hasta que la compartas: ábrela en claude.ai → **Share** → acceso público, y copia el enlace.

### Opción B · GitHub Pages (gratis, solo HTML, sin servidor)
1. Sube el proyecto a GitHub (comandos de abajo).
2. En el repositorio: **Settings → Pages → Source: Deploy from a branch → Branch `main`, carpeta `/docs`**.
3. URL: `https://<usuario>.github.io/<repo>/`. Usa `docs/index.html`, que lleva el motor de simulación
   (`static/js/engine.js`, idéntico al de `simulator/model.py`).
   Si cambias el código, regenera la página con `python build_standalone.py`.

### Opción C · Render / Railway (backend Python + HTML)

> El proyecto usa **1 worker con varios hilos** porque las sesiones de simulación viven en la memoria del
> proceso. No subas el número de workers.

### Render (gratuito)
1. Sube la carpeta a un repositorio de GitHub:
   ```bash
   git init && git add . && git commit -m "Simulador FB vs FB+FF"
   git branch -M main
   git remote add origin https://github.com/<usuario>/<repo>.git
   git push -u origin main
   ```
2. En https://dashboard.render.com → **New → Blueprint**, elige el repositorio. Render lee `render.yaml`
   y crea el servicio.
   También puedes ir a **New → Web Service** y configurarlo a mano:
   - Build command: `pip install -r requirements.txt`
   - Start command: `gunicorn app:app --workers 1 --threads 8 --timeout 120 --bind 0.0.0.0:$PORT`
3. Cuando termine el build, Render te da una URL `https://simulador-flotacion-ff.onrender.com`.
   En el plan gratuito, el servicio se duerme tras unos minutos sin uso y tarda ~30–50 s en despertar.

### Railway
1. https://railway.app → **New Project → Deploy from GitHub repo**.
2. Railway usa `railway.json` (o el `Procfile`) automáticamente.
3. En **Settings → Networking → Generate Domain** obtienes la URL pública.

### Otros (Heroku, Koyeb, Fly…)
Cualquier servicio que lea el `Procfile` funciona sin cambios.

---

## 3. Estructura

```
flotacion-sim/
├── app.py                  # Servidor Flask + API REST + gestión de sesiones
├── build_standalone.py     # Genera la versión HTML de un solo archivo (standalone/ y docs/)
├── scripts/                # Programación del artículo: PLC, calibración, SIMC, control, derivación
├── outputs/                # Figuras, CSV y JSON que generan los scripts
├── standalone/simulador_flotacion.html   # Simulador sin servidor (doble clic)
├── docs/index.html         # Igual que el anterior, para GitHub Pages
├── simulator/
│   ├── __init__.py
│   ├── config.py           # Parámetros del artículo (Tabla 2, Figs. 8, 9, 11, 14)
│   └── model.py            # Planta, instrumentación 16 bits, filtro, PI+FF, IAE
├── templates/index.html    # Interfaz
├── static/
│   ├── css/style.css
│   ├── js/app.js           # Lógica del frontend y gráficas
│   ├── js/engine.js        # Port 1:1 del modelo Python a JS (versión autónoma)
│   └── vendor/chart.umd.min.js
├── tests/test_model.py
├── requirements.txt        # App web (Flask, gunicorn)
├── requirements-scripts.txt  # Scripts (numpy, scipy, matplotlib, sympy)
├── Procfile                # Heroku / Railway / genérico
├── render.yaml             # Render Blueprint
├── railway.json            # Railway
└── .python-version
```

### API
| Método | Ruta | Descripción |
|---|---|---|
| GET  | `/api/defaults` | Parámetros por defecto y datos de la Tabla 2 |
| POST | `/api/session` | Crea una sesión `{params?, scenario: "free"\|"article"}` |
| POST | `/api/session/<id>/step` | Avanza `steps` muestreos aplicando `params` en caliente |
| POST | `/api/session/<id>/reset` | Reinicia la sesión |
| POST | `/api/run` | Corre el experimento completo de una vez (por defecto 600 s, escenario del artículo) |
| GET  | `/api/health` | Health check |

---

## 4. Qué se modela (y de dónde sale cada cosa)

| Elemento | Implementación | Fuente en el artículo |
|---|---|---|
| Planta | `dh_i/dt = k'_i (Q_out,i(t−θ_i) + Q_conc,i − Q_in,i)`; celdas en serie con `Q_in,i = Q_out,i−1` | Tabla 2 (`G_p = k'e^{−θs}/s`), Figs. 4 y 15 |
| k′, θ | −0.001018 en las tres celdas; θ = 7, 6, 3 s | Tabla 2 |
| Geometría | 30 × 30 cm, 45 cm de alto | Fig. 2 |
| Bombas → 16 bits | `Q = m·bits`, con m = 0.0035 (alim.), 0.0029, 0.0033, 0.0033; saturación 0…28 000 bits | Fig. 9, procedimiento de calibración |
| Sensor de nivel → 16 bits | `h = a·bits + b` (−0.0018/40.1363, −0.0019/43.8823, −0.002/41.293) | Fig. 11 |
| Aire | 47 lpm → j<sub>g</sub> = 0.87 cm/s; el ruido del sensor escala con j<sub>g</sub> | Fig. 8, sección de validación |
| Filtro | Mediana móvil de 10 muestras (`medfilt1`) | Sección de validación |
| PI | `u = Kc(e + (1/τI)∫e)`, con Kc = −62, −76, −85 y τI = 56, 30, 44 | Ec. 1 (τd = 0), Tabla 2 |
| Feedforward | `Kff·ΔQ_d`, con `ΔQ_d = Q_d(t) − Q_d(t−1)` y Kff = 0.8, 0.8, 1 | Ecs. 7–8 |
| Perturbación medida | Celda 1: Q<sub>feed</sub>; celdas 2 y 3: relaves de la celda anterior | Texto tras la Fig. 13, Fig. 15 |
| IAE | `∫|e|dt` sobre el nivel filtrado | Ec. 9 |
| Escenario del artículo | Q<sub>feed</sub> = 45; SP 30/34/33 → 29/33/32 cm en t = 180 s; 600 s; T<sub>s</sub> = 1 s | Fig. 14 |

### Implementación del controlador (selector en la interfaz)
- **Incremental (velocidad)**, por defecto:
  `Δu = Kc[(e_k − e_{k−1}) + Ts/τI·e_k] + Kff·ΔQ_d`, con `u_k = sat(u_{k−1} + Δu)`.
  El término ΔQ_d de la Ec. 8 se acumula, así que equivale a un feedforward estático.
  La saturación no produce windup.
- **Posicional (Ec. 7 literal)**: `u = u0 + Kc(e + I/τI) + Kff·ΔQ_d`, con anti-windup por integración
  condicional. Aquí Kff·ΔQ_d solo actúa durante el muestreo en que cambia la perturbación.

### Notas de consistencia del artículo
- **Unidades de caudal.** El artículo rotula los caudales de las bombas como «lpm». Se respetan los mismos
  valores numéricos porque k′, Kc y las calibraciones son coherentes entre sí. Por balance de masa
  (Fig. 12, área de 900 cm²) y por la capacidad de las bombas Masterflex L/S, la unidad física
  coherente es **mL/s**. La simulación no cambia, solo la etiqueta.
- **k′ de las celdas 2 y 3.** Calculados con los puntos de la Fig. 12 dan −0.000895 y −0.000866.
  La Tabla 2 repite −0.001018. Puedes cambiarlos en «Planta e instrumentación».
- **Celda 1 con alimentación constante.** ΔQ_feed = 0, así que FB y FB+FF son idénticos en la celda 1.
  El simulador lo reproduce. Para ver el efecto del feedforward en la celda 1, activa
  «Perturbación aleatoria» o aplica escalones de alimentación.

---

## 5. Uso rápido de la interfaz
1. **📄 Escenario del artículo**: reproduce la Fig. 14 en vivo (setpoints, alimentación de 45 y escalón de SP en t = 180 s).
2. **⚡ Experimento 600 s instantáneo**: calcula los 600 s de una vez con los parámetros actuales.
3. **Comparativo / Solo FB / FB + FF**: muestra ambas estrategias o solo una (gráficas, tanques e IAE).
4. Mientras la simulación corre puedes mover setpoints, Q<sub>feed</sub>, escalones ±, perturbación aleatoria,
   Kc, τI, Kff, k′, θ, aire, ruido, ventana de mediana y bits máximos. Todo se aplica en el siguiente muestreo.
5. En la leyenda de cada gráfica de nivel puedes activar la «Medición cruda» (antes del filtro de mediana).
