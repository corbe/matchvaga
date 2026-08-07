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
2. Worker chama a OpenAI.
3. Resultado premium fica no KV por 2 horas.
4. Browser recebe somente score, quatro matches e quantidade de gaps.
5. Usuário paga por Pix.
6. Você envia o código.
7. `/api/unlock` busca o conteúdo premium no KV e libera.

O conteúdo premium NÃO trafega no `/api/preview`.

## Próxima evolução somente após venda

Trocar o código global por um código/token individual por pagamento e integrar confirmação automática de Pix.
