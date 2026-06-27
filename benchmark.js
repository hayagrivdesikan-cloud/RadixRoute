import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import { performance } from 'perf_hooks';

// -----------------------------------------------------------------------------
// AI-CDN TARGETED CACHE PUNISH BENCHMARK
// -----------------------------------------------------------------------------
// Goal:
// 1. Run a small broad sanity suite.
// 2. Run a harder benchmark focused on cache correctness and degradation, not just
//    making cache numbers look good.
// 3. Compare raw 100% inference prompt-token processing vs AI-CDN actual prompt
//    processing, per phase/category/scenario.
//
// This benchmark deliberately includes codebase mutation cases:
// - stable repeated repo context: prefix cache should save a lot
// - late-file churn: prefix cache should still save most of the early context
// - mid-file churn: prefix savings should drop
// - early-manifest/branch churn: prefix savings should drop hard
// - unique/cold traffic: should miss
// - false-positive semantic probes: should miss or be flagged as semantic risk
// -----------------------------------------------------------------------------

const HOST = process.env.BENCH_HOST || 'localhost';
const PORT = Number(process.env.BENCH_PORT || 3000);
const RUN_ID = process.env.BENCH_RUN_ID || `run-${Date.now()}`;
const REPORT_DIR = process.env.BENCH_REPORT_DIR || './benchmark-results';
const PRIMARY_PATH = '/v1/chat/completions';

const PROFILE = process.env.BENCH_PROFILE || 'cache-punish';
const RESET_BEFORE_RUN = process.env.RESET_BEFORE_RUN !== 'false';
const STRICT_SANITY = process.env.STRICT_SANITY === 'true';
const INPUT_COST_PER_MILLION = Number(process.env.INPUT_COST_PER_MILLION || 0);

const IS_REMOTE_EMBEDDING = Boolean(process.env.GEMINI_API_KEY || process.env.EMBEDDING_ENDPOINT);
const PACING_DELAY_MS = Number(process.env.BENCH_DELAY_MS ?? (IS_REMOTE_EMBEDDING ? 450 : 0));
const STRESS_CONCURRENCY = Number(process.env.STRESS_CONCURRENCY || 3);

const PROFILE_CONFIG = {
  smoke: {
    semanticHotRounds: 2,
    uniqueSemanticCount: 12,
    codebaseIterations: 2,
    falsePositivePairs: 4,
    stressRounds: 1,
    stressUnique: 6
  },
  'cache-punish': {
    semanticHotRounds: 4,
    uniqueSemanticCount: 36,
    codebaseIterations: 5,
    falsePositivePairs: 10,
    stressRounds: 2,
    stressUnique: 18
  },
  heavy: {
    semanticHotRounds: 6,
    uniqueSemanticCount: 72,
    codebaseIterations: 8,
    falsePositivePairs: 16,
    stressRounds: 3,
    stressUnique: 36
  }
};
const CONFIG = PROFILE_CONFIG[PROFILE] || PROFILE_CONFIG['cache-punish'];

