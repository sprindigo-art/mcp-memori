/**
 * memory.maintain v6.0 — File-based Runbook Maintenance
 * @module mcp/tools/memory.maintain
 */
import { RUNBOOKS_DIR, getStats } from '../../storage/files.js';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger.js';

export const definition = {
    name: 'memory_maintain',
    description: 'Maintenance runbook files: list stats, check health',
    inputSchema: {
        type: 'object',
        properties: {
            project_id: { type: 'string', description: 'Project ID' },
            mode: { type: 'string', enum: ['dry_run', 'apply'], description: 'Mode' },
            actions: { type: 'array', items: { type: 'string' }, description: 'Ignored — file system needs no maintenance' },
            policy: { type: 'object', description: 'Ignored' }
        },
        required: ['project_id']
    }
};

export async function execute(params) {
    const traceId = uuidv4();

    try {
        const stats = getStats();
        const files = readdirSync(RUNBOOKS_DIR).filter(f => f.endsWith('.md'));

        // Check for empty files
        const emptyFiles = [];
        for (const file of files) {
            const stat = statSync(join(RUNBOOKS_DIR, file));
            if (stat.size < 50) emptyFiles.push(file);
        }

        return {
            status: 'healthy',
            stats,
            empty_files: emptyFiles,
            message: 'File-based storage requires minimal maintenance. Runbooks are .md files.',
            meta: { trace_id: traceId, storage: 'filesystem' }
        };
    } catch (err) {
        logger.error('memory_maintain error', { error: err.message, trace_id: traceId });
        throw err;
    }
}

export default { definition, execute };
