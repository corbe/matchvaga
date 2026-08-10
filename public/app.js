"use strict";

let resultToken = null;
let turnstileWidget = null;
let cvText = ""; // texto extraído do arquivo (o arquivo em si nunca é enviado)
let analyzing = false;
const firedEvents = new Set();

const $ = id => document.getElementById(id);

// ── Analytics (só contadores agregados — nunca conteúdo) ─────────
async function track(stage) {
  if (firedEvents.has(stage)) return;
  firedEvents.add(stage);
  try {
    await fetch("/api/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stage })
    });
  } catch {
    // analytics nunca deve quebrar o fluxo
  }
}

function trackOnView(id, stage) {
  const el = $(id);
  if (!el) return;
  const obs = new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting)) {
      track(stage);
      obs.disconnect();
    }
  }, { threshold: 0.3 });
  obs.observe(el);
}

// ── Helpers de UI ────────────────────────────────────────────────
function showStatus(msg, kind) {
  const el = $("status");
  el.textContent = msg;
  el.className = "status" + (kind ? " " + kind : "");
}

// Barra de status ao vivo (topo, centralizado)
function showLive(msg) {
  $("liveText").textContent = msg;
  $("liveBar").classList.remove("hidden");
}
function hideLive() {
  $("liveBar").classList.add("hidden");
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

function clearEl(id) {
  const el = $(id);
  if (el) el.innerHTML = "";
}

// Análise-lixo = currículo não foi lido (nada de forças/atenção/reescritas).
function isGarbagePremium(p) {
  return !p ||
    (!(p.strengths && p.strengths.length) &&
     !(p.attention && p.attention.length) &&
     !(p.rewrites && p.rewrites.length));
}

// Relatório incompleto = IA fechou o JSON no limite (faltam campos longos).
function isIncompletePremium(p) {
  return !p || !p.optimized_cv || !p.recruiter_message ||
    !(p.interview_questions && p.interview_questions.length);
}

function refuseGarbage() {
  sessionStorage.removeItem("mv-token");
  sessionStorage.removeItem("mv-pending");
  $("status").textContent = window.t ? window.t("refuse.garbage") : "Sua análise anterior não pôde ser gerada corretamente (o currículo não foi lido). Refaça a análise gratuitamente — o leitor de PDF foi corrigido.";
  $("status").className = "status error";
  $("premium").classList.add("hidden");
  $("paywall").classList.add("hidden");
  document.getElementById("form").scrollIntoView({ behavior: "smooth" });
}

function refuseIncomplete() {
  sessionStorage.removeItem("mv-token");
  sessionStorage.removeItem("mv-pending");
  $("status").textContent = window.t ? window.t("refuse.incomplete") : "Sua análise anterior ficou incompleta (gerada antes da correção do relatório). Rode a análise novamente para receber o kit completo — isso é gratuito.";
  $("status").className = "status error";
  $("premium").classList.add("hidden");
  $("paywall").classList.add("hidden");
  document.getElementById("form").scrollIntoView({ behavior: "smooth" });
}

// ── Upload de currículo (PDF/DOCX → texto, 100% client-side) ─────
$("cvFile").addEventListener("change", async e => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  track("resume_uploaded");
  $("fileInfo").classList.remove("hidden");
  $("fileName").textContent = file.name;
  $("uploadText").textContent = window.t ? window.t("load.fileLoaded") : "Currículo carregado";
  showStatus(window.t ? window.t("load.fileReading") : "Lendo o arquivo...", "ok");
  try {
    const text = await extractFileText(file);
    if (text.trim().length < 40) {
      cvText = "";
      showStatus(window.t ? window.t("load.fileReadFail") : "Não conseguimos ler o texto deste PDF (pode ser escaneado). Prefere colar o texto manualmente?", "error");
      $("paste-toggle")?.setAttribute("open", "");
    } else {
      cvText = text;
      showStatus(window.t ? window.t("load.fileReadOk") : "Currículo lido ✓ " + text.length + " caracteres extraídos.", "ok");
    }
  } catch (err) {
    cvText = "";
    // Falha de extração → orienta colar o texto (caminho sempre confiável).
    const msg = err && err.message ? err.message : window.t ? window.t("load.fileFail") : "Não foi possível ler o arquivo.";
    showStatus(msg, "error");
    const toggle = document.querySelector(".paste-toggle");
    if (toggle) toggle.setAttribute("open", "");
    const ta = $("cvText");
    if (ta) {
      ta.scrollIntoView({ behavior: "smooth", block: "center" });
      ta.focus();
    }
  }
});

