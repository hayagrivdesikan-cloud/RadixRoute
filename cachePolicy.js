class LFUPolicy {
    constructor(maxCapacity = 3) {
        this.maxCapacity = maxCapacity;
        this.store = new Map(); // Key -> Data Payload
        this.frequencies = new Map(); // Key -> Access Count
    }

    get(key) {
        if (!this.store.has(key)) return null;

        // Increment access frequency (LFU Logic)
        const currentFreq = this.frequencies.get(key) || 0;
        this.frequencies.set(key, currentFreq + 1);

        return this.store.get(key);
    }

    set(key, value) {
        if (this.maxCapacity <= 0) return;

        // If key already exists, update data and bump frequency
        if (this.store.has(key)) {
            this.store.set(key, value);
            this.frequencies.set(key, (this.frequencies.get(key) || 0) + 1);
            return;
        }

        // Eviction Boundary Constraint logic
        if (this.store.size >= this.maxCapacity) {
            let minFreq = Infinity;
            let keyToEvict = null;

            // Scan frequencies to isolate the Least Frequently Used item
            for (const [k, freq] of this.frequencies.entries()) {
                if (freq < minFreq) {
                    minFreq = freq;
                    keyToEvict = k;
                }
            }

            if (keyToEvict) {
                console.log(`[Cache Policy] Capacity Blown. Evicting LFU key: "${keyToEvict}" (Frequency: ${minFreq})`);
                this.store.delete(keyToEvict);
                this.frequencies.delete(keyToEvict);
            }
        }

        // Insert fresh entry
        this.store.set(key, value);
        this.frequencies.set(key, 1); // Baseline frequency
    }
}

export default LFUPolicy;