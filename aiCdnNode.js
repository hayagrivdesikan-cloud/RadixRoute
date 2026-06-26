import path from 'path';
import QueryClassifier from './classifier.js';
import PrefixTrie from './prefixTrie.js';
import VectorCache from './vectorCache.js';
import ClusterEngine from './clusterEngine.js';
import EmbeddingProvider from './embeddingProvider.js';
import PersistentJsonStore from './diskStore.js';
import { extractChatPayload, estimateTokens } from './utils.js';

function safeCollectionPart(value = '') {
    return String(value || 'node')
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'node';
}

class AICdnNode {
    constructor({
        nodeId,
        region,
        dataDir = './data',
        classifier = new QueryClassifier(),
        prefixCache = new PrefixTrie({ maxEntries: 512, maxBytes: 128 * 1024 * 1024 }),
        semanticCache = null,
        clusterEngine = new ClusterEngine(),
        embeddingProvider = new EmbeddingProvider()
    }) {
        this.nodeId = nodeId;
        this.region = region;
        this.classifier = classifier;
        this.prefixCache = prefixCache;
        this.semanticCache = semanticCache || new VectorCache({
            collection: process.env.SHARE_QDRANT_COLLECTIONS === 'true'
                ? (process.env.QDRANT_COLLECTION || 'ai_cdn_semantic_cache')
                : `${process.env.QDRANT_COLLECTION || 'ai_cdn_semantic_cache'}_${safeCollectionPart(nodeId)}`
        });
        this.clusterEngine = clusterEngine;
        this.embeddingProvider = embeddingProvider;
        this.neighbors = [];
        this.diskStore = new PersistentJsonStore(path.join(dataDir, `${nodeId}.json`));
    }

    async init() {
        await this.semanticCache.init();
    }

    addNeighbor(node) {
        if (node && node !== this && !this.neighbors.includes(node)) this.neighbors.push(node);
    }

    _mockInference(payload, { route, source, prefixHit = null } = {}) {
        const prompt = payload.userPrompt || 'request';
        const prefixNote = prefixHit ? ` Reused ${prefixHit.tokensSaved} prefix tokens.` : '';
        return `[${route}] ${source}: ${prompt}${prefixNote}`;
    }

    _prefixMaterialForInsert(payload) {
        return payload.prefixText || payload.fullPromptText || payload.userPrompt;
    }

    _prefixMaterialForLookup(payload) {
        return payload.fullPromptText || payload.prefixText || payload.userPrompt;
    }

    _baselineInferenceMs(payload) {
        return this.clusterEngine.estimateInferenceMs(payload.promptTokens);
    }

    _inferenceTypeFromDecision(decision, fallback = 'local') {
        if (!decision) return fallback;
        if (decision.action === 'GLOBAL_INFERENCE') return 'global';
        if (decision.action === 'LOCAL_INFERENCE') return 'local';
        return fallback;
    }

    _withTelemetry({
        body,
        payload,
        route,
        classification,
        startTime,
        cacheEvent = 'miss',
        sourceNode = 'inference',
        neighborLookupAttempted = false,
        neighborHit = false,
        inferenceType = 'none',
        prefixTokensSaved = 0,
        semanticScore = null,
        semanticBackend = null,
        matchedPrompt = null,
        matchedPromptHash = null,
        costDecision = null,
        extra = {}
    }) {
        const latencyMs = Date.now() - startTime;
        const baselinePromptTokens = payload.promptTokens;
        let actualPromptTokens = baselinePromptTokens;

        if (cacheEvent === 'semantic_hit') {
            actualPromptTokens = 0;
        } else if (cacheEvent === 'prefix_reuse') {
            actualPromptTokens = Math.max(0, baselinePromptTokens - prefixTokensSaved);
        }

        const tokensSaved = Math.max(0, baselinePromptTokens - actualPromptTokens);
        const baselineInferenceMs = this._baselineInferenceMs(payload);
        const estimatedActualInferenceMs = inferenceType === 'none'
            ? 0
            : this.clusterEngine.estimateInferenceMs(baselinePromptTokens, {
                global: inferenceType === 'global',
                prefixTokensSaved
            });

        const telemetry = {
            nodeId: this.nodeId,
            region: this.region,
            requestId: payload.requestId,
            route,
            classifierReason: classification.reason,
            cacheEvent,
            sourceNode,
            neighborLookupAttempted,
            neighborHit,
            inferenceType,
            promptTokens: baselinePromptTokens,
            baselinePromptTokens,
            actualPromptTokens,
            tokensSaved,
            prefixTokensSaved,
            semanticScore,
            semanticBackend,
            matchedPrompt,
            matchedPromptHash,
            baselineInferenceMs,
            estimatedActualInferenceMs,
            estimatedLatencySavedMs: Math.max(0, baselineInferenceMs - estimatedActualInferenceMs),
            costDecisionAction: costDecision?.action || null,
            costDecisionReason: costDecision?.reason || null,
            latencyMs,
            ...extra
        };

        return {
            body: {
                ...body,
                latencyMs,
                telemetry
            }
        };
    }

