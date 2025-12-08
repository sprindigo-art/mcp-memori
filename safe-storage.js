#!/usr/bin/env node
/**
 * SAFE STORAGE MODULE v1.0.0
 * Multi-instance safe file operations dengan:
 * - File locking (proper-lockfile)
 * - Atomic writes (temp file + rename)
 * - Retry mechanism dengan exponential backoff
 * - Stale lock detection dan auto-cleanup
 */

import lockfile from 'proper-lockfile';
import AsyncLock from 'async-lock';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// In-memory lock untuk operasi dalam process yang sama
const asyncLock = new AsyncLock({ timeout: 30000, maxPending: 1000 });

// Konfigurasi default - v12.0 UPDATE: Increased timeouts for multi-instance
const DEFAULT_CONFIG = {
    lockRetries: 7,        // v12.0: Increased from 5 to 7
    lockRetryWait: 150,    // v12.0: Increased from 100 to 150
    lockStale: 30000,      // v12.0: Increased from 10s to 30s for multi-instance (2-3 droid)
    lockUpdate: 10000,     // v12.0: Increased from 5s to 10s
    writeRetries: 4,       // v12.0: Increased from 3 to 4
    writeRetryDelay: 300   // v12.0: Increased from 200 to 300
};

/**
 * SafeStorage - Wrapper untuk operasi file yang thread-safe
 */
