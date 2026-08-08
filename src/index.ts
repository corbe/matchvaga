interface Env {
  ASSETS: Fetcher;
  RESULTS: KVNamespace;
  OPENAI_API_KEY: string;
  OPENAI_MODEL: string;
  PRICE_BRL: string;
  PIX_KEY: string;
  UNLOCK_CODE: string;
  RATE_LIMIT_PER_HOUR: string;
  DAILY_PREVIEW_BUDGET: string;
  TURNSTILE_SITEKEY: string;
  TURNSTILE_SECRET: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  ALERT_WEBHOOK_URL: string;
}

type Strength = { requirement: string; explanation: string };
type Attention = { requirement: string; what_we_found: string; in_your_cv: string; what_to_do: string };
type Rewrite = { original: string; suggestion: string; why: string };

type PremiumResult = {
  score: number;
  score_explanation: string;
  requirements: { category: string; items: string[] }[];
  table: { requirement: string; situation: string; evidence: string }[];
  strengths: Strength[];
  attention: Attention[];
  locked_insights: string[];
  rewrites: Rewrite[];
  optimized_cv: string;
  recruiter_message: string;
  interview_questions: string[];
};

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
};

// Headers de segurança aplicados às respostas de conteúdo (HTML/CSS/JS).
const securityHeaders: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy":
    // 'unsafe-eval' apenas para o fallback do Turnstile: se um stub (extensão)
    // vencer a corrida contra o load da tag, re-executamos o api.js via eval no
    // mesmo task da limpeza. O código avaliado é o próprio api.js da Cloudflare,
    // baixado via HTTPS de challenges.cloudflare.com.
    "default-src 'self'; script-src 'self' https://challenges.cloudflare.com https://static.cloudflareinsights.com 'unsafe-eval'; " +
    "style-src 'self'; img-src 'self' data:; connect-src 'self' https://challenges.cloudflare.com https://cloudflareinsights.com; " +
    "base-uri 'self'; form-action 'self'; frame-src https://challenges.cloudflare.com; " +
    "worker-src 'self' https://challenges.cloudflare.com blob:; frame-ancestors 'none'"
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
}

function randomToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

// ── Proteção de custo (anti-abuso) ────────────────────────────────
function clientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    "unknown"
  );
}

function parseNum(raw: string | null | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function kvCount(env: Env, key: string): Promise<number> {
  return parseNum(await env.RESULTS.get(key));
}

// Devolve uma unidade de cota (melhor esforço) quando a análise FALHA —
// assim timeout/erro da IA não queimam o slot do usuário.
async function refund(env: Env, key: string, ttl: number) {
  const current = await kvCount(env, key);
  if (current > 0) {
    await env.RESULTS.put(key, String(current - 1), { expirationTtl: ttl });
  }
}

// Incrementa um contador no KV com TTL. Retorna o novo valor, ou null quando o
// limite já foi atingido.
async function checkAndIncrement(env: Env, key: string, limit: number, ttl: number): Promise<number | null> {
  const current = await kvCount(env, key);
  if (current >= limit) return null;
  const next = current + 1;
  await env.RESULTS.put(key, String(next), { expirationTtl: ttl });
  return next;
}

async function contentHash(cv: string, job: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(cv + "\u0000" + job)
  );
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, "0")).join("");
}

// ── Funil de conversão (agregado, sem dados pessoais) ────────────
// Etapas medidas. Contadores por dia (TTL 31d) e totais (sem TTL).
const FUNNEL_STAGES = [
  "landing_view",
  "analysis_started",
  "resume_uploaded",
  "job_description_added",
  "analysis_completed",
  "result_viewed",
  "locked_insights_viewed",
  "unlock_clicked",
  "checkout_started",
  "payment_completed",
  "full_report_viewed"
] as const;
type FunnelStage = (typeof FUNNEL_STAGES)[number];

