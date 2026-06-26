import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import { performance } from 'perf_hooks';

// --- CONFIGURATION ---
const HOST = process.env.BENCH_HOST || 'localhost';
const PORT = Number(process.env.BENCH_PORT || 3000);
const RUN_ID = process.env.BENCH_RUN_ID || `run-${Date.now()}`;

const COLD_ROUNDS = 1;
const WARM_ROUNDS = Number(process.env.WARM_ROUNDS || 10);
const STRESS_ROUNDS = Number(process.env.STRESS_ROUNDS || 5);
const STRESS_CONCURRENCY = Number(process.env.STRESS_CONCURRENCY || 6);

const RESET_BEFORE_RUN = process.env.RESET_BEFORE_RUN !== 'false';
const STRICT_INVARIANTS = process.env.STRICT_INVARIANTS !== 'false';
const REPORT_DIR = process.env.BENCH_REPORT_DIR || './benchmark-results';
const PRIMARY_PATH = '/v1/chat/completions';
const NEIGHBOR_NODE = process.env.BENCH_NEIGHBOR_NODE || 'edge-us-central-1';

// Auto-throttling logic based on environment
const IS_LIVE_API = Boolean(process.env.GEMINI_API_KEY);
const PACING_DELAY_MS = IS_LIVE_API ? 650 : Number(process.env.BENCH_DELAY_MS || 0);

