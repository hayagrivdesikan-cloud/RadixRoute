import http from "http";
import { performance } from "perf_hooks";

const HOST = "localhost";
const PORT = 3000;
const TOTAL_ROUNDS = 100;
const WARMUP_ROUNDS = 10;

function postJSON(path, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);

    const req = http.request(
      {
        hostname: HOST,
        port: PORT,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve({
              statusCode: res.statusCode,
              body: JSON.parse(body),
            });
          } catch {
            resolve({
              statusCode: res.statusCode,
              body: { raw: body },
            });
          }
        });
      }
    );

    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function getJSON(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: HOST,
        port: PORT,
        path,
        method: "GET",
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve({ raw: body });
          }
        });
      }
    );

    req.on("error", reject);
    req.end();
  });
}

const shallowSemanticRequests = [
  {
    name: "semantic-calc-1",
    tenantId: "tenant-a",
    companyId: "acme",
    repoId: "none",
    chatDepth: 1,
    systemPrompt: "Tutor",
    userPrompt: "Explain calculus",
  },
  {
    name: "semantic-calc-2",
    tenantId: "tenant-a",
    companyId: "acme",
    repoId: "none",
    chatDepth: 2,
    systemPrompt: "Tutor",
    userPrompt: "Can you explain calculus simply?",
  },
  {
    name: "semantic-docker-1",
    tenantId: "tenant-a",
    companyId: "acme",
    repoId: "none",
    chatDepth: 1,
    systemPrompt: "DevOps Tutor",
    userPrompt: "What is Docker used for?",
  },
  {
    name: "semantic-docker-2",
    tenantId: "tenant-a",
    companyId: "acme",
    repoId: "none",
    chatDepth: 2,
    systemPrompt: "DevOps Tutor",
    userPrompt: "Explain Docker in simple terms",
  },
];

const deepPrefixRequests = [
  {
    name: "prefix-agent-1",
    tenantId: "tenant-a",
    companyId: "acme",
    repoId: "ai-cdn",
    messages: [
      { role: "system", content: "You are a repo coding agent." },
      {
        role: "user",
        content:
          "Repository context: server.js classifier.js aiCdnNode.js vectorCache.js prefixTrie.js cachePolicy.js. The system is an AI-CDN with semantic and prefix caching.",
      },
      { role: "assistant", content: "I understand the repository." },
      {
        role: "user",
        content: "Modify the routing logic so depth 3 and above uses prefix caching.",
      },
    ],
  },
  {
    name: "prefix-agent-2",
    tenantId: "tenant-a",
    companyId: "acme",
    repoId: "ai-cdn",
    messages: [
      { role: "system", content: "You are a repo coding agent." },
      {
        role: "user",
        content:
          "Repository context: server.js classifier.js aiCdnNode.js vectorCache.js prefixTrie.js cachePolicy.js. The system is an AI-CDN with semantic and prefix caching.",
      },
      { role: "assistant", content: "I understand the repository." },
      {
        role: "user",
        content: "Now explain how the prefix cache avoids recomputing shared context.",
      },
    ],
  },
  {
    name: "prefix-code-1",
    tenantId: "tenant-a",
    companyId: "acme",
    repoId: "ai-cdn",
    chatDepth: 4,
    systemPrompt: "Coder",
    userPrompt:
      "Given this codebase with class AICDNNode, class PrefixTrie, class VectorCache, and class ClusterEngine, explain the cache lookup order and how neighbor nodes are checked.",
  },
];

const multiTenantRequests = [
  {
    name: "tenant-isolation-a",
    tenantId: "tenant-a",
    companyId: "acme",
    repoId: "none",
    chatDepth: 1,
    systemPrompt: "Tutor",
    userPrompt: "Explain calculus",
  },
  {
    name: "tenant-isolation-b",
    tenantId: "tenant-b",
    companyId: "globex",
    repoId: "none",
    chatDepth: 1,
    systemPrompt: "Tutor",
    userPrompt: "Explain calculus",
  },
];

const lfuPressureRequests = Array.from({ length: 80 }, (_, i) => ({
  name: `lfu-pressure-${i}`,
  tenantId: "tenant-pressure",
  companyId: "loadtest",
  repoId: "none",
  chatDepth: 1,
  systemPrompt: "Tutor",
  userPrompt: `Unique shallow prompt number ${i}: explain concept ${i}`,
}));

const workload = [
  ...shallowSemanticRequests,
  ...deepPrefixRequests,
  ...multiTenantRequests,
  ...lfuPressureRequests,
];

