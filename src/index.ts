interface Env {
  ASSETS: Fetcher;
  RESULTS: KVNamespace;
  OPENAI_API_KEY: string;
  OPENAI_MODEL?: string;
  PRICE_BRL?: string;
  PRICE_USD?: string;
  PIX_KEY?: string;
  STATS_KEY?: string; // proteção do dashboard /api/stats (opcional)
  UNLOCK_CODE: string;
  RATE_LIMIT_PER_HOUR: string;
  DAILY_PREVIEW_BUDGET: string;
  TURNSTILE_SITEKEY: string;
  TURNSTILE_SECRET: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  ALERT_WEBHOOK_URL: string;
  RELIABLE_SINCE?: string; // instrumentação v2 — métricas confiáveis a partir de
}

type Strength = { requirement: string; explanation: string };
type Attention = {
  requirement: string;
  what_we_found: string;   // o que a vaga pede
  in_your_cv: string;      // o que encontramos (ou não) no currículo
  interpretation: string;  // não significa que não possui
  why: string;             // por que merece atenção
  what_to_do: string;      // recomendação condicional / ação honesta
};
type Rewrite = { original: string; suggestion: string; why: string };

type PremiumResult = {
  score: number;
  score_explanation: string;
  requirements: { category: string; items: string[] }[];
  table: { requirement: string; situation: string; evidence: string }[];
  strengths: Strength[];
  attention: Attention[];
  rewrites: Rewrite[];
  recommendations: string[];
  keywords: string[];
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

async function contentHash(cv: string, job: string, lang = "pt", market: Market = "br"): Promise<string> {
  // lang + market NO hash (correção de bug verificado em produção): sem eles, uma
  // análise EN cacheada vazava para quem pedia ES — e agora misturaria BR/US.
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(cv + "\u0000" + job + "\u0000" + lang + "\u0000" + market)
  );
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, "0")).join("");
}

// ── Funil de conversão (agregado, sem dados pessoais) ────────────
// Etapas medidas. Contadores por dia (TTL 31d) e totais (sem TTL).
// Semântica v2 (12/08): o funil usa ENTIDADES ÚNICAS (sessões de navegador,
// guard `seen:<stage>:<sid>`), não contagem bruta de eventos. Eventos brutos
// continuam em ev:/evt: (pageviews/KPI), o funil lê evu:/evut:.
// `checkout_session_created` = SÓ depois que a API da Stripe retorna uma
// Checkout Session válida (substitui o antigo `checkout_started`, que era
// semântica correta mas nome errado — e tinha um artefato de teste contando).
// `checkout_error` = falha na criação da sessão (sem dados sensíveis).
const FUNNEL_STAGES = [
  "session_view",
  "landing_view",
  "resume_uploaded",
  "job_description_added",
  "analysis_started",
  "analysis_completed",
  "result_viewed",
  "free_insight_viewed",
  "locked_insights_viewed",
  "unlock_clicked",
  "checkout_started",
  "checkout_session_created",
  "checkout_error",
  "payment_completed",
  "full_report_viewed"
] as const;
type FunnelStage = (typeof FUNNEL_STAGES)[number];

// Contador de SESSÕES ÚNICAS por etapa: cada session_id conta no máximo UMA
// VEZ por etapa (refreshes/retries não inflam — o guard `seen:` segura).
// Refresh não transforma uma pessoa em cinco conversões.
async function bumpUnique(env: Env, stage: FunnelStage, market: Market, sid: string) {
  if (!sid || sid.length < 8 || sid.length > 80) return;
  const seenKey = `seen:${stage}:${sid}`;
  if (await env.RESULTS.get(seenKey)) return;
  await env.RESULTS.put(seenKey, "1", { expirationTtl: 31 * 86400 });
  const day = new Date().toISOString().slice(0, 10);
  const [d, t] = await Promise.all([
    kvCount(env, `evu:${market}:${stage}:${day}`),
    kvCount(env, `evut:${market}:${stage}`)
  ]);
  await env.RESULTS.put(`evu:${market}:${stage}:${day}`, String(d + 1), { expirationTtl: 86400 * 31 });
  await env.RESULTS.put(`evut:${market}:${stage}`, String(t + 1));
}

// ── Bots/crawlers/link previews ──────────────────────────────────
// landing_view NÃO deve contar tráfego claramente automatizado (crawlers,
// link previews de WhatsApp/Telegram/Facebook, health checks, scanners).
// Heurística simples de User-Agent — sem sistema complexo de antifraude.
const BOT_UA = /bot|crawl|spider|slurp|facebookexternalhit|twitterbot|whatsapp|telegram|discordbot|linkedinbot|slackbot|preview|headless|curl|wget|python-requests|go-http-client|java\/|libwww|scrapy|ahrefs|semrush|mj12|petalbot|bingbot|duckduckbot|yandex|baiduspider|applebot|googlebot|google-inspectiontool|pingdom|uptimerobot|monitor|check-host|360spider|sogou|exabot|archive\.org/i;
function isBotRequest(request: Request): boolean {
  const ua = request.headers.get("user-agent") || "";
  return BOT_UA.test(ua);
}

// Tráfego de teste (diagnóstico interno) NÃO contamina o dashboard comercial:
// o cliente marca a sessão com `?mv_test=1` → sessionStorage `mv-test` → todo
// evento/checkout carrega `test:true`. O servidor grava `tst:<token>` no
// checkout e pula os contadores comerciais (bump/bumpUnique). Pagamentos de
// teste também não contam (webhook checa tst:<token>). Não depende de IP.
function isTestRequest(body: any): boolean {
  return body?.test === true || body?.test === "1" || body?.test === 1;
}

// ── Mercado (experimento BR vs US) ───────────────────────────────
// Dimensão de mercado em TODOS os contadores: `ev:<mkt>:<etapa>:<dia>`.
// Chaves legadas SEM prefixo de mercado (pré-12/08) contam como BR na leitura.
const MARKETS = ["br", "us"] as const;
type Market = (typeof MARKETS)[number];

function normMarket(raw: unknown): Market {
  return String(raw || "").toLowerCase().slice(0, 2) === "us" ? "us" : "br";
}

function marketPrice(env: Env, market: Market): string {
  return market === "us" ? env.PRICE_USD || "2.99" : env.PRICE_BRL || "9,90";
}

function marketCurrency(market: Market): string {
  return market === "us" ? "usd" : "brl";
}

function marketProductName(market: Market): string {
  return market === "us"
    ? "MatchVaga — Kit for this application"
    : "MatchVaga — Kit para esta candidatura";
}

async function bump(env: Env, stage: FunnelStage, market: Market = "br") {
  const day = new Date().toISOString().slice(0, 10);
  const dayKey = `ev:${market}:${stage}:${day}`;
  const totalKey = `evt:${market}:${stage}`;
  const [dayCount, totalCount] = await Promise.all([kvCount(env, dayKey), kvCount(env, totalKey)]);
  await env.RESULTS.put(dayKey, String(dayCount + 1), { expirationTtl: 86400 * 31 });
  await env.RESULTS.put(totalKey, String(totalCount + 1));
}