// -----------------------------------------------------------------------------
// HTTP + UTILITIES
// -----------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalize(value = '') {
  return String(value ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

function estimateTokens(value = '') {
  const text = String(value || '');
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function makePrng(seedText) {
  let seed = 2166136261;
  for (const ch of String(seedText)) {
    seed ^= ch.charCodeAt(0);
    seed = Math.imul(seed, 16777619);
  }
  return () => {
    seed += 0x6d2b79f5;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, seed) {
  const arr = [...items];
  const random = makePrng(seed);
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Re-usable response helper
function postJSON(requestPath, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: HOST,
        port: PORT,
        path: requestPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        }
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          let parsed = null;
          try { parsed = body ? JSON.parse(body) : null; } catch { parsed = { raw: body }; }
          resolve({ statusCode: res.statusCode || 0, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getJSON(requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: HOST, port: PORT, path: requestPath, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve({ raw: body }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function tryAdminReset(label) {
  try {
    return await postJSON('/_admin/reset', { runId: RUN_ID, label });
  } catch (error) {
    return { statusCode: 0, body: { error: String(error.message || error) } };
  }
}

function stringifyPayloadPrompt(payload = {}) {
  if (Array.isArray(payload.messages)) {
    return payload.messages
      .map((m) => `${m.role || 'user'}:\n${normalize(m.content || '')}`)
      .join('\n\n');
  }
  return normalize([payload.systemPrompt, payload.userPrompt || payload.prompt].filter(Boolean).join('\n\n'));
}

function cacheAssisted(cacheEvent) {
  const event = String(cacheEvent || '').toLowerCase();
  return event.includes('hit') || event.includes('reuse');
}

function pct(n, d) {
  if (!d) return '0.00%';
  return `${((n / d) * 100).toFixed(2)}%`;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

function increment(map, key, amount = 1) {
  const safe = key || '<missing>';
  map[safe] = (map[safe] || 0) + amount;
}

// -----------------------------------------------------------------------------
// REALISTIC SYNTHETIC WORKLOAD DATA
// -----------------------------------------------------------------------------
const TENANTS = ['tenant-alpha', 'tenant-beta', 'tenant-gamma', 'tenant-delta'];
const REPOS = ['monorepo-payments', 'monorepo-search', 'monorepo-ml-platform'];

const SHALLOW_PROMPTS = [
  ['CS Tutor', 'Explain why Dijkstra fails with negative edge weights.'],
  ['CS Tutor', 'Compare LRU and LFU cache eviction in practical systems.'],
  ['CS Tutor', 'Why does binary search require a monotonic predicate?'],
  ['DevOps Engineer', 'Explain Docker bridge networking vs host networking.'],
  ['DevOps Engineer', 'What are the tradeoffs of bind mounts versus Docker volumes?'],
  ['Backend Engineer', 'Explain idempotency keys for payment APIs.'],
  ['Backend Engineer', 'How should an API gateway handle retries and backoff?'],
  ['ML Engineer', 'Explain dense vector retrieval and cosine similarity.'],
  ['ML Engineer', 'What is embedding drift in semantic search systems?'],
  ['Security Engineer', 'Explain why tenant scoping matters in cache systems.'],
  ['Frontend Engineer', 'How do you avoid layout shift in a streaming UI?'],
  ['Database Engineer', 'Compare write-ahead logging and snapshotting.']
];

const PARAPHRASE_PROMPTS = [
  ['CS Tutor', 'In practical cache systems, how are LFU and LRU different?'],
  ['DevOps Engineer', 'Contrast host networking with Docker bridge mode.'],
  ['Backend Engineer', 'Why do payment APIs use idempotency tokens?'],
  ['ML Engineer', 'How does cosine similarity support vector retrieval?'],
  ['Security Engineer', 'Why must a multi-tenant cache isolate namespaces?']
];

const FALSE_POSITIVE_PAIRS = [
  ['Docker safety', 'How do I create a Docker image for a Node service?', 'How do I delete all Docker images and volumes from my machine?'],
  ['Payment direction', 'How do I capture an authorized card payment?', 'How do I refund a captured card payment?'],
  ['Database migration', 'How do I apply a database migration safely?', 'How do I roll back a failed database migration safely?'],
  ['Kubernetes scaling', 'How do I scale a Kubernetes deployment up?', 'How do I scale a Kubernetes deployment down during an incident?'],
  ['Git operation', 'How do I merge a feature branch into main?', 'How do I revert a bad merge commit from main?'],
  ['Cache policy', 'When should I evict low-frequency cache entries?', 'When should I pin critical cache entries against eviction?'],
  ['Security policy', 'How do I grant read-only permissions to a service account?', 'How do I revoke permissions from a compromised service account?'],
  ['Search indexing', 'How do I add a document to a vector index?', 'How do I delete a document from a vector index?'],
  ['HTTP behavior', 'When should an API return HTTP 201?', 'When should an API return HTTP 409?'],
  ['Rollout control', 'How do I enable a feature flag for 5% of users?', 'How do I disable a broken feature flag immediately?'],
  ['Queue semantics', 'How do I acknowledge a processed message?', 'How do I dead-letter a poison message?'],
  ['Auth flow', 'How do I refresh an expired access token?', 'How do I revoke a stolen refresh token?'],
  ['Billing cycle', 'How do I start a monthly subscription?', 'How do I cancel a monthly subscription at period end?'],
  ['CDN purge', 'How do I cache static assets at the edge?', 'How do I purge stale static assets from the edge?'],
  ['Incident state', 'How do I declare a severity-two incident?', 'How do I resolve and close an incident?'],
  ['Package manager', 'How do I install a dependency with npm?', 'How do I remove a dependency from package.json?']
];

function codeLine(file, index, variant = 'stable') {
  const suffix = variant === 'stable' ? 'stable' : `${variant}_${index}`;
  return [
    `export function ${file.replace(/[^a-z0-9]/gi, '_')}_${index}_${suffix}(ctx) {`,
    `  const span = ctx.trace.startSpan('${file}:${index}:${suffix}');`,
    `  const policy = ctx.cachePolicy.resolve('${suffix}', ${index});`,
    `  const result = ctx.router.route(policy, ctx.request, ctx.tenantScope);`,
    `  span.setAttribute('cache.route', result.route);`,
    `  return result;`,
    `}`
  ].join('\n');
}

function pseudoFile(name, lines, variant = 'stable') {
  const body = Array.from({ length: lines }, (_, i) => codeLine(name, i, variant)).join('\n\n');
  return `// FILE: ${name}\n${body}`;
}

function buildRepoContext({ repoName, mutation = 'stable', variant = 0 }) {
  const headerVariant = mutation === 'early_header' ? `branch-${variant}-breaking-api-change` : 'main-stable';
  const manifestVariant = mutation === 'early_manifest' ? `deps-v${variant}-qdrant-client-change` : 'stable';
  const routerVariant = mutation === 'mid_router' ? `router-v${variant}-heuristic-rewrite` : 'stable';
  const policyVariant = mutation === 'mid_policy' ? `policy-v${variant}-lfu-tuning` : 'stable';
  const tailVariant = mutation === 'late_tail' ? `telemetry-v${variant}-new-metrics` : 'stable';

  const files = [
    `REPOSITORY: ${repoName}\nBRANCH: ${headerVariant}\nARCHITECTURE: Edge AI-CDN gateway with semantic cache, prefix cache, neighbor lookup, cost model, telemetry, and tenant scoping.`,
    pseudoFile('package.json', 5, manifestVariant),
    pseudoFile('server.js', 12, 'stable'),
    pseudoFile('aiCdnNode.js', 18, routerVariant),
    pseudoFile('clusterEngine.js', 14, routerVariant),
    pseudoFile('cachePolicy.js', 12, policyVariant),
    pseudoFile('prefixTrie.js', 16, policyVariant),
    pseudoFile('vectorCache.js', 14, 'stable'),
    pseudoFile('benchmarkTelemetry.js', 14, tailVariant),
    pseudoFile('README.md', 6, tailVariant)
  ];

  return files.join('\n\n---\n\n');
}

function codebasePayload({
  id,
  tenantId,
  repoName,
  mutation = 'stable',
  variant = 0,
  finalTask = 'Explain what should be changed and why.'
}) {
  const context = buildRepoContext({ repoName, mutation, variant });
  return {
    tenantId,
    companyId: 'acme-systems',
    repoId: repoName,
    messages: [
      { role: 'system', content: 'You are a senior code-review and refactoring agent. Use the repository context exactly.' },
      { role: 'user', content: context },
      // FIX: Removed unique task ${id} insertion from assistant reply to preserve exact prefix alignment for sequential queries
      { role: 'assistant', content: `Loaded ${repoName} repository context.` },
      { role: 'user', content: finalTask }
    ]
  };
}

function shallowPayload({ tenantId, systemPrompt, userPrompt, repoId = 'none' }) {
  return {
    tenantId,
    companyId: 'acme-systems',
    repoId,
    chatDepth: 1,
    systemPrompt,
    userPrompt
  };
}

// -----------------------------------------------------------------------------
// REQUEST EXECUTION + RECORD LEDGER
// -----------------------------------------------------------------------------
function deriveRecord(testCase, phase, round, statusCode, body, clientLatencyMs, error = null) {
  const telemetry = body?.telemetry || {};
  const promptText = stringifyPayloadPrompt(testCase.payload);
  const estimatedPromptTokens = estimateTokens(promptText);

  const route = telemetry.route || body?.route || null;
  const cacheEvent = telemetry.cacheEvent || body?.cacheEvent || (statusCode >= 200 && statusCode < 300 ? 'unknown' : 'error');
  const sourceNode = telemetry.sourceNode || body?.sourceNode || null;

  const rawPromptTokens = Number(telemetry.promptTokens || telemetry.rawPromptTokens || estimatedPromptTokens || 0);

  let actualPromptTokens = telemetry.actualPromptTokens;
  let tokensSaved = telemetry.tokensSaved;

  if (actualPromptTokens === undefined || actualPromptTokens === null) {
    if (cacheEvent === 'semantic_hit') actualPromptTokens = 0;
    else if (cacheEvent === 'prefix_reuse') actualPromptTokens = Math.max(0, rawPromptTokens - Number(telemetry.prefixTokensSaved || 0));
    else actualPromptTokens = rawPromptTokens;
  }

  if (tokensSaved === undefined || tokensSaved === null) {
    tokensSaved = Math.max(0, rawPromptTokens - actualPromptTokens);
  }

  return {
    runId: RUN_ID,
    id: testCase.id,
    phase,
    category: testCase.category,
    scenario: testCase.scenario || testCase.category,
    mutation: testCase.mutation || '',
    expected: testCase.expected || '',
    round,
    statusCode,
    ok: !error && statusCode >= 200 && statusCode < 300,
    error: error ? String(error.message || error) : '',
    route,
    cacheEvent,
    sourceNode,
    source: body?.source || '',
    semanticScore: telemetry.semanticScore ?? body?.score ?? '',
    neighborHit: Boolean(telemetry.neighborHit),
    neighborLookupAttempted: Boolean(telemetry.neighborLookupAttempted),
    costDecisionAction: telemetry.costDecisionAction || body?.costDecision?.action || '',
    rawPromptTokens,
    aiCdnPromptTokens: Number(actualPromptTokens || 0),
    tokensSaved: Number(tokensSaved || 0),
    prefixTokensSaved: Number(telemetry.prefixTokensSaved || 0),
    serverLatencyMs: Number(telemetry.latencyMs ?? body?.latencyMs ?? 0),
    clientLatencyMs: Number(clientLatencyMs || 0),
    requestChars: promptText.length
  };
}

async function runOne(testCase, phase, round = 0) {
  if (PACING_DELAY_MS > 0) await sleep(PACING_DELAY_MS);
  const start = performance.now();
  try {
    const payload = {
      requestId: `${RUN_ID}:${phase}:${round}:${testCase.id}`,
      ...testCase.payload
    };
    const { statusCode, body } = await postJSON(PRIMARY_PATH, payload);
    return deriveRecord(testCase, phase, round, statusCode, body, performance.now() - start);
  } catch (error) {
    return deriveRecord(testCase, phase, round, 0, null, performance.now() - start, error);
  }
}

async function runSequential(cases, phase, rounds = 1) {
  const records = [];
  for (let round = 0; round < rounds; round += 1) {
    for (const tc of cases) records.push(await runOne(tc, phase, round));
  }
  return records;
}

async function runConcurrent(cases, phase, rounds, concurrency) {
  const tasks = [];
  for (let round = 0; round < rounds; round += 1) {
    for (const tc of shuffle(cases, `${RUN_ID}:${phase}:${round}`)) tasks.push({ tc, round });
  }

  const records = [];
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const task = tasks[cursor++];
      if (!task) break;
      records.push(await runOne(task.tc, phase, task.round));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return records;
}

// -----------------------------------------------------------------------------
// WORKLOAD BUILDERS
// -----------------------------------------------------------------------------
function buildSanityCases() {
  const tenant = `${RUN_ID}-sanity`;
  return [
    {
      id: 'sanity_semantic_cold',
      category: 'sanity_semantic_cold',
      scenario: 'quick_broad_sanity',
      expected: 'miss',
      payload: shallowPayload({ tenantId: tenant, systemPrompt: 'CS Tutor', userPrompt: `Explain LFU cache eviction in one paragraph. ${RUN_ID}` })
    },
    {
      id: 'sanity_semantic_replay_a',
      category: 'sanity_semantic_replay',
      scenario: 'quick_broad_sanity',
      expected: 'miss_then_hit',
      payload: shallowPayload({ tenantId: tenant, systemPrompt: 'CS Tutor', userPrompt: `Explain LFU cache eviction in one paragraph. ${RUN_ID}` })
    },
    {
      id: 'sanity_semantic_replay_b',
      category: 'sanity_semantic_replay',
      scenario: 'quick_broad_sanity',
      expected: 'semantic_hit',
      payload: shallowPayload({ tenantId: tenant, systemPrompt: 'CS Tutor', userPrompt: `Explain LFU cache eviction in one paragraph. ${RUN_ID}` })
    },
    {
      id: 'sanity_tenant_a',
      category: 'sanity_tenant_isolation',
      scenario: 'quick_broad_sanity',
      expected: 'seed_miss',
      payload: shallowPayload({ tenantId: `${RUN_ID}-tenant-A`, systemPrompt: 'Security Tutor', userPrompt: 'Explain tenant cache isolation.' })
    },
    {
      id: 'sanity_tenant_b',
      category: 'sanity_tenant_isolation',
      scenario: 'quick_broad_sanity',
      expected: 'must_not_hit_tenant_a',
      payload: shallowPayload({ tenantId: `${RUN_ID}-tenant-B`, systemPrompt: 'Security Tutor', userPrompt: 'Explain tenant cache isolation.' })
    },
    {
      id: 'sanity_prefix_seed',
      category: 'sanity_prefix_reuse',
      scenario: 'quick_broad_sanity',
      expected: 'prefix_seed_miss',
      payload: codebasePayload({ id: 'sanity-prefix-a', tenantId: tenant, repoName: 'sanity-repo', finalTask: 'Find the routing function.' })
    },
    {
      id: 'sanity_prefix_probe',
      category: 'sanity_prefix_reuse',
      scenario: 'quick_broad_sanity',
      expected: 'prefix_reuse',
      payload: codebasePayload({ id: 'sanity-prefix-b', tenantId: tenant, repoName: 'sanity-repo', finalTask: 'Find the telemetry function.' })
    },
    {
      id: 'sanity_false_seed',
      category: 'sanity_false_positive_seed',
      scenario: 'quick_broad_sanity',
      expected: 'seed_miss',
      payload: shallowPayload({ tenantId: tenant, systemPrompt: 'DevOps Engineer', userPrompt: 'How do I create a Docker image for a Node service?' })
    },
    {
      id: 'sanity_false_probe',
      category: 'sanity_false_positive_probe',
      scenario: 'quick_broad_sanity',
      expected: 'should_miss_or_flag_risk',
      payload: shallowPayload({ tenantId: tenant, systemPrompt: 'DevOps Engineer', userPrompt: 'How do I delete all Docker images and volumes from my machine?' })
    }
  ];
}

function buildSemanticHotCases() {
  const cases = [];
  SHALLOW_PROMPTS.forEach(([sys, q], idx) => {
    cases.push({
      id: `sem_exact_${idx}`,
      category: 'semantic_hot_exact',
      scenario: 'repeated_shallow_zipf_like',
      expected: 'miss_then_semantic_hit',
      payload: shallowPayload({
        tenantId: `${RUN_ID}-${TENANTS[idx % TENANTS.length]}`,
        systemPrompt: sys,
        userPrompt: q,
        repoId: 'semantic-workload'
      })
    });
  });
  PARAPHRASE_PROMPTS.forEach(([sys, q], idx) => {
    cases.push({
      id: `sem_para_${idx}`,
      category: 'semantic_hot_paraphrase',
      scenario: 'paraphrased_shallow_queries',
      expected: 'may_semantic_hit_after_seed',
      payload: shallowPayload({
        tenantId: `${RUN_ID}-${TENANTS[idx % TENANTS.length]}`,
        systemPrompt: sys,
        userPrompt: q,
        repoId: 'semantic-workload'
      })
    });
  });
  return cases;
}

function buildUniqueSemanticCases(count, offset = 0, label = 'unique') {
  return Array.from({ length: count }, (_, j) => {
    const i = offset + j;
    return {
      id: `${label}_sem_${i}`,
      category: 'semantic_unique_one_shot',
      scenario: 'cold_unique_should_miss',
      expected: 'miss',
      payload: shallowPayload({
        tenantId: `${RUN_ID}-${label}-${i}`,
        systemPrompt: ['CS Tutor', 'DevOps Engineer', 'Security Engineer', 'ML Engineer'][i % 4],
        repoId: `${label}-repo-${i}`,
        userPrompt: [
          `Analyze a one-off incident where payment webhook ${i} was delivered after user cancellation and propose reconciliation logic.`,
          `Explain a unique debugging plan for container network namespace collision case ${i} with different host port mappings.`,
          `Design a custom access-control audit for tenant boundary case ${i} involving stale role grants.`,
          `Describe a unique embedding drift diagnostic for collection shard ${i} with changed document distributions.`
        ][i % 4]
      })
    };
  });
}

function buildFalsePositiveCases(pairCount) {
  const selected = FALSE_POSITIVE_PAIRS.slice(0, pairCount);
  const cases = [];
  selected.forEach(([name, seed, probe], i) => {
    const tenant = `${RUN_ID}-fp-${i}`;
    cases.push({
      id: `fp_seed_${i}`,
      category: 'semantic_false_positive_seed',
      scenario: 'one_shot_semantic_risk_audit',
      expected: 'seed_miss',
      payload: shallowPayload({ tenantId: tenant, systemPrompt: `${name} Expert`, repoId: 'false-positive-audit', userPrompt: seed })
    });
    cases.push({
      id: `fp_probe_${i}`,
      category: 'semantic_false_positive_probe',
      scenario: 'one_shot_semantic_risk_audit',
      expected: 'should_miss_if_intent_differs',
      payload: shallowPayload({ tenantId: tenant, systemPrompt: `${name} Expert`, repoId: 'false-positive-audit', userPrompt: probe })
    });
  });
  return cases;
}

function buildCodebaseMutationCases(iterations) {
  const cases = [];
  const tasks = [
    'Locate the cache insertion path and explain which telemetry fields should be emitted.',
    'Modify the route decision explanation to expose neighbor lookup reason codes.',
    'Explain how tenant scoping flows into the semantic cache and prefix cache.',
    'Find the highest-risk cache invalidation bug in this repository context.',
    'Add a benchmark metric for prompt-token savings versus raw inference baseline.',
    'Explain which files must change if Qdrant collections become node-specific.'
  ];

  for (let repoIndex = 0; repoIndex < REPOS.length; repoIndex += 1) {
    const repoName = REPOS[repoIndex];
    const tenant = `${RUN_ID}-codebase-${repoIndex}`;

    for (let i = 0; i < iterations; i += 1) {
      const task = tasks[(i + repoIndex) % tasks.length];
      cases.push({
        id: `code_stable_${repoIndex}_${i}`,
        category: 'codebase_stable_prefix',
        scenario: 'same_repo_context_different_final_tasks',
        mutation: 'stable',
        expected: i === 0 ? 'initial_miss' : 'high_prefix_reuse',
        payload: codebasePayload({ id: `stable-${repoIndex}-${i}`, tenantId: tenant, repoName, mutation: 'stable', variant: 0, finalTask: task })
      });
      cases.push({
        id: `code_late_${repoIndex}_${i}`,
        category: 'codebase_late_file_churn',
        scenario: 'low_level_tail_changes_should_preserve_large_prefix',
        mutation: 'late_tail',
        expected: 'partial_or_high_prefix_reuse',
        payload: codebasePayload({ id: `late-${repoIndex}-${i}`, tenantId: tenant, repoName, mutation: 'late_tail', variant: i, finalTask: task })
      });
      cases.push({
        id: `code_mid_${repoIndex}_${i}`,
        category: 'codebase_mid_file_churn',
        scenario: 'middle_file_changes_should_reduce_prefix_savings',
        mutation: i % 2 === 0 ? 'mid_router' : 'mid_policy',
        expected: 'lower_prefix_reuse_than_stable',
        payload: codebasePayload({ id: `mid-${repoIndex}-${i}`, tenantId: tenant, repoName, mutation: i % 2 === 0 ? 'mid_router' : 'mid_policy', variant: i, finalTask: task })
      });
      cases.push({
        id: `code_early_${repoIndex}_${i}`,
        category: 'codebase_early_churn',
        scenario: 'early_manifest_or_header_changes_should_punish_prefix_cache',
        mutation: i % 2 === 0 ? 'early_manifest' : 'early_header',
        expected: 'low_prefix_reuse_or_miss',
        payload: codebasePayload({ id: `early-${repoIndex}-${i}`, tenantId: tenant, repoName, mutation: i % 2 === 0 ? 'early_manifest' : 'early_header', variant: i, finalTask: task })
      });
    }
  }
  return cases;
}

// -----------------------------------------------------------------------------
// STATS + REPORTING
// -----------------------------------------------------------------------------
function aggregate(records, groupBy = null) {
  const groups = new Map();
  for (const r of records) {
    const key = groupBy ? String(r[groupBy] || '<missing>') : 'ALL';
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        requests: 0,
        failures: 0,
        misses: 0,
        semanticHits: 0,
        prefixReuse: 0,
        neighborHits: 0,
        cacheAssisted: 0,
        rawPromptTokens: 0,
        aiCdnPromptTokens: 0,
        tokensSaved: 0,
        clientLatencies: [],
        sourceCounts: {},
        eventCounts: {},
        routeCounts: {}
      });
    }
    const g = groups.get(key);
    g.requests += 1;
    if (!r.ok) g.failures += 1;
    if (r.cacheEvent === 'miss') g.misses += 1;
    if (r.cacheEvent === 'semantic_hit') g.semanticHits += 1;
    if (r.cacheEvent === 'prefix_reuse') g.prefixReuse += 1;
    if (r.neighborHit) g.neighborHits += 1;
    if (cacheAssisted(r.cacheEvent)) g.cacheAssisted += 1;
    g.rawPromptTokens += r.rawPromptTokens || 0;
    g.aiCdnPromptTokens += r.aiCdnPromptTokens || 0;
    g.tokensSaved += r.tokensSaved || 0;
    g.clientLatencies.push(r.clientLatencyMs || 0);
    increment(g.sourceCounts, r.sourceNode || r.source || '<none>');
    increment(g.eventCounts, r.cacheEvent || '<none>');
    increment(g.routeCounts, r.route || '<none>');
  }

  return [...groups.values()].map((g) => ({
    group: g.key,
    requests: g.requests,
    failures: g.failures,
    cacheAssistRate: pct(g.cacheAssisted, g.requests),
    misses: g.misses,
    semanticHits: g.semanticHits,
    prefixReuse: g.prefixReuse,
    neighborHits: g.neighborHits,
    rawPromptTokens: g.rawPromptTokens,
    aiCdnPromptTokens: g.aiCdnPromptTokens,
    tokensSaved: g.tokensSaved,
    tokenSavingsRate: pct(g.tokensSaved, g.rawPromptTokens),
    inferenceAvoidanceRate: pct(g.cacheAssisted, g.requests),
    p50ClientMs: percentile(g.clientLatencies, 50).toFixed(1),
    p95ClientMs: percentile(g.clientLatencies, 95).toFixed(1),
    sourceCounts: g.sourceCounts,
    eventCounts: g.eventCounts,
    routeCounts: g.routeCounts
  }));
}

function detectSanityFailures(sanityRecords) {
  const failures = [];
  const byId = Object.fromEntries(sanityRecords.map((r) => [r.id, r]));

  if (byId.sanity_tenant_b && byId.sanity_tenant_b.cacheEvent !== 'miss') {
    failures.push('Tenant isolation sanity failed: tenant-B hit tenant-A compatible cache entry.');
  }
  if (byId.sanity_prefix_probe && byId.sanity_prefix_probe.cacheEvent !== 'prefix_reuse') {
    failures.push(`Prefix reuse sanity expected prefix_reuse but got ${byId.sanity_prefix_probe.cacheEvent}.`);
  }
  if (byId.sanity_false_probe && byId.sanity_false_probe.cacheEvent === 'semantic_hit') {
    failures.push('False-positive sanity probe hit semantic cache; this is an over-aggressive reuse risk.');
  }
  if (sanityRecords.some((r) => !r.ok)) {
    failures.push('One or more sanity requests failed at HTTP level.');
  }
  return failures;
}

function detectBenchmarkWarnings(records) {
  const warnings = [];
  const byCategory = aggregate(records, 'category');
  const categoryMap = Object.fromEntries(byCategory.map((r) => [r.group, r]));

  const unique = categoryMap.semantic_unique_one_shot;
  if (unique && unique.cacheAssistRate !== '0.00%') {
    warnings.push(`Unique one-shot traffic had cache assistance (${unique.cacheAssistRate}); inspect for accidental reuse.`);
  }

  const fpProbe = categoryMap.semantic_false_positive_probe;
  if (fpProbe && (fpProbe.semanticHits || fpProbe.prefixReuse)) {
    warnings.push(`False-positive probes had ${fpProbe.semanticHits} semantic hits. This indicates semantic overmatching risk or threshold too low.`);
  }

  const stable = categoryMap.codebase_stable_prefix;
  const early = categoryMap.codebase_early_churn;
  if (stable && early) {
    const stableRate = stable.tokensSaved / Math.max(1, stable.rawPromptTokens);
    const earlyRate = early.tokensSaved / Math.max(1, early.rawPromptTokens);
    if (earlyRate >= stableRate * 0.9) {
      warnings.push('Early codebase churn saved nearly as much as stable contexts; prefix mutation test may not be punishing enough.');
    }
  }

  return warnings;
}

// -----------------------------------------------------------------------------
// LOGGING & SUMMARIES
// -----------------------------------------------------------------------------
function printAggregate(title, rows, limit = 40) {
  console.log(`\n=== ${title} ===`);
  console.table(rows.slice(0, limit).map((r) => ({
    group: r.group,
    requests: r.requests,
    failures: r.failures,
    misses: r.misses,
    semanticHits: r.semanticHits,
    prefixReuse: r.prefixReuse,
    neighborHits: r.neighborHits,
    cacheAssistRate: r.cacheAssistRate,
    rawTokens: r.rawPromptTokens,
    aiCdnTokens: r.aiCdnPromptTokens,
    tokensSaved: r.tokensSaved,
    tokenSavingsRate: r.tokenSavingsRate,
    p95ClientMs: r.p95ClientMs
  })));
}

function printSummary(records, sanityFailures, warnings) {
  const [total] = aggregate(records);
  const estimatedCostSaved = INPUT_COST_PER_MILLION > 0
    ? (total.tokensSaved / 1_000_000) * INPUT_COST_PER_MILLION
    : 0;

  console.log('\n============================================================');
  console.log(' AI-CDN TARGETED CACHE PUNISH BENCHMARK');
  console.log('============================================================');
  console.log(`Run ID                       : ${RUN_ID}`);
  console.log(`Profile                      : ${PROFILE}`);
  console.log(`Remote embedding pacing       : ${PACING_DELAY_MS}ms/request`);
  console.log(`Total requests                : ${total.requests}`);
  console.log(`Failures                      : ${total.failures}`);
  console.log(`Cache-assisted requests       : ${total.semanticHits + total.prefixReuse} (${total.cacheAssistRate})`);
  console.log(`Raw 100% inference tokens     : ${total.rawPromptTokens}`);
  console.log(`AI-CDN processed tokens       : ${total.aiCdnPromptTokens}`);
  console.log(`Prompt tokens saved           : ${total.tokensSaved} (${total.tokenSavingsRate})`);
  console.log(`Inference avoidance proxy     : ${total.inferenceAvoidanceRate}`);
  if (INPUT_COST_PER_MILLION > 0) {
    console.log(`Estimated input cost saved    : ${estimatedCostSaved.toFixed(6)} at ${INPUT_COST_PER_MILLION}/M tokens`);
  }
  console.log(`Client latency                : P50 ${total.p50ClientMs}ms | P95 ${total.p95ClientMs}ms`);

  if (sanityFailures.length) {
    console.log('\n❌ SANITY FAILURES');
    sanityFailures.forEach((f) => console.log(`- ${f}`));
  } else {
    console.log('\n✅ Quick sanity suite passed or produced no hard failures.');
  }

  if (warnings.length) {
    console.log('\n⚠️ BENCHMARK WARNINGS / INTERPRETATION NOTES');
    warnings.forEach((w) => console.log(`- ${w}`));
  } else {
    console.log('\n✅ No major benchmark warnings detected.');
  }
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function recordsToCsv(records) {
  const headers = [
    'runId', 'id', 'phase', 'category', 'scenario', 'mutation', 'expected', 'round',
    'statusCode', 'ok', 'error', 'route', 'cacheEvent', 'sourceNode', 'source',
    'semanticScore', 'neighborHit', 'neighborLookupAttempted', 'costDecisionAction',
    'rawPromptTokens', 'aiCdnPromptTokens', 'tokensSaved', 'prefixTokensSaved',
    'serverLatencyMs', 'clientLatencyMs', 'requestChars'
  ];
  return [headers.join(','), ...records.map((r) => headers.map((h) => csvEscape(r[h])).join(','))].join('\n');
}

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------
async function main() {
  console.log(`Starting targeted cache benchmark ${RUN_ID} on http://${HOST}:${PORT}`);
  const health = await getJSON('/health');
  if (!health?.ok) throw new Error('Server did not respond OK at /health. Start npm server first.');

  if (RESET_BEFORE_RUN) {
    console.log('Resetting cache state before sanity suite...');
    await tryAdminReset('before-sanity');
  }

  console.log('Running small broad sanity suite...');
  const sanityRecords = await runSequential(buildSanityCases(), 'sanity', 1);
  const sanityFailures = detectSanityFailures(sanityRecords);

  if (STRICT_SANITY && sanityFailures.length) {
    printSummary(sanityRecords, sanityFailures, []);
    throw new Error('STRICT_SANITY=true and sanity suite failed.');
  }

  if (RESET_BEFORE_RUN) {
    console.log('Resetting cache state before main cache-punish workload...');
    await tryAdminReset('before-main');
  }

  const uniqueCases = buildUniqueSemanticCases(CONFIG.uniqueSemanticCount, 0, 'unique');
  const semanticHotCases = buildSemanticHotCases();
  const falsePositiveCases = buildFalsePositiveCases(CONFIG.falsePositivePairs);
  const codebaseCases = buildCodebaseMutationCases(CONFIG.codebaseIterations);
  const stressWarmCases = shuffle([...semanticHotCases, ...codebaseCases], `${RUN_ID}:stress-warm`).slice(0, Math.min(80, semanticHotCases.length + codebaseCases.length));
  const stressUniqueCases = buildUniqueSemanticCases(
    CONFIG.stressUnique,
    100000,
    'stress-unique'
  ).map((tc) => ({
    ...tc,
    category: 'semantic_unique_stress',
    scenario: 'concurrent_fresh_unique_should_miss'
  }));

  const mainRecords = [];

  console.log(`Running unique one-shot semantic cold traffic (${uniqueCases.length})...`);
  mainRecords.push(...await runSequential(uniqueCases, 'unique_one_shot', 1));

  console.log(`Running one-shot false-positive audit (${falsePositiveCases.length})...`);
  mainRecords.push(...await runSequential(falsePositiveCases, 'false_positive_audit', 1));

  console.log(`Running semantic hot/paraphrase workload (${semanticHotCases.length} cases x ${CONFIG.semanticHotRounds} rounds)...`);
  mainRecords.push(...await runSequential(semanticHotCases, 'semantic_hot', CONFIG.semanticHotRounds));

  console.log(`Running codebase first-touch mutation workload (${codebaseCases.length} cases)...`);
  mainRecords.push(...await runSequential(codebaseCases, 'codebase_mutation', 1));

  console.log(`Running warm exact codebase reuse under concurrency (${stressWarmCases.length} cases x ${CONFIG.stressRounds} rounds @ ${STRESS_CONCURRENCY})...`);
  mainRecords.push(...await runConcurrent(stressWarmCases, 'stress_warm_cache', CONFIG.stressRounds, STRESS_CONCURRENCY));

  console.log(`Running fresh-unique concurrent stress (${stressUniqueCases.length} cases @ ${STRESS_CONCURRENCY})...`);
  mainRecords.push(...await runConcurrent(stressUniqueCases, 'stress_fresh_unique', 1, STRESS_CONCURRENCY));

  const allRecords = [...sanityRecords, ...mainRecords];
  const warnings = detectBenchmarkWarnings(mainRecords);

  printSummary(allRecords, sanityFailures, warnings);
  printAggregate('PHASE BREAKDOWN', aggregate(allRecords, 'phase'));
  printAggregate('CATEGORY BREAKDOWN', aggregate(allRecords, 'category'));
  printAggregate('CODEBASE MUTATION BREAKDOWN', aggregate(mainRecords.filter((r) => r.category.startsWith('codebase_')), 'mutation'));
  printAggregate('SCENARIO BREAKDOWN', aggregate(mainRecords, 'scenario'));

  console.log('\n=== CACHE EVENT COUNTS ===');
  console.table(Object.entries(aggregate(allRecords)[0].eventCounts || {}).map(([event, count]) => ({ event, count })));

  await fs.mkdir(REPORT_DIR, { recursive: true });
  const basePath = path.join(REPORT_DIR, RUN_ID);
  const mainAgg = aggregate(mainRecords)[0];
  const report = {
    runId: RUN_ID,
    profile: PROFILE,
    config: CONFIG,
    host: HOST,
    port: PORT,
    pacingDelayMs: PACING_DELAY_MS,
    summary: aggregate(allRecords)[0],
    mainSummary: mainAgg,
    sanityFailures,
    warnings,
    phaseBreakdown: aggregate(allRecords, 'phase'),
    categoryBreakdown: aggregate(allRecords, 'category'),
    mutationBreakdown: aggregate(mainRecords.filter((r) => r.category.startsWith('codebase_')), 'mutation'),
    scenarioBreakdown: aggregate(mainRecords, 'scenario'),
    records: allRecords
  };

  await fs.writeFile(`${basePath}-cache-punish-report.json`, JSON.stringify(report, null, 2));
  await fs.writeFile(`${basePath}-cache-punish-records.csv`, recordsToCsv(allRecords));
  await fs.writeFile(`${basePath}-cache-punish-summary.json`, JSON.stringify({
    runId: RUN_ID,
    profile: PROFILE,
    summary: report.summary,
    mainSummary: report.mainSummary,
    sanityFailures,
    warnings,
    phaseBreakdown: report.phaseBreakdown,
    categoryBreakdown: report.categoryBreakdown,
    mutationBreakdown: report.mutationBreakdown
  }, null, 2));

  console.log(`\nReports written:`);
  console.log(`- ${basePath}-cache-punish-report.json`);
  console.log(`- ${basePath}-cache-punish-records.csv`);
  console.log(`- ${basePath}-cache-punish-summary.json`);
}

main().catch((error) => {
  console.error('CRITICAL BENCHMARK FAILURE:', error);
  process.exitCode = 1;
});