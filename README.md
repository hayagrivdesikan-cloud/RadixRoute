# RadixRoute — AI-CDN Prototype

RadixRoute is a prototype AI-CDN layer for reducing LLM prompt-token processing through route-aware caching.

Instead of sending every request directly to inference, the system classifies prompts into different cache paths:

* **Short / low-depth prompts** use semantic caching with embeddings and Qdrant vector search.
* **Large repo / codebase / agentic prompts** use deterministic prefix matching to safely reuse stable prompt context without relying on risky semantic matches.
* **Expensive misses** can trigger neighbor-node lookup before falling back to inference.

## Core Features

* OpenAI-style `/v1/chat/completions` endpoint
* Prompt classification into semantic and prefix cache paths
* Tenant/company/repo scoped cache keys
* Qdrant-backed semantic cache
* Gemini embeddings with local hash fallback
* Trie-based exact prefix cache for long-context prompts
* LFU eviction with recency tie-breaking
* Simulated neighboring AI-CDN nodes
* Cost model for local inference vs neighbor lookup vs global inference
* Telemetry for route decisions, cache events, token savings, and latency estimates
* Cache-punishment benchmark for cold traffic, false-positive probes, codebase mutations, and warm-cache stress

## Requirements

* Node.js 20+
* Docker / Docker Compose
* Qdrant running locally
* Optional: `GEMINI_API_KEY` for Gemini embeddings

## Setup

```bash
npm install
cp .env.example .env
docker compose up -d qdrant
npm run check
npm start
```

Server runs on:

```bash
http://localhost:3000
```

## Test

Health check:

```bash
curl -s http://localhost:3000/health
```

Stats:

```bash
curl -s http://localhost:3000/stats
```

Example request:

```bash
curl -s http://localhost:3000/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{
    "tenantId": "tenant-alpha",
    "companyId": "acme",
    "repoId": "none",
    "chatDepth": 1,
    "systemPrompt": "Tutor",
    "userPrompt": "Explain LFU cache eviction."
  }'
```

## Benchmark

Run the cache-punishment benchmark:

```bash
node benchmark.js
```

The benchmark tests more than simple repeated prompts. It includes unique cold traffic, paraphrased semantic reuse, false-positive probes, codebase mutation cases, and warm-cache stress.

In one simulation run, RadixRoute reduced estimated prompt-token processing by **74%** compared to a raw 100% inference baseline across **578 main benchmark requests**.

## Notes

This is a systems prototype and simulation, not a production CDN. The goal is to explore inference-routing, cache safety, prompt reuse, and token-cost reduction strategies for LLM workloads.