// Atribuição de tráfego (UTM) no SERVIDOR, a partir da URL do GET / — o único
// lugar onde o utm_source da campanha chega (o cliente não envia landing_view
// pelo /api/event; o código antigo fazia o ev:utm: só lá → fontes zeradas).
async function bumpLandingUtm(env: Env, url: URL, market: Market) {
  const utmSource = String(url.searchParams.get("utm_source") || url.searchParams.get("utm_medium") || "")
    .replace(/[^\w.-]/g, "").slice(0, 40);
  if (!utmSource) return;
  const day = new Date().toISOString().slice(0, 10);
  const dayKey = `ev:utm:${market}:${utmSource}:${day}`;
  const totalKey = `ev:utm:${market}:${utmSource}:total`;
  const [d, t] = await Promise.all([kvCount(env, dayKey), kvCount(env, totalKey)]);
  await env.RESULTS.put(dayKey, String(d + 1), { expirationTtl: 31 * 86400 });
  await env.RESULTS.put(totalKey, String(t + 1));
}

// Tentativa ÚNICA com timeout generoso: duas tentativas de 14s ultrapassam o
// orçamento de execução do Worker (~30s) e o edge mata a requisição no meio do
// retry — o usuário recebe 504/HTML em vez de um JSON de erro. Uma tentativa
// de 25s cobre picos de latência da DeepSeek e, se estourar, o botão
// "Tentar novamente" inicia uma janela nova (e o rate limit é devolvido).
// Tolerante a JSON truncado: se a IA cortar a resposta no meio (limite de
// tokens), tenta várias reparações antes de desistir.
function parseLoose(text: string): any {
  const balance = (t: string) => {
    const openBraces = (t.match(/\{/g) || []).length;
    const closeBraces = (t.match(/\}/g) || []).length;
    const openBrackets = (t.match(/\[/g) || []).length;
    const closeBrackets = (t.match(/\]/g) || []).length;
    let out = t;
    if (closeBrackets < openBrackets) out += "]".repeat(openBrackets - closeBrackets);
    if (closeBraces < openBraces) out += "}".repeat(openBraces - closeBraces);
    return out;
  };
  try {
    return JSON.parse(text);
  } catch {
    // tenta reparar
  }
  const attempts: string[] = [];
  // 1) fecha chaves/colchetes pendentes
  attempts.push(balance(text));
  // 2) string cortada no meio: corta na última aspa e fecha a string
  const lastQuote = text.lastIndexOf('"');
  if (lastQuote > 10) {
    attempts.push(balance(text.slice(0, lastQuote + 1) + '"'));
    attempts.push(balance(text.slice(0, lastQuote)));
  }
  // 3) corta na última vírgula/dois-pontos (remove valor incompleto)
  const lastComma = Math.max(text.lastIndexOf(","), text.lastIndexOf(":"));
  if (lastComma > 10) attempts.push(balance(text.slice(0, lastComma)));
  for (const t of attempts) {
    try {
      return JSON.parse(t);
    } catch {
      // próxima estratégia
    }
  }
  throw new Error("JSON inválido da IA");
}

// Retry compacto: usado quando a 1ª resposta vem com JSON inválido/truncado.
// DIFERENTE do reparo tolerante, EXIGE todas as chaves (o reparo corta no fim
// e perde optimized_cv/mensagem/perguntas). Cabe no orçamento do Worker.
async function compactRetry(env: Env, input: string, lang = "pt"): Promise<Partial<PremiumResult>> {
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json"
    },
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "deepseek-v4-flash",
      messages: [
        {
          role: "system",
          content:
            `Você é um analista de currículos experiente e honesto. Responda APENAS com JSON válido, sem markdown, sem comentários. Escreva TODOS os textos da resposta no idioma: ${LANG_NAMES[lang] || "Português"}. Nunca invente informações sobre o candidato.`
        },
        {
          role: "user",
          content:
            input +
            "\n\nIMPORTANTE: sua resposta anterior foi inválida ou incompleta. Responda APENAS com JSON válido, COMPACTO e COMPLETO, mantendo TODAS as chaves do formato: score, score_explanation, requirements, table, strengths, attention, rewrites, recommendations, keywords, optimized_cv (máximo 500 caracteres), recruiter_message (máximo 200 caracteres), interview_questions (2-3 itens). Total máximo 1500 caracteres."
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
      thinking: { type: "disabled" },
      max_tokens: 1500
    })
  });
  if (!response.ok) throw new Error("OPENAI_FAILED");
  const data: any = await response.json();
  let text = String(data?.choices?.[0]?.message?.content ?? "").trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  }
  if (!text) throw new Error("OPENAI_EMPTY");
  return JSON.parse(text) as Partial<PremiumResult>;
}

// Análise completa exige os campos longos (cv otimizado, mensagem, perguntas)
// E o schema V3 (recommendations, keywords, interpretation nos gaps).
function isCompletePremium(p: PremiumResult): boolean {
  return !!p &&
    typeof p.optimized_cv === "string" && p.optimized_cv.length > 50 &&
    typeof p.recruiter_message === "string" && p.recruiter_message.length > 20 &&
    Array.isArray(p.interview_questions) && p.interview_questions.length >= 1 &&
    Array.isArray(p.recommendations) && Array.isArray(p.keywords) &&
    (!p.attention || !p.attention.length || typeof p.attention[0]?.interpretation === "string");
}

const LANG_NAMES: Record<string, string> = { pt: "Português", en: "English", es: "Español" };

// Mensagens de erro localizadas (mostradas ao usuário).
const SERVER_MSG: Record<string, Record<string, string>> = {
  session_expired: { pt: "Sessão expirada. Gere uma nova análise.", en: "Session expired. Generate a new analysis.", es: "Sesión expirada. Genera un nuevo análisis." },
  analysis_expired: { pt: "Sua análise expirou. Gere uma nova gratuitamente.", en: "Your analysis expired. Generate a new one for free.", es: "Tu análisis expiró. Genera uno nuevo gratis." },
  unreadable_cv: { pt: "Sua análise não pôde ser gerada corretamente (o currículo não foi lido). Refaça a análise gratuitamente.", en: "Your analysis could not be generated correctly (the résumé was not read). Run a new analysis for free.", es: "Tu análisis no pudo generarse correctamente (no se leyó el currículum). Haz un análisis nuevo gratis." },
  already_unlocked: { pt: "Esta análise já foi desbloqueada.", en: "This analysis has already been unlocked.", es: "Este análisis ya fue desbloqueado." },
  text_too_large: { pt: "Texto muito grande para esta versão. Envie um currículo mais resumido.", en: "Text too large for this version. Send a shorter résumé.", es: "Texto demasiado grande para esta versión. Envía un currículum más resumido." },
  rate_limited: { pt: "Muitas análises neste horário. Aguarde um pouco.", en: "Too many analyses in this hour. Please wait a bit.", es: "Demasiados análisis en esta hora. Espera un poco." },
  invalid_code: { pt: "Código de liberação inválido.", en: "Invalid unlock code.", es: "Código de desbloqueo inválido." },
  payment_failed: { pt: "Não foi possível concluir o pagamento. Nenhuma cobrança foi confirmada. Tente novamente.", en: "We could not complete the payment. No charge was confirmed. Please try again.", es: "No pudimos completar el pago. No se confirmó ningún cobro. Inténtalo de nuevo." }
};
const smsg = (lang: string, key: string): string => {
  const l = lang === "en" || lang === "es" ? lang : "pt";
  return (SERVER_MSG[key] && SERVER_MSG[key][l]) || SERVER_MSG[key].pt;
};