async function bump(env: Env, stage: FunnelStage) {
  const day = new Date().toISOString().slice(0, 10);
  const dayKey = `ev:${stage}:${day}`;
  const totalKey = `evt:${stage}`;
  const [dayCount, totalCount] = await Promise.all([kvCount(env, dayKey), kvCount(env, totalKey)]);
  await env.RESULTS.put(dayKey, String(dayCount + 1), { expirationTtl: 86400 * 31 });
  await env.RESULTS.put(totalKey, String(totalCount + 1));
}

// Tentativa ÚNICA com timeout generoso: duas tentativas de 14s ultrapassam o
// orçamento de execução do Worker (~30s) e o edge mata a requisição no meio do
// retry — o usuário recebe 504/HTML em vez de um JSON de erro. Uma tentativa
// de 25s cobre picos de latência da DeepSeek e, se estourar, o botão
// "Tentar novamente" inicia uma janela nova (e o rate limit é devolvido).
// Tolerante a JSON truncado: se a IA cortar a resposta no meio (limite de
// tokens), tenta fechar objetos/arrays pendentes antes de desistir.
function parseLoose(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    // tenta reparar: completa chaves/colchetes não fechados no fim
  }
  const openBraces = (text.match(/\{/g) || []).length;
  const closeBraces = (text.match(/\}/g) || []).length;
  const openBrackets = (text.match(/\[/g) || []).length;
  const closeBrackets = (text.match(/\]/g) || []).length;
  let repaired = text;
  if (closeBrackets < openBrackets) repaired += "]".repeat(openBrackets - closeBrackets);
  if (closeBraces < openBraces) repaired += "}".repeat(openBraces - closeBraces);
  try {
    return JSON.parse(repaired);
  } catch {
    throw new Error("JSON inválido da IA");
  }
}

