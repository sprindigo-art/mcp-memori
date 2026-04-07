/**
 * memory.feedback v6.0 — File-based Runbook Feedback
 * Updates frontmatter metadata in .md file
 * @module mcp/tools/memory.feedback
 */
import { readRunbook, RUNBOOKS_DIR, parseFrontmatter, buildFrontmatter } from '../../storage/files.js';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger.js';

export const definition = {
    name: 'memory_feedback',
    description: 'Beri feedback pada runbook (useful/not_relevant/wrong)',
    inputSchema: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'Runbook filename' },
            label: { type: 'string', enum: ['useful', 'not_relevant', 'wrong'], description: 'Feedback label' },
            notes: { type: 'string', description: 'Additional notes' }
        },
        required: ['id', 'label']
    }
};

export async function execute(params) {
    const traceId = uuidv4();
    const { id, label, notes = '' } = params;

    try {
        const filepath = join(RUNBOOKS_DIR, id);
        let raw;
        try { raw = readFileSync(filepath, 'utf8'); } catch {
            return { ok: false, meta: { trace_id: traceId, error: 'Runbook not found' } };
        }

        const { meta, body } = parseFrontmatter(raw);
        const now = new Date().toISOString();

        // Update metadata based on feedback
        if (label === 'useful') {
            meta.verified = true;
            meta.confidence = Math.min(1.0, (meta.confidence || 0.5) + 0.1);
        } else if (label === 'wrong') {
            meta.verified = false;
            meta.confidence = Math.max(0.1, (meta.confidence || 0.5) - 0.2);
        }

        meta.updated = now;
        meta.last_feedback = `${label}: ${notes} (${now})`;

        const newFile = buildFrontmatter(meta) + body;
        writeFileSync(filepath, newFile, 'utf8');

        return {
            ok: true,
            updated: { id, label, confidence: meta.confidence, verified: meta.verified },
            meta: { trace_id: traceId, storage: 'filesystem' }
        };
    } catch (err) {
        logger.error('memory_feedback error', { error: err.message, trace_id: traceId });
        throw err;
    }
}

export default { definition, execute };
