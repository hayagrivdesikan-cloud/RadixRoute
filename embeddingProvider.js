import { normalizeText } from './utils.js';

export function normalizeVector(vector) {
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (!norm) return vector;
    return vector.map((value) => value / norm);
}

export function cosineSimilarity(vecA, vecB) {
    if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length) return -1;
    let dotProduct = 0;
    for (let i = 0; i < vecA.length; i += 1) dotProduct += vecA[i] * vecB[i];
    return dotProduct;
}

function fnv1a32(value) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

class EmbeddingProvider {
    constructor({ dimensions = 384, endpoint = process.env.EMBEDDING_ENDPOINT || null } = {}) {
        this.dimensions = dimensions;
        this.endpoint = endpoint;
    }

    _localHashEmbedding(text) {
        const vector = new Array(this.dimensions).fill(0);
        const normalized = normalizeText(text).toLowerCase();
        const tokens = normalized.match(/[a-z0-9_+#.-]+/g) || [];

        for (const token of tokens) {
            const features = [token];
            for (let i = 0; i < token.length - 2; i += 1) {
                features.push(token.slice(i, i + 3));
            }

            for (const feature of features) {
                const hash = fnv1a32(feature);
                const index = hash % this.dimensions;
                const sign = (hash & 1) === 0 ? 1 : -1;
                vector[index] += sign;
            }
        }

        return normalizeVector(vector);
    }

    async _remoteEmbedding(text) {
        if (!this.endpoint) return null;

        const response = await fetch(this.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input: text, dimensions: this.dimensions })
        });

        if (!response.ok) {
            throw new Error(`Embedding endpoint failed: ${response.status} ${response.statusText}`);
        }

        const payload = await response.json();
        const embedding = payload.embedding || payload.data?.[0]?.embedding;
        if (!Array.isArray(embedding)) {
            throw new Error('Embedding endpoint response did not contain an embedding array.');
        }

        return normalizeVector(embedding);
    }

    async embed(text) {
        if (this.endpoint) {
            try {
                return await this._remoteEmbedding(text);
            } catch (error) {
                console.warn(`[EmbeddingProvider] Remote embedding failed. Falling back to local hash embedding: ${error.message}`);
            }
        }

        return this._localHashEmbedding(text);
    }
}

export default EmbeddingProvider;