$("removeFile").addEventListener("click", () => {
  cvText = "";
  $("cvFile").value = "";
  $("fileInfo").classList.add("hidden");
  $("uploadText").textContent = window.t ? window.t("form.upload") : "Enviar PDF ou DOCX";
  showStatus("", "");
});

// ── Vaga ─────────────────────────────────────────────────────────
$("job").addEventListener("input", () => {
  if ($("job").value.trim().length > 10) track("job_description_added");
});

// ── Análise ──────────────────────────────────────────────────────
const LOADING_STEPS = [
  window.t ? window.t("load.reading") : "Lendo currículo",
  window.t ? window.t("load.requirements") : "Identificando requisitos da vaga",
  window.t ? window.t("load.comparing") : "Comparando experiências",
  window.t ? window.t("load.finishing") : "Finalizando seu diagnóstico..."
];

function showLoading() {
  $("loading").classList.remove("hidden");
  $("progressBar").classList.add("active");
  showLive(LOADING_STEPS[0]);
}

function hideLoading() {
  $("loading").classList.add("hidden");
  $("progressBar").classList.remove("active");
  hideLive();
}

async function runAnalysis() {
  if (analyzing) return;
  analyzing = true;

  const job = $("job").value.trim();
  const pasted = $("cvText").value.trim();
  const cv = cvText || pasted;

  $("result").classList.add("hidden");
  $("premium").classList.add("hidden");
  $("paywall").classList.add("hidden");
  showStatus("", "");

  if (!cv) {
    showStatus(window.t ? window.t("err.cv") : "Envie seu currículo (PDF ou DOCX) ou cole o texto.", "error");
    analyzing = false;
    return;
  }
  if (!job) {
    showStatus(window.t ? window.t("err.job") : "Cole a descrição da vaga para compararmos.", "error");
    analyzing = false;
    return;
  }

  const btn = $("analyze");
  btn.disabled = true;
  btn.textContent = window.t ? window.t("btn.analyzing") : "Analisando...";
  showLoading();

  // Limite de envio: textos gigantes (extração de PDF pode inflar) são
  // truncados ANTES do fetch — o servidor rejeita corpos grandes com 413.
  const MAX_CV_SEND = 4000;
  const MAX_JOB_SEND = 2500;
  let cvSend = cv;
  let jobSend = job;
  if (cvSend.length > MAX_CV_SEND) {
    cvSend = cvSend.slice(0, MAX_CV_SEND);
    showStatus(window.t ? window.t("load.longCv") : "Currículo longo: analisamos os primeiros " + MAX_CV_SEND + " caracteres.", "ok");
  }
  if (jobSend.length > MAX_JOB_SEND) {
    jobSend = jobSend.slice(0, MAX_JOB_SEND);
    showStatus(window.t ? window.t("load.longJob") : "Vaga longa: analisamos os primeiros " + MAX_JOB_SEND + " caracteres.", "ok");
  }

  // Rotaciona as mensagens de progresso SEM atrasar a API.
  const started = Date.now();
  let stepIdx = 0;
  const stepTimer = setInterval(() => {
    const elapsed = (Date.now() - started) / 1000;
    stepIdx = Math.min(Math.floor(elapsed / 3), LOADING_STEPS.length - 1);
    showLive(LOADING_STEPS[stepIdx]);
  }, 800);

  try {
    const turnstileToken = turnstileWidget ? window.turnstile.getResponse(turnstileWidget) : "";
    const response = await fetch("/api/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cv: cvSend, job: jobSend, turnstile: turnstileToken, lang: window.MV_LANG || "pt" })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) {
      throw new Error(data && data.error ? data.error : window.t ? window.t("err.analysis") : "Falha na análise.");
    }

    resultToken = data.token;
    renderResult(data);
  } catch (err) {
    showFriendlyError(err);
  } finally {
    clearInterval(stepTimer);
    hideLoading();
    btn.disabled = false;
    btn.textContent = window.t ? window.t("form.analyze") : "Analisar compatibilidade →";
    if (turnstileWidget) window.turnstile.reset(turnstileWidget);
    analyzing = false;
  }
}

