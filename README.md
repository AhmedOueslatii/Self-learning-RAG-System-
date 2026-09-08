# Self-Learning RAG System

A retrieval-augmented generation system on Cloudflare Workers that **synthesizes its own knowledge**.

Standard RAG retrieves document chunks and injects them into a prompt. This system adds a *reflection layer*: after each document is ingested, an LLM compares it against semantically related documents already in the knowledge base and writes a synthesis — what the new document adds, how it connects, and what gap remains. That synthesis is embedded and stored as a new searchable document with a ranking boost, so the knowledge base progressively builds understanding rather than just accumulating text.

Built following [this freeCodeCamp tutorial](https://www.freecodecamp.org/news/how-to-build-a-self-learning-rag-system-with-knowledge-reflection/), with several fixes noted below.

## Architecture

| Component | Role |
| --- | --- |
| **Vectorize** | Vector database — 384-dim embeddings, cosine similarity |
| **D1** (SQLite) | Authoritative document text and metadata |
| **Workers AI** | Embeddings (`@cf/baai/bge-small-en-v1.5`) and synthesis LLM |

### The self-learning loop

1. A document is ingested — embedded, then written to Vectorize and D1.
2. In the background, `reflect()` finds related documents (similarity > 0.65).
3. An LLM writes a three-sentence synthesis: what's new, how it connects, what gap remains.
4. The reflection is embedded and stored with a **1.5x ranking boost**.
5. Every 3 reflections, `consolidate()` compresses them into a summary with a **1.8x boost**.
6. At search time, boosts let synthesized knowledge outrank raw chunks on broad questions.

Specific factual queries still return raw chunks; broad conceptual queries surface reflections and summaries.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/ingest` | Add a document (`{id?, content, source?}`); triggers reflection |
| `POST` | `/search` | Query the knowledge base (`{query}`) with boosted ranking |
| `POST` | `/reflect` | Run reflection synchronously for one document (`{id}`) |
| `POST` | `/consolidate` | Force consolidation of pending reflections |
| `GET` | `/documents` | List stored documents with type and score |

## Setup

```bash
pnpm install

# Create resources
npx wrangler vectorize create rag-index --dimensions=384 --metric=cosine
npx wrangler d1 create rag-db   # put the returned database_id in wrangler.jsonc

# Required: without this the reflection layer silently does nothing (see below)
npx wrangler vectorize create-metadata-index rag-index --property-name=doc_type --type=string

# Apply schema
npx wrangler d1 execute rag-db --remote --file=./migrations/001_init.sql
npx wrangler d1 execute rag-db --remote --file=./migrations/003_add_reflection_fields.sql

pnpm run deploy
```

## Usage

```bash
# Ingest
curl -X POST https://<your-worker>.workers.dev/ingest \
  -H "Content-Type: application/json" \
  -d '{"id": "doc-001", "content": "Cursor pagination beats offset pagination for live-updating datasets because offset becomes unreliable when rows are inserted or deleted during pagination."}'

# Search
curl -X POST https://<your-worker>.workers.dev/search \
  -H "Content-Type: application/json" \
  -d '{"query": "what pagination approach should I use?"}'
```

Local development against real Cloudflare resources:

```bash
npx wrangler dev --remote
```

## Environments

Two environments share the same code but use isolated resources, so staging
ingestion never pollutes the production knowledge base.

| Environment | Worker | D1 | Vectorize |
| --- | --- | --- | --- |
| production | `rag-reflection-system` | `rag-db` | `rag-index` |
| staging | `rag-reflection-system-staging` | `rag-db-staging` | `rag-index-staging` |

```bash
pnpm run deploy            # production
pnpm run deploy:staging    # staging

pnpm run dev               # local, production resources
pnpm run dev:staging       # local, staging resources
```

Test risky changes against staging first:

```bash
pnpm run deploy:staging
curl -X POST https://rag-reflection-system-staging.<subdomain>.workers.dev/ingest \
  -H "Content-Type: application/json" -d '{"content": "..."}'
```

## Contributing

`main` is always deployable. Work happens on short-lived branches that merge
back through a pull request — there is no long-lived `dev` branch.

```bash
git switch -c feat/my-change
# ...edit, then:
pnpm run typecheck && pnpm run test:run
git commit -am "Describe the change"
git push -u origin feat/my-change
```

Open a pull request from the link git prints. CI runs typecheck and tests on
every PR. When `main` moves ahead while you work, rebase rather than merge:

```bash
git fetch origin
git rebase origin/main
git push --force-with-lease
```

## Deviations from the tutorial

Four issues surfaced while building this, each failing silently or with a misleading error:

1. **The tutorial's LLM no longer exists.** `@cf/moonshotai/kimi-k2.5` is gone from the catalog, and its successor `kimi-k2.6` is paid-plan only — on the Workers Free plan it returns `AiError 5035`. This project uses `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, which works on the free plan. Check `npx wrangler ai models` for the current catalog.

2. **Vectorize metadata indexes must be created explicitly.** `reflect()` filters on `doc_type`. Without a metadata index that filter matches nothing, so reflection returns early and writes nothing — with no error, and ingest still returns 200. The index also only applies to vectors written *after* it becomes active, so existing documents must be re-ingested.

3. **`ctx.waitUntil()` is unreliable under `wrangler dev --remote`.** Ingest returns 200 but the background reflection never runs. The `POST /reflect` endpoint runs it synchronously so errors surface in the response. Production behaves normally.

4. **The migration's column name contradicts the code.** The tutorial's migration declares `parent_reflection_id` while its insert binds `parent_id`. This project uses `parent_id` throughout.

## Configuration

Bindings live in `wrangler.jsonc` (the modern replacement for `wrangler.toml`):

- `DB` — D1 database
- `VECTORIZE` — Vectorize index
- `AI` — Workers AI

Regenerate types after changing bindings:

```bash
pnpm run cf-typegen
```