async function callOpenAI(env: Env, cv: string, job: string, lang = "pt", market: Market = "br"): Promise<PremiumResult> {
  // Limita o tamanho dos inputs: currículo/vaga gigantes não agregam à análise
  // e atrasam a geração — o principal motivo de timeout com pastes reais.
  const MAX_CV = 3000;
  const MAX_JOB = 2000;
  const cvTrim = cv.length > MAX_CV ? cv.slice(0, MAX_CV) + "\n[...]" : cv;
  const jobTrim = job.length > MAX_JOB ? job.slice(0, MAX_JOB) + "\n[...]" : job;

  const input = `
 Compare rigorosamente o currículo com a vaga.

IDIOMA DA RESPOSTA: escreva TODOS os textos da resposta (score_explanation, requirements, table, strengths, attention, rewrites, recommendations, keywords, optimized_cv, recruiter_message, interview_questions) no idioma: ${LANG_NAMES[lang] || "Português"}. Isso é obrigatório.
${market === "us"
    ? "\nTERMINOLOGIA (mercado americano): use inglês americano natural — 'resume' (NUNCA 'CV'), 'job description', 'job requirements', 'hiring manager', 'Applicant Tracking System (ATS)', 'apply'. Os textos devem soar como escritos por um candidato nativo dos EUA.\n"
    : ""}
REGRAS DE INTEGRIDADE (obrigatórias):
- NUNCA invente experiência, empresa, cargo, tecnologia, certificação ou resultado.
- "Não encontrado no currículo" NÃO significa "o candidato não possui": quando um requisito da vaga não aparecer no currículo, diga que NÃO FOI ENCONTRADO no currículo, nunca que o candidato não tem a experiência.
- Não transforme conhecimento teórico em experiência profissional.
- Não ensine o candidato a mentir.
- O currículo otimizado pode reorganizar, resumir, melhorar clareza, destacar e usar a terminologia da vaga QUANDO VERDADEIRA — mas APENAS com fatos existentes no currículo.

REESCRITA SEGURA (regra absoluta):
- rewrites são reformulações que PODEM ser copiadas. Devem conter SOMENTE fatos suportados pelo currículo.
- NUNCA adicione TDD, BDD, code reviews, mentoria, pair programming, CI/CD ou QUALQUER prática/tecnologia que não esteja comprovada no currículo.
- Se o currículo não menciona testes, não escreva "promoveu boas práticas de testes". Se não menciona code reviews, não escreva "conduziu code reviews".
- "Adicionar 'se verdadeiro' depois de uma frase inventada" TAMBÉM é proibido — isso continua sendo invenção.

RECOMENDAÇÕES CONDICIONAIS (oportunidades):
- recommendations são frases condicionais para gaps: "Se você realmente possui experiência com X, considere evidenciá-la no currículo com exemplos concretos."
- NUNCA coloque essas experiências dentro de rewrites ou do optimized_cv.

FORMATO DE RESPOSTA (JSON válido, sem markdown, EXATAMENTE estas chaves):
{
  "score": <inteiro 0-100 — grau de alinhamento; NÃO é chance de contratação>,
  "score_explanation": "<1-2 frases>",
  "requirements": [{"category":"<ex.: Backend>","items":["<requisitos da vaga>"]}],
  "table": [{"requirement":"<requisito>","situation":"Forte|Compatível|Melhorar|Gap","evidence":"Encontrado claramente|Encontrado|Pouco evidenciado|Não encontrado"}],
  "strengths": [{"requirement":"<requisito>","explanation":"<frase curta>"}],
  "attention": [{"requirement":"<requisito que merece atenção>","what_we_found":"<o que a vaga pede>","in_your_cv":"<o que encontramos (ou não) no currículo>","interpretation":"<isso NÃO significa que o candidato não possui; significa que não está evidente>","why":"<por que merece atenção>","what_to_do":"<recomendação condicional honesta>"}],
  "rewrites": [{"original":"<trecho REAL do currículo>","suggestion":"<reformulação segura, SEM adicionar fatos>","why":"<explicação curta>"}],
  "recommendations": ["<frase condicional para cada gap: Se você realmente possui experiência com X, considere evidenciá-la...>"],
  "keywords": ["<palavras-chave JUSTIFICADAS pela experiência real>"],
  "optimized_cv": "<currículo adaptado à vaga, SOMENTE com fatos existentes>",
  "recruiter_message": "<mensagem curta e honesta, somente fatos do currículo>",
  "interview_questions": ["<perguntas prováveis; é permitido perguntar sobre gaps, ex.: 'Como você utiliza TDD/BDD?'>"]
}

REGRAS ADICIONAIS:
- requirements: agrupe os requisitos da vaga em 2-4 categorias.
- table: cubra os requisitos principais (5-6 linhas).
- strengths: no máximo 3 itens, com frase curta.
- attention: no máximo 5 itens, ORDENADOS por relevância (o 1º será mostrado gratuitamente em detalhe).
- rewrites: no máximo 2 trechos reais, com sugestão SEGURA (sem fatos novos).
- recommendations: 2-3 frases condicionais (uma por gap principal).
- keywords: no máximo 8.
- optimized_cv: máximo 1200 caracteres.
- interview_questions: no máximo 4.
CRÍTICO: a resposta JSON inteira deve ter no máximo 2200 caracteres. Se o
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
            `Você é um analista de currículos experiente e honesto. Responda APENAS com JSON válido, sem markdown, sem comentários. Escreva TODOS os textos da resposta no idioma: ${LANG_NAMES[lang] || "Português"}. Nunca invente informações sobre o candidato.`
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
  let parsed: Partial<PremiumResult>;
  try {
    // 1) JSON íntegro → usa direto
    parsed = JSON.parse(outputText) as Partial<PremiumResult>;
  } catch {
    // 2) Malformado/truncado: tenta retry compacto PRIMEIRO (o reparo de JSON
    // corta no fim e perde campos longos — não pode ser aceito como completo).
    let retried = false;
    try {
      parsed = await compactRetry(env, input, lang);
      retried = true;
    } catch {
      // 3) Último recurso: reparo tolerante do texto truncado.
      parsed = parseLoose(outputText) as Partial<PremiumResult>;
    }
    if (retried) console.error("Usando retry compacto após JSON inválido na 1ª tentativa");
  }
  const premium = normalizePremium(parsed);
  applyAntiInvention(premium, cvTrim);

  // Completude: se a DeepSeek fechar o JSON no max_tokens (JSON válido mas sem
  // os campos longos), roda o retry compacto que EXIGE todas as chaves.
  if (!isCompletePremium(premium)) {
    console.error("Análise incompleta na 1ª tentativa — retentando compacto");
    try {
      const retryPremium = normalizePremium(await compactRetry(env, input, lang));
      applyAntiInvention(retryPremium, cvTrim);
      if (isCompletePremium(retryPremium)) return retryPremium;
    } catch {
      // aceita a melhor versão disponível
    }
  }
  return premium;
}

// ── Validação anti-alucinação (2ª camada, não depende só do prompt) ──
// Remove de reescritas/currículo/mensagem qualquer frase que AFIRME experiência
// em requisito-gap que não aparece no currículo. Frases removidas viram
// recomendações condicionais (que já existem no campo recommendations).
function applyAntiInvention(p: PremiumResult, cv: string): void {
  const cvLower = cv.toLowerCase();
  const banned = (p.table || [])
    .filter(t => /melhorar|gap/i.test(t.situation))
    .map(t => t.requirement)
    .filter((b: string) => b && b.length > 3 && !cvLower.includes(b.toLowerCase()));
  if (!banned.length) return;

  const sanitize = (text: string): string => {
    if (!text) return text;
    const sentences = text.split(/(?<=[.!?])\s+/);
    const kept = sentences.filter(s => {
      const lower = s.toLowerCase();
      return !banned.some(b => lower.includes(b.toLowerCase()));
    });
    return kept.join(" ").trim();
  };

  p.rewrites = (p.rewrites || []).map(r => ({
    ...r,
    suggestion: sanitize(r.suggestion) || r.original
  }));
  p.optimized_cv = sanitize(p.optimized_cv);
  p.recruiter_message = sanitize(p.recruiter_message);
}

// Normaliza o JSON da IA (o json_object da DeepSeek não garante o schema).
function normalizePremium(parsed: Partial<PremiumResult>): PremiumResult {
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
    attention: arr(parsed.attention).map(obj).filter(Boolean).slice(0, 5).map(a => ({
      requirement: str(a!.requirement, "Requisito"),
      what_we_found: str(a!.what_we_found, "A vaga menciona este requisito."),
      in_your_cv: str(a!.in_your_cv, "Não encontramos claramente no currículo."),
      interpretation: str(a!.interpretation, "Isso não significa que você não possui a experiência — significa apenas que ela não está evidente no currículo enviado."),
      why: str(a!.why, "A vaga dá importância a este requisito."),
      what_to_do: str(a!.what_to_do, "Se você realmente possui esta experiência, considere evidenciá-la melhor no currículo.")
    })),
    rewrites: arr(parsed.rewrites).map(obj).filter(Boolean).slice(0, 2).map(r => ({
      original: str(r!.original, ""),
      suggestion: str(r!.suggestion, ""),
      why: str(r!.why, "")
    })),
    recommendations: arr(parsed.recommendations).filter(r => typeof r === "string").slice(0, 4) as string[],
    keywords: arr(parsed.keywords).filter(k => typeof k === "string").slice(0, 8) as string[],
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
// Converte preço decimal → centavos. Aceita os DOIS formatos:
// BR "9,90" (vírgula decimal, ponto = milhar) e US "2.99" (ponto decimal).
// Atenção (bug verificado em teste 12/08): remover TODOS os pontos quebrava
// "2.99" → 29900 ($299,00). Só mexe no separador quando há vírgula.
function priceToCents(price: string): number {
  let s = String(price).trim();
  if (s.includes(",")) {
    // formato BR: "9,90" ou "1.234,56"
    s = s.replace(/\./g, "").replace(",", ".");
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
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

  const lang = String(body?.lang || "pt").slice(0, 2);
  const token = String(body?.token || "");
  const sid = String(body?.sid || "").slice(0, 80);
  const isTest = isTestRequest(body);
  // Token todo-zero (artefato de teste 11/08: 48 zeros passavam o regex e
  // criavam sessão real na Stripe) — rejeita antes de qualquer efeito.
  if (!/^[0-9a-f]{48}$/.test(token) || /^0+$/.test(token)) {
    return json({ error: smsg(lang, "session_expired") }, 400);
  }
  // Mercado do token vem do servidor (fixado na criação da análise). O market
  // do body é só fallback p/ tokens legados (criados antes do mkt:<token>).
  const storedMarket = await env.RESULTS.get(`mkt:${token}`);
  const market = normMarket(storedMarket || body?.market);
  const raw = await env.RESULTS.get(`result:${token}`);
  if (!raw) {
    return json({ error: smsg(lang, "analysis_expired") }, 404);
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
    return json({ error: smsg(lang, "unreadable_cv") }, 422);
  }

  // Evita pagamento duplicado: se já desbloqueou, não deixa pagar de novo.
  if ((await env.RESULTS.get(`paid:${token}`)) === "1") {
    return json({ error: smsg(lang, "already_unlocked") }, 409);
  }

  // Renova o prazo da análise (24h a partir do início do pagamento), para o
  // usuário não perder o conteúdo depois de pagar.
  await env.RESULTS.put(`result:${token}`, raw, { expirationTtl: RESULT_TTL });

  // Checkout idempotente: duplo clique/refresh reusa a MESMA sessão Stripe e
  // não infla checkout_session_created (um checkout por análise).
  const existing = await env.RESULTS.get(`ck:${token}`);
  if (existing) {
    return json({ url: existing });
  }

  const origin = request.headers.get("origin") || `https://${request.headers.get("host") || "matchvaga.kubezen.com"}`;
  // Retorno do Stripe vai para o MESMO mercado (US volta para /us — se voltasse
  // para /, o usuário caía na página PT e a atribuição do relatório vazava).
  const returnPath = market === "us" ? "/us" : "/";
  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("success_url", `${origin}${returnPath}?checkout=success`);
  form.set("cancel_url", `${origin}${returnPath}?checkout=cancel`);
  form.set("metadata[token]", token);
  form.set("metadata[market]", market);
  if (isTest) form.set("metadata[test]", "1");
  form.set("line_items[0][quantity]", "1");
  form.set("line_items[0][price_data][currency]", marketCurrency(market));
  form.set("line_items[0][price_data][unit_amount]", String(priceToCents(marketPrice(env, market))));
  form.set("line_items[0][price_data][product_data][name]", marketProductName(market));

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: form.toString()
  });

  const data: any = await res.json();
  if (!res.ok || !data?.url || !data?.id) {
    // checkout_error: falha na CRIAÇÃO da sessão (sem dados sensíveis).
    // Categorias técnicas: stripe_<http>, timeout, invalid_config, internal.
    let errType = "stripe_" + res.status;
    if (res.status >= 500) errType = "stripe_server_" + res.status;
    else if (res.status === 400 || res.status === 404) errType = "stripe_invalid_" + (data?.error?.code || res.status);
    console.error("Stripe error", res.status, JSON.stringify(data));
    if (!isTest) {
      await bump(env, "checkout_error", market);
      await bumpUnique(env, "checkout_error", market, sid || token);
      await env.RESULTS.put(`ce:${token}`, errType, { expirationTtl: RESULT_TTL });
    }
    return json({ error: smsg(lang, "payment_failed") }, 502);
  }
  await env.RESULTS.put(`ck:${token}`, data.url, { expirationTtl: RESULT_TTL });
  // Guarda o ID da sessão Stripe (auditoria + diagnóstico: o dashboard mostra
  // "Checkout criado" como uma sessão REAL na Stripe, não um clique).
  await env.RESULTS.put(`cs:${token}`, String(data.id), { expirationTtl: RESULT_TTL });
  if (isTest) {
    await env.RESULTS.put(`tst:${token}`, "1", { expirationTtl: RESULT_TTL });
  }
  if (!isTest) {
    // checkout_session_created = sessão REAL devolvida pela API da Stripe.
    // Conta UMA vez por sessão de navegador (bumpUnique) + total bruto.
    await bump(env, "checkout_session_created", market);
    await bumpUnique(env, "checkout_session_created", market, sid || token);
  }
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
    const session = payload?.data?.object || {};
    const token = String(session?.metadata?.token || "");
    // Mercado vem do metadata da sessão Stripe (fonte confiável — o cliente
    // não decide a atribuição da venda depois do pagamento).
    const market = normMarket(session?.metadata?.market);
    // Pagamento de teste (diagnóstico interno) NÃO conta como venda real.
    const isTest = session?.metadata?.test === "1";
    if (/^[0-9a-f]{48}$/.test(token) && !/^0+$/.test(token) && !isTest) {
      // Idempotência dupla:
      // 1) paid:<token> — o desbloqueio da análise (o que o usuário consome);
      // 2) pi:<payment_intent> — rejeita contabilização duplicada mesmo se o
      //    Stripe reentregar o MESMO evento 5x (uma venda = EXATAMENTE uma).
      //    Payment Intent é o identificador único do pagamento; session.id
      //    também serve (checkout sem PI, ex. PIX ainda pendente).
      const piId = String(session?.payment_intent || session?.id || "");
      const piKey = `pi:${piId}`;
      if (await env.RESULTS.get(piKey)) {
        // Já contabilizado — reentrega do webhook.
        return json({ received: true });
      }
      const already = await env.RESULTS.get(`paid:${token}`);
      if (already !== "1") {
        await env.RESULTS.put(`paid:${token}`, "1", { expirationTtl: RESULT_TTL });
        // Registro da venda (sem dados sensíveis): payment_id, amount,
        // currency, market, analysis_id — a receita NUNCA é count × preço
        // (preços/moedas podem variar BR×US e no futuro), é a soma dos
        // pagamentos reais confirmados.
        const amountTotal = Number(session?.amount_total) || 0;
        const currency = String(session?.currency || "").toLowerCase();
        await env.RESULTS.put(
          `pay:${token}`,
          JSON.stringify({
            payment_id: piId,
            amount: amountTotal,
            currency,
            market,
            analysis_id: token,
            ts: Date.now()
          }),
          { expirationTtl: 90 * 86400 }
        );
        // Guarda o PI idempotente DEPOIS de gravar (a venda conta 1x).
        await env.RESULTS.put(piKey, token, { expirationTtl: 90 * 86400 });
        const utmSrc = await env.RESULTS.get(`utm:${token}`);
        if (utmSrc) {
          const uday = new Date().toISOString().slice(0, 10);
          await env.RESULTS.put(`ev:utm-paid:${market}:${utmSrc}:${uday}`, String((await kvCount(env, `ev:utm-paid:${market}:${utmSrc}:${uday}`)) + 1), { expirationTtl: 31 * 86400 });
          await env.RESULTS.put(`ev:utm-paid:${market}:${utmSrc}:total`, String((await kvCount(env, `ev:utm-paid:${market}:${utmSrc}:total`)) + 1));
        }
        console.log(`[stripe] pagamento confirmado para token ${token.slice(0, 8)}… (${market}, ${currency} ${amountTotal})`);
        await bump(env, "payment_completed", market);
        // payment_completed no funil de sessões únicas: recupera o sid da
        // análise (guardado no /api/preview) e conta 1x por sessão.
        const analysisSid = await env.RESULTS.get(`sid:${token}`);
        await bumpUnique(env, "payment_completed", market, analysisSid || token);
      } else {
        // Já desbloqueado (paid: presente) mas PI novo: ainda grava o PI
        // idempotente para o caso de um webhook duplicado chegar depois.
        await env.RESULTS.put(piKey, token, { expirationTtl: 90 * 86400 });
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

  const lang = String(body?.lang || "pt").slice(0, 2);
  const market = normMarket(body?.market);
  // "us" nunca chega como lang (o cliente envia "en"); defesa extra:
  const langClean = lang === "us" ? "en" : lang;
  const sid = String(body?.sid || "").slice(0, 80);
  const isTest = isTestRequest(body);
  const utmSource = String(body?.utm?.source || "").replace(/[^\w.-]/g, "").slice(0, 40);
  const cv = String(body?.cv || "").trim();
  const job = String(body?.job || "").trim();

  if (cv.length < 40) {
    return json({ error: "Não conseguimos ler o texto do currículo. Se o PDF for escaneado, cole o texto manualmente." }, 400);
  }
  if (job.length < 30) {
    return json({ error: "Cole a descrição da vaga completa." }, 400);
  }
  if (cv.length > 10000 || job.length > 5000) {
    return json({ error: smsg(langClean, "text_too_large") }, 413);
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
      return json({ error: smsg(langClean, "rate_limited") }, 429);
    }

    // analysis_started DEPOIS dos gates de conteúdo/budget/rate-limit:
    // pedidos rejeitados (429, texto inválido) NÃO contam como análise
    // iniciada — o funil mede inícios REAIS.
    if (!isTest) {
      await bump(env, "analysis_started", market);
      await bumpUnique(env, "analysis_started", market, sid);
    }

    // 3) Cache por hash: análises idênticas repetidas não gastam créditos de novo.
    // Cache incompleto (IA cortou campos longos) NÃO é reaproveitado.
    // lang + market entram no hash (senão análise EN cacheada vaza para PT/BR).
    const hash = await contentHash(cv, job, langClean, market);
    const cachedRaw = await env.RESULTS.get(`cache:${hash}`);
    let cached: PremiumResult | null = null;
    if (cachedRaw) {
      try {
        const parsed = JSON.parse(cachedRaw) as PremiumResult;
        if (isCompletePremium(parsed)) cached = parsed;
        else await env.RESULTS.delete(`cache:${hash}`).catch(() => {});
      } catch {
        await env.RESULTS.delete(`cache:${hash}`).catch(() => {});
      }
    }
    const premium: PremiumResult = cached ?? (await callOpenAI(env, cv, job, langClean, market));

    if (!cached) {
      await env.RESULTS.put(`cache:${hash}`, JSON.stringify(premium), { expirationTtl: 86400 });
    }

    const token = randomToken();
    await env.RESULTS.put(`result:${token}`, JSON.stringify(premium), { expirationTtl: RESULT_TTL });
    // Mercado do token fixado no servidor: o checkout usa SEMPRE este valor
    // (o market do body é só fallback) — evita precificar análise US em BRL.
    await env.RESULTS.put(`mkt:${token}`, market, { expirationTtl: RESULT_TTL });
    // Sessão que gerou a análise: usada pelo webhook p/ o funil de sessões
    // únicas (payment_completed conta 1x por sessão, não por webhook).
    if (sid) {
      await env.RESULTS.put(`sid:${token}`, sid, { expirationTtl: RESULT_TTL });
    }
    if (isTest) {
      await env.RESULTS.put(`tst:${token}`, "1", { expirationTtl: RESULT_TTL });
    }
    if (utmSource) {
      await env.RESULTS.put(`utm:${token}`, utmSource, { expirationTtl: RESULT_TTL });
    }

    if (!isTest) {
      await bump(env, "analysis_completed", market);
      await bumpUnique(env, "analysis_completed", market, sid);
    }

    // GRÁTIS = descoberta: score, resumo curto, 3 pontos fortes, contagem e
    // títulos dos pontos de atenção + UM gap explicado em detalhe. Nada de
    // solução (reescritas/currículo/mensagem/perguntas ficam para o pago).
    const preview = {
      score: premium.score,
      score_explanation: premium.score_explanation,
      strengths: premium.strengths,
      attention_first: premium.attention[0] || null,
      attention_locked: premium.attention.slice(1).map(a => a.requirement),
      attention_count: premium.attention.length,
      price: marketPrice(env, market),
      currency: marketCurrency(market)
    };

    return json({
      token,
      market,
      preview,
      price: marketPrice(env, market)
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

  const lang = String(body?.lang || "pt").slice(0, 2);
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
    return json({ error: smsg(lang, "invalid_code") }, 403);
  }

  const raw = await env.RESULTS.get(`result:${token}`);
  if (!raw) {
    return json({ error: "Sua análise expirou. Gere uma nova gratuitamente." }, 404);
  }

  return json({ ok: true, premium: JSON.parse(raw) });
}

// Eventos de funil vindos do cliente (sem dados pessoais — só contadores).
// v2: cada etapa conta no máximo UMA VEZ por sessão de navegador (sid), o
// cliente manda o sid que ele mesmo gerou; refreshes não multiplicam usuários.
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
  const market = normMarket(body?.market);
  const sid = String(body?.sid || "").slice(0, 80);
  const isTest = isTestRequest(body);
  const hour = new Date().toISOString().slice(0, 13);
  if ((await checkAndIncrement(env, `rl-ev:${clientIp(request)}:${hour}`, 60, 3700)) === null) {
    return json({ ok: true }); // silencioso sob rate limit
  }
  if (!isTest) {
    await bump(env, stage as FunnelStage, market);
    await bumpUnique(env, stage as FunnelStage, market, sid);
  }
  // Atribuição de tráfego (UTM) — só contadores por fonte, nunca conteúdo.
  // Corrigido 12/08: o antigo só contava quando stage === "landing_view", mas
  // o cliente NUNCA envia esse stage (é server-side no GET /) → fontes sempre
  // zeradas. Agora a atribuição é feita no GET / (servidor, com o UTM da URL);
  // aqui mantemos o fallback caso o cliente reporte um stage com utm.
  const utmSource = String(body?.utm?.source || "").replace(/[^\w.-]/g, "").slice(0, 40);
  if (utmSource && stage === "landing_view") {
    const day = new Date().toISOString().slice(0, 10);
    await env.RESULTS.put(`ev:utm:${market}:${utmSource}:${day}`, String((await kvCount(env, `ev:utm:${market}:${utmSource}:${day}`)) + 1), { expirationTtl: 31 * 86400 });
    await env.RESULTS.put(`ev:utm:${market}:${utmSource}:total`, String((await kvCount(env, `ev:utm:${market}:${utmSource}:total`)) + 1));
  }
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
    price_usd: env.PRICE_USD,
    stripe: Boolean(env.STRIPE_SECRET_KEY),
    turnstile: Boolean(env.TURNSTILE_SECRET)
  });
}

