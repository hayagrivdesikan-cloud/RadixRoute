import crypto from 'crypto';
import LFUPolicy from './cachePolicy.js';
import { cosineSimilarity } from './embeddingProvider.js';
import { hashText, normalizeText } from './utils.js';

class VectorCache {
    constructor({
        similarityThreshold = 0.86,
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
                console.warn(`[VectorCache] Qdrant collection check failed: ${error.message}`);
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
            throw new Error(
        `[VectorCache] Qdrant init failed: ${error.message}`
    );
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
        const parsed = text ? JSON.parse(text) : null;

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
        const payload = this._payload(scopeHash, prompt, response, metadata);
        const localKey = this._localKey(scopeHash, prompt);
        if (!this.qdrantReady) {
    throw new Error('Qdrant is not initialized');
}
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
            return { backend: 'qdrant', id: pointId };
        } catch (error) {
            throw new Error(
        `[VectorCache] Qdrant insert failed: ${error.message}`
    );
        }
    }

    async search({ scopeHash, embedding, limit = 1 }) {
        if (this.qdrantReady) {
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
                    return {
                        backend: 'qdrant',
                        score: match.score,
                        response: match.payload.response,
                        prompt: match.payload.prompt,
                        metadata: match.payload.metadata || {}
                    };
                }
            } catch (error) {
    throw new Error(
        `[VectorCache] Qdrant search failed: ${error.message}`
    );
}
        }

        

        

        

        return null;
    }

    stats() {
        return {
            backend: this.qdrantReady ? 'qdrant+memory' : 'offline',
            threshold: this.threshold,
            collection: this.collection,
            ...this.policy.stats()
        };
    }
}

export default VectorCache;
