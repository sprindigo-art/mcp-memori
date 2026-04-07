/**
 * memory.reflect v6.0 — File-based Runbook Reflection
 * @module mcp/tools/memory.reflect
 */
import { searchRunbooks, listRunbooks, RUNBOOKS_DIR } from '../../storage/files.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger.js';

export const definition = {
    name: 'memory_reflect',
    description: 'Analisis runbook: teknik yang berhasil/gagal, coverage',
    inputSchema: {
        type: 'object',
        properties: {
            project_id: { type: 'string', description: 'Project ID' },
            lookback_count: { type: 'number', description: 'Number of recent runbooks to analyze (default: 20)' },
            filter_tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags' }
        }
    }
};

export async function execute(params) {
    const traceId = uuidv4();
    const { filter_tags: filterTags = [], lookback_count: lookbackCount = 20 } = params || {};

    try {
        const { items } = listRunbooks({ tags: filterTags, limit: lookbackCount });

        const teknikRunbooks = items.filter(i => (i.title || '').includes('[TEKNIK]'));
        const targetRunbooks = items.filter(i => (i.title || '').includes('[RUNBOOK]'));

        return {
            reflection: {
                total_runbooks: items.length,
                teknik_count: teknikRunbooks.length,
                target_count: targetRunbooks.length,
                teknik_list: teknikRunbooks.map(t => t.title),
                target_list: targetRunbooks.map(t => t.title),
                recent_updates: items.slice(0, 5).map(i => ({
                    title: i.title,
                    updated: i.updated_at,
                    content_length: i.content_length
                }))
            },
            meta: { trace_id: traceId, storage: 'filesystem' }
        };
    } catch (err) {
        logger.error('memory_reflect error', { error: err.message, trace_id: traceId });
        throw err;
    }
}

export default { definition, execute };
