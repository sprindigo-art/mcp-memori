/**
 * Configuration loader dengan auto-detection
 * @module utils/config
 */
import { existsSync } from 'fs';
import { execSync } from 'child_process';

// Load .env jika ada
const envPath = new URL('../../.env', import.meta.url).pathname;
if (existsSync(envPath)) {
    const dotenv = await import('dotenv');
    dotenv.config({ path: envPath });
}

/**
 * Cek apakah ollama tersedia di sistem
 */
function detectOllama() {
    try {
        execSync('which ollama', { stdio: 'pipe' });
        execSync('ollama list', { stdio: 'pipe', timeout: 5000 });
        return true;
    } catch {
        return false;
    }
}

/**
 * Cek koneksi Postgres
 */
async function testPostgresConnection(url) {
    if (!url) return false;
    try {
        const pg = await import('pg');
        const client = new pg.default.Client({ connectionString: url });
        await client.connect();
        await client.query('SELECT 1');
        await client.end();
        return true;
    } catch {
        return false;
    }
}

// Auto-detect embedding mode: keyword_only | hybrid | vector_only
// v3.2: Default to hybrid with local sentence transformer (no Ollama required)
let rawEmbeddingMode = process.env.EMBEDDING_MODE || 'hybrid';

// Validate and fallback
const validModes = ['keyword_only', 'hybrid', 'vector_only'];
let embeddingMode = validModes.includes(rawEmbeddingMode) ? rawEmbeddingMode : 'keyword_only';

// v3.2: Local sentence transformer is available, so hybrid mode works without Ollama
// Only fallback if EMBEDDING_BACKEND explicitly set to 'off'
const embeddingBackend = process.env.EMBEDDING_BACKEND || 'local';
if (embeddingBackend === 'off') {
    embeddingMode = 'keyword_only';
}


// Export config
export const config = {
    // Database
    postgresUrl: process.env.POSTGRES_URL || null,
    sqlitePath: process.env.SQLITE_PATH || './data/memory.db',

    // Embedding Mode: keyword_only (default, deterministic) | hybrid | vector_only
    embeddingMode,
    ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
    ollamaModel: process.env.OLLAMA_MODEL || 'nomic-embed-text',

    // LAYER 1: Hybrid Score Weights (configurable)
    // Formula: keyword*wKeyword + vector*wVector + recency*wRecency
    scoreWeights: {
        keyword_only: { keyword: 0.75, vector: 0, recency: 0.25 },
        hybrid: { keyword: 0.5, vector: 0.3, recency: 0.2 },
        vector_only: { keyword: 0, vector: 0.8, recency: 0.2 }
    },

    // LAYER 3: Temporal Decay Factors per type
    // Lower = slower decay (rules/prefs persist longer than events)
    temporalDecay: {
        event: 0.15,       // Fast decay - events become less relevant quickly
        state: 0.1,        // Normal decay
        rule: 0.03,        // Very slow decay - rules persist
        preference: 0.02   // Slowest decay - preferences almost permanent
    },

    // LAYER 4: Governance Thresholds
    governance: {
        quarantineThreshold: 1,     // Feedback wrong count to quarantine
        deleteThreshold: 3,         // Error count to auto-delete
        loopBreakerThreshold: 2,    // Repeated mistakes before guardrail
        maxGuardrailsPerProject: 10
    },

    // MCP Server
    mcpPort: parseInt(process.env.MCP_PORT || '3100', 10),
    mcpHost: process.env.MCP_HOST || 'localhost',

    // Logging
    logLevel: process.env.LOG_LEVEL || 'info',

    // Defaults
    defaultTenant: process.env.DEFAULT_TENANT || 'local-user',
    defaultProject: process.env.DEFAULT_PROJECT || 'default',

    // Helpers
    testPostgresConnection,
    detectOllama,

    // Get effective weights for current mode
    getScoreWeights() {
        return this.scoreWeights[this.embeddingMode] || this.scoreWeights.keyword_only;
    },

    // Get temporal decay for type
    getTemporalDecay(temporalType) {
        return this.temporalDecay[temporalType] || this.temporalDecay.state;
    }
};

export default config;
