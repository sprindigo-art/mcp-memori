/**
 * memory.list v6.0 — File-based Runbook Browser
 * @module mcp/tools/memory.list
 */
import { listRunbooks } from '../../storage/files.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger.js';

export const definition = {
    name: 'memory_list',
    description: 'Browse semua runbook files. Supports pagination, tag/title filtering.',
    inputSchema: {
        type: 'object',
        properties: {
            project_id: { type: 'string', description: 'Project ID' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags (AND logic)' },
            limit: { type: 'number', description: 'Max results per page (default: 20)' },
            offset: { type: 'number', description: 'Offset for pagination (default: 0)' },
            title_contains: { type: 'string', description: 'Filter by title substring' },
            full_content: { type: 'boolean', description: 'Return full content (default: false)' },
            types: { type: 'array', items: { type: 'string' }, description: 'Ignored — all items are runbooks' },
            status: { type: 'string', description: 'Ignored — all items are active' },
            sort_by: { type: 'string', description: 'Ignored — sorted by updated_at desc' },
            sort_order: { type: 'string', description: 'Ignored' }
        },
        required: ['project_id']
    }
};

export async function execute(params) {
    const traceId = uuidv4();
    const {
        tags = [],
        limit = 20,
        offset = 0,
        title_contains: titleContains = '',
        full_content: fullContent = false
    } = params;

    try {
        const { items, pagination } = listRunbooks({ tags, limit, offset, titleContains, fullContent });

        return {
            items,
            pagination,
            meta: { trace_id: traceId, storage: 'filesystem' }
        };
    } catch (err) {
        logger.error('memory_list error', { error: err.message, trace_id: traceId });
        throw err;
    }
}

export default { definition, execute };
