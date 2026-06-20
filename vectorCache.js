class VectorCache {
    constructor(similarityThreshold = 0.92) {
        this.cache = []; // Array of { embedding, response, systemPrompt }
        this.threshold = similarityThreshold;
    }

    // High-performance dot product for normalized embeddings
    _cosineSimilarity(vecA, vecB) {
        let dotProduct = 0.0;
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
        }
        return dotProduct; 
    }

    insert(embedding, response, systemPrompt) {
        this.cache.push({ embedding, response, systemPrompt });
    }

    search(queryEmbedding, systemPrompt) {
        let bestMatch = null;
        let highestScore = -1;

        // Linear scan over current cache (perfect for local prototype validation)
        for (const item of this.cache) {
            if (item.systemPrompt !== systemPrompt) continue;

            const score = this._cosineSimilarity(queryEmbedding, item.embedding);
            if (score > highestScore) {
                highestScore = score;
                bestMatch = item;
            }
        }

        if (highestScore >= this.threshold) {
            return { response: bestMatch.response, score: highestScore };
        }

        return null;
    }
}

export default VectorCache;