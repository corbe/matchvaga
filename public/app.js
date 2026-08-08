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
  $("status").textContent = "Sua análise anterior não pôde ser gerada corretamente (o currículo não foi lido). Refaça a análise gratuitamente — o leitor de PDF foi corrigido.";
  $("status").className = "status error";
  $("premium").classList.add("hidden");
  $("paywall").classList.add("hidden");
  document.getElementById("form").scrollIntoView({ behavior: "smooth" });
}

function refuseIncomplete() {
  sessionStorage.removeItem("mv-token");
  sessionStorage.removeItem("mv-pending");
  $("status").textContent = "Sua análise anterior ficou incompleta (gerada antes da correção do relatório). Rode a análise novamente para receber o kit completo — isso é gratuito.";
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
  $("uploadText").textContent = "Currículo carregado";
  showStatus("Lendo o arquivo...", "ok");
  try {
    const text = await extractFileText(file);
    if (text.trim().length < 40) {
      cvText = "";
      showStatus("Não conseguimos ler o texto deste PDF (pode ser escaneado). Prefere colar o texto manualmente?", "error");
      $("paste-toggle")?.setAttribute("open", "");
    } else {
      cvText = text;
      showStatus("Currículo lido ✓ " + text.length + " caracteres extraídos.", "ok");
    }
  } catch (err) {
    cvText = "";
    // Falha de extração → orienta colar o texto (caminho sempre confiável).
    const msg = err && err.message ? err.message : "Não foi possível ler o arquivo.";
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
  $("uploadText").textContent = "Enviar PDF ou DOCX";
  showStatus("", "");
});

// ── Vaga ─────────────────────────────────────────────────────────
$("job").addEventListener("input", () => {
  if ($("job").value.trim().length > 10) track("job_description_added");
});

// ── Análise ──────────────────────────────────────────────────────
const LOADING_STEPS = [
  "Lendo currículo",
  "Identificando requisitos da vaga",
  "Comparando experiências",
  "Preparando resultado"
];

function showLoading() {
  $("loading").classList.remove("hidden");
  $("loadingMsg").textContent = LOADING_STEPS[0];
  $("progressBar").classList.add("active");
}

function hideLoading() {
  $("loading").classList.add("hidden");
  $("progressBar").classList.remove("active");
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
    showStatus("Envie seu currículo (PDF ou DOCX) ou cole o texto.", "error");
    analyzing = false;
    return;
  }
  if (!job) {
    showStatus("Cole a descrição da vaga para compararmos.", "error");
    analyzing = false;
    return;
  }

  const btn = $("analyze");
  btn.disabled = true;
  btn.textContent = "Analisando...";
  showLoading();

  // Limite de envio: textos gigantes (extração de PDF pode inflar) são
  // truncados ANTES do fetch — o servidor rejeita corpos grandes com 413.
  const MAX_CV_SEND = 4000;
  const MAX_JOB_SEND = 2500;
  let cvSend = cv;
  let jobSend = job;
  if (cvSend.length > MAX_CV_SEND) {
    cvSend = cvSend.slice(0, MAX_CV_SEND);
    showStatus("Currículo longo: analisamos os primeiros " + MAX_CV_SEND + " caracteres.", "ok");
  }
  if (jobSend.length > MAX_JOB_SEND) {
    jobSend = jobSend.slice(0, MAX_JOB_SEND);
    showStatus("Vaga longa: analisamos os primeiros " + MAX_JOB_SEND + " caracteres.", "ok");
  }

  // Rotaciona as mensagens de progresso SEM atrasar a API.
  const started = Date.now();
  let stepIdx = 0;
  const stepTimer = setInterval(() => {
    const elapsed = (Date.now() - started) / 1000;
    stepIdx = Math.min(Math.floor(elapsed / 3), LOADING_STEPS.length - 1);
    $("loadingMsg").textContent = LOADING_STEPS[stepIdx];
  }, 800);

  try {
    const turnstileToken = turnstileWidget ? window.turnstile.getResponse(turnstileWidget) : "";
    const response = await fetch("/api/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cv: cvSend, job: jobSend, turnstile: turnstileToken })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) {
      throw new Error(data && data.error ? data.error : "Falha na análise.");
    }

    resultToken = data.token;
    renderResult(data);
  } catch (err) {
    showFriendlyError(err);
  } finally {
    clearInterval(stepTimer);
    hideLoading();
    btn.disabled = false;
    btn.textContent = "Analisar compatibilidade →";
    if (turnstileWidget) window.turnstile.reset(turnstileWidget);
    analyzing = false;
  }
}

