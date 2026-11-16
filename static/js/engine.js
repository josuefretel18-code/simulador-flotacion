/* =====================================================================================
 * engine.js · Port 1:1 de simulator/model.py + simulator/config.py a JavaScript.
 * Permite ejecutar el simulador SIN servidor (HTML autónomo / hosting estático en la nube).
 * Expone window.LocalAPI.handle(path, body), que imita las rutas de app.py (Flask).
 * ===================================================================================*/
(() => {
  "use strict";

  // ------------------------------------------------------------------ config (config.py)
  const C = {
    CELL_AREA_CM2: 900, CELL_HEIGHT_CM: 45, N: 3,
    INT16_MIN: 0, INT16_MAX: 32767, PUMP_BITS_MAX_CALIBRATED: 28000,
    PUMP_RPM_MAX: 600, PUMP_BITS_FULL_SCALE: 32000,
    PUMP_SLOPE: { feed: 0.0035, tail1: 0.0029, tail2: 0.0033, tail3: 0.0033 },
    LEVEL_CAL: [{ a: -0.0018, b: 40.1363 }, { a: -0.0019, b: 43.8823 }, { a: -0.002, b: 41.293 }],
    AIR_SLOPE_WRITE: 0.0031, AIR_SLOPE_READ: 0.0032, AIR_FLOW_DEFAULT_LPM: 47,
    K_PRIME: [-0.001018, -0.001018, -0.001018], THETA_S: [7, 6, 3],
    TAU_C: [7, 6, 8], KC_INITIAL: [-70.2, -81.8, -78.1], KC_FINAL: [-62, -76, -85],
    TAU_I_INITIAL: [56, 48, 52], TAU_I_FINAL: [56, 30, 44], KFF: [0.8, 0.8, 1.0],
    TS: 1.0, MEDIAN_WINDOW: 10, FEED_FLOW_DEFAULT: 45, EXPERIMENT_DURATION_S: 600,
    SETPOINT_STEP_TIME_S: 180, SP_INITIAL: [30, 34, 33], SP_AFTER_STEP: [29, 33, 32],
    LEVEL_NOISE_STD_CM: 0.35,
  };
  const TAIL_KEYS = ["tail1", "tail2", "tail3"];
  const jgOf = (q) => q * 1000 / 60 / C.CELL_AREA_CM2;

  function defaultParameters() {
    return {
      controller: { Kc: [...C.KC_FINAL], tauI: [...C.TAU_I_FINAL], Kff: [...C.KFF], form: "velocity" },
      plant: { k_prime: [...C.K_PRIME], theta: [...C.THETA_S], conc_flow: [0, 0, 0] },
      setpoints: [...C.SP_INITIAL], feed_flow: C.FEED_FLOW_DEFAULT, air_flow: C.AIR_FLOW_DEFAULT_LPM,
      noise_std: C.LEVEL_NOISE_STD_CM, noise_on: true, median_window: C.MEDIAN_WINDOW,
      pump_bits_max: C.PUMP_BITS_MAX_CALIBRATED, random_dist: { on: false, amplitude: 10, period: 20 },
    };
  }
  function articleInfo() {
    return {
      table2: { k_prime: C.K_PRIME, theta: C.THETA_S, tau_c: C.TAU_C, Kc_initial: C.KC_INITIAL,
        Kc_final: C.KC_FINAL, tauI_initial: C.TAU_I_INITIAL, tauI_final: C.TAU_I_FINAL, Kff: C.KFF },
      pump_slope: C.PUMP_SLOPE, level_cal: C.LEVEL_CAL,
      air_slope: { write: C.AIR_SLOPE_WRITE, read: C.AIR_SLOPE_READ },
      cell: { area_cm2: C.CELL_AREA_CM2, height_cm: C.CELL_HEIGHT_CM }, Ts: C.TS, median_window: C.MEDIAN_WINDOW,
      experiment: { duration: C.EXPERIMENT_DURATION_S, sp_step_time: C.SETPOINT_STEP_TIME_S,
        sp_initial: C.SP_INITIAL, sp_after: C.SP_AFTER_STEP, feed: C.FEED_FLOW_DEFAULT },
    };
  }

  // ------------------------------------------------------------------ utilidades
  const clip = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  // redondeo "bancario" como round() de Python
  function pyRound(x) {
    const f = Math.floor(x), d = x - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
  }
  const r = (x, k = 4) => Math.round(x * 10 ** k) / 10 ** k;
  function median(arr) {
    const s = [...arr].sort((a, b) => a - b), n = s.length, m = n >> 1;
    return n % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  // PRNG con semilla (mulberry32) + Box-Muller
  function makeRng(seed) {
    let a = seed >>> 0;
    const rand = () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let spare = null;
    return {
      random: rand,
      uniform: (lo, hi) => lo + (hi - lo) * rand(),
      gauss: (mu, sigma) => {
        if (spare !== null) { const v = spare; spare = null; return mu + sigma * v; }
        let u = 0, v = 0;
        while (u === 0) u = rand();
        v = rand();
        const mag = Math.sqrt(-2 * Math.log(u));
        spare = mag * Math.sin(2 * Math.PI * v);
        return mu + sigma * mag * Math.cos(2 * Math.PI * v);
      },
    };
  }

  // ------------------------------------------------------------------ instrumentación
  const flowToBits = (q, slope, bitsMax) => clip(pyRound(q / slope), C.INT16_MIN, Math.min(bitsMax, C.INT16_MAX)) | 0;
  const bitsToFlow = (b, slope) => b * slope;
  const bitsToRpm = (b) => clip(b / C.PUMP_BITS_FULL_SCALE * C.PUMP_RPM_MAX, 0, C.PUMP_RPM_MAX);
  const levelToBits = (h, cal) => clip(pyRound((h - cal.b) / cal.a), C.INT16_MIN, C.INT16_MAX) | 0;
  const bitsToLevel = (b, cal) => cal.a * b + cal.b;

  // ------------------------------------------------------------------ controlador PI + FF
  class PIFFController {
    constructor(u0, d0, e0 = 0) { this.u0 = u0; this.uPrev = u0; this.ePrev = e0; this.integral = 0; this.dPrev = d0; }
    compute(e, d, Kc, tauI, Kff, ffOn, form, uMin, uMax, Ts) {
      const dQ = d - this.dPrev;                      // Ec. 8
      const ff = ffOn ? Kff * dQ : 0;
      tauI = Math.max(tauI, 1e-6);
      let u;
      if (form === "positional") {
        const newInt = this.integral + e * Ts;
        const uUnsat = this.u0 + Kc * (e + newInt / tauI) + ff;   // Ec. 7
        u = clip(uUnsat, uMin, uMax);
        const push = Kc * e;
        const windup = (uUnsat > uMax && push > 0) || (uUnsat < uMin && push < 0);
        if (!windup) this.integral = newInt;
      } else {
        const du = Kc * ((e - this.ePrev) + Ts / tauI * e) + ff;
        u = clip(this.uPrev + du, uMin, uMax);
      }
      this.uPrev = u; this.ePrev = e; this.dPrev = d;
      return u;
    }
  }

  // ------------------------------------------------------------------ banco de 3 celdas
  class FlotationBank {
    constructor(params, ffOn, seed = 12345) {
      this.ffOn = ffOn; this.rng = makeRng(seed); this.t = 0; this.p = clone(params); this._build();
    }
    _build() {
      const p = this.p, n = C.N, sp = p.setpoints, qc = p.plant.conc_flow;
      this.h = [...sp];
      let qIn = p.feed_flow; const uSs = [];
      for (let i = 0; i < n; i++) { const qOut = Math.max(qIn - qc[i], 0); uSs.push(qOut); qIn = qOut; }
      this.feedBits = flowToBits(p.feed_flow, C.PUMP_SLOPE.feed, C.INT16_MAX);
      this.qFeed = bitsToFlow(this.feedBits, C.PUMP_SLOPE.feed);
      this.bitsCmd = []; this.uCmd = []; this.delay = [];
      for (let i = 0; i < n; i++) {
        const s = C.PUMP_SLOPE[TAIL_KEYS[i]];
        const b = flowToBits(uSs[i], s, p.pump_bits_max);
        this.bitsCmd.push(b); this.uCmd.push(bitsToFlow(b, s));
        const th = Math.max(0, Math.round(p.plant.theta[i]));
        this.delay.push(new Array(th).fill(this.uCmd[i]));
      }
      this.qOut = [...this.uCmd];
      const w = Math.max(1, p.median_window | 0);
      this.medBuf = this.h.map((h) => new Array(w).fill(h));
      this.yFilt = [...this.h]; this.yMeas = [...this.h];
      this.levelBits = this.h.map((h, i) => levelToBits(h, C.LEVEL_CAL[i]));
      const d0 = [this.qFeed, ...this.qOut.slice(0, -1)];
      this.d = [...d0];
      this.ctrl = [0, 1, 2].map((i) => new PIFFController(this.uCmd[i], d0[i], 0));
      this.iae = [0, 0, 0]; this.overflow = [false, false, false];
    }
    updateParams(nw) {
      const p = this.p;
      ["setpoints", "feed_flow", "air_flow", "noise_std", "noise_on", "pump_bits_max"].forEach((k) => {
        if (k in nw) p[k] = clone(nw[k]);
      });
      if (nw.controller) Object.assign(p.controller, clone(nw.controller));
      if (nw.plant) {
        const pl = nw.plant;
        if (pl.k_prime) p.plant.k_prime = [...pl.k_prime];
        if (pl.conc_flow) p.plant.conc_flow = [...pl.conc_flow];
        if (pl.theta) {
          pl.theta.forEach((th, i) => {
            th = Math.max(0, Math.round(th));
            if (th !== this.delay[i].length) {
              const last = this.delay[i].length ? this.delay[i][this.delay[i].length - 1] : this.uCmd[i];
              this.delay[i] = new Array(th).fill(last);
            }
          });
          p.plant.theta = pl.theta.map((x) => Math.max(0, Math.round(x)));
        }
      }
      if ("median_window" in nw) {
        const w = Math.max(1, nw.median_window | 0);
        if (w !== p.median_window) {
          p.median_window = w;
          for (let i = 0; i < C.N; i++) {
            const last = this.medBuf[i].slice(-w);
            const pad = new Array(w - last.length).fill(last.length ? last[0] : this.h[i]);
            this.medBuf[i] = [...pad, ...last];
          }
        }
      }
    }
    step(feedFlowCmd) {
      const p = this.p, Ts = C.TS, n = C.N, ctrl = p.controller;
      const jg = jgOf(p.air_flow);
      const noiseStd = p.noise_on ? p.noise_std * (jg / 0.87) : 0;
      // 1) sensores + mediana
      for (let i = 0; i < n; i++) {
        const hN = this.h[i] + (noiseStd > 0 ? this.rng.gauss(0, noiseStd) : 0);
        this.levelBits[i] = levelToBits(hN, C.LEVEL_CAL[i]);
        this.yMeas[i] = bitsToLevel(this.levelBits[i], C.LEVEL_CAL[i]);
        const w = p.median_window;
        this.medBuf[i].push(this.yMeas[i]);
        while (this.medBuf[i].length > w) this.medBuf[i].shift();
        this.yFilt[i] = median(this.medBuf[i]);
      }
      // 2) alimentación
      this.feedBits = flowToBits(Math.max(feedFlowCmd, 0), C.PUMP_SLOPE.feed, C.INT16_MAX);
      this.qFeed = bitsToFlow(this.feedBits, C.PUMP_SLOPE.feed);
      // 3) relaves entregados (tiempo muerto)
      for (let i = 0; i < n; i++) this.qOut[i] = this.delay[i].length ? this.delay[i][0] : this.uCmd[i];
      // 4) perturbaciones medidas
      this.d = [this.qFeed, this.qOut[0], this.qOut[1]];
      // 5) control
      for (let i = 0; i < n; i++) {
        const s = C.PUMP_SLOPE[TAIL_KEYS[i]];
        const uMax = bitsToFlow(Math.min(p.pump_bits_max, C.INT16_MAX), s);
        const e = p.setpoints[i] - this.yFilt[i];
        const u = this.ctrl[i].compute(e, this.d[i], +ctrl.Kc[i], +ctrl.tauI[i], +ctrl.Kff[i],
          this.ffOn, ctrl.form || "velocity", 0, uMax, Ts);
        this.bitsCmd[i] = flowToBits(u, s, p.pump_bits_max);
        this.uCmd[i] = bitsToFlow(this.bitsCmd[i], s);
        if (this.delay[i].length) { this.delay[i].push(this.uCmd[i]); this.delay[i].shift(); }
        else this.qOut[i] = this.uCmd[i];
        this.iae[i] += Math.abs(e) * Ts;
      }
      // 6) planta
      let qIn = this.qFeed;
      for (let i = 0; i < n; i++) {
        const dh = +p.plant.k_prime[i] * (this.qOut[i] + +p.plant.conc_flow[i] - qIn) * Ts;
        const hNew = this.h[i] + dh;
        this.overflow[i] = hNew > C.CELL_HEIGHT_CM;
        this.h[i] = clip(hNew, 0, C.CELL_HEIGHT_CM);
        qIn = this.qOut[i];
      }
      this.t += Ts;
      return this.snapshot();
    }
    snapshot() {
      return {
        t: r(this.t, 1), sp: this.p.setpoints.map((x) => r(x, 3)), h: this.h.map((x) => r(x)),
        y_meas: this.yMeas.map((x) => r(x)), y_filt: this.yFilt.map((x) => r(x)),
        level_bits: [...this.levelBits], u: this.qOut.map((x) => r(x, 3)), u_cmd: this.uCmd.map((x) => r(x, 3)),
        bits: [...this.bitsCmd], rpm: this.bitsCmd.map((b) => r(bitsToRpm(b), 1)), d: this.d.map((x) => r(x, 3)),
        feed: r(this.qFeed, 3), feed_bits: this.feedBits, iae: this.iae.map((x) => r(x, 2)), overflow: [...this.overflow],
      };
    }
  }

  class FeedDisturbance {
    constructor(seed = 777) { this.rng = makeRng(seed); this.value = 0; this.counter = 0; }
    next(cfg) {
      if (!cfg || !cfg.on) { this.value = 0; this.counter = 0; return 0; }
      const period = Math.max(1, cfg.period | 0), amp = +cfg.amplitude;
      if (this.counter % period === 0) this.value = this.rng.uniform(-amp, amp);
      this.counter++;
      return this.value;
    }
  }

  class TwinSimulation {
    constructor(params, scenario = "free", seed = 12345) { this.seed = seed; this.reset(params, scenario); }
    reset(params, scenario) {
      if (params) this.params = clone(params);
      if (scenario) this.scenario = scenario;
      if (this.scenario === "article") { this.params.setpoints = [...C.SP_INITIAL]; this.params.feed_flow = C.FEED_FLOW_DEFAULT; }
      this.fb = new FlotationBank(this.params, false, this.seed);
      this.ff = new FlotationBank(this.params, true, this.seed);
      this.dist = new FeedDisturbance(this.seed + 1);
      this.t = 0;
    }
    updateParams(nw) {
      Object.entries(nw).forEach(([k, v]) => {
        if (v && typeof v === "object" && !Array.isArray(v) && this.params[k] && typeof this.params[k] === "object")
          Object.assign(this.params[k], clone(v));
        else this.params[k] = clone(v);
      });
      this.fb.updateParams(nw); this.ff.updateParams(nw);
    }
    _events() {
      if (this.scenario === "article" && Math.abs(this.t - C.SETPOINT_STEP_TIME_S) < 1e-6) {
        const sp = [...C.SP_AFTER_STEP];
        this.params.setpoints = sp;
        this.fb.updateParams({ setpoints: sp }); this.ff.updateParams({ setpoints: sp });
        return true;
      }
      return false;
    }
    step(nSteps = 1) {
      const out = { fb: [], ff: [], events: [] };
      for (let k = 0; k < Math.max(1, nSteps | 0); k++) {
        if (this._events()) out.events.push({ t: this.t, type: "sp_step", setpoints: [...this.params.setpoints] });
        const feedCmd = this.params.feed_flow + this.dist.next(this.params.random_dist || {});
        out.fb.push(this.fb.step(feedCmd)); out.ff.push(this.ff.step(feedCmd));
        this.t += C.TS;
      }
      out.t = this.t; out.setpoints = [...this.params.setpoints];
      return out;
    }
  }

  // ------------------------------------------------------------------ saneamiento (app.py)
  function three(x, def) {
    try { const v = (x || []).slice(0, 3).map(Number); return v.length === 3 && v.every((y) => !Number.isNaN(y)) ? v : [...def]; }
    catch (e) { return [...def]; }
  }
  function sanitize(p) {
    const c = p.controller;
    c.Kc = three(c.Kc, C.KC_FINAL); c.tauI = three(c.tauI, C.TAU_I_FINAL).map((v) => Math.max(1, v));
    c.Kff = three(c.Kff, C.KFF); c.form = c.form === "positional" ? "positional" : "velocity";
    const pl = p.plant;
    pl.k_prime = three(pl.k_prime, C.K_PRIME);
    pl.theta = three(pl.theta, C.THETA_S).map((v) => Math.max(0, Math.min(60, Math.round(v))));
    pl.conc_flow = three(pl.conc_flow, [0, 0, 0]).map((v) => Math.max(0, v));
    p.setpoints = three(p.setpoints, C.SP_INITIAL).map((v) => Math.min(C.CELL_HEIGHT_CM, Math.max(0, v)));
    p.feed_flow = Math.max(0, +p.feed_flow || 0);
    p.air_flow = Math.max(0, Math.min(100, +p.air_flow));
    p.noise_std = Math.max(0, +p.noise_std || 0); p.noise_on = !!p.noise_on;
    p.median_window = Math.max(1, Math.min(60, p.median_window | 0));
    p.pump_bits_max = Math.max(1000, Math.min(C.INT16_MAX, p.pump_bits_max | 0));
    const rd = p.random_dist || {};
    p.random_dist = { on: !!rd.on, amplitude: Math.max(0, +rd.amplitude || 0), period: Math.max(1, rd.period | 0) };
    return p;
  }
  function mergeParams(user) {
    const p = defaultParameters();
    if (!user) return p;
    Object.entries(user).forEach(([k, v]) => {
      if (v && typeof v === "object" && !Array.isArray(v) && p[k] && typeof p[k] === "object") Object.assign(p[k], clone(v));
      else p[k] = clone(v);
    });
    return sanitize(p);
  }

  // ------------------------------------------------------------------ API local (imita Flask)
  const sessions = {};
  let nextId = 1;
  const snap = (sim) => ({ fb: [sim.fb.snapshot()], ff: [sim.ff.snapshot()], t: 0, setpoints: sim.params.setpoints });
  const notFound = () => { const e = new Error("HTTP 404"); e.status = 404; throw e; };

  async function handle(path, body) {
    body = body || {};
    if (path === "/api/defaults") return { params: defaultParameters(), article: articleInfo() };
    if (path === "/api/health") return { status: "ok", sessions: Object.keys(sessions).length, mode: "standalone" };
    if (path === "/api/session") {
      const params = mergeParams(body.params);
      const sim = new TwinSimulation(params, body.scenario || "free");
      const sid = `local-${nextId++}`;
      sessions[sid] = sim;
      return { session_id: sid, params: sim.params, initial: snap(sim) };
    }
    if (path === "/api/run") {
      const params = mergeParams(body.params);
      const duration = Math.max(10, Math.min(7200, body.duration | 0 || C.EXPERIMENT_DURATION_S));
      const sim = new TwinSimulation(params, body.scenario || "article");
      return sim.step(Math.round(duration / C.TS));
    }
    let m = path.match(/^\/api\/session\/([^/]+)\/(step|reset)$/);
    if (m) {
      const sim = sessions[m[1]];
      if (!sim) notFound();
      if (m[2] === "reset") {
        sim.reset(mergeParams(body.params), body.scenario || "free");
        return { params: sim.params, initial: snap(sim) };
      }
      const n = Math.max(1, Math.min(200, body.steps | 0 || 1));
      if (body.params) {
        const merged = mergeParams(Object.assign(clone(sim.params), body.params));
        if (sim.scenario === "article" && !body.override_setpoints) merged.setpoints = sim.params.setpoints;
        sim.updateParams(merged);
      }
      return sim.step(n);
    }
    notFound();
  }

  const api = { handle, TwinSimulation, FlotationBank, defaultParameters, mergeParams, C };
  if (typeof window !== "undefined") window.LocalAPI = api;
  if (typeof module !== "undefined") module.exports = api;
})();
