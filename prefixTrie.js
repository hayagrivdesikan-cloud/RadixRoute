class TrieNode {
    constructor() {
        this.children = {};
        this.isEndOfPrompt = false;
        this.cachedResponse = null;
    }
}

class PrefixTrie {
    constructor() {
        this.root = new TrieNode();
    }

    // Standardizes lookups by combining system and user prompts
    _getCombinedKey(systemPrompt, userPrompt) {
        return `${systemPrompt.trim()}|||${userPrompt.trim()}`;
    }

    insert(systemPrompt, userPrompt, response) {
        const key = this._getCombinedKey(systemPrompt, userPrompt);
        let current = this.root;

        for (const char of key) {
            if (!current.children[char]) {
                current.children[char] = new TrieNode();
            }
            current = current.children[char];
        }
        current.isEndOfPrompt = true;
        current.cachedResponse = response;
    }

    search(systemPrompt, userPrompt) {
        const key = this._getCombinedKey(systemPrompt, userPrompt);
        let current = this.root;

        for (const char of key) {
            if (!current.children[char]) {
                return null; // Cache miss
            }
            current = current.children[char];
        }

        return current.isEndOfPrompt ? current.cachedResponse : null;
    }
}

export default PrefixTrie;