function renderResult(data) {
  const p = data.preview;
  const locked = p.counts.locked || p.locked_insights.length;

  $("score").textContent = p.score;
  $("scoreExplanation").textContent = p.score_explanation || "";

  // O que identificamos nesta vaga
  clearEl("requirements");
  (p.requirements || []).forEach(req => {
    const block = document.createElement("div");
    block.className = "req-cat";
    const title = document.createElement("div");
    title.className = "req-cat-title";
    title.textContent = req.category;
    block.appendChild(title);
    const chips = document.createElement("div");
    chips.className = "chips";
    (req.items || []).forEach(it => {
      const c = document.createElement("span");
      c.className = "chip";
      c.textContent = it;
      chips.appendChild(c);
    });
    block.appendChild(chips);
    $("requirements").appendChild(block);
  });

  // O que seu currículo demonstra bem
  clearEl("strengthsList");
  (p.strengths || []).forEach(s => {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${esc(s.requirement)}</strong><div class="item-note">${esc(s.explanation)}</div>`;
    $("strengthsList").appendChild(li);
  });

  // Um ponto que merece atenção + Segunda descoberta
  const attention = p.attention || [];
  clearEl("attentionFirst");
  if (attention[0]) $("attentionFirst").appendChild(attentionCard(attention[0]));
  clearEl("attentionSecond");
  if (attention[1]) {
    $("attentionSecond").appendChild(attentionCard(attention[1]));
    $("attentionSecondBlock").style.display = "";
  } else {
    $("attentionSecondBlock").style.display = "none";
  }

  // Paywall contextual
  $("paywallTitle").textContent = `Encontramos mais ${locked} pontos nesta análise`;
  clearEl("lockedInsights");
  (p.locked_insights || []).forEach(t => {
    const li = document.createElement("li");
    li.innerHTML = `🔒 ${esc(t)}`;
    $("lockedInsights").appendChild(li);
  });

  $("result").classList.remove("hidden");
  $("paywall").classList.remove("hidden");
  // analysis_completed é contado no servidor (handlePreview), não aqui.

  trackOnView("paywall", "locked_insights_viewed");
  trackOnView("result", "result_viewed");

  $("result").scrollIntoView({ behavior: "smooth" });
}

function attentionCard(a) {
  const div = document.createElement("div");
  div.className = "attention-card";
  div.innerHTML = `<strong>${esc(a.requirement)}</strong>` +
    `<div class="attention-part"><span class="lbl">A vaga pede</span> ${esc(a.what_we_found)}</div>` +
    `<div class="attention-part"><span class="lbl">No seu currículo</span> ${esc(a.in_your_cv)}</div>` +
    (a.what_to_do ? `<div class="attention-part what-to-do">${esc(a.what_to_do)}</div>` : "");
  return div;
}

function showFriendlyError(err) {
  const msg = err && err.message ? err.message : "";
  // Mensagens específicas passam; o resto vira o erro amigável genérico.
  const friendly = /já foi desbloqueada|Limite diário|Muitas análises|muito grande/i.test(msg) ? msg
    : "Não conseguimos concluir sua análise. Tente novamente.";
  showStatus(friendly, "error");
  const btn = $("analyze");
  btn.textContent = "Tentar novamente";
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
    $("status").textContent = "Pagamento confirmado. Liberando sua análise...";
    pollUnlock();
  } else if (params.get("checkout") === "cancel") {
    history.replaceState({}, "", location.pathname);
    $("status").textContent = "Pagamento não concluído. Nenhuma cobrança foi confirmada. Você pode tentar novamente.";
  }
}

function renderResultFromState(pending) {
  $("score").textContent = pending.score;
  $("scoreExplanation").textContent = pending.score_explanation || "";
  clearEl("requirements");
  (pending.requirements || []).forEach(req => {
    const block = document.createElement("div");
    block.className = "req-cat";
    const title = document.createElement("div");
    title.className = "req-cat-title";
    title.textContent = req.category;
    block.appendChild(title);
    const chips = document.createElement("div");
    chips.className = "chips";
    (req.items || []).forEach(it => {
      const c = document.createElement("span");
      c.className = "chip";
      c.textContent = it;
      chips.appendChild(c);
    });
    block.appendChild(chips);
    $("requirements").appendChild(block);
  });
  clearEl("strengthsList");
  (pending.strengths || []).forEach(s => {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${esc(s.requirement)}</strong><div class="item-note">${esc(s.explanation)}</div>`;
    $("strengthsList").appendChild(li);
  });
  clearEl("attentionFirst");
  clearEl("attentionSecond");
  const attention = pending.attention || [];
  if (attention[0]) $("attentionFirst").appendChild(attentionCard(attention[0]));
  if (attention[1]) {
    $("attentionSecond").appendChild(attentionCard(attention[1]));
    $("attentionSecondBlock").style.display = "";
  } else {
    $("attentionSecondBlock").style.display = "none";
  }
  $("paywallTitle").textContent = pending.paywall_title || "Encontramos mais pontos nesta análise";
  clearEl("lockedInsights");
  (pending.locked_insights || []).forEach(t => {
    const li = document.createElement("li");
    li.innerHTML = `🔒 ${esc(t)}`;
    $("lockedInsights").appendChild(li);
  });
  $("result").classList.remove("hidden");
  $("paywall").classList.remove("hidden");
}

