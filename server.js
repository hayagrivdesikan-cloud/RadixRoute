import Fastify from 'fastify';
import PrefixTrie from './prefixTrie.js';
import VectorCache from './vectorCache.js';
import ClusterEngine from './clusterEngine.js';

const fastify = Fastify({ logger: true });
// ... rest of your server code remains exactly the same



// Initialize Tiers
const exactTier = new PrefixTrie();
const semanticTier = new VectorCache(0.90);
const optimizationEngine = new ClusterEngine();

// Simple mock helper to generate 1536-D embeddings based on string characters
function mockGetEmbedding(text) {
    const arr = new Array(1536).fill(0);
    for (let i = 0; i < text.length; i++) {
        arr[i % 1536] += text.charCodeAt(i);
    }
    // Normalize vector
    const magnitude = Math.sqrt(arr.reduce((sum, val) => sum + val * val, 0)) || 1;
    return arr.map(v => v / magnitude);
}

// Router Endpoint
fastify.post('/v1/chat/completions', async (request, reply) => {
    const { systemPrompt, userPrompt, hitRateMetric = 0.5 } = request.body;
    const startTime = Date.now();

    // Step 1: Dynamic Heuristic Bypass check
    if (optimizationEngine.shouldBypassCache(hitRateMetric)) {
        return {
            source: 'Global LLM (Bypass Triggered)',
            response: "This is a fresh response from the main global model cluster.",
            latencyMs: Date.now() - startTime
        };
    }

    // Step 2: Exact Match Tier Lookup
    const exactMatch = exactTier.search(systemPrompt, userPrompt);
    if (exactMatch) {
        return { source: 'Exact Cache (Trie Tier)', response: exactMatch, latencyMs: Date.now() - startTime };
    }

    // Step 3: Semantic Tier Lookup
    const queryEmbedding = mockGetEmbedding(userPrompt);
    const semanticMatch = semanticTier.search(queryEmbedding, systemPrompt);
    if (semanticMatch) {
        return { 
            source: 'Semantic Cache (Vector Tier)', 
            score: semanticMatch.score, 
            response: semanticMatch.response, 
            latencyMs: Date.now() - startTime 
        };
    }

    // Step 4: Cache Miss -> Local / Remote Simulated Model Inference
    const mockLlmResponse = `Generated response for: "${userPrompt}"`;
    
    // Backfill both cache tiers for subsequent optimizations
    exactTier.insert(systemPrompt, userPrompt, mockLlmResponse);
    semanticTier.insert(queryEmbedding, mockLlmResponse, systemPrompt);

    return {
        source: 'Simulated LLM Compute',
        response: mockLlmResponse,
        latencyMs: Date.now() - startTime
    };
});

// Run Server
const start = async () => {
    try {
        await fastify.listen({ port: 3000 });
        console.log("AI-CDN Gateway Prototype Listening on port 3000");
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};
start();