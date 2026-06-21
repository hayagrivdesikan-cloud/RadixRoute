import path from 'path';
import LFUPolicy from './cachePolicy.js';
import QueryClassifier from './classifier.js';
import PrefixTrie from './prefixTrie.js';
import VectorCache from './vectorCache.js';
import ClusterEngine from './clusterEngine.js';
import EmbeddingProvider from './embeddingProvider.js';
import PersistentJsonStore from './diskStore.js';
import { extractChatPayload, hashText, normalizeText, estimateTokens } from './utils.js';

class AICdnNode {
    constructor({
        nodeId,
        region,
        dataDir = './data',
        classifier = new QueryClassifier(),
        exactCache = new LFUPolicy({ maxEntries: 2048, maxBytes: 64 * 1024 * 1024 }),
        prefixCache = new PrefixTrie({ maxEntries: 512, maxBytes: 128 * 1024 * 1024 }),
        semanticCache = new VectorCache(),
        clusterEngine = new ClusterEngine(),
        embeddingProvider = new EmbeddingProvider()
    }) {
        this.nodeId = nodeId;
        this.region = region;
        this.classifier = classifier;
        this.exactCache = exactCache;
        this.prefixCache = prefixCache;
        this.semanticCache = semanticCache;
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

    _exactKey(payload) {
        return hashText(`${payload.scopeHash}\n${normalizeText(payload.fullPromptText || payload.userPrompt)}`);
    }

    _mockInference(payload, { route, source, prefixHit = null } = {}) {
        const prompt = payload.userPrompt || 'request';
        const prefixNote = prefixHit ? ` Reused ${prefixHit.tokensSaved} prefix tokens.` : '';
        return `[${route}] ${source}: ${prompt}${prefixNote}`;
    }

    _cacheExact(payload, response, metadata = {}) {
        this.exactCache.set(this._exactKey(payload), {
            response,
            metadata,
            createdAt: Date.now()
        });
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
        const prefixMaterial = payload.fullPromptText || payload.prefixText;
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

        const exact = this.exactCache.get(this._exactKey(payload));
        if (exact) {
            return {
                source: 'Neighbor Exact Cache',
                route,
                response: exact.response,
                metadata: exact.metadata || {}
            };
        }

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
                    metadata: semanticHit.metadata || {}
                };
            }
        }

        if (route === 'PREFIX_PATH') {
            const prefixHit = this.prefixCache.longestPrefixMatch(
                payload.scope,
                payload.fullPromptText || payload.prefixText
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

        const exact = this.exactCache.get(this._exactKey(payload));
        if (exact) {
            return {
                body: {
                    nodeId: this.nodeId,
                    region: this.region,
                    route: exact.metadata?.route || 'EXACT_PATH',
                    source: 'Local Exact Response Cache',
                    response: exact.response,
                    latencyMs: Date.now() - startTime
                }
            };
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
                this._cacheExact(payload, semanticHit.response, { route, source: 'semantic' });
                return {
                    body: {
                        nodeId: this.nodeId,
                        region: this.region,
                        route,
                        classifierReason: classification.reason,
                        source: 'Local Semantic Cache',
                        backend: semanticHit.backend,
                        score: semanticHit.score,
                        response: semanticHit.response,
                        latencyMs: Date.now() - startTime
                    }
                };
            }

            const decision = this.clusterEngine.decideMiss({
                route,
                promptTokens: payload.promptTokens,
                estimatedNeighborHitRate: payload.estimatedNeighborHitRate ?? payload.hitRateMetric ?? 0.35
            });

            if (decision.action === 'NEIGHBOR_LOOKUP') {
                const neighborHit = await this._lookupNeighbors(payload, route, embedding);
                if (neighborHit) {
                    this._cacheExact(payload, neighborHit.response, { route, source: 'neighbor' });
                    await this._cacheSemantic(payload, neighborHit.response, embedding, { source: 'neighbor_backfill' });
                    return {
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
                            costDecision: decision,
                            latencyMs: Date.now() - startTime
                        }
                    };
                }
            }

            const source = decision.action === 'GLOBAL_INFERENCE' ? 'Global Inference' : 'Local Inference';
            const response = this._mockInference(payload, { route, source });
            this._cacheExact(payload, response, { route, source });
            await this._cacheSemantic(payload, response, embedding, { source });
            this.diskStore.append({ type: 'semantic_response', scopeHash: payload.scopeHash, prompt: payload.userPrompt, response });

            return {
                body: {
                    nodeId: this.nodeId,
                    region: this.region,
                    route,
                    classifierReason: classification.reason,
                    source,
                    response,
                    costDecision: decision,
                    latencyMs: Date.now() - startTime
                }
            };
        }

        const prefixMaterial = payload.fullPromptText || payload.prefixText;
        const prefixHit = this.prefixCache.longestPrefixMatch(payload.scope, prefixMaterial);
        const prefixTokensSaved = prefixHit?.tokensSaved || 0;

        const decision = this.clusterEngine.decideMiss({
            route,
            promptTokens: payload.promptTokens,
            prefixTokensSaved,
            estimatedNeighborHitRate: payload.estimatedNeighborHitRate ?? payload.hitRateMetric ?? 0.45
        });

        let neighborHit = null;
        if (!prefixHit && decision.action === 'NEIGHBOR_LOOKUP') {
            neighborHit = await this._lookupNeighbors(payload, route);
        }

        const activePrefixHit = prefixHit || neighborHit?.prefixHit || null;
        const source = activePrefixHit
            ? (neighborHit ? 'Neighbor Prefix Cache + Inference' : 'Local Prefix Cache + Inference')
            : (decision.action === 'GLOBAL_INFERENCE' ? 'Global Inference' : 'Local Inference');

        const response = neighborHit?.response && activePrefixHit
            ? this._mockInference(payload, { route, source: 'Inference after neighbor prefix reuse', prefixHit: activePrefixHit })
            : this._mockInference(payload, { route, source, prefixHit: activePrefixHit });

        this._cacheExact(payload, response, { route, source });
        this._cachePrefix(payload, response, { source });
        this.diskStore.append({
            type: 'prefix_response',
            scopeHash: payload.scopeHash,
            prefixTokens: estimateTokens(prefixMaterial),
            response
        });

        return {
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
                costDecision: decision,
                latencyMs: Date.now() - startTime
            }
        };
    }

    stats() {
        return {
            nodeId: this.nodeId,
            region: this.region,
            exactCache: this.exactCache.stats(),
            prefixCache: this.prefixCache.stats(),
            semanticCache: this.semanticCache.stats(),
            neighbors: this.neighbors.map((node) => ({ nodeId: node.nodeId, region: node.region }))
        };
    }
}

export default AICdnNode;