function renderResult(data) {
  const p = data.preview;

  $("score").textContent = p.score;
  $("scoreExplanation").textContent = p.score_explanation || "";

  // O que seu currículo demonstra bem (máx 3, todos grátis — prova competência)
  clearEl("strengthsList");
  (p.strengths || []).forEach(s => {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${esc(s.requirement)}</strong><div class="item-note">${esc(s.explanation)}</div>`;
    $("strengthsList").appendChild(li);
  });

  // GRÁTIS = descoberta: contagem + UM gap detalhado + títulos bloqueados.
  const first = p.attention_first;
  const locked = p.attention_locked || [];
  const total = p.attention_count || locked.length + (first ? 1 : 0);
  $("attentionHeading").textContent = (total === 1 ? window.t("result.attentionTitle1") : window.t("result.attentionTitle", { n: total }));
  clearEl("attentionFirst");
  if (first) $("attentionFirst").appendChild(attentionCard(first, true));
  clearEl("attentionLocked");
  locked.forEach(t => {
    const li = document.createElement("li");
    li.innerHTML = `🔒 <strong>${esc(t)}</strong>`;
    $("attentionLocked").appendChild(li);
  });

  // Paywall contextual
  $("paywallTitle").textContent = (locked.length === 1 ? window.t("paywall.title1") : window.t("paywall.title", { n: locked.length }));
  clearEl("lockedInsights");
  locked.forEach(t => {
    const li = document.createElement("li");
    li.innerHTML = `🔒 <strong>${esc(t)}</strong>`;
    $("lockedInsights").appendChild(li);
  });

  $("result").classList.remove("hidden");
  $("paywall").classList.remove("hidden");
  // Análise nova substitui qualquer pagamento/estado anterior pendente.
  sessionStorage.removeItem("mv-pending");
  sessionStorage.removeItem("mv-token");
  // analysis_completed é contado no servidor (handlePreview), não aqui.

  trackOnView("attentionFirst", "free_insight_viewed");
  trackOnView("paywall", "locked_insights_viewed");
  trackOnView("result", "result_viewed");

  $("result").scrollIntoView({ behavior: "smooth" });
}

function attentionCard(a, free) {
  const div = document.createElement("div");
  div.className = "attention-card";
  div.innerHTML = `<strong>⚠ ${esc(a.requirement)}</strong>` +
    `<div class="attention-part"><span class="lbl"${window.t ? window.t("att.jobAsks") : ">O que a vaga pede<"}/span> ${esc(a.what_we_found)}</div>` +
    `<div class="attention-part"><span class="lbl"${window.t ? window.t("att.inCv") : ">No seu currículo<"}/span> ${esc(a.in_your_cv)}</div>` +
    (free
      ? (a.interpretation ? `<div class="attention-part interpretation"><span class="lbl"${window.t ? window.t("att.interpretation") : ">Interpretação<"}/span> ${esc(a.interpretation)}</div>` : "")
      : (a.why ? `<div class="attention-part"><span class="lbl"${window.t ? window.t("att.why") : ">Por que merece atenção<"}/span> ${esc(a.why)}</div>` : "") +
        (a.what_to_do ? `<div class="attention-part what-to-do"><span class="lbl"${window.t ? window.t("att.whatToDo") : ">O que fazer<"}/span> ${esc(a.what_to_do)}</div>` : ""));
  return div;
}

function showFriendlyError(err) {
  const msg = err && err.message ? err.message : "";
  // Mensagens específicas passam; o resto vira o erro amigável genérico.
  const friendly = /já foi desbloqueada|Limite diário|Muitas análises|muito grande/i.test(msg) ? msg
    : window.t ? window.t("err.generic") : "Não conseguimos concluir sua análise. Tente novamente.";
  showStatus(friendly, "error");
  const btn = $("analyze");
  btn.textContent = window.t ? window.t("btn.tryAgain") : "Tentar novamente";
  btn.disabled = false;
}

// ── Pagamento ────────────────────────────────────────────────────
function restorePending() {
  try {
    return JSON.parse(sessionStorage.getItem("mv-pending") || "null");
  } catch {
    return null;
  }
}

function handleCheckoutReturn() {
  const params = new URLSearchParams(location.search);
  const pending = restorePending();
  if (params.get("checkout") === "success" && pending) {
    history.replaceState({}, "", location.pathname);
    resultToken = pending.token;
    renderResultFromState(pending);
    $("status").textContent = window.t ? window.t("unlock.paid") : "Pagamento confirmado. Liberando sua análise...";
    pollUnlock();
  } else if (params.get("checkout") === "cancel") {
    history.replaceState({}, "", location.pathname);
    $("status").textContent = window.t ? window.t("unlock.notDone") : "Pagamento não concluído. Nenhuma cobrança foi confirmada. Você pode tentar novamente.";
  }
}

function renderResultFromState(pending) {
  $("score").textContent = pending.score;
  $("scoreExplanation").textContent = pending.score_explanation || "";
  clearEl("strengthsList");
  (pending.strengths || []).forEach(s => {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${esc(s.requirement)}</strong><div class="item-note">${esc(s.explanation)}</div>`;
    $("strengthsList").appendChild(li);
  });
  clearEl("attentionFirst");
  clearEl("attentionLocked");
  const first = pending.attention_first;
  const locked = pending.attention_locked || [];
  const total = pending.attention_count || locked.length + (first ? 1 : 0);
  $("attentionHeading").textContent = (total === 1 ? window.t("result.attentionTitle1") : window.t("result.attentionTitle", { n: total }));
  if (first) $("attentionFirst").appendChild(attentionCard(first, true));
  locked.forEach(t => {
    const li = document.createElement("li");
    li.innerHTML = `🔒 <strong>${esc(t)}</strong>`;
    $("attentionLocked").appendChild(li);
  });
  $("paywallTitle").textContent = pending.paywall_title || window.t("paywall.title", { n: (pending.attention_locked || []).length });
  clearEl("lockedInsights");
  locked.forEach(t => {
    const li = document.createElement("li");
    li.innerHTML = `🔒 <strong>${esc(t)}</strong>`;
    $("lockedInsights").appendChild(li);
  });
  $("result").classList.remove("hidden");
  $("paywall").classList.remove("hidden");
}