const ratePct = (from: number, to: number) => (from > 0 ? `${Math.round((to / from) * 100)}%` : null);

// Conversões do funil v2 — TODAS sobre sessões únicas (evu:/evut:):
// - conv da etapa = únicos na etapa / únicos na etapa ANTERIOR
// - conv total = únicos na etapa / sessões válidas (session_view)
// - drop = 1 - conv p/ a próxima etapa (NUNCA negativo: se a próxima tiver
//   MAIS únicos que a atual, os eventos não são comparáveis → "—")
// O funil NÃO mistura landing_view (pageviews) com sessões.
const CONV_PAIRS: [string, string, string][] = [
  ["session_view", "resume_uploaded", "sessão→upload"],
  ["resume_uploaded", "job_description_added", "upload→vaga"],
  ["job_description_added", "analysis_started", "vaga→análise"],
  ["analysis_started", "analysis_completed", "análise→concluída"],
  ["analysis_completed", "result_viewed", "concluída→resultado"],
  ["result_viewed", "locked_insights_viewed", "resultado→insights"],
  ["locked_insights_viewed", "unlock_clicked", "insights→unlock"],
  ["unlock_clicked", "checkout_session_created", "unlock→checkout"],
  ["checkout_session_created", "payment_completed", "checkout→pago"],
  ["payment_completed", "full_report_viewed", "pago→relatório"],
  ["session_view", "payment_completed", "sessão→venda"]
];

