
const KEY = new URLSearchParams(location.search).get("key") || "";
const STAGES = [
  ["landing_view", "dash.fLanding"],
  ["analysis_started", "dash.fStarted"],
  ["analysis_completed", "dash.fCompleted"],
  ["result_viewed", "dash.fResult"],
  ["locked_insights_viewed", "dash.fInsights"],
  ["unlock_clicked", "dash.fUnlock"],
  ["checkout_started", "dash.fCheckout"],
  ["payment_completed", "dash.fPaid"],
  ["full_report_viewed", "dash.fReport"]
];
const st = key => window.t ? window.t(key) : key;
let DAYS = 7;

const fmt = n => (n || 0).toLocaleString("pt-BR");
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);
const cls = r => r >= 60 ? "hot" : r >= 25 ? "mid" : "cold";

function renderSources(sources) {
  const body = document.getElementById("sourcesBody");
  if (!body) return;
  if (!sources.length) {
    body.innerHTML = `<tr><td colspan="4" style="color:var(--faint);font-size:12px">${st("dash.noSources")}</td></tr>`;
    return;
  }
  body.innerHTML = sources.map(s => {
    const conv = s.landings > 0 ? Math.round((s.paid / s.landings) * 100) + "%" : "—";
    return `<tr><td><b>${s.source}</b></td><td>${s.landings}</td><td>${s.paid}</td><td>${conv}</td></tr>`;
  }).join("");
}

async function load() {
  try {
    const res = await fetch("/api/stats?days=" + DAYS + (KEY ? "&key=" + encodeURIComponent(KEY) : ""), { headers: { "cache-control": "no-cache" } });
    if (res.status === 403) { document.getElementById("updated").textContent = window.t ? window.t("dash.denied") : "Acesso negado"; return; }
    const d = await res.json();
    const w = d.window || {};
    const t = d.total || {};
    const conv = d.conv || {};

    const label = window.t ? (DAYS === 0 ? window.t("dash.periodLabel0") : DAYS === 1 ? window.t("dash.periodLabel1") : window.t("dash.periodLabelN", { n: DAYS })) : ("dias=" + DAYS);
    document.getElementById("updated").textContent = window.t ? window.t("dash.updated", { label: label, time: new Date().toLocaleTimeString(navigator.language || "pt-BR"), day: d.day || "" }) : "Período: " + label + " · " + (d.day || "");

    document.getElementById("kVisitas").textContent = fmt(w.landing_view);
    document.getElementById("kAnalises").textContent = fmt(w.analysis_completed);
    document.getElementById("kUnlock").textContent = fmt(w.unlock_clicked);
    document.getElementById("kCheckout").textContent = fmt(w.checkout_started);
    document.getElementById("kVendas").textContent = fmt(w.payment_completed);
    document.getElementById("kConv").textContent = conv["landing→paid"] || "–";
    const vendas = w.payment_completed || 0;
    document.getElementById("kReceita").innerHTML = "R$ " + fmt(vendas * 9.9).replace(",", ".") + '<small> (9,90×' + fmt(vendas) + ")</small>";

    // Funil: barras proporcionais a landing_view
    renderSources(d.sources || []);
    const funnel = document.getElementById("funnel");
    funnel.innerHTML = "";
    const base = Math.max(1, w.landing_view || 1);
    STAGES.forEach(([key, name]) => {
      const count = w[key] || 0;
      const r = pct(count, base);
      const row = document.createElement("div");
      row.className = "frow";
      row.innerHTML = `<div class="name">${st(name)}</div>` +
        `<div class="track"><i style="width:${Math.max(1, Math.min(100, Math.round((count / base) * 100)))}%"></i></div>` +
        `<div class="count">${fmt(count)}</div>` +
        `<div class="pct">${r === null ? "–" : r + "%"}</div>`;
      funnel.appendChild(row);
    });

    // Tabela: quantidade, conv. anterior, conv. total, drop para a próxima
    const tb = document.getElementById("tbody");
    tb.innerHTML = "";
    STAGES.forEach(([key, name], i) => {
      const count = w[key] || 0;
      const prev = i > 0 ? w[STAGES[i - 1][0]] || 0 : 0;
      const next = i < STAGES.length - 1 ? w[STAGES[i + 1][0]] || 0 : null;
      const convPrev = pct(count, prev);
      const convTotal = pct(count, w.landing_view);
      let dropHtml = "–";
      if (next !== null && count > 0) {
        const drop = Math.round(((count - next) / count) * 100);
        dropHtml = `<span class="${drop > 60 ? "drop-bad" : "drop-ok"}">${drop}%</span>`;
      }
      const tr = document.createElement("tr");
      tr.innerHTML = `<td><b>${st(name)}</b><br><span style="color:var(--faint);font-size:11px">${key}</span></td>` +
        `<td><b>${fmt(count)}</b></td>` +
        `<td class="${convPrev === null ? "" : cls(convPrev)}">${convPrev === null ? "—" : convPrev + "%"}</td>` +
        `<td class="${convTotal === null ? "" : cls(convTotal)}">${convTotal === null ? "—" : convTotal + "%"}</td>` +
        `<td>${dropHtml}</td>`;
      tb.appendChild(tr);
    });
  } catch (e) {
    document.getElementById("updated").textContent = window.t ? window.t("dash.failed", { msg: e.message }) : ("falha: " + e.message);
  }
}

document.getElementById("period").addEventListener("click", ev => {
  const btn = ev.target.closest("button");
  if (!btn) return;
  DAYS = Number(btn.dataset.days);
  document.querySelectorAll("#period button").forEach(b => b.classList.toggle("on", b === btn));
  load();
});

if (window.initLangSelector) {
  initLangSelector("langSel");
  applyI18n();
  window.onLangChanged = function () { applyI18n(); load(); };
}
load();
setInterval(load, 30000);
