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

type PremiumResult = {
  score: number;
  matched: string[];
  missing: string[];
  suggestions: string[];
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
    "default-src 'self'; script-src 'self' https://challenges.cloudflare.com 'unsafe-eval'; " +
    "style-src 'self'; img-src 'self' data:; connect-src 'self' https://challenges.cloudflare.com; " +
    "base-uri 'self'; form-action 'self'; frame-src https://challenges.cloudflare.com; " +
    "worker-src https://challenges.cloudflare.com blob:; frame-ancestors 'none'"
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
// limite já foi atingido. (KV é eventualmente consistente: em rajadas extremas o
// contador pode subestimar levemente — para contagem exata seria Durable Objects.)
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
// Etapas: view → analyze → lead → checkout → paid. Contadores por dia
// (TTL 31d) e totais (sem TTL). Expostos em GET /api/stats.
const FUNNEL_STAGES = ["view", "analyze", "lead", "checkout", "paid"] as const;
type FunnelStage = (typeof FUNNEL_STAGES)[number];

async function bump(env: Env, stage: FunnelStage) {
  const day = new Date().toISOString().slice(0, 10);
  const dayKey = `ev:${stage}:${day}`;
  const totalKey = `evt:${stage}`;
  const [dayCount, totalCount] = await Promise.all([kvCount(env, dayKey), kvCount(env, totalKey)]);
  await env.RESULTS.put(dayKey, String(dayCount + 1), { expirationTtl: 86400 * 31 });
  await env.RESULTS.put(totalKey, String(totalCount + 1));
}

async function callOpenAI(env: Env, cv: string, job: string): Promise<PremiumResult> {
  const input = `
Compare rigorosamente o currículo com a vaga.

REGRAS:
- Não invente experiência.
- Não invente tecnologias.
- Não invente resultados.
- O currículo otimizado pode reorganizar e melhorar a redação, mas apenas com fatos existentes.
- Produza sugestões concretas.
- As perguntas de entrevista devem ser plausíveis para esta vaga.
- SEJA CONCISO: optimized_cv com no máximo 2500 caracteres, suggestions com no
  máximo 6 itens, interview_questions com no máximo 6 itens.

FORMATO DE RESPOSTA:
Responda com um objeto JSON com EXATAMENTE estas chaves (sem chaves extras, sem comentários):
{
  "score": <inteiro 0-100>,
  "matched": [<string>, ...],
  "missing": [<string>, ...],
  "suggestions": [<string>, ...],
  "optimized_cv": <string>,
  "recruiter_message": <string>,
  "interview_questions": [<string>, ...]
}

CURRÍCULO:
${cv}

VAGA:
${job}
`;

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json"
    },
    // Workers mata requisições com mais de ~30s; aborta antes com erro limpo.
    signal: AbortSignal.timeout(28000),
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "deepseek-v4-flash",
      messages: [
        {
          role: "system",
          content:
            "Você é um analista de currículos experiente. Responda APENAS com JSON válido, sem markdown, sem comentários."
        },
        { role: "user", content: input }
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
      // deepseek-v4-flash é um modelo de raciocínio: sem controles, ele "pensa"
      // por muito tempo e pode estourar o limite do Worker. Desligar o raciocínio
      // + cap de saída deixou os testes em ~11s com JSON completo.
      thinking: { type: "disabled" },
      max_tokens: 4000
    })
  });

  if (!response.ok) {
    const err = await response.text();
    console.error("DeepSeek error", response.status, err);
    throw new Error("OPENAI_FAILED");
  }

  const data: any = await response.json();

  let outputText = data?.choices?.[0]?.message?.content ?? "";
  outputText = outputText.trim();
  // Tolera fences markdown que o modelo eventualmente adicione.
  if (outputText.startsWith("```")) {
    outputText = outputText.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  }

  if (!outputText) throw new Error("OPENAI_EMPTY");

  // Normaliza a resposta: o JSON mode da DeepSeek não garante o schema,
  // então qualquer campo ausente/errado vira um default seguro.
  const parsed = JSON.parse(outputText) as Partial<PremiumResult>;
  return {
    score: typeof parsed.score === "number" ? parsed.score : 50,
    matched: Array.isArray(parsed.matched) ? parsed.matched : [],
    missing: Array.isArray(parsed.missing) ? parsed.missing : [],
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
    optimized_cv: typeof parsed.optimized_cv === "string" ? parsed.optimized_cv : "",
    recruiter_message: typeof parsed.recruiter_message === "string" ? parsed.recruiter_message : "",
    interview_questions: Array.isArray(parsed.interview_questions) ? parsed.interview_questions : []
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

async function handleCheckout(request: Request, env: Env) {
  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: "Pagamento via Stripe não configurado." }, 503);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON inválido." }, 400);
  }

  const token = String(body?.token || "");
  if (!/^[0-9a-f]{48}$/.test(token)) {
    return json({ error: "Token inválido." }, 400);
  }

  const raw = await env.RESULTS.get(`result:${token}`);
  if (!raw) {
    return json({ error: "Resultado expirado. Gere uma nova análise." }, 404);
  }

  const origin = request.headers.get("origin") || `http://${request.headers.get("host") || "localhost"}`;
  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("success_url", `${origin}/?checkout=success`);
  form.set("cancel_url", `${origin}/?checkout=cancel`);
  form.set("metadata[token]", token);
  form.set("line_items[0][quantity]", "1");
  form.set("line_items[0][price_data][currency]", "brl");
  form.set("line_items[0][price_data][unit_amount]", String(brlToCents(env.PRICE_BRL)));
  form.set("line_items[0][price_data][product_data][name]", "MatchVaga — Candidatura otimizada");

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
    return json({ error: "Falha ao criar pagamento." }, 502);
  }
  await bump(env, "checkout"); // etapa 3 do funil: checkout iniciado
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
      await env.RESULTS.put(`paid:${token}`, "1", { expirationTtl: 7200 });
      console.log(`[stripe] pagamento confirmado para token ${token.slice(0, 8)}…`);
      await bump(env, "paid"); // etapa 4 do funil: pagamento confirmado
    }
  }
  return json({ received: true });
}