class SafeStorage {
    constructor(filePath, config = {}) {
        this.filePath = filePath;
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.instanceId = `${process.pid}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        this.releaseLock = null;
        this.lockKey = `file_${path.basename(filePath)}`;
        
        console.error(`[SafeStorage] Initialized for: ${filePath} (Instance: ${this.instanceId})`);
    }

    /**
     * Acquire file lock dengan retry
     */
    async acquireLock() {
        const lockOptions = {
            stale: this.config.lockStale,
            update: this.config.lockUpdate,
            retries: {
                retries: this.config.lockRetries,
                minTimeout: this.config.lockRetryWait,
                maxTimeout: this.config.lockRetryWait * 10,
                factor: 2
            }
        };

        try {
            // Pastikan file ada sebelum lock
            if (!fs.existsSync(this.filePath)) {
                fs.writeFileSync(this.filePath, '{}', 'utf-8');
            }

            this.releaseLock = await lockfile.lock(this.filePath, lockOptions);
            console.error(`[SafeStorage] Lock acquired: ${this.filePath} (Instance: ${this.instanceId})`);
            return true;
        } catch (error) {
            if (error.code === 'ELOCKED') {
                console.error(`[SafeStorage] File locked by another process: ${this.filePath}`);
                // Coba check apakah lock stale
                try {
                    const isLocked = await lockfile.check(this.filePath, { stale: this.config.lockStale });
                    if (!isLocked) {
                        // Lock stale, coba acquire lagi
                        this.releaseLock = await lockfile.lock(this.filePath, lockOptions);
                        return true;
                    }
                } catch (checkError) {
                    console.error(`[SafeStorage] Lock check error: ${checkError.message}`);
                }
            }
            throw error;
        }
    }

    /**
     * Release file lock
     */
    async releaseLockSafe() {
        if (this.releaseLock) {
            try {
                await this.releaseLock();
                console.error(`[SafeStorage] Lock released: ${this.filePath}`);
            } catch (error) {
                console.error(`[SafeStorage] Error releasing lock: ${error.message}`);
            }
            this.releaseLock = null;
        }
    }

    /**
     * Atomic write - write ke temp file lalu rename
     */
    async atomicWrite(data) {
        const tempPath = `${this.filePath}.${this.instanceId}.tmp`;
        const backupPath = `${this.filePath}.backup`;

        try {
            // Write ke temp file
            const jsonData = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
            fs.writeFileSync(tempPath, jsonData, 'utf-8');

            // Backup file lama jika ada
            if (fs.existsSync(this.filePath)) {
                try {
                    fs.copyFileSync(this.filePath, backupPath);
                } catch (backupError) {
                    console.error(`[SafeStorage] Backup failed (non-critical): ${backupError.message}`);
                }
            }

            // Atomic rename
            fs.renameSync(tempPath, this.filePath);
            
            return true;
        } catch (error) {
            // Cleanup temp file jika gagal
            if (fs.existsSync(tempPath)) {
                try {
                    fs.unlinkSync(tempPath);
                } catch (cleanupError) {
                    console.error(`[SafeStorage] Cleanup temp failed: ${cleanupError.message}`);
                }
            }
            throw error;
        }
    }

    /**
     * Safe read dengan locking
     */
    async safeRead() {
        return asyncLock.acquire(this.lockKey, async () => {
            try {
                await this.acquireLock();
                
                if (!fs.existsSync(this.filePath)) {
                    return null;
                }

                const content = fs.readFileSync(this.filePath, 'utf-8');
                return JSON.parse(content);
            } finally {
                await this.releaseLockSafe();
            }
        });
    }

    /**
     * Safe write dengan locking dan atomic write
     */
    async safeWrite(data) {
        return asyncLock.acquire(this.lockKey, async () => {
            let retries = this.config.writeRetries;
            let lastError;

            while (retries > 0) {
                try {
                    await this.acquireLock();
                    await this.atomicWrite(data);
                    return true;
                } catch (error) {
                    lastError = error;
                    retries--;
                    
                    if (retries > 0) {
                        console.error(`[SafeStorage] Write retry ${this.config.writeRetries - retries}/${this.config.writeRetries}: ${error.message}`);
                        await new Promise(r => setTimeout(r, this.config.writeRetryDelay * (this.config.writeRetries - retries)));
                    }
                } finally {
                    await this.releaseLockSafe();
                }
            }

            throw lastError;
        });
    }

    /**
     * Safe read-modify-write pattern
     */
    async safeModify(modifyFn) {
        return asyncLock.acquire(this.lockKey, async () => {
            try {
                await this.acquireLock();

                // Read
                let data = {};
                if (fs.existsSync(this.filePath)) {
                    const content = fs.readFileSync(this.filePath, 'utf-8');
                    data = JSON.parse(content);
                }

                // Modify
                const modifiedData = await modifyFn(data);

                // Write
                await this.atomicWrite(modifiedData);

                return modifiedData;
            } finally {
                await this.releaseLockSafe();
            }
        });
    }

    /**
     * Check apakah file sedang di-lock oleh process lain
     */
    async isLockedByOther() {
        try {
            const isLocked = await lockfile.check(this.filePath, { stale: this.config.lockStale });
            return isLocked;
        } catch (error) {
            return false;
        }
    }

    /**
     * Get file info termasuk lock status
     */
    async getStatus() {
        const exists = fs.existsSync(this.filePath);
        let size = 0;
        let lastModified = null;

        if (exists) {
            const stats = fs.statSync(this.filePath);
            size = stats.size;
            lastModified = stats.mtime.toISOString();
        }

        const isLocked = await this.isLockedByOther();

        return {
            filePath: this.filePath,
            exists,
            size,
            sizeHuman: this.formatBytes(size),
            lastModified,
            isLocked,
            instanceId: this.instanceId
        };
    }

    formatBytes(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
}

/**
 * LowDB Wrapper dengan SafeStorage
 * Drop-in replacement untuk LowDB yang thread-safe
 */
class SafeLowDB {
    constructor(filePath, defaultData = {}) {
        this.storage = new SafeStorage(filePath);
        this.defaultData = defaultData;
        this.data = null;
        this.filePath = filePath;
    }

    async read() {
        try {
            const content = await this.storage.safeRead();
            this.data = content || { ...this.defaultData };
            
            // Ensure all default fields exist
            for (const [key, value] of Object.entries(this.defaultData)) {
                if (!(key in this.data)) {
                    this.data[key] = value;
                }
            }
            
            return this.data;
        } catch (error) {
            console.error(`[SafeLowDB] Read error: ${error.message}`);
            this.data = { ...this.defaultData };
            return this.data;
        }
    }

    async write() {
        try {
            await this.storage.safeWrite(this.data);
            return true;
        } catch (error) {
            console.error(`[SafeLowDB] Write error: ${error.message}`);
            throw error;
        }
    }

    async modify(modifyFn) {
        return this.storage.safeModify(async (data) => {
            this.data = data || { ...this.defaultData };
            await modifyFn(this.data);
            return this.data;
        });
    }

    async getStatus() {
        return this.storage.getStatus();
    }
}

/**
 * Helper functions untuk direct JSON file operations
 */
export async function safeReadJson(filePath, defaultValue = {}) {
    const storage = new SafeStorage(filePath);
    try {
        const data = await storage.safeRead();
        return data || defaultValue;
    } catch (error) {
        console.error(`[safeReadJson] Error: ${error.message}`);
        return defaultValue;
    }
}

export async function safeWriteJson(filePath, data) {
    const storage = new SafeStorage(filePath);
    return storage.safeWrite(data);
}

export async function safeModifyJson(filePath, modifyFn, defaultValue = {}) {
    const storage = new SafeStorage(filePath);
    return storage.safeModify(async (data) => {
        const result = await modifyFn(data || defaultValue);
        return result;
    });
}

export async function checkFileLockStatus(filePath) {
    const storage = new SafeStorage(filePath);
    return storage.getStatus();
}

export { SafeStorage, SafeLowDB };
export default SafeLowDB;
