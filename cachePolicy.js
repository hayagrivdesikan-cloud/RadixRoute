class LFUPolicy {
    constructor({ maxEntries = 1024, maxBytes = 64 * 1024 * 1024, defaultTtlMs = null } = {}) {
        this.maxEntries = maxEntries;
        this.maxBytes = maxBytes;
        this.defaultTtlMs = defaultTtlMs;
        this.records = new Map();
        this.currentBytes = 0;
        this.evictions = 0;
    }

    _now() {
        return Date.now();
    }

    _estimateBytes(value) {
        try {
            return Buffer.byteLength(JSON.stringify(value), 'utf8');
        } catch {
            return Buffer.byteLength(String(value), 'utf8');
        }
    }

    _isExpired(record) {
        return record.expiresAt !== null && record.expiresAt <= this._now();
    }

    _touch(record) {
        record.frequency += 1;
        record.lastAccessedAt = this._now();
    }

    _remove(key) {
        const record = this.records.get(key);
        if (!record) return false;
        this.currentBytes -= record.bytes;
        this.records.delete(key);
        return true;
    }

    _evictOne() {
        let candidateKey = null;
        let candidate = null;

        for (const [key, record] of this.records.entries()) {
            if (!candidate) {
                candidateKey = key;
                candidate = record;
                continue;
            }

            const lowerFrequency = record.frequency < candidate.frequency;
            const sameFrequencyOlder = record.frequency === candidate.frequency
                && record.lastAccessedAt < candidate.lastAccessedAt;

            if (lowerFrequency || sameFrequencyOlder) {
                candidateKey = key;
                candidate = record;
            }
        }

        if (candidateKey !== null) {
            this._remove(candidateKey);
            this.evictions += 1;
            return candidateKey;
        }

        return null;
    }

    pruneExpired() {
        for (const [key, record] of this.records.entries()) {
            if (this._isExpired(record)) this._remove(key);
        }
    }

    get(key) {
        const record = this.records.get(key);
        if (!record) return null;

        if (this._isExpired(record)) {
            this._remove(key);
            return null;
        }

        this._touch(record);
        return record.value;
    }

    peek(key) {
        const record = this.records.get(key);
        if (!record) return null;

        if (this._isExpired(record)) {
            this._remove(key);
            return null;
        }

        return record.value;
    }

    set(key, value, { ttlMs = this.defaultTtlMs } = {}) {
        if (this.maxEntries <= 0 || this.maxBytes <= 0) return false;

        const now = this._now();
        const bytes = this._estimateBytes(value);
        const expiresAt = ttlMs ? now + ttlMs : null;

        if (bytes > this.maxBytes) {
            return false;
        }

        const existing = this.records.get(key);
        if (existing) {
            this.currentBytes -= existing.bytes;
            this.records.set(key, {
                value,
                bytes,
                frequency: existing.frequency + 1,
                createdAt: existing.createdAt,
                lastAccessedAt: now,
                expiresAt
            });
            this.currentBytes += bytes;
        } else {
            this.records.set(key, {
                value,
                bytes,
                frequency: 1,
                createdAt: now,
                lastAccessedAt: now,
                expiresAt
            });
            this.currentBytes += bytes;
        }

        this.pruneExpired();
        while (this.records.size > this.maxEntries || this.currentBytes > this.maxBytes) {
            this._evictOne();
        }

        return true;
    }

    delete(key) {
        return this._remove(key);
    }

    has(key) {
        return this.peek(key) !== null;
    }

    entries() {
        this.pruneExpired();
        return Array.from(this.records.entries()).map(([key, record]) => [key, record.value]);
    }

    metadata(key) {
        const record = this.records.get(key);
        if (!record || this._isExpired(record)) return null;
        return {
            frequency: record.frequency,
            bytes: record.bytes,
            createdAt: record.createdAt,
            lastAccessedAt: record.lastAccessedAt,
            expiresAt: record.expiresAt
        };
    }

    clear() {
        this.records.clear();
        this.currentBytes = 0;
        this.evictions = 0;
    }

    stats() {
        this.pruneExpired();
        return {
            entries: this.records.size,
            maxEntries: this.maxEntries,
            bytes: this.currentBytes,
            maxBytes: this.maxBytes,
            evictions: this.evictions
        };
    }
}

export default LFUPolicy;
