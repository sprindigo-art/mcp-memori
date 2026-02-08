/**
 * memory.reflect - Metacognition stats aggregator
 * v4.0 - Analyzes recent episode patterns for LLM-driven reflection
 * Returns structured stats on success/failure patterns, NOT raw items
 * LLM host performs high-level reasoning on the aggregated output
 * 
 * @module mcp/tools/memory.reflect
 */
import { query, queryOne } from '../../db/index.js';
import { v4 as uuidv4 } from 'uuid';
import { now } from '../../utils/time.js';
import logger from '../../utils/logger.js';
import { getMinimalForensicMeta } from '../../utils/forensic.js';

// Known blocker keywords for pattern detection
const BLOCKER_KEYWORDS = {
    'WAF': ['waf', 'web application firewall', 'modsecurity', 'mod_security'],
    'Cloudflare': ['cloudflare', 'cf-ray', '403 forbidden', 'challenge page'],
    'MIME Validation': ['mime', 'content-type', 'file type', 'extension blocked'],
    'Patch Applied': ['patched', 'not vulnerable', 'fixed', 'remediated', 'already patch'],
    'Auth Required': ['401', 'authentication', 'login required', 'unauthorized'],
    'Rate Limit': ['rate limit', '429', 'too many request'],
    'Version Mismatch': ['version', 'not applicable', 'different version'],
    'Network/Timeout': ['timeout', 'connection refused', 'unreachable', 'timed out']
};

// Top techniques to compare against for "unused" detection
const KNOWN_TECHNIQUES = [
    'SQLi', 'XSS', 'SSRF', 'LFI', 'RCE', 'File Upload',
    'Deserialization', 'IDOR', 'SSTI', 'Command Injection',
    'Path Traversal', 'XXE', 'CSRF', 'Open Redirect'
];

/**
 * Tool definition for MCP
 */
export const definition = {
    name: 'memory_reflect',
    description: 'Analisis pola kegagalan/kesuksesan (metacognition). Returns structured stats for LLM reasoning.',
    inputSchema: {
        type: 'object',
        properties: {
            lookback_count: {
                type: 'number',
                description: 'Number of recent episodes to analyze (default: 20, max: 100)'
            },
            filter_tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional filter by tags'
            },
            project_id: {
                type: 'string',
                description: 'Project ID (default: janda_workspace)'
            }
        }
    }
};

/**
 * Execute memory reflect
 * @param {object} params
 * @returns {Promise<object>}
 */
