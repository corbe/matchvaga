
const KEY = new URLSearchParams(location.search).get("key") || "";
// Funil v2: TODAS as etapas são SESSÕES ÚNICAS (evu:/evut: no servidor).
// O funil começa em session_view (sessão de navegador) — landing_view
// (pageviews) é KPI secundário e NÃO entra na conta de conversão.
const STAGES = [
  ["session_view", "dash.fSessions"],
  ["resume_uploaded", "dash.fResume"],
  ["job_description_added", "dash.fJob"],
  ["analysis_started", "dash.fStarted"],
  ["analysis_completed", "dash.fCompleted"],
  ["result_viewed", "dash.fResult"],
  ["free_insight_viewed", "dash.fFree"],
  ["locked_insights_viewed", "dash.fInsights"],
  ["unlock_clicked", "dash.fUnlock"],
  ["checkout_session_created", "dash.fCheckoutCreated"],
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
  ["checkout_session_created", "dash.fCheckoutCreated"],
  ["payment_completed", "dash.fPaid"]
];
const COMPARE_CONV = [
  ["session_view", "resume_uploaded", "dash.cSessUpload"],
  ["resume_uploaded", "analysis_completed", "dash.cUploadDone"],
  ["analysis_completed", "locked_insights_viewed", "dash.cDoneInsights"],
  ["locked_insights_viewed", "checkout_session_created", "dash.cInsightsCheckout"],
  ["checkout_session_created", "payment_completed", "dash.cCheckoutPaid"],
  ["session_view", "payment_completed", "dash.cSessPaid"]
];