    async _cacheSemantic(payload, response, embedding, metadata = {}) {
        await this.semanticCache.insert({
            scopeHash: payload.scopeHash,
            prompt: payload.userPrompt,
            embedding,
            response,
            metadata: {
                ...metadata,
                nodeId: this.nodeId,
                route: 'SEMANTIC_PATH'
            }
        });
    }

    _cachePrefix(payload, response, metadata = {}) {
        const prefixMaterial = this._prefixMaterialForInsert(payload);
        return this.prefixCache.insert(payload.scope, prefixMaterial, {
            response,
            metadata: {
                ...metadata,
                nodeId: this.nodeId,
                route: 'PREFIX_PATH'
            }
        });
    }

    async _lookupNeighbors(payload, route, embedding = null) {
        for (const neighbor of this.neighbors) {
            const hit = await neighbor.lookupOnly(payload, route, embedding);
            if (hit) {
                return {
                    ...hit,
                    neighborNodeId: neighbor.nodeId,
                    neighborRegion: neighbor.region
                };
            }
        }
        return null;
    }

    async lookupOnly(payloadOrBody, route, embedding = null) {
        const payload = payloadOrBody.scopeHash ? payloadOrBody : extractChatPayload(payloadOrBody);

        if (route === 'SEMANTIC_PATH') {
            const queryEmbedding = embedding || await this.embeddingProvider.embed(payload.userPrompt);
            const semanticHit = await this.semanticCache.search({
                scopeHash: payload.scopeHash,
                embedding: queryEmbedding
            });
            if (semanticHit) {
                return {
                    source: 'Neighbor Semantic Cache',
                    route,
                    response: semanticHit.response,
                    score: semanticHit.score,
                    backend: semanticHit.backend,
                    matchedPrompt: semanticHit.prompt,
                    matchedPromptHash: semanticHit.promptHash,
                    metadata: semanticHit.metadata || {}
                };
            }
        }

        if (route === 'PREFIX_PATH') {
            const prefixHit = this.prefixCache.longestPrefixMatch(
                payload.scope,
                this._prefixMaterialForLookup(payload)
            );
            if (prefixHit) {
                return {
                    source: 'Neighbor Prefix Cache',
                    route,
                    response: prefixHit.payload.response,
                    prefixHit,
                    metadata: prefixHit.payload.metadata || {}
                };
            }
        }

        return null;
    }