export async function execute(params) {
    const traceId = uuidv4();
    const {
        lookback_count = 20,
        filter_tags = [],
        project_id: projectId = 'janda_workspace',
        tenant_id: tenantId = 'local-user'
    } = params;

    const limit = Math.min(Math.max(lookback_count, 5), 100);

    try {
        // Fetch recent episodes
        let sql = `SELECT id, title, content, tags, usefulness_score, created_at 
                    FROM memory_items 
                    WHERE type = 'episode' AND status = 'active' AND project_id = ?`;
        const sqlParams = [projectId];

        if (filter_tags.length > 0) {
            // Filter by tags (any match)
            const tagConditions = filter_tags.map(() => `tags LIKE ?`).join(' OR ');
            sql += ` AND (${tagConditions})`;
            for (const tag of filter_tags) {
                sqlParams.push(`%${tag}%`);
            }
        }

        sql += ` ORDER BY created_at DESC LIMIT ?`;
        sqlParams.push(limit);

        const episodes = await query(sql, sqlParams);

        if (episodes.length === 0) {
            return {
                reflection: { message: 'No episodes found for analysis' },
                meta: { trace_id: traceId }
            };
        }

        // Analyze patterns
        let successCount = 0;
        let failureCount = 0;
        const techniqueStats = {};
        const targetStats = {};
        const blockerCounts = {};
        const usedTechniques = new Set();

        for (const ep of episodes) {
            const content = (ep.content || '').toLowerCase();
            const title = (ep.title || '').toLowerCase();
            const combined = content + ' ' + title;
            const tags = parseJsonSafe(ep.tags, []);

            // Determine success/failure
            const isSuccess = ep.usefulness_score > 0 ||
                combined.includes('success') ||
                combined.includes('berhasil') ||
                combined.includes('confirmed') ||
                combined.includes('achieved');

            const isFailure = ep.usefulness_score < 0 ||
                combined.includes('failed') ||
                combined.includes('gagal') ||
                combined.includes('blocked') ||
                combined.includes('not vulnerable');

            if (isSuccess) successCount++;
            if (isFailure) failureCount++;

            // Extract technique from tags/title
            for (const technique of KNOWN_TECHNIQUES) {
                if (combined.includes(technique.toLowerCase())) {
                    usedTechniques.add(technique);
                    if (!techniqueStats[technique]) {
                        techniqueStats[technique] = { success: 0, failure: 0, targets: new Set() };
                    }
                    if (isSuccess) techniqueStats[technique].success++;
                    if (isFailure) techniqueStats[technique].failure++;
                }
            }

            // Extract target from title (pattern: [TARGET] or target: or on <domain>)
            const targetMatch = title.match(/\[([^\]]+)\]/) ||
                title.match(/(?:target|on|untuk)\s*[:=]?\s*([a-z0-9.-]+\.[a-z]{2,})/i);
            if (targetMatch) {
                const target = targetMatch[1].trim();
                if (!targetStats[target]) targetStats[target] = { success: 0, failure: 0 };
                if (isSuccess) targetStats[target].success++;
                if (isFailure) targetStats[target].failure++;

                // Add target to technique stats
                for (const technique of KNOWN_TECHNIQUES) {
                    if (combined.includes(technique.toLowerCase()) && techniqueStats[technique]) {
                        techniqueStats[technique].targets.add(target);
                    }
                }
            }

            // Detect blockers (only for failures)
            if (isFailure) {
                for (const [blockerName, keywords] of Object.entries(BLOCKER_KEYWORDS)) {
                    if (keywords.some(kw => combined.includes(kw))) {
                        blockerCounts[blockerName] = (blockerCounts[blockerName] || 0) + 1;
                    }
                }
            }
        }

        // Build failure patterns
        const failurePatterns = Object.entries(techniqueStats)
            .filter(([, stats]) => stats.failure > 0)
            .map(([technique, stats]) => ({
                technique,
                failures: stats.failure,
                successes: stats.success,
                targets: Array.from(stats.targets).slice(0, 5),
                common_blocker: findDominantBlocker(blockerCounts) || 'Unknown'
            }))
            .sort((a, b) => b.failures - a.failures);

        // Build success patterns
        const successPatterns = Object.entries(techniqueStats)
            .filter(([, stats]) => stats.success > 0)
            .map(([technique, stats]) => ({
                technique,
                successes: stats.success,
                targets: Array.from(stats.targets).slice(0, 5)
            }))
            .sort((a, b) => b.successes - a.successes);

        // Determine unused techniques
        const unusedTechniques = KNOWN_TECHNIQUES.filter(t => !usedTechniques.has(t));

        // Generate recommendation hints
        const hints = generateHints(failurePatterns, successPatterns, unusedTechniques, blockerCounts);

        // Build reflection output
        const reflection = {
            period: `last_${episodes.length}_episodes`,
            total_analyzed: episodes.length,
            success_count: successCount,
            failure_count: failureCount,
            neutral_count: episodes.length - successCount - failureCount,
            success_rate: episodes.length > 0
                ? Math.round((successCount / episodes.length) * 100) + '%'
                : 'N/A',
            failure_patterns: failurePatterns.slice(0, 10),
            success_patterns: successPatterns.slice(0, 10),
            unused_techniques: unusedTechniques,
            blocker_distribution: blockerCounts,
            recommendation_hints: hints,
            top_targets: Object.entries(targetStats)
                .map(([target, stats]) => ({
                    target,
                    successes: stats.success,
                    failures: stats.failure
                }))
                .sort((a, b) => (b.successes + b.failures) - (a.successes + a.failures))
                .slice(0, 5)
        };

        // Write audit log
        try {
            await query(
                `INSERT INTO audit_log (id, trace_id, ts, tool_name, request_json, response_json, project_id, tenant_id, is_error)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    uuidv4(), traceId, now(), 'memory_reflect',
                    JSON.stringify({ lookback_count: limit, filter_tags }),
                    JSON.stringify({ episodes_analyzed: episodes.length }),
                    projectId, tenantId, 0
                ]
            );
        } catch (err) {
            logger.warn('Audit log write failed', { error: err.message });
        }

        const forensicMeta = getMinimalForensicMeta(tenantId, projectId);

        return {
            reflection,
            meta: {
                trace_id: traceId,
                forensic: forensicMeta
            }
        };

    } catch (err) {
        logger.error('memory.reflect error', { error: err.message, trace_id: traceId });
        throw err;
    }
}

/**
 * Find dominant blocker from counts
 */
function findDominantBlocker(blockerCounts) {
    let maxCount = 0;
    let dominant = null;
    for (const [blocker, count] of Object.entries(blockerCounts)) {
        if (count > maxCount) {
            maxCount = count;
            dominant = blocker;
        }
    }
    return dominant;
}

/**
 * Generate actionable hints from pattern analysis
 */
function generateHints(failurePatterns, successPatterns, unusedTechniques, blockerCounts) {
    const hints = [];

    // Hint: Repeated technique failures
    for (const pattern of failurePatterns) {
        if (pattern.failures >= 3) {
            hints.push(`${pattern.technique}: ${pattern.failures}x failures detected. Consider switching technique or using bypass.`);
        }
    }

    // Hint: WAF/Cloudflare correlation
    if (blockerCounts['WAF'] >= 2 || blockerCounts['Cloudflare'] >= 2) {
        hints.push('Multiple WAF/Cloudflare blocks detected. Consider origin IP bypass or protocol-level techniques.');
    }

    // Hint: Unused techniques suggestion
    if (unusedTechniques.length > 5 && failurePatterns.length > 0) {
        const suggestions = unusedTechniques.slice(0, 3).join(', ');
        hints.push(`${unusedTechniques.length} techniques unused. Consider trying: ${suggestions}`);
    }

    // Hint: Success pattern reinforcement
    for (const pattern of successPatterns) {
        if (pattern.successes >= 2) {
            hints.push(`${pattern.technique}: ${pattern.successes}x successes. This technique is effective for current targets.`);
        }
    }

    // Hint: Patch blocking
    if (blockerCounts['Patch Applied'] >= 2) {
        hints.push('Multiple targets appear patched. Focus on zero-day or logic-level vulnerabilities.');
    }

    return hints.length > 0 ? hints : ['No significant patterns detected. Continue systematic testing.'];
}

/**
 * Parse JSON safely
 */
function parseJsonSafe(value, defaultValue) {
    if (!value) return defaultValue;
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch {
        return defaultValue;
    }
}

export default { definition, execute };