function buildConv(t: Record<string, number>): Record<string, string> {
  const conv: Record<string, string> = {};
  for (const [a, b, name] of CONV_PAIRS) {
    const r = ratePct(t[a], t[b]);
    if (r) conv[name] = r;
  }
  return conv;
}

// Lê os contadores de UM mercado. BR inclui as chaves LEGADAS sem prefixo
// (pré-mercado, 11/08) para não perder o histórico.
// v2: o funil lê as chaves de SESSÕES ÚNICAS (evu:/evut:); as chaves brutas
// (ev:/evt:) continuam disponíveis como eventos/pageviews (KPI secundário).
async function readMarketStats(env: Env, m: Market, day: string, dates: string[], daysParam: number) {
  const today: Record<string, number> = {};
  const total: Record<string, number> = {};
  const window: Record<string, number> = {};
  const rawWindow: Record<string, number> = {};
  const isBr = m === "br";
  for (const stage of FUNNEL_STAGES) {
    // Únicos (funil)
    today[stage] = await kvCount(env, `evu:${m}:${stage}:${day}`);
    total[stage] = await kvCount(env, `evut:${m}:${stage}`);
    let sum = 0;
    for (const d of dates) sum += await kvCount(env, `evu:${m}:${stage}:${d}`);
    if (isBr) {
      today[stage] += await kvCount(env, `evu:${stage}:${day}`);
      total[stage] += await kvCount(env, `evut:${stage}`);
      for (const d of dates) sum += await kvCount(env, `evu:${stage}:${d}`);
    }
    window[stage] = daysParam > 0 ? sum : total[stage];
    // Brutos (eventos/pageviews — KPI secundário)
    let rawSum = 0;
    for (const d of dates) rawSum += await kvCount(env, `ev:${m}:${stage}:${d}`);
    if (isBr) for (const d of dates) rawSum += await kvCount(env, `ev:${stage}:${d}`);
    rawWindow[stage] = daysParam > 0 ? rawSum : await kvCount(env, `evt:${m}:${stage}`) + (isBr ? await kvCount(env, `evt:${stage}`) : 0);
  }
  return { window, today, total, rawWindow, conv: buildConv(window) };
}

