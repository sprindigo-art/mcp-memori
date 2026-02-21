/**
 * memory.summarize v2.1 - Get project summary with graph intelligence
 * LAYER 2: Conflict detection and multi-hop context enrichment
 * @module mcp/tools/memory.summarize
 */
import { query, queryOne } from '../../db/index.js';
import { generateSnippet } from '../../utils/normalize.js';
import { v4 as uuidv4 } from 'uuid';
import { now } from '../../utils/time.js';
import logger from '../../utils/logger.js';
import { getForensicMeta } from '../../utils/forensic.js';
import { findConflicts, traverseGraph } from '../../retrieval/graph.js';

/**
 * Tool definition for MCP
 */
export const definition = {
    name: 'memory_summarize',
    description: 'Ringkasan project: state terkini, keputusan, runbooks, guardrails',
    inputSchema: {
        type: 'object',
        properties: {
            project_id: { type: 'string', description: 'Project ID' },
            compact: { type: 'boolean', description: 'Compact mode: minimal output (<30 lines) for fast bootstrap. Default: false' }
        },
        required: ['project_id']
    }
};

/**
 * Execute memory summarize
 * @param {object} params
 * @returns {Promise<object>}
 */
export async function execute(params) {
    const traceId = uuidv4();
    const { project_id: projectId, tenant_id: tenantId = 'local-user', compact = false } = params;

    try {
        // COMPACT MODE: Fast bootstrap with minimal output
        if (compact) {
            const states = await query(
                `SELECT id, title, updated_at FROM memory_items
                 WHERE tenant_id = ? AND project_id = ? AND type = 'state' AND status = 'active'
                 ORDER BY updated_at DESC LIMIT 3`,
                [tenantId, projectId]
            );

            const blockers = await query(
                `SELECT id, title FROM memory_items
                 WHERE tenant_id = ? AND project_id = ? AND status = 'active'
                   AND (tags LIKE '%blocker%' OR tags LIKE '%blocked%')
                 ORDER BY updated_at DESC LIMIT 5`,
                [tenantId, projectId]
            );

            let guardrailCount = 0;
            let recentGuardrails = [];
            try {
                const gcRow = await queryOne(
                    `SELECT COUNT(*) as cnt FROM guardrails WHERE project_id = ?`,
                    [projectId]
                );
                guardrailCount = gcRow?.cnt || 0;
                recentGuardrails = await query(
                    `SELECT rule_text FROM guardrails WHERE project_id = ? ORDER BY created_at DESC LIMIT 3`,
                    [projectId]
                );
            } catch { /* guardrails table may not exist */ }

            const totalItems = await queryOne(
                `SELECT COUNT(*) as cnt FROM memory_items WHERE project_id = ? AND status = 'active'`,
                [projectId]
            );

            const needsMaintenance = (totalItems?.cnt || 0) > 500;

            return {
                compact: true,
                states: states.map(s => ({ id: s.id, title: s.title, updated_at: s.updated_at })),
                blockers: blockers.map(b => ({ id: b.id, title: b.title })),
                guardrails: { count: guardrailCount, recent: recentGuardrails.map(g => g.rule_text) },
                total_items: totalItems?.cnt || 0,
                maintenance_needed: needsMaintenance,
                meta: { trace_id: traceId, mode: 'compact' }
            };
        }
        const summary = {
            state_latest: null,
            key_decisions: [],
            runbooks_top: [],
            user_preferences: [], // NEW: User preferences section
            guardrails: [],
            open_todos: [],
            blockers: []
        };

        // Get latest state
        const state = await queryOne(
            `SELECT id, title, content, updated_at, version 
       FROM memory_items
       WHERE tenant_id = ? AND project_id = ? AND type = 'state' AND status = 'active'
       ORDER BY updated_at DESC LIMIT 1`,
            [tenantId, projectId]
        );

        if (state) {
            summary.state_latest = {
                id: state.id,
                title: state.title,
                content: state.content,
                updated_at: state.updated_at,
                version: state.version
            };

            // Extract guardrails from state content
            const guardrailMatch = state.content.match(/## GUARDRAIL\n([\s\S]*?)(?=\n##|$)/i);
            if (guardrailMatch) {
                summary.guardrails.push(guardrailMatch[1].trim());
            }
        } else {
            // Create empty state template
            summary.state_latest = {
                id: null,
                title: 'Current State',
                content: '(No state recorded yet)',
                updated_at: now(),
                version: 0
            };
        }

        // Get key decisions (top 5 by usefulness)
        const decisions = await query(
            `SELECT id, title, content, updated_at, verified, usefulness_score
       FROM memory_items
       WHERE tenant_id = ? AND project_id = ? AND type = 'decision' 
       AND status IN ('active', 'deprecated')
       ORDER BY verified DESC, usefulness_score DESC, updated_at DESC
       LIMIT 5`,
            [tenantId, projectId]
        );

        summary.key_decisions = decisions.map(d => ({
            id: d.id,
            title: d.title,
            snippet: generateSnippet(d.content, 100),
            verified: !!d.verified,
            usefulness: d.usefulness_score
        }));

        // Get top runbooks
        const runbooks = await query(
            `SELECT id, title, content, usefulness_score
       FROM memory_items
       WHERE tenant_id = ? AND project_id = ? AND type = 'runbook' AND status = 'active'
       ORDER BY usefulness_score DESC, updated_at DESC
       LIMIT 3`,
            [tenantId, projectId]
        );

        summary.runbooks_top = runbooks.map(r => ({
            id: r.id,
            title: r.title,
            snippet: generateSnippet(r.content, 100)
        }));

        // FIX #2: Get user preferences (items with 'user_preference' tag)
        const userPrefs = await query(
            `SELECT id, title, content, tags, updated_at
       FROM memory_items
       WHERE tenant_id = ? AND project_id = ? AND status = 'active'
       AND tags LIKE '%user_preference%'
       ORDER BY updated_at DESC
       LIMIT 5`,
            [tenantId, projectId]
        );

        summary.user_preferences = userPrefs.map(p => ({
            id: p.id,
            title: p.title,
            content: p.content,
            tags: typeof p.tags === 'string' ? (() => { try { return JSON.parse(p.tags); } catch { return []; } })() : (p.tags || []),
            updated_at: p.updated_at
        }));

        // Extract todos from facts (items with 'todo' tag or 'TODO' in content)
        const todos = await query(
            `SELECT id, title, content
       FROM memory_items
       WHERE tenant_id = ? AND project_id = ? AND type = 'fact' AND status = 'active'
       AND (tags LIKE '%"todo"%' OR title LIKE '%TODO%' OR content LIKE '%TODO%')
       ORDER BY updated_at DESC
       LIMIT 5`,
            [tenantId, projectId]
        );

        summary.open_todos = todos.map(t => ({
            id: t.id,
            title: t.title.replace(/TODO:?\s*/i, ''),
            snippet: generateSnippet(t.content, 80)
        }));

        // Extract blockers - STRICT: only tag-based or title [BLOCKER], exclude resolved items
        const blockers = await query(
            `SELECT id, title, content
       FROM memory_items
       WHERE tenant_id = ? AND project_id = ? AND status = 'active'
       AND (tags LIKE '%"blocker"%' OR title LIKE '%[BLOCKER]%')
       AND content NOT LIKE '%RESOLVED%'
       AND content NOT LIKE '%SOLVED%'
       AND content NOT LIKE '%COMPLETED%'
       AND content NOT LIKE '%FIXED%'
       AND title NOT LIKE '%SOLVED%'
       AND title NOT LIKE '%RESOLVED%'
       ORDER BY updated_at DESC
       LIMIT 3`,
            [tenantId, projectId]
        );

        summary.blockers = blockers.map(b => ({
            id: b.id,
            title: b.title.replace(/\[?BLOCKER\]?:?\s*/i, ''),
            snippet: generateSnippet(b.content, 80)
        }));

        // Get recent mistakes as additional guardrails
        const mistakes = await query(
            `SELECT signature, count, notes_json
       FROM mistakes
       WHERE tenant_id = ? AND project_id = ? AND count >= 2
       ORDER BY count DESC LIMIT 3`,
            [tenantId, projectId]
        );

        for (const m of mistakes) {
            summary.guardrails.push(`Repeated mistake (${m.count}x): Check signature ${m.signature.substring(0, 8)}...`);
        }

        // FORENSIC: Excluded items (Quarantined) that might have been relevant
        const quarantined = await query(
            `SELECT id, type, title, status_reason 
             FROM memory_items 
             WHERE tenant_id = ? AND project_id = ? AND status = 'quarantined'
             LIMIT 10`,
            [tenantId, projectId]
        );

        summary.excluded_items = quarantined.map(q => ({
            id: q.id,
            title: q.title,
            type: q.type,
            reason: 'quarantined',
            details: q.status_reason
        }));

        // LAYER 2: Graph Intelligence - Conflict Detection
        let conflicts = [];
        try {
            const graphConflicts = await findConflicts(projectId, tenantId);
            conflicts = graphConflicts.map(c => ({
                from: { id: c.from_id, title: c.from_title },
                to: { id: c.to_id, title: c.to_title },
                relation: 'contradicts',
                warning: `CONFLICT: "${c.from_title}" contradicts "${c.to_title}"`
            }));

            // Add conflicts to guardrails as warnings
            for (const c of conflicts) {
                summary.guardrails.push(c.warning);
            }
        } catch (err) {
            logger.warn('Conflict detection failed', { error: err.message });
        }
        summary.graph_conflicts = conflicts;

        // LAYER 2: Multi-hop context enrichment for state
        let relatedItems = [];
        if (state) {
            try {
                const related = await traverseGraph(state.id, 2, ['causes', 'depends_on', 'related_to']);
                if (related.length > 0) {
                    // Get details for related items
                    const relatedIds = related.map(r => r.id);
                    const placeholders = relatedIds.map(() => '?').join(',');
                    const relatedDetails = await query(
                        `SELECT id, title, type FROM memory_items WHERE id IN (${placeholders}) AND status = 'active'`,
                        relatedIds
                    );

                    relatedItems = related.map(r => {
                        const detail = relatedDetails.find(d => d.id === r.id);
                        return {
                            id: r.id,
                            title: detail?.title || 'Unknown',
                            type: detail?.type || 'unknown',
                            hop: r.hop,
                            relation: r.relation,
                            path: r.path
                        };
                    });
                }
            } catch (err) {
                logger.warn('Multi-hop traversal failed', { error: err.message });
            }
        }
        summary.related_context = relatedItems;

        // Enrich summary with used IDs for verification
        summary.decisions_used = summary.key_decisions.map(d => d.id);
        summary.runbooks_used = summary.runbooks_top.map(r => r.id);
        summary.relations_used = relatedItems.length;

        // Build Forensic Metadata
        const forensicMeta = await getForensicMeta(tenantId, projectId);

        // Write audit log
        await writeAuditLog(traceId, 'memory_summarize',
            { project_id: projectId },
            {
                has_state: !!state,
                decision_count: summary.key_decisions.length,
                runbook_count: summary.runbooks_top.length,
                excluded_count: summary.excluded_items.length
            },
            projectId,
            tenantId
        );

        return {
            summary,
            meta: {
                trace_id: traceId,
                forensic: forensicMeta
            }
        };

    } catch (err) {
        logger.error('memory.summarize error', { error: err.message, trace_id: traceId });
        throw err;
    }
}

/**
 * Write to audit log
 */
async function writeAuditLog(traceId, toolName, request, response, projectId, tenantId) {
    try {
        await query(
            `INSERT INTO audit_log (id, trace_id, ts, tool_name, request_json, response_json, project_id, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                uuidv4(),
                traceId,
                now(),
                toolName,
                JSON.stringify(request),
                JSON.stringify(response),
                projectId,
                tenantId
            ]
        );
    } catch (err) {
        logger.warn('Audit log write failed', { error: err.message });
    }
}

export default { definition, execute };
