/**
 * memory.stats v6.0 — File-based Runbook Statistics
 * @module mcp/tools/memory.stats
 */
import { getStats, RUNBOOKS_DIR } from '../../storage/files.js';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { parseFrontmatter } from '../../storage/files.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger.js';

export const definition = {
    name: 'memory_stats',
    description: 'Statistik runbook files: total, size, tags breakdown',
    inputSchema: {
        type: 'object',
        properties: {
            project_id: { type: 'string', description: 'Project ID' },
            sections: { type: 'array', items: { type: 'string' }, description: 'Ignored — returns all stats' }
        }
    }
};

export async function execute(params) {
    const traceId = uuidv4();

    try {
        const stats = getStats();
        const files = readdirSync(RUNBOOKS_DIR).filter(f => f.endsWith('.md'));

        // Tag breakdown
        const tagCounts = {};
        let verifiedCount = 0;
        let successCount = 0;
        let failCount = 0;

        for (const file of files) {
            try {
                const raw = readFileSync(join(RUNBOOKS_DIR, file), 'utf8');
                const { meta } = parseFrontmatter(raw);
                for (const tag of (meta.tags || [])) {
                    tagCounts[tag] = (tagCounts[tag] || 0) + 1;
                }
                if (meta.verified) verifiedCount++;
                if (meta.success === true) successCount++;
                if (meta.success === false) failCount++;
            } catch {}
        }

        // Top tags
        const topTags = Object.entries(tagCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
            .map(([tag, count]) => ({ tag, count }));

        return {
            ...stats,
            verified_count: verifiedCount,
            success_count: successCount,
            fail_count: failCount,
            top_tags: topTags,
            storage: 'filesystem',
            format: '.md',
            meta: { trace_id: traceId }
        };
    } catch (err) {
        logger.error('memory_stats error', { error: err.message, trace_id: traceId });
        throw err;
    }
}

export default { definition, execute };
