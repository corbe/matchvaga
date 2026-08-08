# MatchVaga — Cloudflare MVP

Sem Django, Flask, Docker, servidor ou banco relacional.

## Arquitetura

- Cloudflare Worker: API
- Cloudflare Static Assets: HTML/CSS/JS
- Cloudflare KV: guarda resultado premium temporariamente
- OpenAI API: análise
- Pix manual + código: validação comercial

## 1. Instalar

```bash
npm install
npx wrangler login
```

## 2. Criar KV

```bash
npx wrangler kv namespace create RESULTS
npx wrangler kv namespace create RESULTS --preview
```

Copie os IDs retornados para `wrangler.toml`.

## 3. Configurar segredo da OpenAI

```bash
npx wrangler secret put OPENAI_API_KEY
```

Cole sua chave quando solicitado.

## 4. Configurar Pix e código

Edite em `wrangler.toml`:

```toml
[vars]
OPENAI_MODEL = "gpt-5-mini"
PRICE_BRL = "9,90"
PIX_KEY = "SUA_CHAVE_PIX"
UNLOCK_CODE = "SEU_CODIGO"
```

Para produção, o ideal é mover `UNLOCK_CODE` para secret também:

```bash
npx wrangler secret put UNLOCK_CODE
```

E remover `UNLOCK_CODE` de `[vars]`.

## 5. Rodar local

```bash
npm run dev
```

## 6. Deploy

```bash
npm run deploy
```

O Wrangler exibirá a URL pública `*.workers.dev`.

## Fluxo

1. Usuário cola currículo + vaga.
2. Worker chama a IA.
3. Resultado premium fica no KV por 2 horas.
4. Browser recebe somente score, quatro matches e quantidade de gaps.
5. Quem não paga na hora pode deixar o email (`POST /api/lead`) — fica no KV
   como `lead:<email>` para follow-up do dono (nunca exposto por API).
6. Usuário paga (Stripe: cartão ou PIX) e o webhook libera automaticamente.
7. `/api/unlock` busca o conteúdo premium no KV e libera.

O conteúdo premium NÃO trafega no `/api/preview`.

## Operação (pontos que travam o funil se esquecidos)

- **Webhook do Stripe é obrigatório**: sem o endpoint `https://matchvaga.matchvaga.workers.dev/api/stripe-webhook`
  configurado no painel Stripe (eventos `checkout.session.completed` e
  `checkout.session.async_payment_succeeded`), o pagamento é cobrado mas o
  usuário NUNCA é desbloqueado. O `STRIPE_WEBHOOK_SECRET` do Worker precisa ser
  o secret do endpoint. Test mode e live mode têm endpoints/segredos separados.
- **Turnstile degrada graciosamente**: se o captcha não carregar no navegador
  do usuário (extensão/antivírus interceptando challenges.cloudflare.com), a
  análise é liberada mesmo assim — a proteção de custo fica por conta do rate
  limit por IP + teto diário. O sitekey precisa listar o domínio EXATO do site
  (subdomínio não é herdado de `matchvaga.workers.dev`).
- **Stripe em test mode não cobra**: para vender de verdade, `STRIPE_SECRET_KEY`
  precisa ser `sk_live_...` + webhook endpoint live + whsec do endpoint live.

## Próxima evolução somente após venda

Trocar o código global por um código/token individual por pagamento e integrar confirmação automática de Pix.