async function pollUnlock() {
  // 90s de polling (45 × 2s): o flag paid: no KV pode levar até 60s para
  // propagar até o edge do usuário (eventual consistency do Cloudflare KV).
  for (let i = 0; i < 45; i++) {
    try {
      const response = await fetch("/api/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: resultToken, code: "" })
      });
      const data = await response.json().catch(() => null);
      if (response.ok && data && data.ok) {
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
        $("status").textContent = "Sua análise expirou. Gere uma nova gratuitamente.";
        return;
      }
      if (response.status !== 403) {
        $("status").textContent = "Não foi possível concluir o pagamento. Nenhuma cobrança foi confirmada. Tente novamente.";
        $("retryUnlock").classList.remove("hidden");
        return;
      }
    } catch {
      // tenta de novo
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  // Pagamento pode ter sido confirmado (webhook) mas o flag ainda não
  // propagou no KV — dá o controle ao usuário em vez de desistir.
  $("status").textContent = "Ainda não conseguimos confirmar seu pagamento. Se você já pagou, clique abaixo para liberar sua análise.";
  $("retryUnlock").classList.remove("hidden");
}

$("retryUnlock").addEventListener("click", () => {
  $("retryUnlock").classList.add("hidden");
  $("status").textContent = "Liberando sua análise...";
  pollUnlock();
});

$("pay").addEventListener("click", async () => {
  const button = $("pay");
  if (button.disabled) return; // duplo clique
  button.disabled = true;
  $("payError").textContent = "";
  track("unlock_clicked");

  try {
    if (!resultToken) throw new Error("Faça uma análise primeiro.");

    const response = await fetch("/api/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: resultToken })
    });
    const data = await response.json().catch(() => null);

    if (response.status === 409) {
      // já desbloqueada — tenta liberar direto
      resultToken && unlockDirect(resultToken);
      return;
    }
    if (!response.ok || !data || !data.url) {
      throw new Error((data && data.error) || "Não foi possível concluir o pagamento. Nenhuma cobrança foi confirmada. Tente novamente.");
    }

    // Guarda o estado para restaurar ao voltar do Stripe.
    sessionStorage.setItem("mv-pending", JSON.stringify({
      token: resultToken,
      score: $("score").textContent,
      score_explanation: $("scoreExplanation").textContent,
      requirements: Array.from(document.querySelectorAll("#requirements .req-cat")).map(cat => ({
        category: cat.querySelector(".req-cat-title").textContent,
        items: Array.from(cat.querySelectorAll(".chip")).map(c => c.textContent)
      })),
      strengths: Array.from(document.querySelectorAll("#strengthsList li")).map(li => ({
        requirement: li.querySelector("strong").textContent,
        explanation: li.querySelector(".item-note") ? li.querySelector(".item-note").textContent : ""
      })),
      attention: Array.from(document.querySelectorAll(".attention-card")).map(card => ({
        requirement: card.querySelector("strong").textContent,
        what_we_found: card.querySelector(".attention-part .lbl") ? card.querySelector(".attention-part .lbl").nextSibling.textContent.trim() : "",
        in_your_cv: "",
        what_to_do: card.querySelector(".what-to-do") ? card.querySelector(".what-to-do").textContent : ""
      })),
      locked_insights: Array.from(document.querySelectorAll("#lockedInsights li")).map(li => li.textContent.replace(/^🔒\s*/, "")),
      paywall_title: $("paywallTitle").textContent
    }));

    location.href = data.url;
  } catch (err) {
    $("payError").textContent = err && err.message ? err.message : "Não foi possível concluir o pagamento. Nenhuma cobrança foi confirmada. Tente novamente.";
    button.disabled = false;
  }
});

