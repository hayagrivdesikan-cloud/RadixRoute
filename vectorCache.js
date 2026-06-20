import LFUPolicy from './cachePolicy.js';

class VectorCache {
    constructor(similarityThreshold = 0.85, maxCapacity = 3) {
        this.policy = new LFUPolicy(maxCapacity);
        this.threshold = similarityThreshold;
    }

    _cosineSimilarity(vecA, vecB) {
        let dotProduct = 0.0;
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
        }
        return dotProduct;
    }

    insert(userPrompt, embedding, response, systemPrompt) {
        const cachePayload = { embedding, response, systemPrompt };
        // Pass management mechanics to the LFU tracking policy layer
        this.policy.set(userPrompt, cachePayload);
    }

    search(queryEmbedding, systemPrompt) {
        let bestMatchKey = null;
        let bestMatchPayload = null;
        let highestScore = -1;

        // Iterate over the policy store to look for geometric alignment
        for (const [userPrompt, item] of this.policy.store.entries()) {
            if (item.systemPrompt !== systemPrompt) continue;

            const score = this._cosineSimilarity(queryEmbedding, item.embedding);
            if (score > highestScore) {
                highestScore = score;
                bestMatchKey = userPrompt;
                bestMatchPayload = item;
            }
        }

        if (highestScore >= this.threshold && bestMatchKey) {
            // Re-trigger a get call on the policy layer to bump its LFU counter
            this.policy.get(bestMatchKey);
            return { response: bestMatchPayload.response, score: highestScore };
        }

        return null;
    }
}

export default VectorCache;