import crypto from 'crypto';
import LFUPolicy from './cachePolicy.js';
import { hashText, normalizeText } from './utils.js';

class VectorCache {
    constructor({
        similarityThreshold = 0.91,
        maxCapacity = 2048,
        maxBytes = 128 * 1024 * 1024,
        qdrantUrl = process.env.QDRANT_URL || null,
        qdrantApiKey = process.env.QDRANT_API_KEY || null,
        collection = process.env.QDRANT_COLLECTION || 'ai_cdn_semantic_cache',
        dimensions = Number(process.env.EMBEDDING_DIMENSIONS || 384)
    } = {}) {
        this.policy = new LFUPolicy({ maxEntries: maxCapacity, maxBytes });
        this.threshold = similarityThreshold;
        this.qdrantUrl = qdrantUrl ? qdrantUrl.replace(/\/$/, '') : null;
        this.qdrantApiKey = qdrantApiKey;
        this.collection = collection;
        this.dimensions = dimensions;
        this.qdrantReady = false;
        this.insertions = 0;
        this.searches = 0;
        this.hits = 0;
    }

    async init() {
        if (!this.qdrantUrl) {
            throw new Error('[VectorCache] Missing QDRANT_URL');
        }

        try {
            const existing = await this._request(`/collections/${this.collection}`, { method: 'GET' });
            if (existing?.status === 'green' || existing?.result) {
                this.qdrantReady = true;
                return true;
            }
        } catch (error) {
            if (!String(error.message).includes('404')) {
                throw new Error(`[VectorCache] Qdrant collection check failed: ${error.message}`);
            }
        }

        try {
            await this._request(`/collections/${this.collection}`, {
                method: 'PUT',
                body: {
                    vectors: {
                        size: this.dimensions,
                        distance: 'Cosine'
                    }
                }
            });
            this.qdrantReady = true;
            return true;
        } catch (error) {
            throw new Error(`[VectorCache] Qdrant init failed: ${error.message}`);
        }
    }

    async _request(path, { method = 'GET', body = undefined } = {}) {
        const headers = { 'Content-Type': 'application/json' };
        if (this.qdrantApiKey) headers['api-key'] = this.qdrantApiKey;

        const response = await fetch(`${this.qdrantUrl}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body)
        });

        const text = await response.text();
        let parsed = null;
        try {
            parsed = text ? JSON.parse(text) : null;
        } catch {
            parsed = { raw: text };
        }

        if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}: ${text}`);
        }

        return parsed;
    }

    _localKey(scopeHash, prompt) {
        return hashText(`${scopeHash}\n${normalizeText(prompt)}`);
    }

    _payload(scopeHash, prompt, response, metadata = {}) {
        return {
            scopeHash,
            prompt: normalizeText(prompt),
            response,
            metadata,
            promptHash: hashText(prompt).slice(0, 16),
            createdAt: Date.now()
        };
    }

    async insert({ scopeHash, prompt, embedding, response, metadata = {} }) {
        if (!this.qdrantReady) {
            throw new Error('Qdrant is not initialized');
        }

        const payload = this._payload(scopeHash, prompt, response, metadata);
        const localKey = this._localKey(scopeHash, prompt);
        this.policy.set(localKey, { ...payload, embedding });

        const pointId = crypto.randomUUID();
        try {
            await this._request(`/collections/${this.collection}/points?wait=true`, {
                method: 'PUT',
                body: {
                    points: [{
                        id: pointId,
                        vector: embedding,
                        payload
                    }]
                }
            });
            this.insertions += 1;
            return { backend: 'qdrant', id: pointId };
        } catch (error) {
            throw new Error(`[VectorCache] Qdrant insert failed: ${error.message}`);
        }
    }

    async search({ scopeHash, embedding, limit = 1 }) {
        this.searches += 1;

        if (!this.qdrantReady) {
            throw new Error('Qdrant is not initialized');
        }

        try {
            const result = await this._request(`/collections/${this.collection}/points/search`, {
                method: 'POST',
                body: {
                    vector: embedding,
                    limit,
                    score_threshold: this.threshold,
                    with_payload: true,
                    filter: {
                        must: [{ key: 'scopeHash', match: { value: scopeHash } }]
                    }
                }
            });

            const match = result?.result?.[0];
            if (match?.score >= this.threshold) {
                this.hits += 1;
                return {
                    backend: 'qdrant',
                    score: match.score,
                    response: match.payload.response,
                    prompt: match.payload.prompt,
                    promptHash: match.payload.promptHash,
                    metadata: match.payload.metadata || {}
                };
            }
        } catch (error) {
            throw new Error(`[VectorCache] Qdrant search failed: ${error.message}`);
        }

        return null;
    }

    async count() {
        if (!this.qdrantReady) return this.policy.stats().entries;

        try {
            const result = await this._request(`/collections/${this.collection}/points/count`, {
                method: 'POST',
                body: { exact: true }
            });
            return result?.result?.count ?? 0;
        } catch (error) {
            throw new Error(`[VectorCache] Qdrant count failed: ${error.message}`);
        }
    }

    async clear() {
        this.policy.clear();
        this.insertions = 0;
        this.searches = 0;
        this.hits = 0;

        if (!this.qdrantUrl) {
            this.qdrantReady = false;
            return { cleared: true, backend: 'memory' };
        }

        try {
            await this._request(`/collections/${this.collection}`, { method: 'DELETE' });
        } catch (error) {
            if (!String(error.message).includes('404')) {
                throw new Error(`[VectorCache] Qdrant clear failed: ${error.message}`);
            }
        }

        this.qdrantReady = false;
        await this.init();
        return { cleared: true, backend: 'qdrant', collection: this.collection };
    }

    stats() {
        const searches = this.searches;
        return {
            backend: this.qdrantReady ? 'qdrant+memory' : 'offline',
            threshold: this.threshold,
            collection: this.collection,
            dimensions: this.dimensions,
            insertions: this.insertions,
            searches,
            hits: this.hits,
            hitRate: searches ? this.hits / searches : 0,
            ...this.policy.stats()
        };
    }
}

export default VectorCache;