let unlockMsgTimer = null;

function startUnlockSpinner() {
  if (unlockMsgTimer) clearInterval(unlockMsgTimer);
  // Barra ao vivo no topo: window.t ? window.t("live.confirming") : "Confirmando pagamento" → "Gerando análise completa..."
  const t0 = Date.now();
  const base = window.t ? window.t("live.confirming") : "Confirmando pagamento";
  let dots = 0;
  showLive(base + "...");
  unlockMsgTimer = setInterval(() => {
    dots = dots >= 3 ? 0 : dots + 1;
    const msg = Date.now() - t0 > 8000 ? window.t ? window.t("live.generating") : "Gerando análise completa" : base;
    showLive(msg + ".".repeat(dots));
  }, 500);
}

function stopUnlockSpinner() {
  if (unlockMsgTimer) {
    clearInterval(unlockMsgTimer);
    unlockMsgTimer = null;
  }
  hideLive();
  $("status").classList.remove("spinning");
}

async function pollUnlock() {
  // Spinner + mensagens rotativas: o usuário vê que está trabalhando.
  startUnlockSpinner();
  // 90s de polling (45 × 2s): o flag paid: no KV pode levar até 60s para
  // propagar até o edge do usuário (eventual consistency do Cloudflare KV).
  for (let i = 0; i < 45; i++) {
    try {
      const response = await fetch("/api/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: resultToken, code: "", lang: window.MV_LANG || "pt" })
      });
      const data = await response.json().catch(() => null);
      if (response.ok && data && data.ok) {
        stopUnlockSpinner();
        if (isGarbagePremium(data.premium)) {
          refuseGarbage();
          return;
        }
        if (isIncompletePremium(data.premium)) {
          refuseIncomplete();
          return;
        }
        sessionStorage.removeItem("mv-pending");
        sessionStorage.setItem("mv-token", resultToken); // refresh-safe
        renderPremium(data.premium);
        $("status").textContent = "";
        $("retryUnlock").classList.add("hidden");
        return;
      }
      if (response.status === 404) {
        stopUnlockSpinner();
        $("status").textContent = window.t ? window.t("unlock.expired") : "Sua análise expirou. Gere uma nova gratuitamente.";
        return;
      }
      if (response.status !== 403) {
        stopUnlockSpinner();
        $("status").textContent = window.t ? window.t("unlock.fail") : "Não foi possível concluir o pagamento. Nenhuma cobrança foi confirmada. Tente novamente.";
        $("retryUnlock").classList.remove("hidden");
        return;
      }
    } catch {
      // tenta de novo
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  stopUnlockSpinner();
  // Pagamento pode ter sido confirmado (webhook) mas o flag ainda não
  // propagou no KV — dá o controle ao usuário em vez de desistir.
  $("status").textContent = window.t ? window.t("unlock.notConfirmed") : "Ainda não conseguimos confirmar seu pagamento. Se você já pagou, clique abaixo para liberar sua análise.";
  $("retryUnlock").classList.remove("hidden");
}

$("retryUnlock").addEventListener("click", () => {
  $("retryUnlock").classList.add("hidden");
  $("status").textContent = window.t ? window.t("unlock.unlocking") : "Liberando sua análise...";
  pollUnlock();
});

$("pay").addEventListener("click", async () => {
  const button = $("pay");
  if (button.disabled) return; // duplo clique
  button.disabled = true;
  $("payError").textContent = "";
  track("unlock_clicked");

  try {
    if (!resultToken) throw new Error(window.t ? window.t("err.analyzeFirst") : "Faça uma análise primeiro.");

    const response = await fetch("/api/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: resultToken, lang: window.MV_LANG || "pt" })
    });
    const data = await response.json().catch(() => null);

    if (response.status === 409) {
      // já desbloqueada — tenta liberar direto
      resultToken && unlockDirect(resultToken);
      return;
    }
    if (!response.ok || !data || !data.url) {
      throw new Error((data && data.error) || window.t ? window.t("unlock.fail") : "Não foi possível concluir o pagamento. Nenhuma cobrança foi confirmada. Tente novamente.");
    }

    // Guarda o estado para restaurar ao voltar do Stripe.
    sessionStorage.setItem("mv-pending", JSON.stringify({
      token: resultToken,
      score: $("score").textContent,
      score_explanation: $("scoreExplanation").textContent,
      strengths: Array.from(document.querySelectorAll("#strengthsList li")).map(li => ({
        requirement: li.querySelector("strong").textContent,
        explanation: li.querySelector(".item-note") ? li.querySelector(".item-note").textContent : ""
      })),
      attention_first: (() => {
        const card = document.querySelector("#attentionFirst .attention-card");
        if (!card) return null;
        return {
          requirement: card.querySelector("strong").textContent.replace(/^⚠\s*/, ""),
          what_we_found: card.querySelector(".attention-part .lbl") ? card.querySelector(".attention-part .lbl").nextSibling.textContent.trim() : "",
          in_your_cv: "",
          interpretation: card.querySelector(".interpretation") ? card.querySelector(".interpretation").textContent : ""
        };
      })(),
      attention_locked: Array.from(document.querySelectorAll("#attentionLocked li strong, #lockedInsights li strong")).map(s => s.textContent),
      attention_count: Number(($("attentionHeading").textContent.match(/\d+/) || [0])[0]),
      paywall_title: $("paywallTitle").textContent
    }));

    location.href = data.url;
  } catch (err) {
    $("payError").textContent = err && err.message ? err.message : window.t ? window.t("unlock.fail") : "Não foi possível concluir o pagamento. Nenhuma cobrança foi confirmada. Tente novamente.";
    button.disabled = false;
  }
});

