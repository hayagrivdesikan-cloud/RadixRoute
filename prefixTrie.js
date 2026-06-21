import LFUPolicy from './cachePolicy.js';
import { hashText, normalizeText, scopeKey, estimateTokens } from './utils.js';

class TrieNode {
    constructor() {
        this.children = new Map();
        this.cacheKey = null;
    }
}

class PrefixTrie {
    constructor({ maxEntries = 512, maxBytes = 128 * 1024 * 1024, minPrefixChars = 96 } = {}) {
        this.root = new TrieNode();
        this.policy = new LFUPolicy({ maxEntries, maxBytes });
        this.minPrefixChars = minPrefixChars;
    }

    _scopedText(scope, text) {
        return `${scopeKey(scope)}\n${normalizeText(text)}`;
    }

    insert(scope, prefixText, payload = {}) {
        const normalizedPrefix = normalizeText(prefixText);
        if (!normalizedPrefix || normalizedPrefix.length < this.minPrefixChars) return null;

        const scopedText = this._scopedText(scope, normalizedPrefix);
        const cacheKey = hashText(scopedText);
        let current = this.root;

        for (const char of scopedText) {
            if (!current.children.has(char)) current.children.set(char, new TrieNode());
            current = current.children.get(char);
        }

        current.cacheKey = cacheKey;
        this.policy.set(cacheKey, {
            ...payload,
            scope,
            prefixText: normalizedPrefix,
            prefixHash: hashText(normalizedPrefix).slice(0, 16),
            prefixChars: normalizedPrefix.length,
            prefixTokens: estimateTokens(normalizedPrefix),
            createdAt: Date.now()
        });

        return cacheKey;
    }

    longestPrefixMatch(scope, promptText, { minPrefixChars = this.minPrefixChars } = {}) {
        const normalizedPrompt = normalizeText(promptText);
        if (!normalizedPrompt || normalizedPrompt.length < minPrefixChars) return null;

        const scopedText = this._scopedText(scope, normalizedPrompt);
        const scopeHeaderLength = `${scopeKey(scope)}\n`.length;
        let current = this.root;
        let bestKey = null;
        let matchedChars = 0;

        for (let i = 0; i < scopedText.length; i += 1) {
            const char = scopedText[i];
            const next = current.children.get(char);
            if (!next) break;

            current = next;
            if (current.cacheKey) {
                const payload = this.policy.peek(current.cacheKey);
                const promptCharsMatched = i + 1 - scopeHeaderLength;
                if (payload && promptCharsMatched >= minPrefixChars) {
                    bestKey = current.cacheKey;
                    matchedChars = promptCharsMatched;
                }
            }
        }

        if (!bestKey) return null;
        const payload = this.policy.get(bestKey);
        if (!payload) return null;

        return {
            cacheKey: bestKey,
            matchedChars,
            matchedTokens: estimateTokens(normalizedPrompt.slice(0, matchedChars)),
            tokensSaved: Math.min(payload.prefixTokens, estimateTokens(normalizedPrompt.slice(0, matchedChars))),
            payload
        };
    }

    stats() {
        return this.policy.stats();
    }
}

export default PrefixTrie;