// Receita = soma dos PAGAMENTOS REAIS confirmados (registro pay:<token> com
// amount/currency/market), nunca count × preço. Filtra pelo período.
async function readRevenue(env: Env, dates: string[], daysParam: number, market: Market | "all") {
  const rev = { br: { amount: 0, count: 0 }, us: { amount: 0, count: 0 } };
  const keys = await env.RESULTS.list({ prefix: "pay:" });
  const since = daysParam > 0 ? Date.now() - daysParam * 86400000 : 0;
  for (const k of keys.keys) {
    const raw = await env.RESULTS.get(k.name);
    if (!raw) continue;
    try {
      const rec = JSON.parse(raw);
      if (daysParam > 0 && !(rec.ts >= since)) continue;
      const m: Market = normMarket(rec.market);
      if (market !== "all" && m !== market) continue;
      rev[m].amount += Number(rec.amount) || 0;
      rev[m].count += 1;
    } catch {
      // registro inválido — ignora
    }
  }
  return rev;
}

// Fontes de tráfego (UTM) por mercado; "all" soma BR + US (+ legado em BR).
async function readSources(env: Env, dates: string[], daysParam: number, market: Market | "all") {
  const srcMap = new Map<string, { landings: number; paid: number }>();
  const mkPrefixes = (base: string): string[] =>
    market === "all" ? [`${base}br:`, `${base}us:`, base]
    : market === "us" ? [`${base}us:`]
    : [`${base}br:`, base];
  const addKeys = async (prefixes: string[], paid: boolean) => {
    for (const prefix of prefixes) {
      const keys = await env.RESULTS.list({ prefix });
      for (const k of keys.keys) {
        const parts = k.name.split(":");
        // ev:utm:<mkt>:<src>:<day|total>  |  legado ev:utm:<src>:<day|total>
        const hasMkt = parts[2] === "br" || parts[2] === "us";
        const src = hasMkt ? parts[3] : parts[2];
        const dayPart = hasMkt ? parts[4] : parts[3];
        if (!src || !dayPart) continue;
        if (dayPart === "total") {
          if (daysParam > 0) continue;
        } else if (daysParam > 0 && !dates.includes(dayPart)) {
          continue;
        }
        const e = srcMap.get(src) || { landings: 0, paid: 0 };
        e[paid ? "paid" : "landings"] += Number(await env.RESULTS.get(k.name)) || 0;
        srcMap.set(src, e);
      }
    }
  };
  await addKeys(mkPrefixes("ev:utm:"), false);
  await addKeys(mkPrefixes("ev:utm-paid:"), true);
  const sources = Array.from(srcMap.entries()).map(([source, e]) => ({ source, landings: e.landings, paid: e.paid }));
  sources.sort((a, b) => b.landings - a.landings);
  return sources.slice(0, 20);
}