// Moeda por mercado: exibe como veio da Stripe, sem converter artificialmente.
function fmtMoney(amount, currency) {
  const cents = (amount || 0) / 100;
  if (currency === "usd") return "$ " + cents.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return "R$ " + cents.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

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

// Seção técnica de diagnóstico do checkout (Caso A/B/C do playbook):
// A) unlocks sem sessões Stripe = bug na criação; B) sessões sem pagamentos =
// abandono no Stripe; C) sessões com pagamentos = checkout convertendo.
function renderCheckout(c) {
  const el = document.getElementById("checkoutBody");
  if (!el) return;
  const rows = [
    ["dash.ckUnlock", c.unlock_clicked],
    ["dash.ckCreated", c.checkout_session_created],
    ["dash.ckError", c.checkout_error],
    ["dash.ckPaid", c.payment_completed]
  ];
  el.innerHTML = rows.map(([k, v]) =>
    `<tr><td><b>${st(k)}</b></td><td>${fmt(v)}</td></tr>`).join("");

  // Leitura imediata do caso (o texto explica o que os números significam).
  const note = document.getElementById("checkoutNote");
  if (!note) return;
  let caseKey = "dash.ckCaseC";
  if (c.unlock_clicked > 0 && c.checkout_session_created === 0) caseKey = "dash.ckCaseA";
  else if (c.checkout_session_created > 0 && c.payment_completed === 0) caseKey = "dash.ckCaseB";
  note.textContent = st(caseKey);
}

function renderRevenue(rev) {
  const el = document.getElementById("kReceita");
  if (!el) return;
  const parts = [];
  if (rev.br && rev.br.count > 0) parts.push(fmtMoney(rev.br.amount, "brl") + ` <small>(${rev.br.count})</small>`);
  if (rev.us && rev.us.count > 0) parts.push(fmtMoney(rev.us.amount, "usd") + ` <small>(${rev.us.count})</small>`);
  el.innerHTML = parts.length ? parts.join(" + ") : "–";
}

let loading = false;
let reloadQueued = false;
async function load() {
  // Nunca dispara 2 requests simultâneos (proteção contra múltiplas chamadas
  // do polling + troca de período/mercado ao mesmo tempo). Se um load estiver
  // em andamento quando o usuário trocar período/mercado, agenda outro depois.
  if (loading) { reloadQueued = true; return; }
  loading = true;
  try {
    const res = await fetch("/api/stats?days=" + DAYS + "&market=" + MARKET + (KEY ? "&key=" + encodeURIComponent(KEY) : ""));
    if (res.status === 403) { document.getElementById("updated").textContent = window.t ? window.t("dash.denied") : "Acesso negado"; return; }
    const d = await res.json();
    const w = d.window || {};
    const t = d.total || {};
    const raw = (d.raw && d.raw.window) || {};
    const conv = d.conv || {};

    const label = window.t ? (DAYS === 0 ? window.t("dash.periodLabel0") : DAYS === 1 ? window.t("dash.periodLabel1") : window.t("dash.periodLabelN", { n: DAYS })) : ("dias=" + DAYS);
    document.getElementById("updated").textContent = window.t ? window.t("dash.updated", { label: label, time: new Date().toLocaleTimeString(navigator.language || "pt-BR"), day: d.day || "" }) : "Período: " + label + " · " + (d.day || "");

    // Banner "métricas confiáveis a partir de" — instrumentação v2.
    const rs = document.getElementById("reliableSince");
    if (rs) {
      if (d.reliable_since) {
        const dt = new Date(d.reliable_since);
        const labelRs = dt.toLocaleString(navigator.language || "pt-BR");
        rs.textContent = window.t ? window.t("dash.reliableSince", { when: labelRs }) : ("Métricas confiáveis a partir de: " + labelRs);
        rs.style.display = "";
      } else {
        rs.style.display = "none";
      }
    }

    // KPIs: sessões únicas (base do funil), pageviews como KPI secundário,
    // análises/unlock/checkout/vendas únicos, receita REAL (soma de pagamentos).
    document.getElementById("kVisitas").textContent = fmt(raw.landing_view);
    document.getElementById("kSessions").textContent = fmt(w.session_view);
    document.getElementById("kAnalises").textContent = fmt(w.analysis_completed);
    document.getElementById("kUnlock").textContent = fmt(w.unlock_clicked);
    document.getElementById("kCheckout").textContent = fmt(w.checkout_session_created);
    document.getElementById("kVendas").textContent = fmt(w.payment_completed);
    document.getElementById("kConv").textContent = conv["sessão→venda"] || "–";
    renderRevenue(d.revenue || { br: {}, us: {} });

    renderSources(d.sources || []);
    renderCompare(d);
    renderCheckout(d.checkout || {});

    // Funil: barras proporcionais a session_view (sessões únicas).
    const funnel = document.getElementById("funnel");
    funnel.innerHTML = "";
    const base = Math.max(1, w.session_view || 1);
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

    // Tabela v2: quantidade (sessões únicas), conv. da etapa (únicos atual /
    // únicos anterior), conv. total (únicos atual / sessões), drop p/ próxima.
    // NUNCA mostra >100% nem drop negativo: se a próxima etapa tiver MAIS
    // únicos que a atual, os eventos não são comparáveis → "—".
    const tb = document.getElementById("tbody");
    tb.innerHTML = "";
    STAGES.forEach(([key, name], i) => {
      const count = w[key] || 0;
      const prev = i > 0 ? w[STAGES[i - 1][0]] || 0 : 0;
      const next = i < STAGES.length - 1 ? w[STAGES[i + 1][0]] || 0 : null;
      const convPrev = pct(count, prev);
      const convTotal = pct(count, w.session_view);
      let dropHtml = "—";
      if (next !== null && count > 0) {
        if (next <= count) {
          const drop = Math.round(((count - next) / count) * 100);
          dropHtml = `<span class="${drop > 60 ? "drop-bad" : "drop-ok"}">${drop}%</span>`;
        }
        // next > count → "—" (etapas não comparáveis, nunca drop negativo)
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
  } finally {
    loading = false;
    if (reloadQueued) { reloadQueued = false; load(); }
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
// Polling de 5 minutos (não-realtime): o dashboard é administrativo e o
// /api/stats agora lê 1 RPC ao agregado — sem necessidade de 30s.
setInterval(load, 300000);