// ── Alerta de orçamento (cron + tempo real) ──────────────────────
// Dispara no máximo UMA vez por dia por nível (80% e 100%), para não spammar.
// Chamado pelo cron (a cada 6h) e pela própria requisição que cruza o limite.
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
    return json({ error: "OPENAI_API_KEY não configurada no Worker." }, 500);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON inválido." }, 400);
  }

  const cv = String(body?.cv || "").trim();
  const job = String(body?.job || "").trim();

  if (cv.length < 80 || job.length < 80) {
    return json({ error: "Cole um currículo e uma descrição de vaga completos." }, 400);
  }

  // Limite simples para evitar abuso acidental e prompts gigantes.
  if (cv.length > 18000 || job.length > 12000) {
    return json({ error: "Texto muito grande para esta versão do MVP." }, 413);
  }

  // Anti-bot: exige Turnstile válido QUANDO o token vem preenchido.
  // Degradação graciosa: se o captcha não carregou no navegador do usuário
  // (extensão/antivírus interceptando challenges.cloudflare.com), o token vem
  // vazio e a análise é liberada mesmo assim — os rate limits por IP + teto
  // diário seguram o custo. (Revisitar se houver abuso em escala.)
  const turnstileToken = String(body?.turnstile || "");
  if (turnstileToken && !(await verifyTurnstile(env, turnstileToken, clientIp(request)))) {
    return json({ error: "Verificação anti-bot falhou. Recarregue e tente novamente." }, 400);
  }

  await bump(env, "analyze"); // etapa 2 do funil: análise válida iniciada

  try {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const hour = now.toISOString().slice(0, 13);

    // 1) Teto global diário: limita o CUSTO TOTAL mesmo sob ataque em massa.
    //    Alerta em tempo real quando a requisição cruza 80%/100% do teto.
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
      await env.RESULTS.put(`cache:${hash}`, JSON.stringify(premium), { expirationTtl: 7200 });
    }

    const token = randomToken();

    // Premium fica server-side no KV por 2h.
    await env.RESULTS.put(
      `result:${token}`,
      JSON.stringify(premium),
      { expirationTtl: 7200 }
    );

    return json({
      token,
      preview: {
        score: premium.score,
        matched: premium.matched.slice(0, 4),
        gap_count: premium.missing.length
      },
      price: env.PRICE_BRL || "9,90",
      pix_key: env.PIX_KEY || ""
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
      return json({ error: "A análise demorou demais (limite de 28s). Tente novamente." }, 504);
    }
    return json({ error: "A análise por IA falhou. Tente novamente." }, 503);
  }
}