async function callOpenAI(env: Env, cv: string, job: string): Promise<PremiumResult> {
  // Limita o tamanho dos inputs: currículo/vaga gigantes não agregam à análise
  // e atrasam a geração — o principal motivo de timeout com pastes reais.
  const MAX_CV = 3000;
  const MAX_JOB = 2000;
  const cvTrim = cv.length > MAX_CV ? cv.slice(0, MAX_CV) + "\n[...]" : cv;
  const jobTrim = job.length > MAX_JOB ? job.slice(0, MAX_JOB) + "\n[...]" : job;

  const input = `
 Compare rigorosamente o currículo com a vaga.

REGRAS DE INTEGRIDADE (obrigatórias):
- NUNCA invente experiência, empresa, cargo, tecnologia, certificação ou resultado.
- "Não encontrado no currículo" NÃO significa "o candidato não possui": quando um requisito da vaga não aparecer no currículo, diga que NÃO FOI ENCONTRADO no currículo, nunca que o candidato não tem a experiência.
- Não transforme conhecimento teórico em experiência profissional.
- Não ensine o candidato a mentir.
- O currículo otimizado pode melhorar clareza, reordenar, destacar e usar a terminologia da vaga QUANDO VERDADEIRA — mas APENAS com fatos existentes no currículo.
- Quando faltar informação: "Se você realmente possui experiência com X, considere evidenciá-la melhor no currículo."

FORMATO DE RESPOSTA (JSON válido, sem markdown, EXATAMENTE estas chaves):
{
  "score": <inteiro 0-100 — grau de alinhamento entre currículo e requisitos; NÃO é chance de contratação>,
  "score_explanation": "<1-2 frases>",
  "requirements": [{"category":"<ex.: Backend>","items":["<requisitos da vaga>"]}],
  "table": [{"requirement":"<requisito>","situation":"Forte|Compatível|Melhorar|Gap","evidence":"Encontrado claramente|Encontrado|Pouco evidenciado|Não encontrado"}],
  "strengths": [{"requirement":"<requisito>","explanation":"<por que está bem demonstrado, citando o currículo>"}],
  "attention": [{"requirement":"<requisito que merece atenção>","what_we_found":"<o que a vaga pede>","in_your_cv":"<o que encontramos (ou não) no currículo, sem afirmar que o candidato não sabe>","what_to_do":"<ação honesta>"}],
  "locked_insights": ["<título curto de descoberta adicional, ex.: 'Experiência com Kubernetes pode estar sub-representada'>"],
  "rewrites": [{"original":"<trecho REAL do currículo>","suggestion":"<versão melhorada SEM inventar>","why":"<explicação curta>"}],
  "optimized_cv": "<currículo adaptado à vaga, SEM inventar nada>",
  "recruiter_message": "<mensagem curta e honesta para o recrutador>",
  "interview_questions": ["<perguntas prováveis para esta vaga e este currículo>"]
}

REGRAS ADICIONAIS:
- requirements: agrupe os requisitos da vaga em 2-4 categorias.
- table: cubra os requisitos principais (5-6 linhas), com evidência honesta.
- strengths: no máximo 3 itens.
- attention: no máximo 3 itens (os 2 primeiros serão exibidos gratuitamente).
- locked_insights: 4 títulos curtos e específicos DESTA análise (o que o relatório completo revela).
- rewrites: no máximo 2 trechos reais do currículo com sugestão honesta de melhoria.
- optimized_cv: máximo 1200 caracteres.
- interview_questions: no máximo 4.
CRÍTICO: a resposta JSON inteira deve ter no máximo 2000 caracteres. Se o
currículo for extenso, priorize o essencial. NUNCA deixe o JSON incompleto.

CURRÍCULO:
${cvTrim}

VAGA:
${jobTrim}
`;

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json"
    },
    // 25s: cabe no orçamento de execução do Worker (~30s) com margem.
    signal: AbortSignal.timeout(25000),
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "deepseek-v4-flash",
      messages: [
        {
          role: "system",
          content:
            "Você é um analista de currículos experiente e honesto. Responda APENAS com JSON válido, sem markdown, sem comentários. Nunca invente informações sobre o candidato."
        },
        { role: "user", content: input }
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
      thinking: { type: "disabled" },
      // Saída limitada: geração menor = resposta mais rápida e JSON sempre
      // completo dentro dos 25s (truncar no meio do JSON derruba a análise).
      max_tokens: 2000,
    })
  });

  if (!response.ok) {
    const err = await response.text();
    console.error("DeepSeek error", response.status, err);
    throw new Error("OPENAI_FAILED");
  }

  const data: any = await response.json();
  let outputText = String(data?.choices?.[0]?.message?.content ?? "").trim();
  if (outputText.startsWith("```")) {
    outputText = outputText.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  }
  if (!outputText) throw new Error("OPENAI_EMPTY");

  // Normaliza: o JSON mode da DeepSeek não garante o schema — defaults seguros.
  const parsed = parseLoose(outputText) as Partial<PremiumResult>;
  const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
  const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
  const obj = <T extends Record<string, unknown>>(v: unknown): T | null =>
    v && typeof v === "object" ? (v as T) : null;

  return {
    score: typeof parsed.score === "number" && parsed.score >= 0 && parsed.score <= 100 ? parsed.score : 50,
    score_explanation: str(parsed.score_explanation, "Análise do alinhamento entre seu currículo e a vaga."),
    requirements: arr(parsed.requirements).map(obj).filter(Boolean).slice(0, 4).map(r => ({
      category: str(r!.category, "Requisitos"),
      items: arr(r!.items).filter(i => typeof i === "string").slice(0, 12) as string[]
    })),
    table: arr(parsed.table).map(obj).filter(Boolean).slice(0, 10).map(t => ({
      requirement: str(t!.requirement, "Requisito"),
      situation: str(t!.situation, "Melhorar"),
      evidence: str(t!.evidence, "—")
    })),
    strengths: arr(parsed.strengths).map(obj).filter(Boolean).slice(0, 3).map(s => ({
      requirement: str(s!.requirement, "Requisito"),
      explanation: str(s!.explanation, "Bem demonstrado no currículo.")
    })),
    attention: arr(parsed.attention).map(obj).filter(Boolean).slice(0, 3).map(a => ({
      requirement: str(a!.requirement, "Requisito"),
      what_we_found: str(a!.what_we_found, "A vaga menciona este requisito."),
      in_your_cv: str(a!.in_your_cv, "Não encontramos claramente no currículo."),
      what_to_do: str(a!.what_to_do, "Se você realmente possui esta experiência, considere evidenciá-la melhor no currículo.")
    })),
    locked_insights: arr(parsed.locked_insights).filter(i => typeof i === "string").slice(0, 4) as string[],
    rewrites: arr(parsed.rewrites).map(obj).filter(Boolean).slice(0, 2).map(r => ({
      original: str(r!.original, ""),
      suggestion: str(r!.suggestion, ""),
      why: str(r!.why, "")
    })),
    optimized_cv: str(parsed.optimized_cv, ""),
    recruiter_message: str(parsed.recruiter_message, ""),
    interview_questions: arr(parsed.interview_questions).filter(q => typeof q === "string").slice(0, 4) as string[]
  } as PremiumResult;
}

