class QueryClassifier {
    constructor({ prefixDepthThreshold = 3, longPromptChars = 1800 } = {}) {
        this.prefixDepthThreshold = prefixDepthThreshold;
        this.longPromptChars = longPromptChars;
    }

    classify(metadata) {
        const prompt = metadata.fullPromptText || metadata.userPrompt || '';
        const chatDepth = Number(metadata.chatDepth || 1);
        const promptSize = Number(metadata.promptSize || prompt.length || 0);

        const hasAgenticMarkers = /```|\b(function|class|import|export|const|let|var|def|package\.json|dockerfile|traceback|stack trace)\b|<file>|<repo>|#!\/usr\/bin\/env/i.test(prompt);

        if (chatDepth >= this.prefixDepthThreshold) {
            return { route: 'PREFIX_PATH', reason: `chat_depth_${chatDepth}` };
        }

        if (promptSize >= this.longPromptChars || hasAgenticMarkers) {
            return { route: 'PREFIX_PATH', reason: hasAgenticMarkers ? 'agentic_or_code_context' : 'long_context' };
        }

        return { route: 'SEMANTIC_PATH', reason: `shallow_chat_depth_${chatDepth}` };
    }
}

export default QueryClassifier;
