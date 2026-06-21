import fs from 'fs';
import path from 'path';

class PersistentJsonStore {
    constructor(filePath, { maxRecords = 5000 } = {}) {
        this.filePath = filePath;
        this.maxRecords = maxRecords;
        this.records = [];
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        this._load();
    }

    _load() {
        if (!fs.existsSync(this.filePath)) return;
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            this.records = Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            console.warn(`[PersistentJsonStore] Could not read ${this.filePath}: ${error.message}`);
            this.records = [];
        }
    }

    _flush() {
        const limited = this.records.slice(-this.maxRecords);
        this.records = limited;
        fs.writeFileSync(this.filePath, JSON.stringify(limited, null, 2));
    }

    append(record) {
        this.records.push({ ...record, storedAt: Date.now() });
        this._flush();
    }

    latest(count = 50) {
        return this.records.slice(-count).reverse();
    }
}

export default PersistentJsonStore;
