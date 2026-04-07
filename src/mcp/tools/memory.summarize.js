/**
 * memory.summarize v6.0 — File-based Runbook Summary
 * @module mcp/tools/memory.summarize
 */
import { listRunbooks, getStats, RUNBOOKS_DIR } from '../../storage/files.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger.js';

export const definition = {
    name: 'memory_summarize',
    description: 'Ringkasan semua runbook: list files, stats, recent updates',
    inputSchema: {
        type: 'object',
        properties: {
            project_id: { type: 'string', description: 'Project ID' },
            compact: { type: 'boolean', description: 'Compact mode (default: false)' }
        },
        required: ['project_id']
    }
};

export async function execute(params) {
    const traceId = uuidv4();
    const { compact = false } = params;

    try {
        const stats = getStats();
        const { items: recentRunbooks } = listRunbooks({ limit: compact ? 5 : 20 });

        return {
            summary: {
                total_runbooks: stats.total_runbooks,
                total_size_mb: stats.total_size_mb,
                directory: stats.directory,
                recent_runbooks: recentRunbooks.map(r => ({
                    id: r.id,
                    title: r.title,
                    tags: r.tags,
                    content_length: r.content_length,
                    updated_at: r.updated_at
                }))
            },
            meta: { trace_id: traceId, storage: 'filesystem' }
        };
    } catch (err) {
        logger.error('memory_summarize error', { error: err.message, trace_id: traceId });
        throw err;
    }
}

export default { definition, execute };