async function handleStats(env: Env, url: URL) {
  // Proteção interna: se STATS_KEY estiver definida, exige ?key=<chave>.
  if (env.STATS_KEY && url.searchParams.get("key") !== env.STATS_KEY) {
    return json({ error: "Acesso negado." }, 403);
  }

  // Período: 1=hoje, 7, 30, 0=todo período (totais). Usa as chaves diárias.
  const daysParam = Math.max(0, Math.min(365, Number(url.searchParams.get("days") || "1") || 0));
  const day = new Date().toISOString().slice(0, 10);
  const dates: string[] = [];
  if (daysParam > 0) {
    for (let i = 0; i < daysParam; i++) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      dates.push(d);
    }
  }

  // Mercado selecionado: br | us | all (padrão: all = soma BR + US).
  const marketParam = String(url.searchParams.get("market") || "all").toLowerCase();
  const selected: Market | "all" = marketParam === "us" ? "us" : marketParam === "br" ? "br" : "all";

  const [br, us] = await Promise.all([readMarketStats(env, "br", day, dates, daysParam), readMarketStats(env, "us", day, dates, daysParam)]);
  const merge = (a: Record<string, number>, b: Record<string, number>): Record<string, number> => {
    const o: Record<string, number> = {};
    for (const stage of FUNNEL_STAGES) o[stage] = (a[stage] || 0) + (b[stage] || 0);
    return o;
  };
  const window = selected === "all" ? merge(br.window, us.window) : selected === "us" ? us.window : br.window;
  const today = selected === "all" ? merge(br.today, us.today) : selected === "us" ? us.today : br.today;
  const total = selected === "all" ? merge(br.total, us.total) : selected === "us" ? us.total : br.total;
  const rawWindow = selected === "all" ? merge(br.rawWindow, us.rawWindow) : selected === "us" ? us.rawWindow : br.rawWindow;

  // Diagnóstico do checkout (seção técnica): distingue abandono comercial de
  // erro técnico — Caso A (unlocks sem sessões) = bug de criação; Caso B
  // (sessões sem pagamentos) = abandono no Stripe; Caso C = checkout ok.
  const checkout = {
    unlock_clicked: window.unlock_clicked || 0,
    checkout_session_created: window.checkout_session_created || 0,
    checkout_error: window.checkout_error || 0,
    payment_completed: window.payment_completed || 0
  };

  const revenue = await readRevenue(env, dates, daysParam, selected);

  return json({
    day,
    days: daysParam,
    market: selected,
    // Métricas confiáveis a partir de: instrumentação v2 (sessões únicas +
    // checkout_session_created + receita real). Antes disso, os dados misturam
    // pageviews com eventos e não devem basear decisão comercial.
    reliable_since: env.RELIABLE_SINCE || "",
    sources: await readSources(env, dates, daysParam, selected),
    window,
    today,
    total,
    // Pageviews/eventos brutos (KPI secundário — não entram no funil).
    raw: { window: rawWindow, today, total },
    checkout,
    revenue,
    conv: buildConv(window),
    convTotal: buildConv(total),
    // Comparação BR vs US (sempre presente — o dashboard usa p/ o experimento).
    markets: {
      br: { window: br.window, total: br.total, conv: br.conv },
      us: { window: us.window, total: us.total, conv: us.conv }
    }
  });
}