async function unlockDirect(token) {
  try {
    const res = await fetch("/api/unlock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, code: "", lang: window.MV_LANG || "pt" })
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data && data.ok) {
      if (isGarbagePremium(data.premium)) {
        refuseGarbage();
        return;
      }
      if (isIncompletePremium(data.premium)) {
        refuseIncomplete();
        return;
      }
      sessionStorage.removeItem("mv-pending");
      sessionStorage.setItem("mv-token", token);
      renderPremium(data.premium);
    } else {
      $("payError").textContent = (data && data.error) || window.t ? window.t("unlock.fail") : "Não foi possível concluir o pagamento. Nenhuma cobrança foi confirmada. Tente novamente.";
    }
  } finally {
    $("pay").disabled = false;
  }
}

// ── Relatório completo ───────────────────────────────────────────
let lastPremium = null;
function renderPremium(p) {
  lastPremium = p;
  $("pScore").textContent = p.score;
  $("pScoreExplanation").textContent = p.score_explanation || "";

  const tbody = document.querySelector("#reqTable tbody");
  tbody.innerHTML = "";
  (p.table || []).forEach(row => {
    const tr = document.createElement("tr");
    const sitClass = row.situation.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    tr.innerHTML = `<td>${esc(row.requirement)}</td><td class="sit sit-${sitClass}">${esc(row.situation)}</td><td>${esc(row.evidence)}</td>`;
    tbody.appendChild(tr);
  });

  clearEl("pAttention");
  (p.attention || []).forEach(a => {
    $("pAttention").appendChild(attentionCard(a, false));
  });

  clearEl("pRewrites");
  (p.rewrites || []).forEach(r => {
    const div = document.createElement("div");
    div.className = "rewrite";
    div.innerHTML = `<div class="rewrite-orig"><span class="lbl"${window.t ? window.t("att.original") : ">Original<"}/span>${esc(r.original)}</div>` +
      `<div class="rewrite-sug"><span class="lbl"${window.t ? window.t("att.safeSuggestion") : ">Sugestão segura<"}/span>${esc(r.suggestion)}</div>` +
      (r.why ? `<div class="rewrite-why"><span class="lbl"${window.t ? window.t("att.whyShort") : ">Por quê<"}/span>${esc(r.why)}</div>` : "");
    $("pRewrites").appendChild(div);
  });

  clearEl("pRecommendations");
  (p.recommendations || []).forEach(r => {
    const li = document.createElement("li");
    li.innerHTML = `💡 ${esc(r)}`;
    $("pRecommendations").appendChild(li);
  });

  $("pOptimized").textContent = p.optimized_cv || "";
  $("pMessage").textContent = p.recruiter_message || "";

  const kw = $("pKeywords");
  kw.innerHTML = "";
  (p.keywords || []).forEach(k => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = k;
    kw.appendChild(chip);
  });

  // Esconde seções vazias (relatório incompleto nunca mostra buraco feio).
  ["pOptimized", "pMessage", "pQuestions", "pRewrites", "pAttention", "pRecommendations", "pKeywords", "reqTable"].forEach(id => {
    const el = $(id);
    const card = el ? el.closest(".card") : null;
    if (!card) return;
    const empty = id === "reqTable" ? !(p.table && p.table.length)
      : id === "pRewrites" ? !(p.rewrites && p.rewrites.length)
      : id === "pAttention" ? !(p.attention && p.attention.length)
      : id === "pQuestions" ? !(p.interview_questions && p.interview_questions.length)
      : id === "pRecommendations" ? !(p.recommendations && p.recommendations.length)
      : id === "pKeywords" ? !(p.keywords && p.keywords.length)
      : !el.textContent.trim();
    card.style.display = empty ? "none" : "";
  });

  clearEl("pQuestions");
  (p.interview_questions || []).forEach(q => {
    const li = document.createElement("li");
    li.textContent = q;
    $("pQuestions").appendChild(li);
  });

  $("paywall").classList.add("hidden");
  $("premium").classList.remove("hidden");
  track("full_report_viewed");
  $("premium").scrollIntoView({ behavior: "smooth" });
}