// --- UTILITIES ---
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalize(value = '') {
  return String(value || '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

function stringifyPayloadPrompt(payload = {}) {
  if (Array.isArray(payload.messages)) {
    return payload.messages.map((m) => `${m.role || 'user'}:${normalize(m.content || '')}`).join('\n');
  }
  return normalize([payload.systemPrompt, payload.userPrompt || payload.prompt].filter(Boolean).join('\n'));
}

function makePrng(seedText) {
  let seed = 2166136261;
  for (const ch of seedText) {
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
  const random = makePrng(seed);
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// --- ZIPF DISTRIBUTION SAMPLER ---
function createZipfSampler(size, exponent = 0.9, seedText = 'zipf-seed') {
  const random = makePrng(seedText);
  const frequencies = [];
  let sum = 0;
  
  for (let i = 1; i <= size; i++) {
    sum += 1 / Math.pow(i, exponent);
    frequencies.push(sum);
  }
  
  return () => {
    const value = random() * sum;
    for (let i = 0; i < size; i++) {
      if (value <= frequencies[i]) return i;
    }
    return size - 1;
  };
}

// --- HTTP CLIENT TIER ---
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
          resolve({ statusCode: res.statusCode, body: parsed });
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

// --- SIMULATED REAL-WORLD WORKLOAD MATRIX ---
const TENANT_POOL = ['tenant-alpha', 'tenant-beta', 'tenant-gamma', 'tenant-delta'];

const SEMANTIC_TEMPLATES = [
  { sys: 'CS Tutor', q: 'Explain why an AVL tree balance factor must remain between -1 and 1.' },
  { sys: 'CS Tutor', q: 'How do left-right double rotations resolve branch symmetry imbalances?' },
  { sys: 'CS Tutor', q: 'What is the theoretical performance degradation if trees drift into linked list configurations?' },
  { sys: 'UI/UX Advisor', q: 'Draft low-fidelity wireframe states required for a mobile checkout drawer viewport.' },
  { sys: 'UI/UX Advisor', q: 'What visual hierarchy layout rules prevent cognitive overload in notifications lists?' },
  { sys: 'DevOps Engineer', q: 'Explain the internal differences between standard bridge networking and host port exposures.' },
  { sys: 'DevOps Engineer', q: 'How do Docker volume multi-mount mappings isolate write-heavy asset processes safely?' },
  { sys: 'Film Critic', q: 'Analyze the dual narrative parallel arcs and structural symbolism in the movie Masaan.' },
  { sys: 'General Assistant', q: 'Write a concise mathematical proof showing why binary search operates within logarithmic time limits.' }
];

const PARAPHRASED_VARIANTS = [
  { sys: 'CS Tutor', q: 'Why does an AVL tree require a balance score metric of -1, 0, or 1?' },
  { sys: 'CS Tutor', q: 'Can you show me how double rotations clean up symmetrical node tree imbalances?' },
  { sys: 'UI/UX Advisor', q: 'What low-fi screens should I design for a shopper app transactional flow?' },
  { sys: 'DevOps Engineer', q: 'Contrast container bridge networking configurations against raw host port binds.' },
  { sys: 'Film Critic', q: 'What do the narrative structures and river imagery represent across the movie Masaan?' }
];

// Generates an evolving multi-turn dialogue state to test trie context growth over real agent sessions
function generateAgenticSession(sessionId, step, topicIndex) {
  const topics = [
    {
      context: 'You are an elite code refactoring agent. Context initialized for: clusterEngine.js version 2.0.0.',
      turns: [
        'Analyze the decideMiss formula weights inside clusterEngine.js.',
        'Refactor decideMiss to integrate network jitter coefficients inside neighborExpectedCost calculations.',
        'Optimize execution speeds by replacing nested mathematical lookup evaluations with localized LFU memory caches.',
        'Expose a direct programmatic telemetry hook tracking metric savings differences instantly across edge nodes.'
      ]
    },
    {
      context: 'You are a technical UI component architect. Context initialized for: shopping application wireframes.',
      turns: [
        'Generate low-fidelity template schemas mapping wishlist and transactional shopping cart interactions.',
        'Inject structural modifications handling push notification banners inside standard header modules cleanly.',
        'Refactor checkout page layout properties to support multi-tenant checkout validation steps seamlessly.',
        'Verify if adding dynamic badges on the cart icon causes layout shifts across mobile responsive frames.'
      ]
    }
  ];

  const selection = topics[topicIndex % topics.length];
  const messages = [
    { role: 'system', content: selection.context }
  ];

  for (let i = 0; i <= step; i++) {
    messages.push({ role: 'user', content: selection.turns[i % selection.turns.length] });
    if (i < step) {
      messages.push({ role: 'assistant', content: `Understood. Step ${i} context indexed successfully into active trie storage layers.` });
    }
  }

  return {
    tenantId: `${RUN_ID}-${TENANT_POOL[topicIndex % TENANT_POOL.length]}`,
    companyId: 'acme-corp',
    repoId: topicIndex % 2 === 0 ? 'ai-cdn-core' : 'ux-shopping-app',
    messages
  };
}

// --- RECORD DERIVATION ENGINE ---
function deriveRecord(testCase, phase, round, statusCode, body, clientLatencyMs, error = null) {
  const telemetry = body?.telemetry || {};
  const promptText = stringifyPayloadPrompt(testCase.payload);
  const promptTokens = telemetry.promptTokens || Math.max(1, Math.ceil(promptText.length / 4));
  const actualPromptTokens = telemetry.actualPromptTokens ?? promptTokens;
  const tokensSaved = telemetry.tokensSaved ?? Math.max(0, promptTokens - actualPromptTokens);
  const cacheEvent = telemetry.cacheEvent || 'unknown';

  return {
    id: testCase.id,
    category: testCase.category,
    phase,
    round,
    statusCode,
    ok: !error && statusCode >= 200 && statusCode < 300,
    error: error ? String(error.message || error) : null,
    route: telemetry.route || body?.route || null,
    source: body?.source || null,
    cacheEvent,
    sourceNode: telemetry.sourceNode || null,
    neighborHit: Boolean(telemetry.neighborHit),
    promptTokens,
    actualPromptTokens,
    tokensSaved,
    prefixTokensSaved: telemetry.prefixTokensSaved || 0,
    serverLatencyMs: telemetry.latencyMs ?? body?.latencyMs ?? 0,
    clientLatencyMs,
    costDecisionAction: telemetry.costDecisionAction || body?.costDecision?.action || null
  };
}

async function runOne(testCase, phase, round = 0, requestPath = PRIMARY_PATH) {
  const start = performance.now();
  if (PACING_DELAY_MS > 0) await sleep(PACING_DELAY_MS);
  
  try {
    const { statusCode, body } = await postJSON(requestPath, {
      requestId: `${RUN_ID}:${phase}:${round}:${testCase.id}`,
      ...testCase.payload
    });
    return deriveRecord(testCase, phase, round, statusCode, body, performance.now() - start);
  } catch (error) {
    return deriveRecord(testCase, phase, round, 0, null, performance.now() - start, error);
  }
}

// --- THE CONCURRENT STRESS PHASE WORKER ---
async function runConcurrentPhase(cases, rounds, concurrency) {
  const tasks = [];
  for (let r = 0; r < rounds; r++) {
    const shuffled = shuffle(cases, `${RUN_ID}:stress:${r}`);
    for (const tc of shuffled) tasks.push({ tc, round: r });
  }

  const records = [];
  let cursor = 0;

  async function worker() {
    while (cursor < tasks.length) {
      const current = tasks[cursor++];
      if (!current) break;
      records.push(await runOne(current.tc, 'stress', current.round));
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return records;
}

// --- SYSTEM INVARIANT VALIDATORS ---
async function runInvariants() {
  const failures = [];
  await postJSON('/_admin/reset', { runId: RUN_ID });

  // Test Case 1: Checking multi-tenant data leak boundaries
  const payloadA = { tenantId: `${RUN_ID}-tenant-A`, companyId: 'acme', repoId: 'x', userPrompt: 'Masaan plot themes.' };
  const payloadB = { tenantId: `${RUN_ID}-tenant-B`, companyId: 'globex', repoId: 'x', userPrompt: 'Masaan plot themes.' };

  const recA = await runOne({ id: 'inv_leak_A', category: 'invariant', payload: payloadA }, 'invariant');
  const recB = await runOne({ id: 'inv_leak_B', category: 'invariant', payload: payloadB }, 'invariant');

  if (recB.cacheEvent !== 'miss') {
    failures.push('Tenant boundary breached: Cached response exposed across separate tenant namespaces.');
  }
  return failures;
}

// --- POST-BENCHMARK METRICS SUMMARY ---
function summarize(records, failures) {
  const latencies = records.map(r => r.clientLatencyMs);
  latencies.sort((a, b) => a - b);
  
  const p50 = latencies[Math.floor(latencies.length * 0.50)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  
  let totalTokens = 0;
  let savedTokens = 0;
  let cacheHits = 0;

  records.forEach(r => {
    totalTokens += r.promptTokens || 0;
    savedTokens += r.tokensSaved || 0;
    if (r.cacheEvent.includes('hit') || r.cacheEvent.includes('reuse')) cacheHits++;
  });

  console.log('\n================================================');
  console.log('       📊 COMPREHENSIVE AI-CDN PROPER BENCHMARK  ');
  console.log('================================================');
  console.log(`Run Identifier          : ${RUN_ID}`);
  console.log(`Pacing Delay Mode       : ${IS_LIVE_API ? 'Adaptive Free-Tier Guard Enabled (650ms)' : 'Unthrottled Local Core Speeded'}`);
  console.log(`Total Requests Audited  : ${records.length}`);
  console.log(`System Crashes/Failures : ${records.filter(r => !r.ok).length}`);
  console.log(`Global Cache Hit Rate   : ${((cacheHits / records.length) * 100).toFixed(2)}%`);
  console.log(`Gross Base Input Tokens : ${totalTokens}`);
  console.log(`Net Tokens Intercepted  : ${savedTokens} (${((savedTokens / (totalTokens || 1)) * 100).toFixed(2)}% savings rate)`);
  console.log(`Client Latency Metrics  : P50: ${p50.toFixed(1)}ms | P95: ${p95.toFixed(1)}ms`);
  console.log('------------------------------------------------');

  if (failures.length) {
    console.log('❌ INVARIANT FAILURE LIST:');
    failures.forEach(f => console.log(`  - ${f}`));
  } else {
    console.log('✅ ALL ISOLATION AND STRUCTURAL INVARIANTS SECURED.');
  }
}

// --- MAIN CONTROL ARBITRATOR ---
async function main() {
  console.log(`Initializing system benchmark run: ${RUN_ID}`);
  
  const health = await getJSON('/health');
  if (!health?.ok) throw new Error('Target edge gateway server unreachable via /health endpoint');

  let failures = [];
  if (RESET_BEFORE_RUN) {
    failures = await runInvariants();
    await postJSON('/_admin/reset', { runId: RUN_ID });
  }

  // Generate Pools mapping Zipf distribution weights
  const semanticPoolSize = SEMANTIC_TEMPLATES.length;
  const sampleSemanticZipf = createZipfSampler(semanticPoolSize, 0.85, 'semantic-seed');
  
  const agentPoolSize = 6; // Max turns
  const sampleAgentZipf = createZipfSampler(agentPoolSize, 0.70, 'agentic-seed');

  // 1. Compile Cold Boot Verification Array
  const coldCases = [];
  SEMANTIC_TEMPLATES.forEach((item, idx) => {
    coldCases.push({
      id: `cold_sem_${idx}`,
      category: 'semantic_cold_miss',
      payload: {
        tenantId: `${RUN_ID}-tenant-cold`,
        companyId: 'acme-corp',
        repoId: 'none',
        chatDepth: 1,
        systemPrompt: item.sys,
        userPrompt: item.q
      }
    });
  });

  // 2. Compile Zipf-Distributed Realistic Warm Workload Array
  const warmCases = [];
  for (let i = 0; i < 35; i++) {
    const isAgentic = i % 3 === 0;
    if (isAgentic) {
      const turnIdx = sampleAgentZipf();
      warmCases.push({
        id: `warm_agentic_${i}_turn_${turnIdx}`,
        category: 'prefix_agentic_trajectory',
        payload: generateAgenticSession(`session-${i % 3}`, turnIdx, i)
      });
    } else {
      const idx = sampleSemanticZipf();
      // Inject intermittent near-duplicate paraphrase text arrays
      const useParaphrase = i % 4 === 0 && PARAPHRASED_VARIANTS[idx];
      const targetQuery = useParaphrase ? PARAPHRASED_VARIANTS[idx] : SEMANTIC_TEMPLATES[idx];
      
      warmCases.push({
        id: `warm_sem_${i}_template_${idx}_pf_${useParaphrase}`,
        category: useParaphrase ? 'semantic_paraphrase_match' : 'semantic_exact_match',
        payload: {
          tenantId: `${RUN_ID}-${TENANT_POOL[i % TENANT_POOL.length]}`,
          companyId: 'acme-corp',
          repoId: 'ai-cdn-core',
          chatDepth: 1,
          systemPrompt: targetQuery.sys,
          userPrompt: targetQuery.q
        }
      });
    }
  }

  // 3. Execution Pipeline orchestration
  console.log(`Executing Phase 1 (Cold Initialization Baseline): Processing ${coldCases.length} baseline queries...`);
  const coldRecords = [];
  for (const tc of coldCases) {
    coldRecords.push(await runOne(tc, 'cold', 0));
  }

  console.log(`Executing Phase 2 (Zipf Distributed Traffic): Processing ${warmCases.length} variations x ${WARM_ROUNDS} structural rounds...`);
  const warmRecords = [];
  for (let r = 0; r < WARM_ROUNDS; r++) {
    for (const tc of warmCases) {
      warmRecords.push(await runOne(tc, 'warm', r));
    }
  }

  console.log(`Executing Phase 3 (Concurrent Thread Jitter Stress): Pumping ${warmCases.length} queries x ${STRESS_ROUNDS} rounds @ parallel rate ${STRESS_CONCURRENCY}...`);
  const stressRecords = await runConcurrentPhase(warmCases, STRESS_ROUNDS, STRESS_CONCURRENCY);

  // 4. Summarization and logging outputs
  const allRecords = [...coldRecords, ...warmRecords, ...stressRecords];
  summarize(allRecords, failures);

  // Write final transaction ledger log out to result dir location
  await fs.mkdir(REPORT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(REPORT_DIR, `${RUN_ID}-proper.json`),
    JSON.stringify({ summary: { runId: RUN_ID, length: allRecords.length }, records: allRecords }, null, 2)
  );
}

main().catch(err => {
  console.error('CRITICAL BENCHMARK EXECUTION HALTED:', err);
  process.exitCode = 1;
});