async function handleConfig(env: Env, url: URL) {
  const market = normMarket(url.searchParams.get("market"));
  return json({
    turnstile_sitekey: env.TURNSTILE_SITEKEY || "",
    price: marketPrice(env, market),
    currency: marketCurrency(market)
  });
}

// ── Landing dos EUA (/us) ────────────────────────────────────────
// O MESMO index.html da versão BR, com head en-US injetado: título SEO,
// meta description, canonical, Open Graph/Twitter e o marcador mv-market
// que o cliente lê para ativar o dicionário "us" e o funil do mercado US.
const US_META_TITLE = "Resume Job Match Checker — See How Well Your Resume Fits the Job";
const US_META_DESC =
  "Upload your resume, paste the job description and get your match score, missing skills and personalized improvements in about 60 seconds. Free initial analysis.";
const US_CANONICAL = "https://matchvaga.kubezen.com/us";

function injectUsLanding(html: string): string {
  const meta =
    `<meta name="mv-market" content="us">\n` +
    `    <title>${US_META_TITLE}</title>\n` +
    `    <meta name="description" content="${US_META_DESC}">\n` +
    `    <link rel="canonical" href="${US_CANONICAL}">\n` +
    `    <meta property="og:title" content="${US_META_TITLE}">\n` +
    `    <meta property="og:description" content="${US_META_DESC}">\n` +
    `    <meta property="og:url" content="${US_CANONICAL}">\n` +
    `    <meta property="og:locale" content="en_US">\n` +
    `    <meta name="twitter:title" content="${US_META_TITLE}">\n` +
    `    <meta name="twitter:description" content="${US_META_DESC}">`;
  let out = html
    .replace('<html lang="pt-BR">', '<html lang="en-US">')
    // remove os defaults PT (o <title> com data-i18n, senão o applyI18n do
    // i18n.js sobrescreveria o título SEO pelo H1)
    .replace(/<title[^>]*>[\s\S]*?<\/title>/, "")
    .replace(/<meta name="description"[^>]*>/, "")
    .replace(/<link rel="canonical"[^>]*>/, "")
    .replace(/<meta property="og:title"[^>]*>/, "")
    .replace(/<meta property="og:description"[^>]*>/, "")
    .replace(/<meta property="og:url"[^>]*>/, "")
    .replace(/<meta property="og:locale"[^>]*>/, "")
    .replace(/<meta name="twitter:title"[^>]*>/, "")
    .replace(/<meta name="twitter:description"[^>]*>/, "");
  return out.replace("<head>", "<head>\n    " + meta);
}

async function serveLanding(env: Env, url: URL, request: Request, market: Market): Promise<Response> {
  let asset = await env.ASSETS.fetch(new Request(new URL("/index.html", url), request), { redirect: "manual" });
  let hops = 0;
  while ((asset.status === 301 || asset.status === 302 || asset.status === 307 || asset.status === 308) && hops < 4) {
    const loc = asset.headers.get("location");
    if (!loc) break;
    asset = await env.ASSETS.fetch(new Request(new URL(loc, url), request), { redirect: "manual" });
    hops++;
  }
  const body = market === "us" ? injectUsLanding(await asset.text()) : await asset.text();
  const headers = new Headers({
    "content-type": asset.headers.get("content-type") || "text/html;charset=utf-8",
    "cache-control": "no-store"
  });
  for (const [name, value] of Object.entries(securityHeaders)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return new Response(body, { status: asset.status, headers });
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
      return handleStats(env, url);
    }

    // Dashboard do funil — rota interna protegida (não conta como landing_view).
    // Serve o HTML inline (sem redirect): o asset server canonicaliza
    // /dashboard.html → /dashboard, o que criaria loop com esta rota.
    if (request.method === "GET" && (url.pathname === "/dashboard" || url.pathname === "/stats")) {
      if (env.STATS_KEY && url.searchParams.get("key") !== env.STATS_KEY) {
        return json({ error: "Acesso negado." }, 403);
      }
      let asset = await env.ASSETS.fetch(new Request(new URL("/dashboard.html", url), request), { redirect: "manual" });
      let hops = 0;
      while ((asset.status === 301 || asset.status === 302 || asset.status === 307 || asset.status === 308) && hops < 4) {
        const loc = asset.headers.get("location");
        if (!loc) break;
        asset = await env.ASSETS.fetch(new Request(new URL(loc, url), request), { redirect: "manual" });
        hops++;
      }
      const headers = new Headers({
        "content-type": asset.headers.get("content-type") || "text/html;charset=utf-8",
        "cache-control": "no-store"
      });
      for (const [name, value] of Object.entries(securityHeaders)) {
        if (!headers.has(name)) headers.set(name, value);
      }
      return new Response(asset.body, { status: asset.status, headers });
    }

    if (request.method === "GET" && url.pathname === "/api/config") {
      return handleConfig(env, url);
    }

    // /us = landing americana (experimento). landing_view NO mercado US conta
    // só navegação HUMANA real: bots/crawlers/link previews são ignorados e o
    // retorno do Stripe (?checkout=success|cancel) NÃO é uma visita nova.
    if (request.method === "GET" && url.pathname === "/us") {
      if (!isBotRequest(request) && !url.searchParams.has("checkout") && url.searchParams.get("mv_test") !== "1") {
        await bump(env, "landing_view", "us");
        await bumpLandingUtm(env, url, "us");
      }
      return serveLanding(env, url, request, "us");
    }

    if (request.method === "GET" && url.pathname === "/") {
      // landing_view v2: NÃO conta refresh/bots/retorno do Stripe. O funil
      // principal começa em session_view (sessões únicas, client-side);
      // landing_view é KPI secundário = pageviews válidos. ?mv_test=1 (testes
      // internos) também fica fora das métricas comerciais.
      if (!isBotRequest(request) && !url.searchParams.has("checkout") && url.searchParams.get("mv_test") !== "1") {
        await bump(env, "landing_view", "br");
        await bumpLandingUtm(env, url, "br");
      }
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