// ── Turnstile ────────────────────────────────────────────────────
function clearTurnstileStub() {
  if (!("turnstile" in window)) return;
  if (window.turnstile && typeof window.turnstile.render === "function") return;
  let p = window;
  while (p) {
    try {
      if ("turnstile" in p) delete p.turnstile;
    } catch {
      // propriedade não-configurável — segue em frente
    }
    p = Object.getPrototypeOf(p);
  }
}

const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

// Carrega a API do Turnstile via tag <script>, UMA única vez.
// NUNCA re-executar via eval e NUNCA re-injetar: o api.js detecta
// window.turnstile existente ("already has been loaded") e desiste. Em
// máquinas cujo software de segurança injeta um shim indeletável, o captcha
// não inicializa — degradação graciosa (captcha é opcional, rate limit protege).
async function loadTurnstileScript() {
  if (window.turnstile && typeof window.turnstile.render === "function") return;

  clearTurnstileStub();
  document.querySelectorAll('script[src*="challenges.cloudflare.com/turnstile"]').forEach(s => s.remove());

  await new Promise(resolve => {
    const s = document.createElement("script");
    s.src = TURNSTILE_SRC;
    s.async = true;
    s.onload = resolve;
    s.onerror = resolve; // falhou → degradação graciosa (captcha é opcional)
    document.head.appendChild(s);
  });

  if (!(window.turnstile && typeof window.turnstile.render === "function")) {
    console.warn("[turnstile] API não inicializou (shim de segurança no navegador?)");
    throw new Error("API do Turnstile indisponível no navegador");
  }
}

