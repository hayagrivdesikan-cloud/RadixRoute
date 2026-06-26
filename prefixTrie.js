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
        this.maxEntries = maxEntries;
        this.maxBytes = maxBytes;
        this.root = new TrieNode();
        this.policy = new LFUPolicy({ maxEntries, maxBytes });
        this.minPrefixChars = minPrefixChars;
        this.insertions = 0;
        this.lookups = 0;
        this.hits = 0;
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
        const stored = this.policy.set(cacheKey, {
            ...payload,
            scope,
            prefixText: normalizedPrefix,
            prefixHash: hashText(normalizedPrefix).slice(0, 16),
            prefixChars: normalizedPrefix.length,
            prefixTokens: estimateTokens(normalizedPrefix),
            createdAt: Date.now()
        });

        if (stored) this.insertions += 1;
        return stored ? cacheKey : null;
    }

    longestPrefixMatch(scope, promptText, { minPrefixChars = this.minPrefixChars } = {}) {
        this.lookups += 1;

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

        const matchedText = normalizedPrompt.slice(0, matchedChars);
        const matchedTokens = estimateTokens(matchedText);
        const tokensSaved = Math.min(payload.prefixTokens, matchedTokens);

        this.hits += 1;
        return {
            cacheKey: bestKey,
            matchedChars,
            matchedTokens,
            tokensSaved,
            payload
        };
    }

    clear() {
        this.root = new TrieNode();
        this.policy.clear();
        this.insertions = 0;
        this.lookups = 0;
        this.hits = 0;
    }

    stats() {
        return {
            ...this.policy.stats(),
            minPrefixChars: this.minPrefixChars,
            insertions: this.insertions,
            lookups: this.lookups,
            hits: this.hits,
            hitRate: this.lookups ? this.hits / this.lookups : 0
        };
    }
}

export default PrefixTrie;
