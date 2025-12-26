/**
 * Simple structured logger
 * Writes ALL output to stderr to avoid corrupting JSON-RPC on stdout
 * @module utils/logger
 */
import config from './config.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = LEVELS[config.logLevel] ?? LEVELS.info;

function formatMessage(level, message, meta = {}) {
    const ts = new Date().toISOString();
    const metaStr = Object.keys(meta).length > 0 ? JSON.stringify(meta) : '';
    return `[${ts}] [${level.toUpperCase()}] ${message} ${metaStr}`.trim();
}

// Write to stderr to avoid corrupting stdout (used by MCP JSON-RPC)
function writeStderr(msg) {
    process.stderr.write(msg + '\n');
}

export const logger = {
    error(msg, meta) {
        if (currentLevel >= LEVELS.error) {
            writeStderr(formatMessage('error', msg, meta));
        }
    },
    warn(msg, meta) {
        if (currentLevel >= LEVELS.warn) {
            writeStderr(formatMessage('warn', msg, meta));
        }
    },
    info(msg, meta) {
        if (currentLevel >= LEVELS.info) {
            writeStderr(formatMessage('info', msg, meta));
        }
    },
    debug(msg, meta) {
        if (currentLevel >= LEVELS.debug) {
            writeStderr(formatMessage('debug', msg, meta));
        }
    },
};

export default logger;

