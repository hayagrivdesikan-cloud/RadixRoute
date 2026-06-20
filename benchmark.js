const http = require('http');

// Helper to make automated HTTP POST requests to your Fastify server
function sendRequest(payload) {
    return new Promise((resolve) => {
        const data = JSON.stringify(payload);
        const options = {
            hostname: 'localhost',
            port: 3000,
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': data.length,
            },
        };

        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => resolve(JSON.parse(body)));
        });

        req.write(data);
        req.end();
    });
}

// Main execution loop
async function runSuite() {
    console.log("🚀 Starting AI-CDN System Metric Analysis Suite...\n");

    const telemetry = {
        totalRequests: 0,
        exactTrieHits: 0,
        semanticHits: 0,
        localInferenceMisses: 0,
        globalBypasses: 0,
        latencies: []
    };

    // Simulated Workload Dataset
    const baseRequests = [
        { systemPrompt: "Tutor", userPrompt: "Explain calculus", hitRateMetric: 0.8 },
        { systemPrompt: "Tutor", userPrompt: "Explain calculus", hitRateMetric: 0.8 }, // Exact Hit
        { systemPrompt: "Tutor", userPrompt: "Can you explain calculus?", hitRateMetric: 0.8 }, // Semantic Hit
        { systemPrompt: "Coder", userPrompt: "Write a trie tree in C++", hitRateMetric: 0.8 }, // Cold Miss
        { systemPrompt: "Coder", userPrompt: "Write a trie tree in C++", hitRateMetric: 0.2 }, // Low hitRate -> Shoud trigger dynamic Global Bypass
    ];

    // Loop to scale up requests and gather average bounds
    for (let i = 0; i < 50; i++) {
        for (const req of baseRequests) {
            telemetry.totalRequests++;
            const result = await sendRequest(req);
            
            telemetry.latencies.push(result.latencyMs);

            if (result.source.includes('Exact')) telemetry.exactTrieHits++;
            else if (result.source.includes('Semantic')) telemetry.semanticHits++;
            else if (result.source.includes('Global')) telemetry.globalBypasses++;
            else if (result.source.includes('Simulated')) telemetry.localInferenceMisses++;
        }
    }

    // Mathematical Aggregations
    const avgLatency = telemetry.latencies.reduce((a, b) => a + b, 0) / telemetry.latencies.length;
    const cacheHitRate = ((telemetry.exactTrieHits + telemetry.semanticHits) / telemetry.totalRequests) * 100;

    console.log("=== 📈 AI-CDN SYSTEM TELEMETRY REPORT ===");
    console.log(`Total Requests Processed : ${telemetry.totalRequests}`);
    console.log(`Exact Trie Hits          : ${telemetry.exactTrieHits} (${((telemetry.exactTrieHits/telemetry.totalRequests)*100).toFixed(1)}%)`);
    console.log(`Semantic Vector Hits     : ${telemetry.semanticHits} (${((telemetry.semanticHits/telemetry.totalRequests)*100).toFixed(1)}%)`);
    console.log(`Heuristic Global Bypasses: ${telemetry.globalBypasses} (${((telemetry.globalBypasses/telemetry.totalRequests)*100).toFixed(1)}%)`);
    console.log(`Compute Cache Misses     : ${telemetry.localInferenceMisses} (${((telemetry.localInferenceMisses/telemetry.totalRequests)*100).toFixed(1)}%)`);
    console.log(`-----------------------------------------`);
    console.log(`Net System Cache Hit Rate: ${cacheHitRate.toFixed(2)}%`);
    console.log(`Mean Pipeline Latency    : ${avgLatency.toFixed(2)} ms`);
    console.log("=========================================");
}

runSuite();