async function unlockDirect(token) {
  try {
    const res = await fetch("/api/unlock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, code: "" })
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
      $("payError").textContent = (data && data.error) || "Não foi possível concluir o pagamento. Nenhuma cobrança foi confirmada. Tente novamente.";
    }
  } finally {
    $("pay").disabled = false;
  }
}

// ── Relatório completo ───────────────────────────────────────────
function renderPremium(p) {
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
    const div = document.createElement("div");
    div.className = "improvement";
    div.innerHTML = `<h4>${esc(a.requirement)}</h4>` +
      `<div class="attention-part"><span class="lbl">O que encontramos</span> ${esc(a.what_we_found)}</div>` +
      `<div class="attention-part"><span class="lbl">No seu currículo</span> ${esc(a.in_your_cv)}</div>` +
      (a.what_to_do ? `<div class="attention-part what-to-do"><span class="lbl">O que fazer</span> ${esc(a.what_to_do)}</div>` : "");
    $("pAttention").appendChild(div);
  });

  clearEl("pRewrites");
  (p.rewrites || []).forEach(r => {
    const div = document.createElement("div");
    div.className = "rewrite";
    div.innerHTML = `<div class="rewrite-orig"><span class="lbl">Original</span>${esc(r.original)}</div>` +
      `<div class="rewrite-sug"><span class="lbl">Sugestão</span>${esc(r.suggestion)}</div>` +
      (r.why ? `<div class="rewrite-why"><span class="lbl">Por quê</span>${esc(r.why)}</div>` : "");
    $("pRewrites").appendChild(div);
  });

  $("pOptimized").textContent = p.optimized_cv || "";
  $("pMessage").textContent = p.recruiter_message || "";

  // Esconde seções vazias (relatório incompleto nunca mostra buraco feio).
  ["pOptimized", "pMessage", "pQuestions", "pRewrites", "pAttention", "reqTable"].forEach(id => {
    const el = $(id);
    const card = el ? el.closest(".card") : null;
    if (!card) return;
    const empty = id === "reqTable" ? !(p.table && p.table.length)
      : id === "pRewrites" ? !(p.rewrites && p.rewrites.length)
      : id === "pAttention" ? !(p.attention && p.attention.length)
      : id === "pQuestions" ? !(p.interview_questions && p.interview_questions.length)
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

// Duas camadas de defesa:
// 1) Tag <script> REAL (caminho normal — o api.js precisa achar a própria tag).
// 2) Se um stub vencer a corrida, re-executa via eval no MESMO task da limpeza.
async function loadTurnstileScript() {
  if (window.turnstile && typeof window.turnstile.render === "function") return;

  clearTurnstileStub();
  document.querySelectorAll('script[src*="challenges.cloudflare.com/turnstile"]').forEach(s => s.remove());

  const codePromise = fetch(TURNSTILE_SRC).then(r => r.text()).catch(() => null);

  await new Promise(resolve => {
    const s = document.createElement("script");
    s.src = TURNSTILE_SRC;
    s.async = true;
    s.onload = resolve;
    s.onerror = resolve; // mesmo falhando, segue para o fallback via eval
    document.head.appendChild(s);
  });

  if (window.turnstile && typeof window.turnstile.render === "function") return;

  const code = await codePromise;
  if (!code) throw new Error("api.js do Turnstile indisponível para fallback");
  clearTurnstileStub();
  (0, eval)(code);
  if (typeof window.turnstile?.render !== "function") {
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

    turnstileWidget = window.turnstile.render($("turnstile"), {
      sitekey: config.turnstile_sitekey,
      theme: "light"
    });
  } catch (err) {
    console.error("[turnstile]", err);
    // Degradação graciosa: sem captcha o usuário NÃO fica bloqueado.
    const msg = document.createElement("p");
    msg.className = "hint small";
    msg.textContent = "O captcha não carregou (bloqueador ou antivírus?). Sem problema: a análise continua disponível, com limite de uso por IP.";
    $("turnstile").appendChild(msg);
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
  note.textContent = "O score compara informações encontradas no currículo com os requisitos identificados na vaga. Ele não prevê contratação.";
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
        body: JSON.stringify({ token: savedToken, code: "" })
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