function pickWorkload(round, index) {
  if (round % 5 === 0) return shallowSemanticRequests[index % shallowSemanticRequests.length];
  if (round % 5 === 1) return deepPrefixRequests[index % deepPrefixRequests.length];
  if (round % 5 === 2) return multiTenantRequests[index % multiTenantRequests.length];
  if (round % 5 === 3) return lfuPressureRequests[index % lfuPressureRequests.length];
  return workload[index % workload.length];
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function classifyResult(result) {
  const source = String(result.source || "").toLowerCase();
  const route = String(result.route || "").toUpperCase();

  return {
    semanticRoute: route.includes("SEMANTIC"),
    prefixRoute: route.includes("PREFIX"),

    semanticHit: source.includes("semantic"),
    prefixHit: source.includes("prefix"),
    neighborHit: source.includes("neighbor"),
    localInference: source.includes("local inference") || source.includes("simulated"),
    globalInference: source.includes("global"),

    tokensSaved: Number(result.tokensSaved || result.prefixTokensSaved || 0),
  };
}

async function runPhase(name, rounds, measured) {
  const telemetry = {
    requests: 0,
    failures: 0,

    semanticRoutes: 0,
    prefixRoutes: 0,

    semanticHits: 0,
    prefixHits: 0,
    neighborHits: 0,

    localInference: 0,
    globalInference: 0,

    tokensSaved: 0,
    latencies: [],
  };

  console.log(`\n${name} phase started...`);

  for (let round = 0; round < rounds; round++) {
    for (let i = 0; i < workload.length; i++) {
      const payload = pickWorkload(round, i);
      const start = performance.now();

      try {
        const res = await postJSON("/v1/chat/completions", payload);
        const end = performance.now();

        if (res.statusCode >= 400) {
          telemetry.failures++;
          continue;
        }

        if (!measured) continue;

        const result = res.body;
        const derived = classifyResult(result);

        telemetry.requests++;
        telemetry.latencies.push(Number(result.latencyMs ?? end - start));

        if (derived.semanticRoute) telemetry.semanticRoutes++;
        if (derived.prefixRoute) telemetry.prefixRoutes++;

        if (derived.semanticHit) telemetry.semanticHits++;
        if (derived.prefixHit) telemetry.prefixHits++;
        if (derived.neighborHit) telemetry.neighborHits++;

        if (derived.localInference) telemetry.localInference++;
        if (derived.globalInference) telemetry.globalInference++;

        telemetry.tokensSaved += derived.tokensSaved;
      } catch (err) {
        telemetry.failures++;
      }
    }
  }

  return telemetry;
}

function printReport(telemetry, beforeStats, afterStats) {
  const totalHits =
    telemetry.semanticHits + telemetry.prefixHits + telemetry.neighborHits;

  const cacheHitRate =
    telemetry.requests === 0 ? 0 : (totalHits / telemetry.requests) * 100;

  const inferenceRate =
    telemetry.requests === 0
      ? 0
      : ((telemetry.localInference + telemetry.globalInference) /
          telemetry.requests) *
        100;

  const meanLatency =
    telemetry.latencies.reduce((a, b) => a + b, 0) /
    Math.max(1, telemetry.latencies.length);

  console.log("\n=== AI-CDN HARDCORE BENCHMARK REPORT ===");
  console.log(`Requests measured        : ${telemetry.requests}`);
  console.log(`Failures                 : ${telemetry.failures}`);
  console.log("----------------------------------------");
  console.log(`Semantic routes          : ${telemetry.semanticRoutes}`);
  console.log(`Prefix routes            : ${telemetry.prefixRoutes}`);
  console.log("----------------------------------------");
  console.log(`Semantic cache hits      : ${telemetry.semanticHits}`);
  console.log(`Prefix cache hits        : ${telemetry.prefixHits}`);
  console.log(`Neighbor cache hits      : ${telemetry.neighborHits}`);
  console.log(`Total cache hit rate     : ${cacheHitRate.toFixed(2)}%`);
  console.log("----------------------------------------");
  console.log(`Local inference calls    : ${telemetry.localInference}`);
  console.log(`Global inference calls   : ${telemetry.globalInference}`);
  console.log(`Inference rate           : ${inferenceRate.toFixed(2)}%`);
  console.log("----------------------------------------");
  console.log(`Mean latency             : ${meanLatency.toFixed(2)} ms`);
  console.log(`P95 latency              : ${percentile(telemetry.latencies, 95).toFixed(2)} ms`);
  console.log(`P99 latency              : ${percentile(telemetry.latencies, 99).toFixed(2)} ms`);
  console.log("----------------------------------------");
  console.log(`Estimated tokens saved   : ${telemetry.tokensSaved}`);
  console.log("----------------------------------------");
  console.log("Stats before:");
  console.log(JSON.stringify(beforeStats, null, 2));
  console.log("Stats after:");
  console.log(JSON.stringify(afterStats, null, 2));
  console.log("========================================\n");
}

async function main() {
  console.log("🚀 Starting AI-CDN hardcore benchmark...");
  console.log("Make sure the server is already running with: npm start\n");

  const health = await getJSON("/health");
  console.log("Health:", health);

  const beforeStats = await getJSON("/stats");

  await runPhase("Warmup", WARMUP_ROUNDS, false);

  const telemetry = await runPhase("Measured", TOTAL_ROUNDS, true);

  const afterStats = await getJSON("/stats");

  printReport(telemetry, beforeStats, afterStats);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});