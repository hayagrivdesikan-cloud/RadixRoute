import { GoogleGenAI } from '@google/genai';
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
    constructor({ dimensions = Number(process.env.EMBEDDING_DIMENSIONS || 384) } = {}) {
        this.dimensions = dimensions;
        
        // Initialize the official Gemini client if the key exists
        if (process.env.GEMINI_API_KEY) {
            this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        } else {
            console.warn('[EmbeddingProvider] GEMINI_API_KEY missing in environmental variables. Defaulting to local hashing.');
        }
    }

    /**
     * Fallback mechanism only used if Gemini is unconfigured or encounters an outage
     */
    _localHashEmbedding(text) {
        const vector = new Array(this.dimensions).fill(0);
        const normalized = normalizeText(text).toLowerCase();
        const tokens = normalized.match(/[a-z0-9_+#.-]+/g) || [];

        for (const feature of tokens) {
            const hash = fnv1a32(feature);
            const index = hash % this.dimensions;
            const sign = (hash & 1) === 0 ? 1 : -1;
            vector[index] += sign;
        }

        return normalizeVector(vector);
    }

    /**
     * Live production method querying Gemini with compressed dimensions matching Qdrant
     */
    async _geminiEmbedding(text) {
        if (!this.ai) return null;

        // gemini-embedding-001 natively supports Matryoshka truncation down to specified dimensions
        const response = await this.ai.models.embedContent({
            model: 'gemini-embedding-001',
            contents: text,
            config: {
                outputDimensionality: this.dimensions
            }
        });

        // Robust parsing to catch structural layout differences in single/batch responses
        let embeddingValues = null;
        if (response.embedding?.values) {
            embeddingValues = response.embedding.values;
        } else if (Array.isArray(response.embeddings)) {
            embeddingValues = response.embeddings[0]?.values;
        } else if (response.embeddings?.values) {
            embeddingValues = response.embeddings.values;
        }

        if (!Array.isArray(embeddingValues)) {
            throw new Error('Gemini API response structure did not return valid embedding values.');
        }

        return normalizeVector(embeddingValues);
    }

    async embed(text) {
        if (this.ai) {
            try {
                return await this._geminiEmbedding(text);
            } catch (error) {
                console.warn(`[EmbeddingProvider] Gemini API failed. Falling back to local hash: ${error.message}`);
            }
        }

        return this._localHashEmbedding(text);
    }
}

export default EmbeddingProvider;