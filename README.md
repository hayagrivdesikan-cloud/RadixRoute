# AI-CDN upgraded prototype

This version implements the architecture in the sketch:

- ingress metadata and tenant/repo/system-prompt scoping
- simple route split: shallow chat goes semantic, depth >= 3 / agentic / long context goes prefix
- LFU-managed exact response cache
- deterministic longest-prefix cache for long/agentic chats
- Qdrant-backed semantic cache with in-memory fallback
- nearby AI-CDN node lookup before inference when the cost model says it is worth it
- disk persistence snapshots under `./data`

## Run locally

```bash
npm install
cp .env.example .env
npm run check
npm start
```

## Run Qdrant locally

```bash
docker compose up -d qdrant
```

Then keep `QDRANT_URL=http://localhost:6333` in `.env`.

## Test requests

Shallow depth goes semantic:

```bash
curl -s http://localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "tenantId":"t1",
    "companyId":"acme",
    "repoId":"none",
    "chatDepth":1,
    "systemPrompt":"Tutor",
    "userPrompt":"Explain calculus"
  }' | jq
```

Depth >= 3 goes prefix:

```bash
curl -s http://localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "tenantId":"t1",
    "companyId":"acme",
    "repoId":"repo-ai-cdn",
    "messages":[
      {"role":"system","content":"You are a repo coding agent."},
      {"role":"user","content":"Here is the repo context: file server.js ... file vectorCache.js ..."},
      {"role":"assistant","content":"I read it."},
      {"role":"user","content":"Now modify the prefix cache path."}
    ]
  }' | jq
```

Inspect the node state:

```bash
curl -s http://localhost:3000/stats | jq
```