// ── Turnstile (anti-bot) ─────────────────────────────────────────
// Se TURNSTILE_SECRET não estiver configurada, libera (modo dev/setup).
async function verifyTurnstile(env: Env, token: string, ip: string): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip });
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString()
  });
  if (!res.ok) return false;
  const data: any = await res.json();
  if (data?.success !== true) {
    console.error("[turnstile] rejeitado:", JSON.stringify(data?.["error-codes"] ?? data));
  }
  return data?.success === true;
}

// ── Stripe (pagamento) ───────────────────────────────────────────
// Converte "9,90" → 990 (centavos).
function brlToCents(price: string): number {
  const n = Number(String(price).replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) : 990;
}

const RESULT_TTL = 86400; // análise fica disponível 24h (tempo para pagar)

async function handleCheckout(request: Request, env: Env) {
  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: "Pagamento indisponível no momento. Tente novamente em instantes." }, 503);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Requisição inválida." }, 400);
  }

  const token = String(body?.token || "");
  if (!/^[0-9a-f]{48}$/.test(token)) {
    return json({ error: "Sessão expirada. Gere uma nova análise." }, 400);
  }

  const raw = await env.RESULTS.get(`result:${token}`);
  if (!raw) {
    return json({ error: "Sua análise expirou. Gere uma nova gratuitamente." }, 404);
  }

  // NÃO deixa pagar por análise-lixo: se o currículo não pôde ser lido, o
  // resultado vem sem forças/atenção/reescritas. Cobrar por isso é inadmissível.
  let premium: PremiumResult | null = null;
  try {
    premium = JSON.parse(raw) as PremiumResult;
  } catch {
    // resultado corrompido — trata como lixo
  }
  const isGarbage = !premium ||
    (!(premium.strengths && premium.strengths.length) &&
     !(premium.attention && premium.attention.length) &&
     !(premium.rewrites && premium.rewrites.length));
  if (isGarbage) {
    await env.RESULTS.delete(`result:${token}`).catch(() => {});
    return json({ error: "Sua análise não pôde ser gerada corretamente (o currículo não foi lido). Refaça a análise gratuitamente." }, 422);
  }

  // Evita pagamento duplicado: se já desbloqueou, não deixa pagar de novo.
  if ((await env.RESULTS.get(`paid:${token}`)) === "1") {
    return json({ error: "Esta análise já foi desbloqueada." }, 409);
  }

  // Renova o prazo da análise (24h a partir do início do pagamento), para o
  // usuário não perder o conteúdo depois de pagar.
  await env.RESULTS.put(`result:${token}`, raw, { expirationTtl: RESULT_TTL });

  const origin = request.headers.get("origin") || `https://${request.headers.get("host") || "matchvaga.kubezen.com"}`;
  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("success_url", `${origin}/?checkout=success`);
  form.set("cancel_url", `${origin}/?checkout=cancel`);
  form.set("metadata[token]", token);
  form.set("line_items[0][quantity]", "1");
  form.set("line_items[0][price_data][currency]", "brl");
  form.set("line_items[0][price_data][unit_amount]", String(brlToCents(env.PRICE_BRL)));
  form.set("line_items[0][price_data][product_data][name]", "MatchVaga — Kit para esta candidatura");

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: form.toString()
  });

  const data: any = await res.json();
  if (!res.ok || !data?.url) {
    console.error("Stripe error", res.status, JSON.stringify(data));
    return json({ error: "Não foi possível concluir o pagamento. Nenhuma cobrança foi confirmada. Tente novamente." }, 502);
  }
  await bump(env, "checkout_started");
  return json({ url: data.url });
}