async function initTurnstile() {
  try {
    const res = await fetch("/api/config");
    const config = await res.json();
    if (!config.turnstile_sitekey) return;

    await loadTurnstileScript();

    if (typeof window.turnstile?.render !== "function") {
      throw new Error("API do Turnstile indisponível no navegador");
    }

    turnstileWidget = window.turnstile.render($("turnstileWidget"), {
      sitekey: config.turnstile_sitekey,
      theme: "light"
    });
  } catch (err) {
    // Esperado quando um software de segurança injeta um shim de turnstile —
    // ruído de console, não um erro real: a análise segue sem captcha.
    console.warn("[turnstile]", err?.message || err);
    // Degradação graciosa: sem captcha o usuário NÃO fica bloqueado.
    const msg = document.createElement("p");
    msg.className = "hint small";
    msg.textContent = window.t ? window.t("captcha.fallback") : "Verificação de segurança indisponível neste navegador. Sem problema: a análise continua disponível, com limite de uso por IP.";
    $("turnstileWidget").appendChild(msg);

    // Diagnóstico oculto: ?tsdiag=1 mostra o estado real do shim na página.
    if (new URLSearchParams(location.search).get("tsdiag") === "1") {
      let diag = "turnstile in window: " + ("turnstile" in window) + "\n";
      const desc = Object.getOwnPropertyDescriptor(window, "turnstile");
      diag += "own property: " + !!desc + (desc ? " | configurable: " + desc.configurable + " | writable: " + desc.writable : "") + "\n";
      // Varre a cadeia de protótipos: onde está o turnstile e dá para apagar?
      let p = window, depth = 0;
      while (p && depth < 6) {
        if (Object.prototype.hasOwnProperty.call(p, "turnstile")) {
          const d2 = Object.getOwnPropertyDescriptor(p, "turnstile");
          let del = "n/a";
          if (d2 && d2.configurable) {
            try { del = String(delete p.turnstile); } catch (e) { del = "throw:" + e.message; }
          } else if (d2) {
            del = "não-configurável";
          }
          diag += "depth " + depth + " (" + ((p.constructor && p.constructor.name) || Object.prototype.toString.call(p)) + "): configurable=" + (d2 ? d2.configurable : "?") + " delete=" + del + "\n";
        }
        p = Object.getPrototypeOf(p);
        depth++;
      }
      const pre = document.createElement("pre");
      pre.style.cssText = "margin-top:10px;font-size:11px;text-align:left;background:#f2f4f7;padding:8px;border-radius:8px;white-space:pre-wrap";
      pre.textContent = diag;
      $("turnstileWidget").appendChild(pre);
    }
  }
}