// ── Captura de lead (email) ─────────────────────────────────────
// Guarda o email de quem analisou mas não pagou, para follow-up do dono.
// Os emails ficam SÓ no KV (chave `lead:<email>`, valor = metadados) e nunca
// são expostos por nenhum endpoint — o dono os lê via `wrangler kv key list`.
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

async function handleLead(request: Request, env: Env) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON inválido." }, 400);
  }

  const email = String(body?.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return json({ error: "Email inválido." }, 400);
  }

  // Rate limit por IP/hora: evita coleta de emails em massa.
  const hour = new Date().toISOString().slice(0, 13);
  if ((await checkAndIncrement(env, `rl-lead:${clientIp(request)}:${hour}`, 5, 3700)) === null) {
    return json({ error: "Muitas tentativas. Aguarde um pouco." }, 429);
  }

  // Dedupe: mesmo email não é gravado duas vezes.
  const key = `lead:${email}`;
  if (await env.RESULTS.get(key)) {
    return json({ ok: true, already: true });
  }

  // Associa (melhor esforço) token/score/gap_count para segmentação futura.
  const token = String(body?.token || "");
  const meta: Record<string, unknown> = { created_at: new Date().toISOString() };
  if (/^[0-9a-f]{48}$/.test(token)) {
    try {
      const raw = await env.RESULTS.get(`result:${token}`);
      if (raw) {
        const premium = JSON.parse(raw) as PremiumResult;
        meta.token = token;
        meta.score = premium.score;
        meta.gap_count = premium.missing.length;
      }
    } catch {
      // melhor esforço
    }
  }

  await env.RESULTS.put(key, JSON.stringify(meta));
  await bump(env, "lead"); // etapa do funil: email capturado
  return json({ ok: true });
}

async function handleUnlock(request: Request, env: Env) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON inválido." }, 400);
  }

  const token = String(body?.token || "");
  const code = String(body?.code || "").trim();

  if (!token) {
    return json({ error: "Token é obrigatório." }, 400);
  }

  // Rate limit só para tentativas COM código (vetor de brute-force).
  // Polls pós-pagamento enviam código vazio e não devem ser limitadas.
  if (code) {
    const now = new Date();
    const hour = now.toISOString().slice(0, 13);
    if ((await checkAndIncrement(env, `rl-unlock:${clientIp(request)}:${hour}`, 10, 3700)) === null) {
      return json({ error: "Muitas tentativas de desbloqueio. Aguarde um pouco." }, 429);
    }
  }

  if (!/^[0-9a-f]{48}$/.test(token)) {
    return json({ error: "Token inválido." }, 400);
  }

  // Libera com código manual OU com pagamento Stripe confirmado (código vazio).
  const paid = await env.RESULTS.get(`paid:${token}`);
  if (code !== env.UNLOCK_CODE && paid !== "1") {
    return json({ error: "Código de liberação inválido." }, 403);
  }

  const raw = await env.RESULTS.get(`result:${token}`);
  if (!raw) {
    return json({ error: "Resultado expirado. Gere uma nova análise." }, 404);
  }

  return json({ ok: true, premium: JSON.parse(raw) });
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
  if (total.view > 0) conv.analyze = `${Math.round((total.analyze / total.view) * 100)}%`;
  if (total.analyze > 0) conv.lead = `${Math.round((total.lead / total.analyze) * 100)}%`;
  if (total.lead > 0) conv.checkout = `${Math.round((total.checkout / total.lead) * 100)}%`;
  if (total.checkout > 0) conv.paid = `${Math.round((total.paid / total.checkout) * 100)}%`;
  return json({ day, today, total, conv });
}

async function handleConfig(env: Env) {
  return json({
    turnstile_sitekey: env.TURNSTILE_SITEKEY || "",
    price: env.PRICE_BRL || "9,90",
    pix_key: env.PIX_KEY || ""
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // HTTPS obrigatório: redireciona http → https (algumas zonas Cloudflare
    // não têm "Always Use HTTPS" ativo; o worker garante em qualquer domínio).
    if (url.protocol === "http:") {
      return Response.redirect(`https://${url.host}${url.pathname}${url.search}`, 301);
    }

    if (request.method === "POST" && url.pathname === "/api/preview") {
      return handlePreview(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/lead") {
      return handleLead(request, env);
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
      await bump(env, "view"); // etapa 1 do funil: página carregada
    }

    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    for (const [name, value] of Object.entries(securityHeaders)) {
      if (!headers.has(name)) headers.set(name, value);
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
