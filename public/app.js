let resultToken = null;
let turnstileWidget = null;

const $ = id => document.getElementById(id);

// Exemplo real (currículo fictício) gerado pelo próprio produto — vitrine da landing.
const EXAMPLE_RESULT = {
  score: 75,
  missing: ["testes automatizados", "metodologias ágeis", "experiência com pagamentos"],
  suggestions: [
    "Adicione uma seção de habilidades listando explicitamente testes automatizados (ex.: Jest, Mocha) e metodologias ágeis (ex.: Scrum, Kanban).",
    "Inclua um projeto onde você escreveu testes unitários ou de integração, mesmo que pessoal.",
    "Mencione participação em sprints, daily stand-ups ou uso de Jira.",
    "Se tiver qualquer contato com sistemas de pagamento (ex.: Stripe, PayPal), destaque-o."
  ],
  optimized_cv: "Ana Souza\nDesenvolvedora Full Stack | Node.js, TypeScript, React\n\nResumo:\nDesenvolvedora Full Stack com 4 anos de experiência na construção de aplicações web escaláveis. Especializada em Node.js, TypeScript e React, com sólida experiência em APIs REST, bancos de dados relacionais e deploy em nuvem. Comunicação em inglês avançado.\n\nExperiência Profissional:\nDesenvolvedora Full Stack | Empresa XYZ | [Período]\n- Desenvolvi e mantive APIs REST utilizando Node.js, Express e PostgreSQL, garantindo alta performance e confiabilidade.\n- Implementei interfaces de usuário com React e Next.js, melhorando a experiência do usuário.\n- Configurei ambientes com Docker e automatizei pipelines de CI/CD com GitHub Actions, reduzindo o tempo de deploy.\n- Colaborei com equipes multidisciplinares em ambiente ágil, participando de sprints e cerimônias do time.\n\nFormação:\nBacharel em Ciência da Computação — UFMG\n\nIdiomas:\nInglês avançado",
  interview_questions: [
    "Descreva um desafio técnico que você enfrentou ao desenvolver uma API REST e como o resolveu.",
    "Como você garante a qualidade do código? Fale sobre sua experiência com testes automatizados.",
    "Você já trabalhou com metodologias ágeis? Como lida com mudanças de requisitos durante um sprint?"
  ]
};

function renderExample() {
  $("exScore").textContent = EXAMPLE_RESULT.score;
  $("exGaps").textContent = EXAMPLE_RESULT.missing.length;
  fillList("exMissing", EXAMPLE_RESULT.missing);
  fillList("exSuggestions", EXAMPLE_RESULT.suggestions);
  fillList("exQuestions", EXAMPLE_RESULT.interview_questions);
  $("exOptimized").textContent = EXAMPLE_RESULT.optimized_cv;
}

$("exCta").addEventListener("click", () => {
  $("cv").scrollIntoView({ behavior: "smooth", block: "center" });
  setTimeout(() => $("cv").focus(), 400);
});

function fillList(id, items) {
  const el = $(id);
  el.innerHTML = "";
  (items || []).forEach(item => {
    const li = document.createElement("li");
    li.textContent = item;
    el.appendChild(li);
  });
}

function restorePending() {
  try {
    return JSON.parse(sessionStorage.getItem("mv-pending") || "null");
  } catch {
    return null;
  }
}

// Se veio de volta do Stripe (?checkout=success), restaura o estado e
// fica sondando o unlock até o webhook confirmar o pagamento.
function handleCheckoutReturn() {
  const params = new URLSearchParams(location.search);
  const pending = restorePending();
  if (params.get("checkout") === "success" && pending) {
    history.replaceState({}, "", location.pathname);
    resultToken = pending.token;
    $("score").textContent = pending.score;
    $("gapCount").textContent = pending.gap_count;
    $("price").textContent = pending.price;
    fillList("matched", pending.matched);
    $("result").classList.remove("hidden");
    $("status").textContent = "Aguardando confirmação do pagamento...";
    pollUnlock();
  } else if (params.get("checkout") === "cancel") {
    history.replaceState({}, "", location.pathname);
    $("status").textContent = "Pagamento cancelado. Você pode tentar novamente.";
  }
}