    async handleRequest(body) {
        const startTime = Date.now();
        const payload = extractChatPayload(body);

        if (!payload.userPrompt) {
            return { statusCode: 400, body: { error: 'Missing user prompt string.' } };
        }

        const classification = this.classifier.classify(payload);
        const route = classification.route;

        if (route === 'SEMANTIC_PATH') {
            const embedding = await this.embeddingProvider.embed(payload.userPrompt);
            const semanticHit = await this.semanticCache.search({
                scopeHash: payload.scopeHash,
                embedding
            });

            if (semanticHit) {
                return this._withTelemetry({
                    body: {
                        nodeId: this.nodeId,
                        region: this.region,
                        route,
                        classifierReason: classification.reason,
                        source: 'Local Semantic Cache',
                        backend: semanticHit.backend,
                        score: semanticHit.score,
                        response: semanticHit.response
                    },
                    payload,
                    route,
                    classification,
                    startTime,
                    cacheEvent: 'semantic_hit',
                    sourceNode: 'local',
                    neighborLookupAttempted: false,
                    neighborHit: false,
                    inferenceType: 'none',
                    semanticScore: semanticHit.score,
                    semanticBackend: semanticHit.backend,
                    matchedPrompt: semanticHit.prompt,
                    matchedPromptHash: semanticHit.promptHash
                });
            }

            const decision = this.clusterEngine.decideMiss({
                route,
                promptTokens: payload.promptTokens,
                estimatedNeighborHitRate: payload.estimatedNeighborHitRate ?? payload.hitRateMetric ?? 0.35
            });

            let neighborLookupAttempted = false;
            if (decision.action === 'NEIGHBOR_LOOKUP') {
                neighborLookupAttempted = true;
                const neighborHit = await this._lookupNeighbors(payload, route, embedding);
                if (neighborHit) {
                    await this._cacheSemantic(payload, neighborHit.response, embedding, { source: 'neighbor_backfill' });
                    return this._withTelemetry({
                        body: {
                            nodeId: this.nodeId,
                            region: this.region,
                            route,
                            classifierReason: classification.reason,
                            source: neighborHit.source,
                            neighborNodeId: neighborHit.neighborNodeId,
                            neighborRegion: neighborHit.neighborRegion,
                            score: neighborHit.score,
                            response: neighborHit.response,
                            costDecision: decision
                        },
                        payload,
                        route,
                        classification,
                        startTime,
                        cacheEvent: 'semantic_hit',
                        sourceNode: 'neighbor',
                        neighborLookupAttempted,
                        neighborHit: true,
                        inferenceType: 'none',
                        semanticScore: neighborHit.score,
                        semanticBackend: neighborHit.backend,
                        matchedPrompt: neighborHit.matchedPrompt,
                        matchedPromptHash: neighborHit.matchedPromptHash,
                        costDecision: decision,
                        extra: {
                            neighborNodeId: neighborHit.neighborNodeId,
                            neighborRegion: neighborHit.neighborRegion
                        }
                    });
                }
            }

            const source = decision.action === 'GLOBAL_INFERENCE' ? 'Global Inference' : 'Local Inference';
            const response = this._mockInference(payload, { route, source });
            await this._cacheSemantic(payload, response, embedding, { source });
            this.diskStore.append({ type: 'semantic_response', scopeHash: payload.scopeHash, prompt: payload.userPrompt, response });

            return this._withTelemetry({
                body: {
                    nodeId: this.nodeId,
                    region: this.region,
                    route,
                    classifierReason: classification.reason,
                    source,
                    response,
                    costDecision: decision
                },
                payload,
                route,
                classification,
                startTime,
                cacheEvent: 'miss',
                sourceNode: 'inference',
                neighborLookupAttempted,
                neighborHit: false,
                inferenceType: this._inferenceTypeFromDecision(decision),
                costDecision: decision
            });
        }

        const prefixLookupMaterial = this._prefixMaterialForLookup(payload);
        const prefixHit = this.prefixCache.longestPrefixMatch(payload.scope, prefixLookupMaterial);
        const localPrefixTokensSaved = prefixHit?.tokensSaved || 0;

        const decision = this.clusterEngine.decideMiss({
            route,
            promptTokens: payload.promptTokens,
            prefixTokensSaved: localPrefixTokensSaved,
            estimatedNeighborHitRate: payload.estimatedNeighborHitRate ?? payload.hitRateMetric ?? 0.45
        });

        let neighborLookupAttempted = false;
        let neighborHit = null;
        if (!prefixHit && decision.action === 'NEIGHBOR_LOOKUP') {
            neighborLookupAttempted = true;
            neighborHit = await this._lookupNeighbors(payload, route);
        }

        const activePrefixHit = prefixHit || neighborHit?.prefixHit || null;
        const prefixTokensSaved = activePrefixHit?.tokensSaved || 0;
        const source = activePrefixHit
            ? (neighborHit ? 'Neighbor Prefix Cache + Inference' : 'Local Prefix Cache + Inference')
            : (decision.action === 'GLOBAL_INFERENCE' ? 'Global Inference' : 'Local Inference');

        const response = neighborHit?.response && activePrefixHit
            ? this._mockInference(payload, { route, source: 'Inference after neighbor prefix reuse', prefixHit: activePrefixHit })
            : this._mockInference(payload, { route, source, prefixHit: activePrefixHit });

        this._cachePrefix(payload, response, { source });
        this.diskStore.append({
            type: 'prefix_response',
            scopeHash: payload.scopeHash,
            prefixTokens: estimateTokens(this._prefixMaterialForInsert(payload)),
            response
        });

        const inferenceType = activePrefixHit
            ? 'local'
            : this._inferenceTypeFromDecision(decision);

        return this._withTelemetry({
            body: {
                nodeId: this.nodeId,
                region: this.region,
                route,
                classifierReason: classification.reason,
                source,
                response,
                prefixHit: activePrefixHit ? {
                    cacheKey: activePrefixHit.cacheKey,
                    matchedTokens: activePrefixHit.matchedTokens,
                    tokensSaved: activePrefixHit.tokensSaved,
                    neighborNodeId: neighborHit?.neighborNodeId,
                    neighborRegion: neighborHit?.neighborRegion
                } : null,
                costDecision: decision
            },
            payload,
            route,
            classification,
            startTime,
            cacheEvent: activePrefixHit ? 'prefix_reuse' : 'miss',
            sourceNode: activePrefixHit ? (neighborHit ? 'neighbor' : 'local') : 'inference',
            neighborLookupAttempted,
            neighborHit: Boolean(neighborHit),
            inferenceType,
            prefixTokensSaved,
            costDecision: decision,
            extra: {
                matchedPrefixTokens: activePrefixHit?.matchedTokens || 0,
                neighborNodeId: neighborHit?.neighborNodeId || null,
                neighborRegion: neighborHit?.neighborRegion || null
            }
        });
    }

    async clear() {
        this.prefixCache.clear();
        await this.semanticCache.clear();
        if (this.diskStore?.records) this.diskStore.records = [];
        return { nodeId: this.nodeId, cleared: true };
    }

    async semanticCount() {
        return this.semanticCache.count();
    }

    stats() {
        return {
            nodeId: this.nodeId,
            region: this.region,
            prefixCache: this.prefixCache.stats(),
            semanticCache: this.semanticCache.stats(),
            neighbors: this.neighbors.map((node) => ({ nodeId: node.nodeId, region: node.region }))
        };
    }
}

export default AICdnNode;
