/**
 * memory.stats - Comprehensive analytics and health metrics
 * Eliminates need for direct sqlite3 queries for auditing
 * @module mcp/tools/memory.stats
 */
import { query, queryOne } from '../../db/index.js';
import { v4 as uuidv4 } from 'uuid';
import { now } from '../../utils/time.js';
import logger from '../../utils/logger.js';

/**
 * Tool definition for MCP
 */
export const definition = {
    name: 'memory_stats',
    description: 'Statistik lengkap: total items, breakdown per type/status, health check, guardrails, format compliance, database info',
    inputSchema: {
        type: 'object',
        properties: {
            project_id: { type: 'string', description: 'Project ID (optional, omit for global stats)' },
            sections: {
                type: 'array',
                items: { type: 'string' },
                description: 'Sections to include: counts, health, guardrails, format, versions, mistakes, database, audit. Default: all'
            }
        }
    }
};

/**
 * Execute memory stats
 * @param {object} params
 * @returns {Promise<object>}
 */
export async function execute(params) {
    const traceId = uuidv4();
    const {
        project_id: projectId,
        tenant_id: tenantId = 'local-user',
        sections = ['counts', 'health', 'guardrails', 'format', 'versions', 'mistakes', 'database', 'audit']
    } = params || {};

    const result = {
        project_id: projectId || 'ALL',
        generated_at: now(),
        meta: { trace_id: traceId }
    };

    // Build WHERE clause for project filtering
    const projectFilter = projectId
        ? { where: 'AND project_id = ?', params: [tenantId, projectId] }
        : { where: '', params: [tenantId] };

    try {

        // ============ SECTION: COUNTS ============
        if (sections.includes('counts')) {
            // Total by status
            const statusCounts = await query(
                `SELECT status, COUNT(*) as count FROM memory_items 
                 WHERE tenant_id = ? ${projectFilter.where}
                 GROUP BY status ORDER BY count DESC`,
                projectFilter.params
            );

            // Total by type (active only)
            const typeCounts = await query(
                `SELECT type, COUNT(*) as count FROM memory_items 
                 WHERE tenant_id = ? AND status = 'active' ${projectFilter.where}
                 GROUP BY type ORDER BY count DESC`,
                projectFilter.params
            );

            // Total overall
            const totalRow = await queryOne(
                `SELECT COUNT(*) as total FROM memory_items WHERE tenant_id = ? ${projectFilter.where}`,
                projectFilter.params
            );

            // Active items
            const activeRow = await queryOne(
                `SELECT COUNT(*) as total FROM memory_items WHERE tenant_id = ? AND status = 'active' ${projectFilter.where}`,
                projectFilter.params
            );

            // Recent items (last 24h)
            const recentRow = await queryOne(
                `SELECT COUNT(*) as total FROM memory_items 
                 WHERE tenant_id = ? AND status = 'active' AND created_at > datetime('now', '-1 day') ${projectFilter.where}`,
                projectFilter.params
            );

            result.counts = {
                total: totalRow?.total || 0,
                active: activeRow?.total || 0,
                recent_24h: recentRow?.total || 0,
                by_status: Object.fromEntries(statusCounts.map(r => [r.status, r.count])),
                by_type: Object.fromEntries(typeCounts.map(r => [r.type, r.count]))
            };
        }

        // ============ SECTION: HEALTH ============
        if (sections.includes('health')) {
            // Orphan links
            const orphanRow = await queryOne(
                `SELECT COUNT(*) as count FROM memory_links l 
                 WHERE NOT EXISTS (SELECT 1 FROM memory_items m WHERE m.id = l.from_id AND m.status = 'active')
                    OR NOT EXISTS (SELECT 1 FROM memory_items m WHERE m.id = l.to_id AND m.status = 'active')`
            );

            // Duplicate links
            const dupeLinksRow = await queryOne(
                `SELECT COUNT(*) - COUNT(DISTINCT from_id || '|' || to_id || '|' || relation) as count 
                 FROM memory_links`
            );

            // Total links
            const totalLinksRow = await queryOne(
                `SELECT COUNT(*) as count FROM memory_links`
            );

            // Items with high error count
            const highErrorRow = await queryOne(
                `SELECT COUNT(*) as count FROM memory_items 
                 WHERE tenant_id = ? AND status = 'active' AND error_count >= 3 ${projectFilter.where}`,
                projectFilter.params
            );

            // Duplicate titles (same title, same type, same project)
            const dupeTitlesRow = await queryOne(
                `SELECT COUNT(*) as count FROM (
                    SELECT title, type, project_id, COUNT(*) as cnt 
                    FROM memory_items 
                    WHERE tenant_id = ? AND status = 'active' ${projectFilter.where}
                    GROUP BY title, type, project_id HAVING cnt > 1
                )`,
                projectFilter.params
            );

            result.health = {
                orphan_links: orphanRow?.count || 0,
                duplicate_links: dupeLinksRow?.count || 0,
                total_links: totalLinksRow?.count || 0,
                high_error_items: highErrorRow?.count || 0,
                duplicate_titles: dupeTitlesRow?.count || 0,
                status: (orphanRow?.count || 0) === 0 && (dupeLinksRow?.count || 0) === 0 ? '✅ HEALTHY' : '⚠️ NEEDS MAINTENANCE'
            };
        }

        // ============ SECTION: GUARDRAILS ============
        if (sections.includes('guardrails')) {
            const activeGuardrails = await query(
                `SELECT rule_type, pattern_signature, description, created_at, expires_at 
                 FROM guardrails 
                 WHERE tenant_id = ? AND active = 1 
                 AND (expires_at IS NULL OR expires_at > ?)
                 ${projectFilter.where ? projectFilter.where.replace('AND project_id', 'AND guardrails.project_id') : ''}
                 ORDER BY created_at DESC`,
                [...(projectId ? [tenantId, now(), projectId] : [tenantId, now()])]
            );

            const totalGuardrailsRow = await queryOne(
                `SELECT COUNT(*) as count FROM guardrails WHERE tenant_id = ?`,
                [tenantId]
            );

            const expiredRow = await queryOne(
                `SELECT COUNT(*) as count FROM guardrails 
                 WHERE tenant_id = ? AND active = 1 AND expires_at IS NOT NULL AND expires_at <= ?`,
                [tenantId, now()]
            );

            result.guardrails = {
                active: activeGuardrails.length,
                total_ever: totalGuardrailsRow?.count || 0,
                expired: expiredRow?.count || 0,
                rules: activeGuardrails.map(g => ({
                    type: g.rule_type,
                    description: g.description,
                    expires: g.expires_at || 'never'
                }))
            };
        }

        // ============ SECTION: FORMAT COMPLIANCE ============
        if (sections.includes('format')) {
            // Episodes with Command: format
            const episodeTotal = await queryOne(
                `SELECT COUNT(*) as count FROM memory_items 
                 WHERE tenant_id = ? AND status = 'active' AND type = 'episode' ${projectFilter.where}`,
                projectFilter.params
            );
            const episodeWithCmd = await queryOne(
                `SELECT COUNT(*) as count FROM memory_items 
                 WHERE tenant_id = ? AND status = 'active' AND type = 'episode'
                 AND (content LIKE '%Command:%' OR content LIKE '%command:%' 
                      OR content LIKE '%→ Result%' OR content LIKE '%COMMANDS EXECUTED%')
                 ${projectFilter.where}`,
                projectFilter.params
            );

            // Runbooks with ## STEP format
            const runbookTotal = await queryOne(
                `SELECT COUNT(*) as count FROM memory_items 
                 WHERE tenant_id = ? AND status = 'active' AND type = 'runbook' ${projectFilter.where}`,
                projectFilter.params
            );
            const runbookWithStep = await queryOne(
                `SELECT COUNT(*) as count FROM memory_items 
                 WHERE tenant_id = ? AND status = 'active' AND type = 'runbook'
                 AND (content LIKE '%## STEP%' OR content LIKE '%Step%')
                 AND (content LIKE '%Command:%' OR content LIKE '%command:%')
                 ${projectFilter.where}`,
                projectFilter.params
            );

            // Facts with HOW TO USE (credential facts)
            const credFactTotal = await queryOne(
                `SELECT COUNT(*) as count FROM memory_items 
                 WHERE tenant_id = ? AND status = 'active' AND type = 'fact'
                 AND (content LIKE '%credential%' OR content LIKE '%password%' OR content LIKE '%Password%')
                 ${projectFilter.where}`,
                projectFilter.params
            );
            const credFactWithHow = await queryOne(
                `SELECT COUNT(*) as count FROM memory_items 
                 WHERE tenant_id = ? AND status = 'active' AND type = 'fact'
                 AND (content LIKE '%credential%' OR content LIKE '%password%' OR content LIKE '%Password%')
                 AND (content LIKE '%HOW TO USE%' OR content LIKE '%Example:%' OR content LIKE '%Command:%')
                 ${projectFilter.where}`,
                projectFilter.params
            );

            const epTotal = episodeTotal?.count || 0;
            const epCmd = episodeWithCmd?.count || 0;
            const rbTotal = runbookTotal?.count || 0;
            const rbStep = runbookWithStep?.count || 0;
            const cfTotal = credFactTotal?.count || 0;
            const cfHow = credFactWithHow?.count || 0;

            result.format_compliance = {
                episode: {
                    total: epTotal,
                    compliant: epCmd,
                    rate: epTotal > 0 ? Math.round((epCmd / epTotal) * 100) + '%' : 'N/A'
                },
                runbook: {
                    total: rbTotal,
                    compliant: rbStep,
                    rate: rbTotal > 0 ? Math.round((rbStep / rbTotal) * 100) + '%' : 'N/A'
                },
                credential_fact: {
                    total: cfTotal,
                    compliant: cfHow,
                    rate: cfTotal > 0 ? Math.round((cfHow / cfTotal) * 100) + '%' : 'N/A'
                }
            };
        }

        // ============ SECTION: VERSION UPDATES ============
        if (sections.includes('versions')) {
            const updatedRow = await queryOne(
                `SELECT COUNT(*) as count FROM memory_items 
                 WHERE tenant_id = ? AND status = 'active' AND version > 1 ${projectFilter.where}`,
                projectFilter.params
            );
            const totalActiveRow = await queryOne(
                `SELECT COUNT(*) as count FROM memory_items 
                 WHERE tenant_id = ? AND status = 'active' ${projectFilter.where}`,
                projectFilter.params
            );

            // Top updated items
            const topUpdated = await query(
                `SELECT id, title, type, version, updated_at FROM memory_items 
                 WHERE tenant_id = ? AND status = 'active' AND version > 1 ${projectFilter.where}
                 ORDER BY version DESC LIMIT 10`,
                projectFilter.params
            );

            const total = totalActiveRow?.count || 0;
            const updated = updatedRow?.count || 0;

            result.versions = {
                total_active: total,
                items_updated: updated,
                update_rate: total > 0 ? Math.round((updated / total) * 10000) / 100 + '%' : 'N/A',
                top_updated: topUpdated.map(i => ({
                    title: i.title,
                    type: i.type,
                    version: i.version,
                    updated_at: i.updated_at
                }))
            };
        }

        // ============ SECTION: MISTAKES (LOOPBREAKER) ============
        if (sections.includes('mistakes')) {
            const mistakesCritical = await query(
                `SELECT signature, count, severity, last_seen_at FROM mistakes 
                 WHERE tenant_id = ? AND count >= 3
                 ${projectId ? 'AND project_id = ?' : ''}
                 ORDER BY count DESC LIMIT 20`,
                projectId ? [tenantId, projectId] : [tenantId]
            );

            const totalMistakesRow = await queryOne(
                `SELECT COUNT(*) as count, SUM(count) as total_occurrences FROM mistakes 
                 WHERE tenant_id = ? ${projectId ? 'AND project_id = ?' : ''}`,
                projectId ? [tenantId, projectId] : [tenantId]
            );

            result.mistakes = {
                unique_patterns: totalMistakesRow?.count || 0,
                total_occurrences: totalMistakesRow?.total_occurrences || 0,
                critical_repeats: mistakesCritical.map(m => ({
                    signature: m.signature,
                    count: m.count,
                    severity: m.severity,
                    last_seen: m.last_seen_at
                }))
            };
        }

        // ============ SECTION: DATABASE ============
        if (sections.includes('database')) {
            // Database size
            let dbSize = 'unknown';
            try {
                // Use pragma table-functions (better-sqlite3 compatible)
                const sizeRow = await queryOne(
                    'SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()'
                );
                if (sizeRow && sizeRow.size > 0) {
                    dbSize = Math.round(sizeRow.size / 1024 / 1024 * 100) / 100 + ' MB';
                }
            } catch (e) {
                logger.debug('Could not get DB size', { error: e.message });
            }

            // Freelist pages
            let freePages = 0;
            try {
                const freeRow = await queryOne(
                    'SELECT freelist_count FROM pragma_freelist_count()'
                );
                freePages = freeRow?.freelist_count || 0;
            } catch (e) {
                logger.debug('Could not get freelist count', { error: e.message });
            }

            // Audit log size
            const auditRow = await queryOne('SELECT COUNT(*) as count FROM audit_log');

            // FTS health
            let ftsStatus = 'unknown';
            try {
                const ftsRow = await queryOne("SELECT COUNT(*) as count FROM memory_items_fts");
                ftsStatus = ftsRow?.count > 0 ? `✅ OK (${ftsRow.count} entries)` : '❌ EMPTY';
            } catch (e) {
                ftsStatus = '❌ ERROR: ' + e.message;
            }

            result.database = {
                size: dbSize,
                freelist_pages: freePages,
                needs_vacuum: freePages > 10,
                audit_log_entries: auditRow?.count || 0,
                fts_index: ftsStatus
            };
        }

        // ============ SECTION: AUDIT ANALYTICS ============
        if (sections.includes('audit')) {
            try {
                const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

                // Top 5 most used tools (last 7 days)
                const topTools = await query(
                    `SELECT tool_name, COUNT(*) as call_count 
                     FROM audit_log WHERE ts > ? 
                     GROUP BY tool_name ORDER BY call_count DESC LIMIT 5`,
                    [sevenDaysAgo]
                );

                // Tool usage with error rate (using is_error column - v4.0 fix)
                const errorTools = await query(
                    `SELECT tool_name, 
                            COUNT(*) as total_calls,
                            SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) as error_calls
                     FROM audit_log WHERE ts > ?
                     GROUP BY tool_name HAVING error_calls > 0
                     ORDER BY CAST(error_calls AS FLOAT) / total_calls DESC LIMIT 5`,
                    [sevenDaysAgo]
                );

                // Total audit entries (7 days)
                const totalAudit = await queryOne(
                    `SELECT COUNT(*) as count FROM audit_log WHERE ts > ?`,
                    [sevenDaysAgo]
                );

                result.audit = {
                    period: 'last_7_days',
                    total_entries: totalAudit?.count || 0,
                    top_tools: topTools.map(t => ({
                        tool: t.tool_name,
                        calls: t.call_count
                    })),
                    error_prone_tools: errorTools.map(t => ({
                        tool: t.tool_name,
                        total: t.total_calls,
                        errors: t.error_calls,
                        error_rate: Math.round((t.error_calls / t.total_calls) * 100) + '%'
                    }))
                };
            } catch (auditErr) {
                logger.warn('Audit analytics section failed', { error: auditErr.message });
                result.audit = { error: auditErr.message };
            }
        }

        // Write audit log
        await writeAuditLog(traceId, 'memory_stats', params, {
            sections_returned: sections.length
        }, projectId || 'global', tenantId);

        return result;

    } catch (err) {
        logger.error('memory_stats error', { error: err.message, trace_id: traceId });
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