async function pollUnlock() {
  for (let i = 0; i < 20; i++) {
    try {
      const response = await fetch("/api/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: resultToken, code: "" })
      });
      const data = await response.json();
      if (response.ok && data.ok) {
        sessionStorage.removeItem("mv-pending");
        renderPremium(data.premium);
        $("status").textContent = "";
        return;
      }
      if (response.status === 403) break; // pagamento ainda não confirmado
    } catch {
      // tenta de novo
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  $("status").textContent = "Pagamento ainda não confirmado. Tente desbloquear em instantes.";
}

function renderPremium(p) {
  fillList("missing", p.missing);
  fillList("suggestions", p.suggestions);
  fillList("questions", p.interview_questions);
  $("optimized").textContent = p.optimized_cv || "";
  $("message").textContent = p.recruiter_message || "";
  $("premium").classList.remove("hidden");
  $("paywall").classList.add("hidden"); // já pagou — some o card de pagamento
  $("premium").scrollIntoView({ behavior: "smooth" });
}

// Alguns ambientes (extensões/tools de privacidade, navegadores automatizados)
// poluem o protótipo com `turnstile` vazio. O api.js do Cloudflare vê
// "turnstile" in window e recusa inicializar ("already has been loaded").
// Remove o stub herdado antes de carregar o script real.
function clearTurnstileStub() {
  if (!("turnstile" in window)) return;
  if (window.turnstile && typeof window.turnstile.render === "function") return; // API real

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

// Carrega o api.js via fetch + eval no MESMO task da limpeza do stub:
// JS é single-threaded, então nenhum timer/ferramenta consegue repoluir
// o protótipo entre a limpeza e a execução do script. Fallback: script tag.
async function loadTurnstileScript() {
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
    if (!res.ok) throw new Error("fetch api.js falhou");
    const code = await res.text();
    clearTurnstileStub();
    (0, eval)(code);
  } catch {
    clearTurnstileStub();
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.onload = resolve;
      s.onerror = () => reject(new Error("script do Turnstile falhou ao carregar"));
      document.head.appendChild(s);
    });
  }
}

async function initTurnstile() {
  try {
    const res = await fetch("/api/config");
    const config = await res.json();
    if (!config.turnstile_sitekey) return; // não configurado → sem captcha

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
    const msg = document.createElement("p");
    msg.className = "error small";
    msg.textContent =
      "O captcha não carregou. Desative o bloqueador de anúncios e recarregue (Ctrl+Shift+R). " +
      "Se continuar, o sitekey pode não permitir este domínio.";
    $("turnstile").appendChild(msg);
  }
}

$("analyze").addEventListener("click", async () => {
  const button = $("analyze");
  button.disabled = true;
  $("result").classList.add("hidden");
  $("premium").classList.add("hidden");
  $("paywall").classList.remove("hidden"); // nova análise = novo pagamento possível

  const started = Date.now();
  $("status").textContent = "Analisando...";
  const timer = setInterval(() => {
    const s = Math.round((Date.now() - started) / 1000);
    $("status").textContent = `Analisando... ${s}s (pode levar até 40s)`;
  }, 1000);

  try {
    const turnstileToken = turnstileWidget ? window.turnstile.getResponse(turnstileWidget) : "";
    const response = await fetch("/api/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cv: $("cv").value,
        job: $("job").value,
        turnstile: turnstileToken
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Falha na análise.");

    resultToken = data.token;
    $("score").textContent = data.preview.score;
    $("gapCount").textContent = data.preview.gap_count;
    $("price").textContent = data.price;
    fillList("matched", data.preview.matched);

    $("result").classList.remove("hidden");
    $("status").textContent = "";
    $("result").scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    $("status").textContent = err.message || "Erro inesperado.";
  } finally {
    clearInterval(timer);
    button.disabled = false;
    if (turnstileWidget) window.turnstile.reset(turnstileWidget);
  }
});

$("pay").addEventListener("click", async () => {
  const button = $("pay");
  button.disabled = true;
  $("unlockError").textContent = "";

  try {
    if (!resultToken) throw new Error("Faça uma análise primeiro.");

    const response = await fetch("/api/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: resultToken })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Falha ao iniciar pagamento.");

    // Guarda o estado para restaurar ao voltar do Stripe.
    sessionStorage.setItem("mv-pending", JSON.stringify({
      token: resultToken,
      score: $("score").textContent,
      gap_count: $("gapCount").textContent,
      price: $("price").textContent,
      matched: Array.from($("matched").children).map(li => li.textContent)
    }));

    location.href = data.url;
  } catch (err) {
    $("unlockError").textContent = err.message || "Erro inesperado.";
  } finally {
    button.disabled = false;
  }
});

initTurnstile();
handleCheckoutReturn();
renderExample();
