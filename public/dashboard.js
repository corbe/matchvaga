
const KEY = new URLSearchParams(location.search).get("key") || "";
const STAGES = [
  ["session_view", "dash.fSessions"],
  ["landing_view", "dash.fLanding"],
  ["resume_uploaded", "dash.fResume"],
  ["job_description_added", "dash.fJob"],
  ["analysis_started", "dash.fStarted"],
  ["analysis_completed", "dash.fCompleted"],
  ["result_viewed", "dash.fResult"],
  ["free_insight_viewed", "dash.fFree"],
  ["locked_insights_viewed", "dash.fInsights"],
  ["unlock_clicked", "dash.fUnlock"],
  ["checkout_started", "dash.fCheckout"],
  ["payment_completed", "dash.fPaid"],
  ["full_report_viewed", "dash.fReport"]
];
const st = key => window.t ? window.t(key) : key;
let DAYS = 7;
// Mercado selecionado: br | us | all (padrão: ambos). Persistido na URL (?market=).
let MARKET = (new URLSearchParams(location.search).get("market") || "all");

const fmt = n => (n || 0).toLocaleString("pt-BR");
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);
const cls = r => r >= 60 ? "hot" : r >= 25 ? "mid" : "cold";
const pctCell = r => r === null ? "—" : r + "%";

// Linhas da comparação BR vs US (experimento): etapas-chave + conversões.
const COMPARE_STAGES = [
  ["session_view", "dash.fSessions"],
  ["resume_uploaded", "dash.fResume"],
  ["analysis_completed", "dash.fCompleted"],
  ["result_viewed", "dash.fResult"],
  ["locked_insights_viewed", "dash.fInsights"],
  ["checkout_started", "dash.fCheckout"],
  ["payment_completed", "dash.fPaid"]
];
const COMPARE_CONV = [
  ["session_view", "resume_uploaded", "dash.cSessUpload"],
  ["resume_uploaded", "analysis_completed", "dash.cUploadDone"],
  ["analysis_completed", "locked_insights_viewed", "dash.cDoneInsights"],
  ["locked_insights_viewed", "checkout_started", "dash.cInsightsCheckout"],
  ["checkout_started", "payment_completed", "dash.cCheckoutPaid"],
  ["session_view", "payment_completed", "dash.cSessPaid"]
];

function renderCompare(d) {
  const body = document.getElementById("compareBody");
  if (!body) return;
  const br = (d.markets && d.markets.br && d.markets.br.window) || {};
  const us = (d.markets && d.markets.us && d.markets.us.window) || {};
  const rows = [];
  COMPARE_STAGES.forEach(([key, name]) => {
    rows.push(`<tr><td><b>${st(name)}</b></td><td>${fmt(br[key])}</td><td>${fmt(us[key])}</td></tr>`);
  });
  COMPARE_CONV.forEach(([a, b, name]) => {
    rows.push(`<tr><td class="cmp-conv">${st(name)}</td><td class="${cls(pct(br[a], br[b]))}">${pctCell(pct(br[a], br[b]))}</td><td class="${cls(pct(us[a], us[b]))}">${pctCell(pct(us[a], us[b]))}</td></tr>`);
  });
  body.innerHTML = rows.join("");
}

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
    const res = await fetch("/api/stats?days=" + DAYS + "&market=" + MARKET + (KEY ? "&key=" + encodeURIComponent(KEY) : ""), { headers: { "cache-control": "no-cache" } });
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

    // Receita por mercado: vendas BR × R$ 9,90 + vendas US × $2,99.
    const brSales = (d.markets && d.markets.br && d.markets.br.window.payment_completed) || 0;
    const usSales = (d.markets && d.markets.us && d.markets.us.window.payment_completed) || 0;
    const brRev = brSales * 9.9;
    const usRev = usSales * 2.99;
    if (MARKET === "us") {
      document.getElementById("kReceita").innerHTML = "$ " + fmt(usRev) + '<small> (2.99×' + fmt(usSales) + ")</small>";
    } else if (MARKET === "br") {
      document.getElementById("kReceita").innerHTML = "R$ " + fmt(brRev).replace(",", ".") + '<small> (9,90×' + fmt(brSales) + ")</small>";
    } else {
      document.getElementById("kReceita").innerHTML = "R$ " + fmt(brRev).replace(",", ".") + " + $ " + fmt(usRev) + '<small> (9,90×' + fmt(brSales) + " + 2.99×" + fmt(usSales) + ")</small>";
    }

    // Funil: barras proporcionais a landing_view
    renderSources(d.sources || []);
    renderCompare(d);
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

// Filtro de mercado (BR | US | Ambos) — o estado fica na URL p/ compartilhar.
document.getElementById("market").addEventListener("click", ev => {
  const btn = ev.target.closest("button");
  if (!btn) return;
  MARKET = btn.dataset.market;
  document.querySelectorAll("#market button").forEach(b => b.classList.toggle("on", b === btn));
  const u = new URL(location.href);
  if (MARKET === "all") u.searchParams.delete("market"); else u.searchParams.set("market", MARKET);
  history.replaceState({}, "", u.pathname + u.search);
  load();
});
document.querySelectorAll("#market button").forEach(b => {
  b.classList.toggle("on", b.dataset.market === MARKET);
});

if (window.initLangSelector) {
  initLangSelector("langSel");
  applyI18n();
  window.onLangChanged = function () { applyI18n(); load(); };
}
load();
setInterval(load, 30000);
