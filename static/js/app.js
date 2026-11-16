/* =====================================================================================
 * Frontend del simulador de control de nivel FB vs FB+FF
 * - Mantiene una sesión en el backend (dos plantas gemelas: Solo FB y FB+FF)
 * - Envía los parámetros en cada tick para que los cambios se apliquen en tiempo real
 * - Dibuja los niveles, caudales, perturbaciones e IAE con Chart.js
 * ===================================================================================*/
(() => {
  "use strict";

  const TICK_MS = 200;
  const N = 3;
  const COLORS = {
    sp: "#ff4d6d", fb: "#ff8a3d", ff: "#2ec4a6",
    distFb: "#38d6f5", distFf: "#9be7ff", grid: "#2a3541", tick: "#8b98a5",
  };

  const S = {
    sid: null,
    params: null,
    info: null,
    running: false,
    pending: false,
    mode: "compare",
    speed: 5,
    acc: 0,
    windowS: 600,
    scenario: "free",
    spOverride: false,
    afterBatch: false,
    pumpAngle: { fb: [0, 0, 0], ff: [0, 0, 0] },
    last: { fb: null, ff: null },
    charts: [],
  };

  const $ = (id) => document.getElementById(id);
  const fmt = (x, d = 1) => (x === null || x === undefined || Number.isNaN(x) ? "–" : Number(x).toFixed(d));

  // ----------------------------------------------------------------------------- API
  async function api(path, body) {
    // Modo autónomo (HTML sin servidor / hosting estático): motor JS local
    if (window.LocalAPI) return window.LocalAPI.handle(path, body);
    const res = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  // ----------------------------------------------------------------------------- UI: construcción
  function buildSetpoints() {
    const wrap = $("spControls");
    wrap.innerHTML = "";
    for (let i = 0; i < N; i++) {
      const row = document.createElement("div");
      row.className = "sp-row";
      row.innerHTML = `<span>Celda ${i + 1}</span>
        <input type="range" id="sp${i}" min="20" max="40" step="0.1">
        <b id="spVal${i}"></b>`;
      wrap.appendChild(row);
      const inp = row.querySelector("input");
      inp.addEventListener("input", () => {
        S.params.setpoints[i] = parseFloat(inp.value);
        $(`spVal${i}`).textContent = `${fmt(inp.value, 1)} cm`;
        if (S.scenario === "article") S.spOverride = true;
      });
    }
  }

  function buildParamTable(tableId, rows) {
    const tb = $(tableId).querySelector("tbody");
    tb.innerHTML = "";
    rows.forEach((r) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td title="${r.title || ""}">${r.label}</td>` +
        [0, 1, 2].map((i) =>
          `<td><input type="number" step="${r.step}" data-group="${r.group}" data-key="${r.key}" data-i="${i}"></td>`
        ).join("");
      tb.appendChild(tr);
    });
    tb.querySelectorAll("input").forEach((inp) => {
      inp.addEventListener("change", () => {
        const g = inp.dataset.group, k = inp.dataset.key, i = +inp.dataset.i;
        const v = parseFloat(inp.value);
        if (Number.isNaN(v)) return;
        S.params[g][k][i] = v;
      });
    });
  }

  function buildTanks() {
    const wrap = $("tanksWrap");
    wrap.innerHTML = "";
    ["fb", "ff"].forEach((kind) => {
      const row = document.createElement("div");
      row.className = `bank-row ${kind}`;
      row.id = `bank-${kind}`;
      const title = kind === "fb" ? "Solo FB<small>PI</small>" : "FB + FF<small>PI + Kff·ΔQ</small>";
      let html = `<div class="bank-label">${title}</div>`;
      for (let i = 0; i < N; i++) {
        html += `
        <div class="tank-box">
          <div class="tank-title">C-${i + 1}</div>
          <div class="tank" id="tank-${kind}-${i}">
            <div class="lip"></div>
            <div class="pulp" id="pulp-${kind}-${i}"></div>
            <div class="froth" id="froth-${kind}-${i}"></div>
            <div class="spline" id="spl-${kind}-${i}"></div>
            <div class="readout"><span id="lvl-${kind}-${i}">–</span><span id="err-${kind}-${i}"></span></div>
          </div>
          <div class="tank-meta">
            <span class="pump" id="pump-${kind}-${i}"></span>P-${i + 1}: <b id="q-${kind}-${i}">–</b><br>
            <span id="bits-${kind}-${i}">–</span>
          </div>
        </div>`;
      }
      html += `<div class="feedbox">→ T-1<br>Q<sub>feed</sub> (P-4): <b id="feed-${kind}">–</b><br><span id="feedbits-${kind}"></span></div>`;
      row.innerHTML = html;
      wrap.appendChild(row);
    });
  }

  function buildIae() {
    const g = $("iaeGrid");
    g.innerHTML = "";
    for (let i = 0; i < N; i++) {
      const d = document.createElement("div");
      d.className = "iae";
      d.innerHTML = `<h3>IAE celda ${i + 1} · ∫|e|dt [cm·s]</h3>
        <div class="vals">
          <div class="v fb" id="iae-fb-${i}">–<small>Solo FB</small></div>
          <div class="v ff" id="iae-ff-${i}">–<small>FB + FF</small></div>
          <div class="gain" id="iae-gain-${i}">–</div>
        </div>`;
      g.appendChild(d);
    }
  }

  function baseChartOptions(yTitle, yMin, yMax) {
    return {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      normalized: true,
      interaction: { mode: "nearest", axis: "x", intersect: false },
      plugins: {
        legend: { labels: { color: COLORS.tick, boxWidth: 14, boxHeight: 2, font: { size: 11 } } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmt(c.parsed.y, 2)}` } },
        decimation: { enabled: true, algorithm: "min-max" },
      },
      scales: {
        x: { type: "linear", title: { display: true, text: "Tiempo [s]", color: COLORS.tick },
             ticks: { color: COLORS.tick, maxTicksLimit: 8, includeBounds: false }, grid: { color: COLORS.grid } },
        y: { title: { display: true, text: yTitle, color: COLORS.tick }, suggestedMin: yMin, suggestedMax: yMax,
             ticks: { color: COLORS.tick }, grid: { color: COLORS.grid } },
      },
      elements: { point: { radius: 0 }, line: { borderWidth: 1.6 } },
    };
  }

  function ds(label, color, extra = {}) {
    return Object.assign({ label, data: [], borderColor: color, backgroundColor: color, fill: false, tension: 0 }, extra);
  }

  function buildCharts() {
    const wrap = $("charts");
    wrap.innerHTML = "";
    S.charts.forEach((c) => { c.level.destroy(); c.flow.destroy(); });
    S.charts = [];
    for (let i = 0; i < N; i++) {
      const row = document.createElement("div");
      row.className = "chart-row";
      row.innerHTML = `
        <div class="chart-card"><h4>Celda ${i + 1} · nivel de pulpa h<sub>p</sub> <span>[cm]</span></h4>
          <div class="chart-box"><canvas id="cl${i}"></canvas></div></div>
        <div class="chart-card"><h4>Celda ${i + 1} · caudal de relaves y perturbación <span>[«lpm»]</span></h4>
          <div class="chart-box"><canvas id="cf${i}"></canvas></div></div>`;
      wrap.appendChild(row);

      const level = new Chart($(`cl${i}`), {
        type: "line",
        data: { datasets: [
          ds("Setpoint", COLORS.sp, { stepped: true, borderWidth: 1.8 }),
          ds("Nivel FB (filtrado)", COLORS.fb),
          ds("Nivel FB+FF (filtrado)", COLORS.ff),
          ds("Medición cruda FB", "rgba(255,138,61,.25)", { borderWidth: 1, hidden: true }),
          ds("Medición cruda FB+FF", "rgba(46,196,166,.25)", { borderWidth: 1, hidden: true }),
        ] },
        options: baseChartOptions("h_p [cm]", 26, 36),
      });
      const flow = new Chart($(`cf${i}`), {
        type: "line",
        data: { datasets: [
          ds("Relaves FB (MV)", COLORS.fb),
          ds("Relaves FB+FF (MV)", COLORS.ff),
          ds(i === 0 ? "Q_feed FB (perturbación)" : `Relaves C-${i} → FB (perturbación)`, COLORS.distFb,
             { borderDash: [5, 3], borderWidth: 1.3 }),
          ds(i === 0 ? "Q_feed FB+FF (perturbación)" : `Relaves C-${i} → FB+FF (perturbación)`, COLORS.distFf,
             { borderDash: [2, 3], borderWidth: 1.3 }),
        ] },
        options: baseChartOptions("Q", 0, 100),
      });
      S.charts.push({ level, flow });
    }
    applyModeVisibility();
  }

  // ----------------------------------------------------------------------------- UI: sincronización
  function syncUiFromParams() {
    const p = S.params;
    for (let i = 0; i < N; i++) {
      $(`sp${i}`).value = p.setpoints[i];
      $(`spVal${i}`).textContent = `${fmt(p.setpoints[i], 1)} cm`;
    }
    $("feed").value = p.feed_flow;
    $("feedVal").textContent = fmt(p.feed_flow, 1);
    $("randOn").checked = !!p.random_dist.on;
    $("randAmp").value = p.random_dist.amplitude;
    $("randPer").value = p.random_dist.period;
    $("ctrlForm").value = p.controller.form;
    $("air").value = p.air_flow;
    updateAirLabel();
    $("noiseOn").checked = !!p.noise_on;
    $("noiseStd").value = p.noise_std;
    $("medWin").value = p.median_window;
    $("bitsMax").value = p.pump_bits_max;
    document.querySelectorAll(".ptable input").forEach((inp) => {
      const g = inp.dataset.group, k = inp.dataset.key, i = +inp.dataset.i;
      inp.value = S.params[g][k][i];
    });
    $("spHint").textContent = S.scenario === "article"
      ? "Escenario del artículo: los setpoints bajan 1 cm en t = 180 s (Fig. 14). Si mueves un slider, tu valor manda."
      : "Mueve los sliders para cambiar el setpoint en caliente.";
  }

  function updateAirLabel() {
    const q = S.params.air_flow;
    const jg = q * 1000 / 60 / 900;
    $("airVal").textContent = `${fmt(q, 0)} lpm · jg = ${fmt(jg, 2)} cm/s`;
  }

  function bindControls() {
    $("modeSeg").querySelectorAll("button").forEach((b) => {
      b.addEventListener("click", () => {
        $("modeSeg").querySelectorAll("button").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        S.mode = b.dataset.mode;
        applyModeVisibility();
      });
    });
    $("btnPlay").addEventListener("click", () => {
      if (S.afterBatch) { S.afterBatch = false; resetSession("article", true); return; }
      setRunning(!S.running);
    });
    $("btnReset").addEventListener("click", () => resetSession("free"));
    $("btnArticle").addEventListener("click", () => resetSession("article", true));
    $("btnBatch").addEventListener("click", runBatch);
    $("speed").addEventListener("input", (e) => {
      S.speed = +e.target.value;
      $("speedVal").textContent = `×${S.speed}`;
    });
    $("windowSel").addEventListener("change", (e) => {
      S.windowS = +e.target.value;
      trimAll();
      S.charts.forEach((c) => { c.level.update("none"); c.flow.update("none"); });
    });

    $("feed").addEventListener("input", (e) => {
      S.params.feed_flow = parseFloat(e.target.value);
      $("feedVal").textContent = fmt(S.params.feed_flow, 1);
    });
    const step = (sgn) => {
      const a = parseFloat($("stepAmp").value) || 0;
      S.params.feed_flow = Math.max(0, Math.min(95, S.params.feed_flow + sgn * a));
      $("feed").value = S.params.feed_flow;
      $("feedVal").textContent = fmt(S.params.feed_flow, 1);
    };
    $("btnStepUp").addEventListener("click", () => step(+1));
    $("btnStepDn").addEventListener("click", () => step(-1));
    $("randOn").addEventListener("change", (e) => { S.params.random_dist.on = e.target.checked; });
    $("randAmp").addEventListener("change", (e) => { S.params.random_dist.amplitude = parseFloat(e.target.value) || 0; });
    $("randPer").addEventListener("change", (e) => { S.params.random_dist.period = Math.max(1, parseInt(e.target.value, 10) || 1); });

    $("ctrlForm").addEventListener("change", (e) => { S.params.controller.form = e.target.value; });
    $("btnTuneFinal").addEventListener("click", () => {
      const t = S.info.table2;
      S.params.controller.Kc = [...t.Kc_final];
      S.params.controller.tauI = [...t.tauI_final];
      S.params.controller.Kff = [...t.Kff];
      syncUiFromParams();
    });
    $("btnTuneSimc").addEventListener("click", () => {
      const t = S.info.table2;
      S.params.controller.Kc = [...t.Kc_initial];
      S.params.controller.tauI = [...t.tauI_initial];
      S.params.controller.Kff = [...t.Kff];
      syncUiFromParams();
    });

    $("air").addEventListener("input", (e) => { S.params.air_flow = parseFloat(e.target.value); updateAirLabel(); });
    $("noiseOn").addEventListener("change", (e) => { S.params.noise_on = e.target.checked; });
    $("noiseStd").addEventListener("change", (e) => { S.params.noise_std = Math.max(0, parseFloat(e.target.value) || 0); });
    $("medWin").addEventListener("change", (e) => { S.params.median_window = Math.max(1, parseInt(e.target.value, 10) || 1); });
    $("bitsMax").addEventListener("change", (e) => { S.params.pump_bits_max = Math.max(1000, Math.min(32767, parseInt(e.target.value, 10) || 28000)); });
  }

  function applyModeVisibility() {
    const showFb = S.mode !== "ff";
    const showFf = S.mode !== "fb";
    S.charts.forEach((c) => {
      c.level.data.datasets[1].hidden = !showFb;
      c.level.data.datasets[2].hidden = !showFf;
      if (!showFb) c.level.data.datasets[3].hidden = true;
      if (!showFf) c.level.data.datasets[4].hidden = true;
      c.flow.data.datasets[0].hidden = !showFb;
      c.flow.data.datasets[2].hidden = !showFb;
      c.flow.data.datasets[1].hidden = !showFf;
      c.flow.data.datasets[3].hidden = !showFf;
      c.level.update("none");
      c.flow.update("none");
    });
    $("bank-fb").classList.toggle("hidden", !showFb);
    $("bank-ff").classList.toggle("hidden", !showFf);
    for (let i = 0; i < N; i++) {
      $(`iae-fb-${i}`).classList.toggle("hidden", !showFb);
      $(`iae-ff-${i}`).classList.toggle("hidden", !showFf);
      $(`iae-gain-${i}`).classList.toggle("hidden", !(showFb && showFf));
    }
  }

  function setRunning(on) {
    S.running = on;
    $("btnPlay").textContent = on ? "⏸ Pausar" : "▶ Iniciar";
    const pill = $("statusPill");
    pill.className = "pill" + (on ? " run" : "");
    pill.textContent = on ? (S.scenario === "article" ? "Simulando · escenario artículo" : "Simulando") : "Detenido";
  }

  // ----------------------------------------------------------------------------- datos
  function clearData() {
    S.charts.forEach((c) => {
      c.level.data.datasets.forEach((d) => (d.data = []));
      c.flow.data.datasets.forEach((d) => (d.data = []));
    });
    S.last = { fb: null, ff: null };
  }

  function appendSamples(fbArr, ffArr) {
    for (let k = 0; k < fbArr.length; k++) {
      const a = fbArr[k], b = ffArr[k];
      for (let i = 0; i < N; i++) {
        const L = S.charts[i].level.data.datasets;
        const F = S.charts[i].flow.data.datasets;
        L[0].data.push({ x: a.t, y: a.sp[i] });
        L[1].data.push({ x: a.t, y: a.y_filt[i] });
        L[2].data.push({ x: b.t, y: b.y_filt[i] });
        L[3].data.push({ x: a.t, y: a.y_meas[i] });
        L[4].data.push({ x: b.t, y: b.y_meas[i] });
        F[0].data.push({ x: a.t, y: a.u[i] });
        F[1].data.push({ x: b.t, y: b.u[i] });
        F[2].data.push({ x: a.t, y: a.d[i] });
        F[3].data.push({ x: b.t, y: b.d[i] });
      }
    }
    if (fbArr.length) {
      S.last.fb = fbArr[fbArr.length - 1];
      S.last.ff = ffArr[ffArr.length - 1];
    }
  }

  function trimAll() {
    if (!S.windowS || !S.last.fb) return;
    const tMin = S.last.fb.t - S.windowS;
    S.charts.forEach((c) => {
      [...c.level.data.datasets, ...c.flow.data.datasets].forEach((d) => {
        let k = 0;
        while (k < d.data.length && d.data[k].x < tMin) k++;
        if (k) d.data.splice(0, k);
      });
      c.level.options.scales.x.min = Math.max(0, tMin);
      c.flow.options.scales.x.min = Math.max(0, tMin);
    });
  }

  function refreshCharts() {
    trimAll();
    if (!S.windowS) S.charts.forEach((c) => { delete c.level.options.scales.x.min; delete c.flow.options.scales.x.min; });
    S.charts.forEach((c) => { c.level.update("none"); c.flow.update("none"); });
  }

  // ----------------------------------------------------------------------------- tanques e IAE
  const TANK_PX = 170, H_MAX = 45;

  function renderTanks(dtSeconds) {
    ["fb", "ff"].forEach((kind) => {
      const s = S.last[kind];
      if (!s) return;
      for (let i = 0; i < N; i++) {
        const h = s.h[i];
        const px = (h / H_MAX) * TANK_PX;
        $(`pulp-${kind}-${i}`).style.height = `${px}px`;
        $(`froth-${kind}-${i}`).style.bottom = `${Math.min(TANK_PX - 12, px)}px`;
        $(`spl-${kind}-${i}`).style.bottom = `${(s.sp[i] / H_MAX) * TANK_PX}px`;
        $(`lvl-${kind}-${i}`).textContent = `${fmt(s.y_filt[i], 2)} cm`;
        const e = s.sp[i] - s.y_filt[i];
        $(`err-${kind}-${i}`).textContent = `e=${e >= 0 ? "+" : ""}${fmt(e, 2)}`;
        $(`q-${kind}-${i}`).textContent = `${fmt(s.u_cmd[i], 1)} (entrega ${fmt(s.u[i], 1)})`;
        $(`bits-${kind}-${i}`).textContent = `${s.bits[i]} bits · ${fmt(s.rpm[i], 0)} rpm`;
        $(`tank-${kind}-${i}`).classList.toggle("alarm", !!s.overflow[i] || h <= 0.01);
        S.pumpAngle[kind][i] = (S.pumpAngle[kind][i] + s.rpm[i] / 60 * 360 * (dtSeconds || 0) * 0.05) % 360;
        $(`pump-${kind}-${i}`).style.setProperty("--rot", `${S.pumpAngle[kind][i]}deg`);
      }
      $(`feed-${kind}`).textContent = fmt(s.feed, 1);
      $(`feedbits-${kind}`).textContent = `${s.feed_bits} bits`;
    });
  }

  function renderIae() {
    const a = S.last.fb, b = S.last.ff;
    if (!a || !b) return;
    for (let i = 0; i < N; i++) {
      $(`iae-fb-${i}`).firstChild.nodeValue = fmt(a.iae[i], 1);
      $(`iae-ff-${i}`).firstChild.nodeValue = fmt(b.iae[i], 1);
      const g = $(`iae-gain-${i}`);
      if (a.iae[i] > 1e-9) {
        const pct = (1 - b.iae[i] / a.iae[i]) * 100;
        g.textContent = `${pct >= 0 ? "−" : "+"}${fmt(Math.abs(pct), 1)} % (Δ ${fmt(a.iae[i] - b.iae[i], 1)})`;
        g.className = "gain " + (pct >= 0 ? "good" : "bad");
      } else {
        g.textContent = "–";
        g.className = "gain";
      }
    }
    $("simTime").textContent = fmt(a.t, 0);
  }

  // ----------------------------------------------------------------------------- sesión
  async function createSession(scenario = "free") {
    const r = await api("/api/session", { params: S.params, scenario });
    S.sid = r.session_id;
    S.scenario = scenario;
    S.params = r.params;
    clearData();
    appendSamples(r.initial.fb, r.initial.ff);
    syncUiFromParams();
    refreshCharts();
    renderTanks(0);
    renderIae();
  }

  async function resetSession(scenario, autostart = false) {
    S.spOverride = false;
    S.afterBatch = false;
    try {
      const r = await api(`/api/session/${S.sid}/reset`, { params: S.params, scenario });
      S.params = r.params;
      S.scenario = scenario;
      clearData();
      appendSamples(r.initial.fb, r.initial.ff);
    } catch (e) {
      if (e.status === 404) await createSession(scenario);
      else throw e;
    }
    S.scenario = scenario;
    syncUiFromParams();
    refreshCharts();
    renderTanks(0);
    renderIae();
    setRunning(autostart || S.running);
  }

  async function tick() {
    if (!S.running || S.pending || !S.sid) return;
    S.acc += S.speed * TICK_MS / 1000;
    const steps = Math.floor(S.acc);
    if (steps < 1) return;
    S.acc -= steps;
    S.pending = true;
    try {
      const body = { steps, params: S.params, override_setpoints: S.spOverride };
      const r = await api(`/api/session/${S.sid}/step`, body);
      appendSamples(r.fb, r.ff);
      if (r.events && r.events.length) {
        S.params.setpoints = [...r.setpoints];
        syncUiFromParams();
      } else if (S.scenario === "article" && !S.spOverride) {
        S.params.setpoints = [...r.setpoints];
      }
      refreshCharts();
      renderTanks(steps);
      renderIae();
    } catch (e) {
      if (e.status === 404) {
        await createSession(S.scenario);
      } else {
        console.error(e);
        setRunning(false);
        $("statusPill").textContent = "Error de conexión";
      }
    } finally {
      S.pending = false;
    }
  }

  async function runBatch() {
    setRunning(false);
    const pill = $("statusPill");
    pill.className = "pill batch";
    pill.textContent = "Calculando…";
    try {
      const r = await api("/api/run", { params: S.params, scenario: "article", duration: 600 });
      clearData();
      appendSamples(r.fb, r.ff);
      const prevWin = S.windowS;
      S.windowS = 0;
      refreshCharts();
      S.windowS = prevWin;
      S.charts.forEach((c) => {
        c.level.options.scales.x.min = 0; c.level.options.scales.x.max = 600;
        c.flow.options.scales.x.min = 0; c.flow.options.scales.x.max = 600;
        c.level.update("none"); c.flow.update("none");
        delete c.level.options.scales.x.max; delete c.flow.options.scales.x.max;
      });
      renderTanks(0);
      renderIae();
      pill.textContent = "Experimento Fig. 14 (600 s) · resultado estático";
      S.afterBatch = true;
      // deja la sesión viva lista para continuar desde cero con los mismos parámetros
      S.scenario = "article";
      syncUiFromParams();
    } catch (e) {
      console.error(e);
      pill.className = "pill";
      pill.textContent = "Error";
    }
  }

  // ----------------------------------------------------------------------------- arranque
  async function init() {
    const d = await api("/api/defaults");
    S.params = d.params;
    S.info = d.article;
    buildSetpoints();
    buildParamTable("ctrlTable", [
      { label: "K<sub>c</sub> [«lpm»/cm]", group: "controller", key: "Kc", step: 1, title: "Ganancia del controlador (Tabla 2)" },
      { label: "τ<sub>I</sub> [s]", group: "controller", key: "tauI", step: 1, title: "Tiempo integral (Tabla 2)" },
      { label: "K<sub>ff</sub> [–]", group: "controller", key: "Kff", step: 0.05, title: "Constante feedforward (0–1)" },
    ]);
    buildParamTable("plantTable", [
      { label: "k′ [cm/s/«lpm»]", group: "plant", key: "k_prime", step: 0.00001, title: "Pendiente integradora (Tabla 2)" },
      { label: "θ [s]", group: "plant", key: "theta", step: 1, title: "Tiempo muerto (Tabla 2)" },
      { label: "Q<sub>conc</sub>", group: "plant", key: "conc_flow", step: 0.5, title: "Rebalse de espuma (concentrado)" },
    ]);
    buildTanks();
    buildIae();
    buildCharts();
    bindControls();
    await createSession("free");
    setInterval(tick, TICK_MS);
  }

  window.addEventListener("DOMContentLoaded", () => {
    init().catch((e) => {
      console.error(e);
      $("statusPill").textContent = "No se pudo conectar con el servidor";
    });
  });
})();