// Verifica a assinatura HMAC-SHA256 do webhook do Stripe (header stripe-signature).
async function verifyStripeSignature(
  env: Env,
  rawBody: string,
  sigHeader: string | null
): Promise<{ ok: boolean; payload?: any }> {
  if (!env.STRIPE_WEBHOOK_SECRET || !sigHeader) return { ok: false };

  const parts: Record<string, string> = {};
  for (const piece of sigHeader.split(",")) {
    const eq = piece.indexOf("=");
    if (eq > 0) parts[piece.slice(0, eq).trim()] = piece.slice(eq + 1).trim();
  }
  const t = parts["t"];
  const v1 = parts["v1"];
  if (!t || !v1) return { ok: false };

  // Tolerância de 5 min contra replay.
  const ageSec = Math.abs(Date.now() / 1000 - Number(t));
  if (ageSec > 300) return { ok: false };

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${rawBody}`));
  const hex = Array.from(new Uint8Array(mac), b => b.toString(16).padStart(2, "0")).join("");

  if (hex.length !== v1.length) return { ok: false };
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ v1.charCodeAt(i);
  if (diff !== 0) return { ok: false };

  return { ok: true, payload: JSON.parse(rawBody) };
}

async function handleStripeWebhook(request: Request, env: Env) {
  const raw = await request.text();
  const { ok, payload } = await verifyStripeSignature(env, raw, request.headers.get("stripe-signature"));
  if (!ok) return json({ error: "Assinatura inválida." }, 401);

  const type = payload?.type;
  // PIX via Stripe é assíncrono: cobre os dois eventos de sucesso.
  if (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") {
    const token = String(payload?.data?.object?.metadata?.token || "");
    if (/^[0-9a-f]{48}$/.test(token)) {
      // Idempotente: webhooks do Stripe são reentregues — não conta pagamento 2x.
      const already = await env.RESULTS.get(`paid:${token}`);
      if (already !== "1") {
        await env.RESULTS.put(`paid:${token}`, "1", { expirationTtl: RESULT_TTL });
        console.log(`[stripe] pagamento confirmado para token ${token.slice(0, 8)}…`);
        await bump(env, "payment_completed");
      }
    }
  }
  return json({ received: true });
}

// ── Alerta de orçamento (cron + tempo real) ──────────────────────
async function fireBudgetAlertIfNeeded(env: Env, day: string, used: number, limit: number) {
  const pct = Math.round((used / limit) * 100);
  if (pct < 80 || !env.ALERT_WEBHOOK_URL) return;
  const level = pct >= 100 ? "full" : "80";
  const sentKey = `alert:${day}:${level}`;
  if (await env.RESULTS.get(sentKey)) return;
  try {
    await fetch(env.ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title:
          level === "full"
            ? "MatchVaga: orçamento diário ESGOTADO"
            : "MatchVaga: orçamento diário quase esgotado",
        message: `${pct}% do teto usado (${used}/${limit}). Possível ataque ou pico de uso.`
      })
    });
    console.log(`[alert] enviado (${level}, ${pct}%)`);
  } catch (err) {
    console.error("alert webhook falhou", err);
  }
  await env.RESULTS.put(sentKey, "1", { expirationTtl: 90000 });
}

async function checkBudgetAndAlert(env: Env) {
  const day = new Date().toISOString().slice(0, 10);
  const used = await kvCount(env, `budget:${day}`);
  const limit = parseNum(env.DAILY_PREVIEW_BUDGET) || 100;
  console.log(`[budget] ${day}: ${used}/${limit} (${Math.round((used / limit) * 100)}%)`);
  await fireBudgetAlertIfNeeded(env, day, used, limit);
}

// ── Handlers de API ──────────────────────────────────────────────
async function handlePreview(request: Request, env: Env) {
  if (!env.OPENAI_API_KEY) {
    return json({ error: "Não conseguimos analisar seu currículo agora. Tente novamente em instantes." }, 500);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Requisição inválida." }, 400);
  }

  const cv = String(body?.cv || "").trim();
  const job = String(body?.job || "").trim();

  if (cv.length < 40) {
    return json({ error: "Não conseguimos ler o texto do currículo. Se o PDF for escaneado, cole o texto manualmente." }, 400);
  }
  if (job.length < 30) {
    return json({ error: "Cole a descrição da vaga completa." }, 400);
  }
  if (cv.length > 10000 || job.length > 5000) {
    return json({ error: "Texto muito grande para esta versão. Envie um currículo mais resumido." }, 413);
  }

  // Anti-bot: exige Turnstile válido QUANDO o token vem preenchido.
  // Degradação graciosa: se o captcha não carregou no navegador do usuário
  // (extensão/antivírus interceptando challenges.cloudflare.com), o token vem
  // vazio e a análise é liberada mesmo assim — os rate limits por IP + teto
  // diário seguram o custo.
  const turnstileToken = String(body?.turnstile || "");
  if (turnstileToken && !(await verifyTurnstile(env, turnstileToken, clientIp(request)))) {
    return json({ error: "Verificação anti-bot falhou. Recarregue e tente novamente." }, 400);
  }

  await bump(env, "analysis_started");

  try {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const hour = now.toISOString().slice(0, 13);

    // 1) Teto global diário: limita o CUSTO TOTAL mesmo sob ataque em massa.
    const dailyBudget = parseNum(env.DAILY_PREVIEW_BUDGET) || 100;
    const budgetCount = await checkAndIncrement(env, `budget:${day}`, dailyBudget, 90000);
    if (budgetCount === null) {
      return json({ error: "Limite diário de análises atingido. Volte amanhã." }, 429);
    }
    await fireBudgetAlertIfNeeded(env, day, budgetCount, dailyBudget);

    // 2) Rate limit por IP/hora: impede que um único abusador queime tudo.
    const perHourLimit = parseNum(env.RATE_LIMIT_PER_HOUR) || 3;
    if ((await checkAndIncrement(env, `rl:${clientIp(request)}:${hour}`, perHourLimit, 3700)) === null) {
      return json({ error: "Muitas análises neste horário. Aguarde um pouco." }, 429);
    }

    // 3) Cache por hash: análises idênticas repetidas não gastam créditos de novo.
    const hash = await contentHash(cv, job);
    const cached = await env.RESULTS.get(`cache:${hash}`);
    const premium: PremiumResult = cached
      ? (JSON.parse(cached) as PremiumResult)
      : await callOpenAI(env, cv, job);

    if (!cached) {
      await env.RESULTS.put(`cache:${hash}`, JSON.stringify(premium), { expirationTtl: 86400 });
    }

    const token = randomToken();
    await env.RESULTS.put(`result:${token}`, JSON.stringify(premium), { expirationTtl: RESULT_TTL });

    await bump(env, "analysis_completed");

    // Diagnóstico grátis: score + vaga compreendida + pontos fortes + 2
    // descobertas + títulos dos insights bloqueados (a curiosidade do paywall).
    const preview = {
      score: premium.score,
      score_explanation: premium.score_explanation,
      requirements: premium.requirements,
      strengths: premium.strengths,
      attention: premium.attention.slice(0, 2),
      locked_insights: premium.locked_insights,
      counts: {
        attention: premium.attention.length,
        locked: premium.locked_insights.length
      }
    };

    return json({
      token,
      preview,
      price: env.PRICE_BRL || "9,90"
    });
  } catch (err) {
    console.error(err);
    // Devolve a cota consumida (budget + rate limit) — falha da IA não queima o slot.
    try {
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      const hour = now.toISOString().slice(0, 13);
      await refund(env, `budget:${day}`, 90000);
      await refund(env, `rl:${clientIp(request)}:${hour}`, 3700);
    } catch {
      // melhor esforço
    }
    if (err instanceof Error && err.name === "TimeoutError") {
      return json({ error: "Não conseguimos analisar seu currículo agora. Tente novamente em instantes." }, 504);
    }
    return json({ error: "Não conseguimos analisar seu currículo agora. Tente novamente em instantes." }, 503);
  }
}

async function handleUnlock(request: Request, env: Env) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Requisição inválida." }, 400);
  }

  const token = String(body?.token || "");
  const code = String(body?.code || "").trim();

  if (!token) {
    return json({ error: "Token é obrigatório." }, 400);
  }

  // Rate limit só para tentativas COM código (vetor de brute-force).
  if (code) {
    const now = new Date();
    const hour = now.toISOString().slice(0, 13);
    if ((await checkAndIncrement(env, `rl-unlock:${clientIp(request)}:${hour}`, 10, 3700)) === null) {
      return json({ error: "Muitas tentativas de desbloqueio. Aguarde um pouco." }, 429);
    }
  }

  if (!/^[0-9a-f]{48}$/.test(token)) {
    return json({ error: "Sessão inválida." }, 400);
  }

  // Libera com código manual OU com pagamento Stripe confirmado (código vazio).
  const paid = await env.RESULTS.get(`paid:${token}`);
  if (code !== env.UNLOCK_CODE && paid !== "1") {
    return json({ error: "Código de liberação inválido." }, 403);
  }

  const raw = await env.RESULTS.get(`result:${token}`);
  if (!raw) {
    return json({ error: "Sua análise expirou. Gere uma nova gratuitamente." }, 404);
  }

  return json({ ok: true, premium: JSON.parse(raw) });
}

// Eventos de funil vindos do cliente (sem dados pessoais — só contadores).
async function handleEvent(request: Request, env: Env) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Requisição inválida." }, 400);
  }
  const stage = String(body?.stage || "");
  if (!(FUNNEL_STAGES as readonly string[]).includes(stage)) {
    return json({ error: "Evento desconhecido." }, 400);
  }
  const hour = new Date().toISOString().slice(0, 13);
  if ((await checkAndIncrement(env, `rl-ev:${clientIp(request)}:${hour}`, 60, 3700)) === null) {
    return json({ ok: true }); // silencioso sob rate limit
  }
  await bump(env, stage as FunnelStage);
  return json({ ok: true });
}

async function handleStatus(env: Env) {
  const day = new Date().toISOString().slice(0, 10);
  const used = await kvCount(env, `budget:${day}`);
  const limit = parseNum(env.DAILY_PREVIEW_BUDGET) || 100;
  return json({
    budget: { used, limit, remaining: Math.max(0, limit - used) },
    model: env.OPENAI_MODEL,
    price: env.PRICE_BRL,
    stripe: Boolean(env.STRIPE_SECRET_KEY),
    turnstile: Boolean(env.TURNSTILE_SECRET)
  });
}

async function handleStats(env: Env) {
  const day = new Date().toISOString().slice(0, 10);
  const today: Record<string, number> = {};
  const total: Record<string, number> = {};
  for (const stage of FUNNEL_STAGES) {
    today[stage] = await kvCount(env, `ev:${stage}:${day}`);
    total[stage] = await kvCount(env, `evt:${stage}`);
  }
  // Taxas de conversão do funil (evitando divisão por zero).
  const conv: Record<string, string> = {};
  const rate = (from: number, to: number) => (from > 0 ? `${Math.round((to / from) * 100)}%` : null);
  const t = total;
  const c1 = rate(t.landing_view, t.analysis_started);
  const c2 = rate(t.analysis_started, t.analysis_completed);
  const c3 = rate(t.analysis_completed, t.result_viewed);
  const c4 = rate(t.result_viewed, t.locked_insights_viewed);
  const c5 = rate(t.locked_insights_viewed, t.unlock_clicked);
  const c6 = rate(t.unlock_clicked, t.checkout_started);
  const c7 = rate(t.checkout_started, t.payment_completed);
  const c8 = rate(t.payment_completed, t.full_report_viewed);
  const totalConv = rate(t.landing_view, t.payment_completed);
  if (c1) conv["landing→analysis"] = c1;
  if (c2) conv["analysis→completed"] = c2;
  if (c3) conv["completed→result"] = c3;
  if (c4) conv["result→insights"] = c4;
  if (c5) conv["insights→unlock"] = c5;
  if (c6) conv["unlock→checkout"] = c6;
  if (c7) conv["checkout→paid"] = c7;
  if (c8) conv["paid→report"] = c8;
  if (totalConv) conv["landing→paid"] = totalConv;
  return json({ day, today, total, conv });
}

async function handleConfig(env: Env) {
  return json({
    turnstile_sitekey: env.TURNSTILE_SITEKEY || "",
    price: env.PRICE_BRL || "9,90"
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // HTTPS obrigatório: redireciona http → https (algumas zonas Cloudflare
    // não têm "Always Use HTTPS" ativo; o worker garante em qualquer domínio).
    // localhost fica de fora (dev roda em http puro).
    if (url.protocol === "http:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      return Response.redirect(`https://${url.host}${url.pathname}${url.search}`, 301);
    }

    if (request.method === "POST" && url.pathname === "/api/preview") {
      return handlePreview(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/unlock") {
      return handleUnlock(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/checkout") {
      return handleCheckout(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/stripe-webhook") {
      return handleStripeWebhook(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/event") {
      return handleEvent(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/status") {
      return handleStatus(env);
    }

    if (request.method === "GET" && url.pathname === "/api/stats") {
      return handleStats(env);
    }

    if (request.method === "GET" && url.pathname === "/api/config") {
      return handleConfig(env);
    }

    if (request.method === "GET" && url.pathname === "/") {
      await bump(env, "landing_view");
    }

    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    for (const [name, value] of Object.entries(securityHeaders)) {
      if (!headers.has(name)) headers.set(name, value);
    }
    // Cache à prova de versão antiga: HTML nunca é cacheado (nem por proxies
    // intermediários); JS/CSS revalidam sempre; só binários estáveis cacheiam.
    if (url.pathname.endsWith(".html") || url.pathname === "/") {
      headers.set("Cache-Control", "no-store");
    } else if (url.pathname.endsWith(".js") || url.pathname.endsWith(".css")) {
      headers.set("Cache-Control", "no-cache, max-age=0, must-revalidate");
    } else {
      headers.set("Cache-Control", "public, max-age=86400");
    }
    return new Response(asset.body, {
      status: asset.status,
      statusText: asset.statusText,
      headers
    });
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await checkBudgetAndAlert(env);
  }
};
