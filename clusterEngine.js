class ClusterEngine {
    constructor({
        localExactLookupMs = 1,
        localVectorLookupMs = 8,
        localPrefixLookupMs = 3,
        neighborRttMs = 22,
        neighborLookupMs = 10,
        localInferenceBaseMs = 90,
        globalRttMs = 45,
        globalInferenceBaseMs = 80,
        tokenCostMs = 0.02,
        cheapRequestTokenCutoff = 180
    } = {}) {
        this.localExactLookupMs = localExactLookupMs;
        this.localVectorLookupMs = localVectorLookupMs;
        this.localPrefixLookupMs = localPrefixLookupMs;
        this.neighborRttMs = neighborRttMs;
        this.neighborLookupMs = neighborLookupMs;
        this.localInferenceBaseMs = localInferenceBaseMs;
        this.globalRttMs = globalRttMs;
        this.globalInferenceBaseMs = globalInferenceBaseMs;
        this.tokenCostMs = tokenCostMs;
        this.cheapRequestTokenCutoff = cheapRequestTokenCutoff;
    }

    estimateInferenceMs(promptTokens = 0, { global = false, prefixTokensSaved = 0 } = {}) {
        const base = global ? this.globalInferenceBaseMs : this.localInferenceBaseMs;
        const billablePromptTokens = Math.max(0, promptTokens - prefixTokensSaved);
        return base + billablePromptTokens * this.tokenCostMs;
    }

    decideMiss({
        route,
        promptTokens,
        estimatedNeighborHitRate = 0.35,
        prefixTokensSaved = 0,
        forceLocal = false,
        forceGlobal = false
    } = {}) {
        if (forceLocal) return { action: 'LOCAL_INFERENCE', reason: 'forced_local' };
        if (forceGlobal) return { action: 'GLOBAL_INFERENCE', reason: 'forced_global' };

        const localInferenceCost = this.estimateInferenceMs(promptTokens, { prefixTokensSaved });
        const globalInferenceCost = this.globalRttMs + this.estimateInferenceMs(promptTokens, { global: true, prefixTokensSaved });
        const neighborExpectedCost = this.neighborRttMs
            + this.neighborLookupMs
            + (1 - estimatedNeighborHitRate) * Math.min(localInferenceCost, globalInferenceCost);

        const isCheapSemanticRequest = route === 'SEMANTIC_PATH' && promptTokens <= this.cheapRequestTokenCutoff;
        if (isCheapSemanticRequest && localInferenceCost <= neighborExpectedCost) {
            return {
                action: 'LOCAL_INFERENCE',
                reason: 'cheap_shallow_request',
                costs: { localInferenceCost, globalInferenceCost, neighborExpectedCost }
            };
        }

        if (neighborExpectedCost < Math.min(localInferenceCost, globalInferenceCost)) {
            return {
                action: 'NEIGHBOR_LOOKUP',
                reason: 'neighbor_expected_cost_lower',
                costs: { localInferenceCost, globalInferenceCost, neighborExpectedCost }
            };
        }

        if (globalInferenceCost < localInferenceCost) {
            return {
                action: 'GLOBAL_INFERENCE',
                reason: 'global_inference_expected_cost_lower',
                costs: { localInferenceCost, globalInferenceCost, neighborExpectedCost }
            };
        }

        return {
            action: 'LOCAL_INFERENCE',
            reason: 'local_inference_expected_cost_lower',
            costs: { localInferenceCost, globalInferenceCost, neighborExpectedCost }
        };
    }
}

export default ClusterEngine;