// ── Init ─────────────────────────────────────────────────────────
$("analyze").addEventListener("click", runAnalysis);
$("cvText").addEventListener("input", () => {
  if ($("cvText").value.trim().length > 40) track("resume_uploaded");
});
$("scoreTip").addEventListener("click", () => {
  const tip = $("scoreTip");
  const note = document.createElement("p");
  note.className = "tip-text";
  note.textContent = window.t ? window.t("result.scoreTip") : "O score compara informações encontradas no currículo com os requisitos identificados na vaga. Ele não prevê contratação.";
  if (tip.dataset.open) {
    tip.nextElementSibling && tip.nextElementSibling.classList.contains("tip-text") && tip.nextElementSibling.remove();
    delete tip.dataset.open;
  } else {
    tip.insertAdjacentElement("afterend", note);
    tip.dataset.open = "1";
  }
});

initTurnstile();
handleCheckoutReturn();

// ── Idioma (i18n) ──
if (window.initLangSelector) {
  initLangSelector("langSel");
  applyI18n();
  window.onLangChanged = function () {
    applyI18n();
    // re-renderiza conteúdo dinâmico visível no idioma novo
    const pendingRaw = sessionStorage.getItem("mv-pending");
    if (pendingRaw) {
      try { renderResultFromState(JSON.parse(pendingRaw)); } catch {}
    }
    if (lastPremium && !$("premium").classList.contains("hidden")) {
      renderPremium(lastPremium);
    }
  };
}

// Auto-recuperação: quem pagou mas o desbloqueio não propagou a tempo volta
// para a página e o relatório é liberado sozinho (mv-pending guarda o token).
const pendingState = restorePending();
if (pendingState && !new URLSearchParams(location.search).get("checkout")) {
  resultToken = pendingState.token;
  renderResultFromState(pendingState);
  pollUnlock();
}

// Refresh-safe: quem já pagou recupera o relatório ao voltar.
const savedToken = sessionStorage.getItem("mv-token");
if (savedToken) {
  resultToken = savedToken;
  (async () => {
    try {
      const res = await fetch("/api/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: savedToken, code: "", lang: window.MV_LANG || "pt" })
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data && data.ok) {
        if (isGarbagePremium(data.premium)) {
          refuseGarbage();
          return;
        }
        if (isIncompletePremium(data.premium)) {
          refuseIncomplete();
          return;
        }
        renderPremium(data.premium);
      } else if (res.status === 404) {
        sessionStorage.removeItem("mv-token");
      }
    } catch {
      // silencioso
    }
  })();
}
