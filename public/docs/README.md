# public/docs — Swagger/OpenAPI console

Two specs served by this Worker:

- `openapi.yaml` — **MatchVaga API** (the worker's own API). Served at
  `https://matchvaga.kubezen.com/docs/openapi.yaml` and rendered by the UI at
  `/docs`. Generated from the actual handlers in `src/index.ts`; update it
  whenever an endpoint changes.
- `v1.json` — **Zen Mon API** (verbatim copy of
  `zen-mon/api/openapi/v1.json` from the zen-mon repo, v0.1.0). Served at
  `https://swagger.kubezen.com/v1.json` (aliases: `/openapi.json`,
  `/openapi.yaml`) and rendered by the UI at `https://swagger.kubezen.com/`.

Sync rule for `v1.json`: copy the source file from the zen-mon repo when it
changes (`cp ~/projects/zen/zen-mon/api/openapi/v1.json public/docs/v1.json`),
commit, deploy. Do not hand-edit it here — the zen-mon repo is the source of
truth.

The Swagger UI assets live in `public/vendor/swagger-ui/` (swagger-ui-dist
5.32.13, self-hosted because the site CSP forbids CDN script/style sources).

Routing (src/index.ts): the `DOCS_HOST` (`swagger.kubezen.com`) branch serves
the UI at `/` and the spec at `/v1.json`; the pathname branch serves `/docs`
(+ `/docs/openapi.yaml`) on the app host. Both go through `serveDocs()`,
which relaxes only `style-src` (Swagger UI injects inline styles) and extends
`connect-src` with the API origins, keeps the remaining security headers, and
serves `no-store`. Docs pages carry `<meta name="robots" content="noindex">`
and never count analytics.
